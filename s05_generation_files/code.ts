#!/usr/bin/env node
/**
 * s05_generation_files.ts - Committed Generations Never Change
 *
 * dsh's JSONL persistence (packages/session/session-persistence-jsonl/):
 *
 *   - sessions are stores of immutable, version-named "canonical generation"
 *     files: session.jsonl (gen 1), session.v2.jsonl, session.v3.jsonl...
 *   - opening for write publishes a NEW version-named successor and takes an
 *     EXCLUSIVE lock (native flock binding: native/system)
 *   - committed generations are never renamed, overwritten, or deleted
 *   - a turn that crashed mid-flight is repaired with synthetic closers
 *     ("interruptedTurnClosers"): the unresolved tool call gets a synthesized
 *     ABORTED result, the turn ends marked interrupted
 *   - checkpoint policy: before the next action, the model request + top-level
 *     tool side effects + completed steps are already on disk
 *
 * Usage: node s05_generation_files/code.ts   (offline, deterministic)
 */

import { mkdtempSync, mkdirSync, openSync, closeSync, writeFileSync, appendFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Event = { seq: number; type: string; data: Record<string, unknown> };

// ---------------------------------------------------------------------------
// 1. Generation-file persistence with exclusive write ownership
// ---------------------------------------------------------------------------

class SessionPersistence {
	private dir: string;
	private lockFd: number | null = null;
	private activeFile: string | null = null;
	private activeGen = 0;
	private seq = 0;

	constructor(sessionId: string, sharedDir?: string) {
		// Shared dir lets the demo simulate two processes; default dir is unique
		// per instance so a crashed run never leaves a stale lock for the next.
		this.dir = sharedDir ?? join(mkdtempSync(join(tmpdir(), "mini-dsh-s05-")), sessionId);
		mkdirSync(this.dir, { recursive: true });
	}

	private files(): string[] {
		return existsSync(this.dir) ? readdirSync(this.dir).filter((f) => f.endsWith(".jsonl")).sort() : [];
	}

	/** Exclusive write lock - simulated flock via O_EXCL create (real: native flock). */
	private acquireLock(): void {
		const lockPath = join(this.dir, "write.lock");
		try {
			this.lockFd = openSync(lockPath, "wx"); // fails if another writer holds it
		} catch {
			throw new Error(`session is already open for write (exclusive lock held by another writer)`);
		}
	}

	private releaseLock(): void {
		if (this.lockFd !== null) {
			closeSync(this.lockFd);
			rmSync(join(this.dir, "write.lock"), { force: true });
			this.lockFd = null;
		}
	}

	openForWrite(): void {
		this.acquireLock();
		const existing = this.files();
		// Generation 1 is canonical `session.jsonl`; successors are version-named.
		this.activeGen = existing.length === 0 ? 1 : existing.length + 1;
		this.activeFile = this.activeGen === 1 ? join(this.dir, "session.jsonl") : join(this.dir, `session.v${this.activeGen}.jsonl`);
		writeFileSync(this.activeFile, "");
		console.log(`\x1b[2m[persistence] opened gen ${this.activeGen} for write (${this.activeFile.split("/").pop()}) - lock held\x1b[0m`);
	}

	append(type: string, data: Record<string, unknown>): Event {
		if (!this.activeFile) throw new Error("not open for write");
		const event = { seq: ++this.seq, type, data };
		appendFileSync(this.activeFile, `${JSON.stringify(event)}\n`);
		return event;
	}

	/** Commit = close the generation. From now on it is immutable. */
	commit(): void {
		console.log(`\x1b[2m[persistence] gen ${this.activeGen} committed - immutable from now on\x1b[0m`);
		this.releaseLock();
		this.activeFile = null;
	}

	/** Simulate process death: the kernel would release flock; nothing is committed. */
	simulateCrashCleanup(): void {
		if (this.lockFd !== null) {
			closeSync(this.lockFd);
			this.lockFd = null;
			rmSync(join(this.dir, "write.lock"), { force: true }); // mimic kernel flock release
		}
		this.activeFile = null;
	}

	/** Detect the newest uncommitted generation and repair the interrupted turn. */
	repair(): string[] {
		const actions: string[] = [];
		const files = this.files().filter((f) => readFileSync(join(this.dir, f), "utf8").trim().length > 0);
		const last = files.at(-1);
		if (!last) return ["nothing on disk to repair"];

		const events = readFileSync(join(this.dir, last), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as Event);

		const openTurn = events.some((e) => e.type === "turn.started") && !events.some((e) => e.type === "turn.ended");
		if (!openTurn) return ["no interrupted turn found - nothing to repair"];

		// The last generation was never committed -> appending to it is legal.
		// (We may already hold the lock from our own openForWrite.)
		if (this.lockFd === null) this.acquireLock();
		this.seq = Math.max(...events.map((e) => e.seq)); // continue the log's sequence
		this.activeGen = files.length;
		this.activeFile = join(this.dir, last);

		const dispatchedCall = [...events].reverse().find((e) => e.type === "assistant.message_added" && Array.isArray(e.data["toolCalls"]) && (e.data["toolCalls"] as unknown[]).length > 0);
		if (dispatchedCall && !events.some((e) => e.type === "tool.result_added")) {
			this.append("tool.result_added", {
				toolCallId: (dispatchedCall.data["toolCalls"] as unknown[])[0],
				content: "ABORTED_BEFORE_DISPATCH: harness crashed before this call could run",
			});
			actions.push("synthesized tool result for the dispatched-but-unresolved call");
		}
		this.append("turn.ended", { interrupted: true });
		actions.push("closed the interrupted turn with turn.ended{interrupted:true}");
		this.commit();
		return actions;
	}

	inspect(): void {
		for (const file of this.files()) {
			const events = readFileSync(join(this.dir, file), "utf8").split("\n").filter(Boolean);
			console.log(`\x1b[1m${file}\x1b[0m (${events.length} events)`);
			for (const line of events) {
				const e = JSON.parse(line) as Event;
				console.log(`  \x1b[2m${String(e.seq).padStart(2)} ${e.type} ${JSON.stringify(e.data).slice(0, 70)}\x1b[0m`);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// 2. Demo: a committed generation, exclusivity, a crash, a repair
// ---------------------------------------------------------------------------

function main() {
	console.log("s05: Generation Files\n");
	// One shared directory = one session disk, as if several processes opened it.
	const sharedDir = mkdtempSync(join(tmpdir(), "mini-dsh-s05-"));

	const persistence = new SessionPersistence("demo", sharedDir);

	// -- generation 1: a complete, committed turn ---------------------------
	persistence.openForWrite();
	persistence.append("turn.started", { turnId: 1 });
	persistence.append("user.message_added", { text: "hello" });
	persistence.append("assistant.message_added", { text: "Hi!", toolCalls: [] });
	persistence.append("turn.ended", { interrupted: false });
	persistence.commit();

	// -- generation 2: exclusivity while open --------------------------------
	console.log("\n-- while gen 2 is open, a second writer must fail --");
	persistence.openForWrite();
	persistence.append("turn.started", { turnId: 2 });
	persistence.append("user.message_added", { text: "do the thing" });
	persistence.append("assistant.message_added", { text: "On it.", toolCalls: ["call_x"] });
	try {
		new SessionPersistence("demo", sharedDir).openForWrite(); // same disk, lock taken
	} catch (err) {
		console.log(`  \x1b[31m✗ ${(err as Error).message}\x1b[0m`);
	}

	// -- the crash: no commit, lock evaporates with the process --------------
	console.log("\n-- process crashes - gen 2 left uncommitted, turn 2 mid-flight --");
	console.log("  \x1b[31m✗ crash! (no commit; real flock releases with the dying process)\x1b[0m");
	persistence.simulateCrashCleanup(); // release OS lock the way a dead process would

	// -- recovery: a fresh process opens and repairs --------------------------
	console.log("\n-- recovery: reopen and repair --");
	const recovery = new SessionPersistence("recovery", sharedDir);
	for (const action of recovery.repair()) console.log(`  \x1b[32m✓ ${action}\x1b[0m`);

	console.log("\n\x1b[1m--- final state on disk ---\x1b[0m");
	recovery.inspect();

	console.log("\nCommitted generations never changed. The crash was repaired with synthetic closers,");
	console.log("and the s04 invariant still holds: every request re-derives from this log.");
}

try {
	main();
} catch (err) {
	console.error(err);
	process.exit(1);
}
