#!/usr/bin/env node
/**
 * s03_tool_pipeline.ts - One Pipeline, Five Gates
 *
 * Every tool call in dsh crosses the SAME fixed pipeline
 * (packages/core/tools + docs/tool-execution-pipeline.md):
 *
 *   1. tools/pre-execute   extensible waterfall: allow / deny / ask
 *   2. monotonic guard     ctx.tools.guard(fn) - runs AFTER pre-execute,
 *                          can only deny, can never be overturned
 *   3. tools/execute       wrapped dispatch: schema check, timeout, retry
 *   4. tools/post-execute  inspect / replace the result
 *   5. tools/result        read-only notification (logging, metrics)
 *
 * Design rule from the real tree: invalid model arguments become a normal
 * error result - the turn continues, nothing crashes.
 *
 * Usage: node s03_tool_pipeline/code.ts   (offline, deterministic)
 */

import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const WORKSPACE = mkdtempSync(join(tmpdir(), "mini-dsh-s03-"));
writeFileSync(join(WORKSPACE, "a.txt"), "alpha\n");

// ---------------------------------------------------------------------------
// 1. Tool definitions (defineTool DSL - simplified schemas)
// ---------------------------------------------------------------------------

interface ToolDefinition {
	name: string;
	description: string;
	parameters: Record<string, "string" | "number" | "boolean">;
	timeoutMs?: number;
	execute: (args: Record<string, unknown>) => Promise<string> | string;
}

const bash: ToolDefinition = {
	name: "bash",
	description: "Run a shell command.",
	parameters: { command: "string" },
	execute: (args) => `stdout of: ${String(args["command"] ?? "")}`,
};

const write_file: ToolDefinition = {
	name: "write_file",
	description: "Write a file.",
	parameters: { path: "string", content: "string" },
	execute: (args) => {
		writeFileSync(join(WORKSPACE, String(args["path"])), String(args["content"] ?? ""));
		return `wrote ${String(args["path"])}`;
	},
};

const secret_read: ToolDefinition = {
	name: "secret_read",
	description: "Read a credential from the vault (guarded - see below).",
	parameters: { key: "string" },
	execute: (args) => `*** contents of ${String(args["key"])} ***`,
};

const slow_task: ToolDefinition = {
	name: "slow_task",
	description: "A tool that always takes too long (timeout demo).",
	parameters: {},
	timeoutMs: 100,
	execute: async () => {
		await sleep(500);
		return "finally done";
	},
};

// ---------------------------------------------------------------------------
// 2. The pipeline runtime (provided as the "tools" service)
// ---------------------------------------------------------------------------

type PreDecision = { action: "allow" } | { action: "deny"; reason: string } | { action: "ask"; reason: string };
type ToolExecution = { name: string; arguments: Record<string, unknown> };
type ToolResult = { ok: boolean; output: string; gate?: string };

class ToolRuntime {
	private defs = new Map<string, ToolDefinition>();
	private preListeners: Array<(exec: ToolExecution) => PreDecision | void> = [];
	private guards: Array<(exec: ToolExecution) => string | null> = [];
	private postListeners: Array<(exec: ToolExecution, result: ToolResult) => ToolResult | void> = [];
	private readonly approval: (reason: string) => Promise<boolean>;
	readonly trace: string[] = [];

	constructor(approval: (reason: string) => Promise<boolean>) {
		this.approval = approval;
	}

	register(def: ToolDefinition): void {
		this.defs.set(def.name, def);
	}

	/** Extensible waterfall: allow / deny / ask. Multiple listeners: deny > ask > allow. */
	onPreExecute(listener: (exec: ToolExecution) => PreDecision | void): void {
		this.preListeners.push(listener);
	}

	/** Monotonic guard: evaluated AFTER pre-execute; denies are final. */
	guard(fn: (exec: ToolExecution) => string | null): void {
		this.guards.push(fn);
	}

	/** Inspect or replace results before they reach the model. */
	onPostExecute(listener: (exec: ToolExecution, result: ToolResult) => ToolResult | void): void {
		this.postListeners.push(listener);
	}

	/** Project only what the model may see - never execute(). */
	schemasForModel(): Array<{ name: string; description: string; parameters: unknown }> {
		return [...this.defs.values()].map(({ name, description, parameters }) => ({ name, description, parameters }));
	}

	async run(exec: ToolExecution): Promise<ToolResult> {
		this.trace.push(`pre-execute(${exec.name})`);

		// -- gate 1: pre-execute waterfall --------------------------------
		let decision: PreDecision = { action: "allow" };
		for (const listener of this.preListeners) {
			const d = listener(exec);
			if (!d) continue;
			if (d.action === "deny") return this.finish(exec, { ok: false, output: `Error: denied by policy - ${d.reason}`, gate: "pre-execute" });
			if (d.action === "ask") decision = d; // ask only sticks if nobody denies
		}
		if (decision.action === "ask") {
			this.trace.push(`approval(${exec.name})`);
			const granted = await this.approval(decision.reason);
			if (!granted) return this.finish(exec, { ok: false, output: `Error: user declined - ${decision.reason}`, gate: "approval" });
		}

		// -- gate 2: monotonic guards (cannot be overturned) ---------------
		for (const guard of this.guards) {
			const denial = guard(exec);
			if (denial) return this.finish(exec, { ok: false, output: `Error: rejected by guard - ${denial}`, gate: "guard" });
		}

		// -- gate 3: wrapped execution (schema check + timeout) -------------
		const def = this.defs.get(exec.name);
		if (!def) return this.finish(exec, { ok: false, output: `Error: unknown tool '${exec.name}'`, gate: "execute" });
		for (const [param, type] of Object.entries(def.parameters)) {
			if (!(param in exec.arguments)) return this.finish(exec, { ok: false, output: `Error: missing argument '${param}'`, gate: "execute" });
			if (typeof exec.arguments[param] !== type) return this.finish(exec, { ok: false, output: `Error: argument '${param}' must be ${type}`, gate: "execute" });
		}
		let output: string;
		try {
			output = await Promise.race([
				Promise.resolve(def.execute(exec.arguments)),
				sleep(def.timeoutMs ?? 5_000).then(() => {
					throw new Error(`timeout after ${def.timeoutMs ?? 5000}ms`);
				}),
			]);
		} catch (err) {
			return this.finish(exec, { ok: false, output: `Error: ${(err as Error).message}`, gate: "execute" });
		}

		return this.finish(exec, { ok: true, output });
	}

	/** gates 4+5: post-execute (may replace), then the read-only result event. */
	private finish(exec: ToolExecution, result: ToolResult): ToolResult {
		if (result.gate !== "pre-execute") this.trace.push(`post-execute(${exec.name})`);
		for (const listener of this.postListeners) {
			const replacement = listener(exec, result);
			if (replacement) result = replacement;
		}
		this.trace.push(`result(${exec.name}, ok=${result.ok})`);
		return result;
	}
}

// ---------------------------------------------------------------------------
// 3. Plugins wire the pipeline together
// ---------------------------------------------------------------------------

// headless approval answerer: denies anything mentioning "network"
function approvalPlugin(ctx: Context2): void {
	ctx.provide("approval", async (reason: string) => !/network/i.test(reason));
}

function auditPlugin(rt: ToolRuntime): void {
	rt.onPreExecute((exec) => {
		console.log(`  \x1b[2m[audit] ${exec.name} is entering the pipeline\x1b[0m`);
	});
	rt.onPostExecute((exec, result) => {
		if (result.ok && exec.name === "bash") {
			return { ...result, output: `${result.output} (exit=0)` }; // result enrichment
		}
	});
}

function policyPlugin(rt: ToolRuntime): void {
	rt.onPreExecute((exec) => {
		if (exec.name === "bash" && String(exec.arguments["command"] ?? "").includes("rm -rf")) {
			return { action: "deny", reason: "destructive command" };
		}
		if (exec.name === "bash" && String(exec.arguments["command"] ?? "").includes("curl")) {
			return { action: "ask", reason: "network access requested" };
		}
	});
	// The monotonic guard: even if every listener allows, this still rejects.
	rt.guard((exec) =>
		exec.name === "secret_read" ? "credential access is off-limits in this deployment" : null,
	);
}

// -- minimal ctx (same shape as s01) ------------------------------------------

interface Context2 {
	provide(key: string, impl: unknown): void;
	consume<T>(key: string): T;
}

// ---------------------------------------------------------------------------
// 4. Scripted demo: six calls, six different outcomes
// ---------------------------------------------------------------------------

const calls: ToolExecution[] = [
	{ name: "bash", arguments: { command: "ls" } }, // allow -> execute -> post-enrich
	{ name: "bash", arguments: { command: "rm -rf /tmp/x" } }, // pre-execute deny
	{ name: "bash", arguments: { command: "curl https://x" } }, // ask -> approval denies (network)
	{ name: "secret_read", arguments: { key: "api-key" } }, // pre allow, GUARD denies (monotonic)
	{ name: "slow_task", arguments: {} }, // timeout
	{ name: "write_file", arguments: { path: "b.txt" } }, // schema error (missing content)
];

async function main() {
	console.log(`s03: Tool Pipeline   (workspace: ${WORKSPACE})\n`);

	const approval = (reason: string) => !/network/i.test(reason);
	const rt = new ToolRuntime(approval);
	for (const def of [bash, write_file, secret_read, slow_task]) rt.register(def);
	auditPlugin(rt);
	policyPlugin(rt);

	for (const call of calls) {
		console.log(`\x1b[33m⚡ ${call.name} ${JSON.stringify(call.arguments).slice(0, 60)}\x1b[0m`);
		const result = await rt.run(call);
		const color = result.ok ? "\x1b[2m" : "\x1b[31m";
		console.log(`  ${color}[${result.gate ?? "ok"}] ${result.output}\x1b[0m`);
	}

	console.log("\npipeline trace:");
	for (const line of rt.trace) console.log(`  ${line}`);
	console.log("\nOne fixed pipeline. Policy lives in plugins; guards are final; bad args are just error results.");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
