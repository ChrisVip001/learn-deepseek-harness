#!/usr/bin/env node
/**
 * s06_capability_seams.ts - Define the Seam, Swap the World
 *
 * dsh routes every "power" (filesystem, shell, terminal, ssh, lsp...) through
 * a CAPABILITY SEAM with three roles (docs/capability-seams.md):
 *
 *   Service Definition  the interface + its key          ("what exists")
 *   Service Provider    an implementation registered      ("who serves it")
 *   Consumer            usually a model-facing tool       ("who uses it")
 *
 * Providers are swappable per deployment: point the fs/shell seams at a
 * remote sandbox and the ENTIRE agent moves worlds - the tools never notice.
 * One shared policy family (ctx.sandboxPolicy) governs file decisions across
 * ALL consumers (fs, subprocess, ptc) - not per-tool ad-hoc rules.
 *
 * Usage: node s06_capability_seams/code.ts   (offline, deterministic)
 */

import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// 1. Service definitions: the seams (pure interfaces + keys)
// ---------------------------------------------------------------------------

interface FsSeam {
	world: string;
	readFile(path: string): string;
	writeFile(path: string, content: string): string;
	listDir(path: string): string[];
}

interface ShellSeam {
	world: string;
	exec(command: string): string;
}

// ---------------------------------------------------------------------------
// 2. Providers: two complete worlds behind the same seams
// ---------------------------------------------------------------------------

function createLocalWorld(): { fs: FsSeam; shell: ShellSeam } {
	const root = mkdtempSync(join(tmpdir(), "mini-dsh-s06-local-"));
	writeFileSync(join(root, "app.ts"), "console.log('local app')\n");
	writeFileSync(join(root, "notes.md"), "local scratch notes\n");
	return {
		fs: {
			world: "local",
			readFile: (path) => {
				try {
					return readFileSync(join(root, path), "utf8");
				} catch {
					return `Error: no such file '${path}' in LOCAL world`;
				}
			},
			writeFile: (path, content) => {
				writeFileSync(join(root, path), content);
				return `wrote '${path}' to LOCAL disk (${content.length} chars)`;
			},
			listDir: (path) => readdirSync(path === "." ? root : join(root, path)),
		},
		shell: {
			world: "local",
			exec: (command) => {
				const r = spawnSync(command, { shell: true, cwd: root, encoding: "utf8", timeout: 10_000 });
				return `LOCAL: ${`${r.stdout ?? ""}${r.stderr ?? ""}`.trim() || "(no output)"}`;
			},
		},
	};
}

// A simulated remote host: its own virtual filesystem, different contents.
function createRemoteWorld(): { fs: FsSeam; shell: ShellSeam } {
	const files = new Map<string, string>([
		["deploy.log", "remote deployment: ok\nrevision 4f2c1a\n"],
		["/etc/motd", "welcome to build-host-07\n"],
	]);
	return {
		fs: {
			world: "remote",
			readFile: (path) => files.get(path) ?? `Error: no such file '${path}' in REMOTE world`,
			writeFile: (path, content) => {
				files.set(path, content);
				return `wrote '${path}' to REMOTE host (${content.length} chars)`;
			},
			listDir: (path) => [...files.keys()].filter((k) => k.startsWith(path === "." ? "" : path)),
		},
		shell: {
			world: "remote",
			exec: (command) => `REMOTE(build-host-07): executed '${command}' over ssh`,
		},
	};
}

// ---------------------------------------------------------------------------
// 3. Shared policy: ONE decision family for every file-touching consumer
// ---------------------------------------------------------------------------

class WorkspacePolicy {
	private readonly allowedPrefixes: string[];

	constructor(allowedPrefixes: string[]) {
		this.allowedPrefixes = allowedPrefixes;
	}
	checkRead(path: string): string | null {
		return this.allowedPrefixes.some((p) => path.startsWith(p)) ? null : `read outside allowed roots: '${path}'`;
	}
	checkWrite(path: string): string | null {
		return this.allowedPrefixes.some((p) => path.startsWith(p)) && !path.startsWith("/etc") ? null : `write outside workspace: '${path}'`;
	}
}

// ---------------------------------------------------------------------------
// 4. Consumers: model-facing tools that know NOTHING about which world
// ---------------------------------------------------------------------------

interface Ctx {
	consume<T>(key: string): T;
}

function makeConsumerTools(ctx: Ctx): Array<{ name: string; execute: (args: Record<string, unknown>) => string }> {
	const fs = ctx.consume<FsSeam>("fs");
	const shell = ctx.consume<ShellSeam>("shell");
	const policy = ctx.consume<WorkspacePolicy>("policy");
	return [
		{
			name: "read_file",
			execute: (args) => {
				const path = String(args["path"]);
				const denial = policy.checkRead(path);
				return denial ?? fs.readFile(path);
			},
		},
		{
			name: "write_file",
			execute: (args) => {
				const path = String(args["path"]);
				const denial = policy.checkWrite(path);
				return denial ?? fs.writeFile(path, String(args["content"] ?? ""));
			},
		},
		{
			name: "bash",
			execute: (args) => shell.exec(String(args["command"] ?? "")),
		},
	];
}

// ---------------------------------------------------------------------------
// 5. Runtime: assemble the world from config, run the SAME task in both
// ---------------------------------------------------------------------------

type WorldConfig = "local" | "remote";

function assembleWorld(config: WorldConfig): Ctx {
	const services = new Map<string, unknown>();
	const world = config === "local" ? createLocalWorld() : createRemoteWorld();
	services.set("fs", world.fs);
	services.set("shell", world.shell);
	services.set("policy", new WorkspacePolicy([".", "/tmp/workspace"]));
	return { consume: <T,>(key: string) => services.get(key) as T };
}

async function runTask(config: WorldConfig): Promise<void> {
	console.log(`\x1b[1m--- task against world: ${config} ---\x1b[0m`);
	const ctx = assembleWorld(config);
	const tools = makeConsumerTools(ctx);
	const world = ctx.consume<FsSeam>("fs").world;

	// The scripted "model" issues identical calls in both worlds.
	const script: Array<{ name: string; arguments: Record<string, unknown> }> = [
		{ name: "bash", arguments: { command: "ls" } },
		{ name: "read_file", arguments: { path: "notes.md" } },
		{ name: "write_file", arguments: { path: "report.md", content: `audit by ${world} world\n` } },
		{ name: "read_file", arguments: { path: "/etc/shadow" } }, // policy blocks in BOTH worlds
	];
	for (const call of script) {
		const tool = tools.find((t) => t.name === call.name)!;
		const output = tool.execute(call.arguments);
		const blocked = output.startsWith("read outside") || output.startsWith("write outside");
		console.log(`  \x1b[33m⚡ ${call.name} ${JSON.stringify(call.arguments).slice(0, 50)}\x1b[0m`);
		console.log(`     ${blocked ? "\x1b[31m" : "\x1b[2m"}${output.slice(0, 80)}\x1b[0m`);
	}
	console.log("");
}

async function main() {
	console.log("s06: Capability Seams\n");
	console.log("Same tools. Same task. Two worlds swapped behind the seams.\n");
	await runTask("local");
	await runTask("remote");
	console.log("Consumer tools contain zero world-specific code. The policy family fired identically in both.");
	console.log("In real dsh this is how Bash/PTY/LSP move to a remote sandbox without forking the providers.");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
