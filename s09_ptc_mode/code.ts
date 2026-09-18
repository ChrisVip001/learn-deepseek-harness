#!/usr/bin/env node
/**
 * s09_ptc_mode.ts - Code Is the Tool-Calling Protocol
 *
 * Native tool-calling: N tools x M round-trips, every schema in every request.
 * dsh's second path - PTC, Program-Tooled-Code (packages/core/tools/src/ptc.ts
 * + packages/ptc-runtime/) - collapses all of that:
 *
 *   - the model sees ONE transport tool: run_code
 *   - a TypeScript SDK is GENERATED from the visible tool schemas
 *   - the model writes a program; SDK functions route through the SAME
 *     execution pipeline (s03) - just called from code instead of blocks
 *   - only the program's console output / return value enters the conversation
 *     (intermediate values stay local, cost zero tokens)
 *   - wider sandbox_permissions demand a non-empty justification + approval
 *   - Promise.all parallelism is just... JavaScript
 *
 * Usage: node s09_ptc_mode/code.ts   (offline, deterministic)
 */

// ---------------------------------------------------------------------------
// 1. Visible tools (same shapes as s03) + the pipeline they route through
// ---------------------------------------------------------------------------

interface ToolDef {
	name: string;
	description: string;
	parameters: Record<string, string>;
	execute: (args: Record<string, unknown>) => string;
}

const TOOLS: ToolDef[] = [
	{ name: "bash", description: "Run a shell command.", parameters: { command: "string" }, execute: (a) => `stdout(${String(a["command"])}): alpha beta` },
	{ name: "read_file", description: "Read a file.", parameters: { path: "string" }, execute: (a) => `contents of ${String(a["path"])}: 42 lines` },
	{ name: "search", description: "Search the codebase.", parameters: { query: "string" }, execute: (a) => `matches for '${String(a["query"])}': 3 files` },
];

function pipelineRun(name: string, args: Record<string, unknown>): string {
	// In real dsh this IS the s03 pipeline; here, a policy stand-in.
	if (name === "bash" && String(args["command"] ?? "").includes("rm -rf")) {
		return "Error: denied by policy - destructive command";
	}
	const def = TOOLS.find((t) => t.name === name);
	if (!def) return `Error: unknown tool '${name}'`;
	return def.execute(args);
}

// ---------------------------------------------------------------------------
// 2. The generated SDK: types + runtime functions from tool schemas
// ---------------------------------------------------------------------------

function generateSdkSource(tools: ToolDef[]): string {
	const lines = tools.map((t) => {
		const params = Object.entries(t.parameters).map(([p, type]) => `${p}: ${type}`).join(", ");
		return `// ${t.description}\ndeclare function ${t.name}(${params}): Promise<string>;`;
	});
	return ["// ---- generated SDK (from visible tool schemas) ----", ...lines, ""].join("\n");
}

function buildSdkRuntime(): Record<string, (...args: never[]) => Promise<string>> {
	const runtime: Record<string, (...args: never[]) => Promise<string>> = {};
	for (const tool of TOOLS) {
		runtime[tool.name] = (async (...args: unknown[]) => {
			const def = tool;
			const keys = Object.keys(def.parameters);
			const argObject: Record<string, unknown> = {};
			keys.forEach((k, i) => (argObject[k] = args[i]));
			return pipelineRun(def.name, argObject); // same pipeline, code-driven
		}) as (...args: never[]) => Promise<string>;
	}
	return runtime;
}

// ---------------------------------------------------------------------------
// 3. The run_code transport tool
// ---------------------------------------------------------------------------

type RunCodeArgs = { code: string; justification?: string };

async function runCode(args: RunCodeArgs, approval: (justification: string) => Promise<boolean>): Promise<string> {
	// Wider sandbox permissions demand justification + approval (fail-closed).
	const wide = /write|exec|network/i.test(args.code) && /permissions\s*[:=]\s*["']wide["']/.test(args.code);
	if (wide) {
		if (!args.justification?.trim()) {
			return "Error: wide sandbox_permissions requested without justification";
		}
		const granted = await approval(args.justification);
		if (!granted) return "Error: wide sandbox_permissions denied by approval";
	}

	const captured: string[] = [];
	const fakeConsole = { log: (...parts: unknown[]) => captured.push(parts.map((p) => String(p)).join(" ")) };
	const sdk = buildSdkRuntime();
	try {
		const fn = new Function(...Object.keys(sdk), "console", `"use strict"; return (async () => { ${args.code} })()`);
		const returnValue = await fn(...Object.values(sdk), fakeConsole);
		const output = captured.join("\n");
		// ONLY the captured output + return value cross into the conversation.
		return [output, returnValue !== undefined ? `-> ${String(returnValue)}` : null].filter(Boolean).join("\n") || "(no output)";
	} catch (err) {
		return `Error in program: ${(err as Error).message}\npartial output:\n${captured.join("\n")}`;
	}
}

// ---------------------------------------------------------------------------
// 4. Demo: one program does what native mode needs four round-trips for
// ---------------------------------------------------------------------------

const MODEL_PROGRAM = `
const listing = await bash("ls -la");
const docs = await read_file("docs/overview.md");
const hits  = await search("compaction");
console.log("workspace:", listing);
console.log("docs:", docs);
console.log("search:", hits);
return "audit complete: 3 sources checked";
`;

function tokenCostOfSchemas(): { native: number; ptc: number } {
	const native = TOOLS.reduce(
		(sum, t) => sum + Math.ceil((t.name + t.description + Object.entries(t.parameters).map(([k, v]) => k + v).join("")).length / 4),
		0,
	);
	const ptc = Math.ceil(("run_code: Run a program against the generated SDK. {code: string}".length) / 4);
	return { native, ptc };
}

async function main() {
	console.log("s09: PTC Mode\n");

	console.log(generateSdkSource(TOOLS));

	console.log("\x1b[1m--- native mode: 3 tools in schema, 3+ round-trips ---\x1b[0m");
	const { native, ptc } = tokenCostOfSchemas();
	console.log(`  schema cost per request: ~${native} tokens (every request carries every schema)`);
	console.log(`  worst-case round-trips for the audit task: 3 tool batches + 1 final = 4`);

	console.log("\n\x1b[1m--- PTC mode: 1 transport tool, 1 round-trip ---\x1b[0m");
	console.log(`  schema cost per request: ~${ptc} tokens (just run_code)`);
	console.log(`  round-trips: 1\n`);
	console.log(`  \x1b[33m⚡ run_code { code: "...audit program...", justification: none }\x1b[0m`);
	const result = await runCode({ code: MODEL_PROGRAM }, async () => true);
	console.log(`  \x1b[2m${result.split("\n").join("\n  ")}\x1b[0m`);
	console.log(`  \x1b[2m(model saw ONLY this output - the SDK's intermediate values cost zero tokens)\x1b[0m`);

	console.log("\n\x1b[1m--- safety still applies ---\x1b[0m");
	const denied = await runCode({ code: `console.log(await bash("rm -rf /")); return "ok";` }, async () => true);
	console.log(`  \x1b[31m${denied.split("\n")[0]}\x1b[0m  <- pipeline ran inside the program too`);

	console.log("\nOne transport tool. Same pipeline. Code IS the tool-calling protocol.");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
