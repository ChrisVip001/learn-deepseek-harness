#!/usr/bin/env node
/**
 * s02_loop_as_plugin.ts - Even the Loop Is a Plugin
 *
 * In dsh, the default agent loop (packages/core/agent-loop, "ReactLoopAgent")
 * registers itself on ctx.agents as an AgentFactory. Consumers NEVER import
 * it - they resolve an agent by id from the registry. Swapping the loop is
 * a config line, not a code change.
 *
 * This chapter builds:
 *   - an AgentRegistry service          (provided by a tiny "core" plugin)
 *   - a scripted LLM service            (faux - free, deterministic)
 *   - react-loop-v1: turn/step machine  (step = one LLM request + its tools;
 *                                        turn = steps until nothing is owed)
 *   - a "goal-guard" plugin that VETOES turn/stopping when the task's
 *     artifact is missing - injecting a follow-up input instead
 *   - react-loop-v2: wraps v1 with a step cap - swapped by config, consumer
 *     code identical
 *
 * Turn/step semantics (docs/architecture.md):
 *   step = one model request + the tool calls it made
 *   turn = zero or more steps; continues while tools owe work or new
 *          inputs arrived; serial `turn/stopping` may veto the stop
 *
 * Usage: node s02_loop_as_plugin/code.ts   (offline, deterministic)
 */

import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WORKSPACE = mkdtempSync(join(tmpdir(), "mini-dsh-s02-"));
writeFileSync(join(WORKSPACE, "readme.md"), "project motto: everything is a plugin\n");

// ---------------------------------------------------------------------------
// 1. Slim composition runtime (from s01)
// ---------------------------------------------------------------------------

type Listener = (payload: unknown) => void;

class Context {
	private listeners = new Map<string, Listener[]>();
	private services = new Map<string, unknown>();

	on(event: string, listener: Listener): void {
		const list = this.listeners.get(event) ?? [];
		list.push(listener);
		this.listeners.set(event, list);
	}
	emit(event: string, payload?: unknown): void {
		for (const l of [...(this.listeners.get(event) ?? [])]) l(payload);
	}
	provide(key: string, impl: unknown): void {
		this.services.set(key, impl);
	}
	consume<T>(key: string): T {
		const hit = this.services.get(key);
		if (hit === undefined) throw new Error(`service '${key}' not provided`);
		return hit as T;
	}
}

class Runtime {
	readonly ctx = new Context();
	use(plugin: (ctx: Context) => void): void {
		plugin(this.ctx);
	}
}

// ---------------------------------------------------------------------------
// 2. Contracts: LLM service, tools service, agent registry
// ---------------------------------------------------------------------------

type LlmStep = { text: string; calls?: Array<{ name: string; arguments: Record<string, unknown> }> };
interface Llm {
	complete(step: number): LlmStep;
}
interface Tool {
	name: string;
	execute: (args: Record<string, unknown>) => string;
}

type AgentEvent =
	| { type: "turn/start"; input: string }
	| { type: "step/start"; n: number }
	| { type: "agent/request"; step: number }
	| { type: "tool/exec"; name: string; arguments: Record<string, unknown>; output: string }
	| { type: "turn/stopping"; vetoed: boolean }
	| { type: "turn/end"; steps: number };

interface Agent {
	readonly id: string;
	run(input: string): AsyncGenerator<AgentEvent>;
}
type AgentFactory = (llm: Llm, tools: Tool[]) => Agent;

class AgentRegistry {
	private factories = new Map<string, AgentFactory>();
	register(id: string, factory: AgentFactory): void {
		this.factories.set(id, factory);
	}
	resolve(id: string, llm: Llm, tools: Tool[]): Agent {
		const factory = this.factories.get(id);
		if (!factory) throw new Error(`no agent factory '${id}' registered`);
		return factory(llm, tools);
	}
}

// ---------------------------------------------------------------------------
// 3. Infrastructure plugins: llm + tools + agents registry
// ---------------------------------------------------------------------------

function corePlugin(ctx: Context): void {
	ctx.provide("agents", new AgentRegistry());
}

function llmPlugin(ctx: Context): void {
	// Stateful faux LLM: each complete() advances the script.
	const script: LlmStep[] = [
		{ text: "Reading the readme first.", calls: [{ name: "read_file", arguments: { path: "readme.md" } }] },
		{ text: "The readme states the motto. I'll report it now." }, // no artifact yet -> guard will veto
		{ text: "Writing the summary.", calls: [{ name: "write_file", arguments: { path: "summary.txt", content: "motto: everything is a plugin" } }] },
		{ text: "Summary written to summary.txt. Done." },
	];
	let cursor = 0;
	ctx.provide<Llm>("llm", {
		complete: () => script[Math.min(cursor++, script.length - 1)]!,
	});
}

function toolsPlugin(ctx: Context): void {
	ctx.provide<Tool[]>("tools", [
		{
			name: "read_file",
			execute: (args) => {
				try {
					return readFileSync(join(WORKSPACE, String(args["path"])), "utf8").trim();
				} catch {
					return `Error: cannot read ${String(args["path"])}`;
				}
			},
		},
		{
			name: "write_file",
			execute: (args) => {
				writeFileSync(join(WORKSPACE, String(args["path"])), String(args["content"] ?? ""));
				return `wrote ${String(args["path"])}`;
			},
		},
	]);
}

// ---------------------------------------------------------------------------
// 4. The loop plugin - registers itself like any other plugin
// ---------------------------------------------------------------------------

function reactLoopV1Plugin(ctx: Context): void {
	const registry = ctx.consume<AgentRegistry>("agents");
	registry.register("react-loop-v1", (llm, tools) => ({
		id: "react-loop-v1",
		async *run(input: string): AsyncGenerator<AgentEvent> {
			yield { type: "turn/start", input };
			let step = 0;
			while (true) {
				// -- step: one model request + its tool calls --
				yield { type: "step/start", n: ++step };
				yield { type: "agent/request", step };
				const response = llm.complete(step);
				if (!response.calls || response.calls.length === 0) {
					// Nothing owed: propose stopping - but stopping is serial and vetoable.
					const veto = { flagged: false };
					ctx.emit("turn/stopping", veto);
					if (!veto.flagged) {
						yield { type: "turn/stopping", vetoed: false };
						yield { type: "turn/end", steps: step };
						return;
					}
					yield { type: "turn/stopping", vetoed: true }; // a listener injected follow-up work
					continue;
				}
				for (const call of response.calls) {
					const tool = tools.find((t) => t.name === call.name);
					const output = tool ? tool.execute(call.arguments) : `Error: unknown tool '${call.name}'`;
					yield { type: "tool/exec", name: call.name, arguments: call.arguments, output };
				}
				// Tools just ran - the turn still owes work, so loop into the next step.
			}
		},
	}));
}

// -- a guard plugin: vetoes stopping until the artifact exists ---------------

function goalGuardPlugin(ctx: Context): void {
	ctx.on("turn/stopping", (payload) => {
		const veto = payload as { flagged: boolean };
		if (!existsSync(join(WORKSPACE, "summary.txt"))) {
			console.log("  \x1b[35m[goal-guard] artifact summary.txt missing - vetoing stop\x1b[0m");
			veto.flagged = true;
		}
	});
}

// -- react-loop-v2: a different loop, same contract, swapped by config -------

function reactLoopV2Plugin(ctx: Context): void {
	const registry = ctx.consume<AgentRegistry>("agents");
	registry.register("react-loop-v2", (llm, tools) => {
		const inner = registry.resolve("react-loop-v1", llm, tools);
		return {
			id: "react-loop-v2",
			async *run(input: string): AsyncGenerator<AgentEvent> {
				const MAX_STEPS = 3;
				for await (const ev of inner.run(input)) {
					if (ev.type === "step/start" && ev.n > MAX_STEPS) {
						yield { type: "turn/end", steps: MAX_STEPS };
						return;
					}
					yield ev;
				}
			},
		};
	});
}

// ---------------------------------------------------------------------------
// 5. The consumer: resolves by CONFIG, never imports a loop
// ---------------------------------------------------------------------------

const CONFIG = { agent: "react-loop-v1" }; // <- flip to "react-loop-v2" to swap the loop

async function runOnce(runtime: Runtime, label: string): Promise<void> {
	console.log(`\x1b[1m--- run: agent='${CONFIG.agent}' (${label}) ---\x1b[0m`);
	const agent = runtime.ctx
		.consume<AgentRegistry>("agents")
		.resolve(CONFIG.agent, runtime.ctx.consume<Llm>("llm"), runtime.ctx.consume<Tool[]>("tools"));
	for await (const ev of agent.run("Read the readme and write summary.txt.")) {
		switch (ev.type) {
			case "turn/start":
				console.log(`\x1b[36m▶ turn/start\x1b[0m "${ev.input}"`);
				break;
			case "step/start":
				console.log(`  \x1b[2mstep ${ev.n}\x1b[0m`);
				break;
			case "agent/request":
				console.log("    \x1b[2m→ llm request\x1b[0m");
				break;
			case "tool/exec":
				console.log(`    \x1b[33m⚡ ${ev.name} ${JSON.stringify(ev.arguments).slice(0, 60)}\x1b[0m`);
				console.log(`      \x1b[2m${ev.output.slice(0, 70)}\x1b[0m`);
				break;
			case "turn/stopping":
				console.log(`  \x1b[34m${ev.vetoed ? "⟳ stopping vetoed - turn continues" : "■ stopping accepted"}\x1b[0m`);
				break;
			case "turn/end":
				console.log(`\x1b[36m■ turn/end\x1b[0m after ${ev.steps} step(s)\n`);
				break;
		}
	}
}

async function main() {
	console.log(`s02: Loop as Plugin   (workspace: ${WORKSPACE})\n`);
	const runtime = new Runtime();
	runtime.use(corePlugin);
	runtime.use(llmPlugin);
	runtime.use(toolsPlugin);
	runtime.use(reactLoopV1Plugin);
	runtime.use(goalGuardPlugin);
	runtime.use(reactLoopV2Plugin);

	await runOnce(runtime, "guard vetoes once, then the artifact lands");

	CONFIG.agent = "react-loop-v2";
	await runOnce(runtime, "same consumer code, swapped loop, step cap 3");

	console.log("The consumer never imported a loop. 'Replace the agent loop' is a config line.");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
