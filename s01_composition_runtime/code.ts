#!/usr/bin/env node
/**
 * s01_composition_runtime.ts - Registration Is a Side Effect
 *
 * dsh is built on Cordis, a composition framework whose one big idea is:
 * EVERY registration is a reversible side effect.
 *
 *   ctx.on(event, listener)   -> returns a disposer (unlisten)
 *   ctx.effect(() => cleanup) -> register cleanup for everything you did
 *   ctx.provide(key, impl)    -> services come and go the same way
 *
 * A plugin is just a function (ctx) => void | Dispose. Because every
 * contribution carries its own undo, the runtime can stop or swap ANY plugin
 * at ANY time - that is the foundation dsh builds "no privileged core" on.
 * (Real thing: vendor/ @deepseek-ai/cordis + docs/cordis-tutorial/)
 *
 * Usage: node s01_composition_runtime/code.ts   (offline, deterministic)
 */

// ---------------------------------------------------------------------------
// 1. mini-cordis: contexts, disposers, events, services
// ---------------------------------------------------------------------------

type Dispose = () => void;
type Listener = (payload: unknown) => void;

class Context {
	private listeners: Map<string, Listener[]>;
	private services: Map<string, unknown>;
	private disposers: Dispose[] = [];
	private label: string;

	constructor(label: string, parent?: Context) {
		this.label = label;
		// Child contexts share the parent's event bus and service registry,
		// so events emitted on root reach plugin listeners and services
		// provided by one plugin are visible to the others. The disposers
		// list stays private: each plugin still only undoes its own work.
		this.listeners = parent?.listeners ?? new Map();
		this.services = parent?.services ?? new Map();
	}

	/** Register a listener; registration IS a side effect - it returns its own undo. */
	on(event: string, listener: Listener): Dispose {
		const list = this.listeners.get(event) ?? [];
		list.push(listener);
		this.listeners.set(event, list);
		const dispose = () => {
			const current = this.listeners.get(event) ?? [];
			this.listeners.set(event, current.filter((l) => l !== listener));
		};
		this.disposers.push(dispose);
		return dispose;
	}

	/** Register arbitrary cleanup - the plugin's total contribution is reversible. */
	effect(fn: () => Dispose | void): void {
		const dispose = fn();
		if (dispose) this.disposers.push(dispose);
	}

	emit(event: string, payload?: unknown): void {
		for (const listener of [...(this.listeners.get(event) ?? [])]) listener(payload);
	}

	/** Provide a service; the disposer withdraws it and notifies consumers. */
	provide(key: string, impl: unknown): Dispose {
		this.services.set(key, impl);
		this.emit(`service:${key}`, impl);
		const dispose = () => {
			this.services.delete(key);
			this.emit(`service:${key}`, undefined);
		};
		this.disposers.push(dispose);
		return dispose;
	}

	consume<T>(key: string): T | undefined {
		return this.services.get(key) as T | undefined;
	}

	dispose(): void {
		// Reverse order: the last side effect is undone first.
		for (const dispose of this.disposers.reverse()) dispose();
		this.disposers = [];
		console.log(`  \x1b[2m[${this.label}] context disposed - every contribution undone\x1b[0m`);
	}
}

type Plugin = (ctx: Context) => void;

class Runtime {
	private plugins: Array<{ name: string; ctx: Context }> = [];
	readonly root = new Context("runtime-root");

	/** Install a plugin into its own context. Uninstalling disposes the context. */
	use(name: string, plugin: Plugin): void {
		const ctx = new Context(`plugin:${name}`, this.root);
		plugin(ctx);
		this.plugins.push({ name, ctx });
		console.log(`\x1b[32m+ plugin '${name}' loaded\x1b[0m`);
	}

	unload(name: string): void {
		const index = this.plugins.findIndex((p) => p.name === name);
		if (index === -1) return;
		const [removed] = this.plugins.splice(index, 1);
		removed!.ctx.dispose();
		console.log(`\x1b[31m- plugin '${name}' unloaded\x1b[0m`);
	}

	async stop(): Promise<void> {
		for (const { ctx } of this.plugins.reverse()) ctx.dispose();
		this.plugins = [];
		this.root.dispose();
	}
}

// ---------------------------------------------------------------------------
// 2. Three plugins built the way dsh builds everything
// ---------------------------------------------------------------------------

function loggerPlugin(ctx: Context): void {
	// Provide a service; withdraw it automatically when this plugin unloads.
	ctx.provide("logger", {
		info: (msg: string) => console.log(`  [logger] ${msg}`),
	});
	ctx.effect(() => {
		const startedAt = Date.now();
		console.log("  [logger] effect: opened log sink");
		return () => console.log(`  [logger] effect: closed log sink (open for ${Date.now() - startedAt}ms)`);
	});
}

function commandsPlugin(ctx: Context): void {
	ctx.on("command", (payload) => {
		const { name, args } = payload as { name: string; args: string[] };
		// Consume a service that may or may not exist RIGHT NOW.
		const logger = ctx.consume<{ info: (m: string) => void }>("logger");
		if (name === "greet") {
			logger?.info(`greet -> hello, ${args.join(" ")}!`);
		} else if (name === "fail") {
			throw new Error("command failed");
		}
	});
	// React to the service appearing/disappearing (Cordis invalidates dependents).
	ctx.on("service:logger", (impl) => {
		console.log(`  [commands] logger service ${impl ? "appeared - commands can log again" : "withdrawn - commands degrade gracefully"}`);
	});
}

function metricsPlugin(ctx: Context): void {
	let events = 0;
	ctx.on("command", () => events++);
	ctx.effect(() => {
		const report = () => console.log(`  [metrics] observed ${events} command(s)`);
		const timer = setInterval(report, 10_000);
		return () => {
			clearInterval(timer);
			report(); // final report on dispose - cleanup can be meaningful work
		};
	});
}

// ---------------------------------------------------------------------------
// 3. Demo: load, use, unload, re-load, stop - every step reversible
// ---------------------------------------------------------------------------

async function main() {
	console.log("s01: Composition Runtime (mini-cordis)\n");
	const runtime = new Runtime();

	runtime.use("logger", loggerPlugin);
	runtime.use("commands", commandsPlugin);
	runtime.use("metrics", metricsPlugin);

	console.log("\n-- emit 'greet' --");
	runtime.root.emit("command", { name: "greet", args: ["world"] });

	console.log("\n-- unload 'logger' (its context undoes its own contributions) --");
	runtime.unload("logger");

	console.log("\n-- emit 'greet' again (command still runs; logging degrades) --");
	runtime.root.emit("command", { name: "greet", args: ["again"] });

	console.log("\n-- re-install 'logger' --");
	runtime.use("logger", loggerPlugin);
	runtime.root.emit("command", { name: "greet", args: ["restored"] });

	console.log("\n-- runtime.stop(): all plugins disposed in REVERSE order --");
	await runtime.stop();

	console.log("\nThe runtime never destroyed anything itself. Every plugin undid itself.");
	console.log("This reversibility is what makes 'replace the agent loop from config' possible (s02).");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
