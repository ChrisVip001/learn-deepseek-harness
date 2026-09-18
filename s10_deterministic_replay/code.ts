#!/usr/bin/env node
/**
 * s10_deterministic_replay.ts - Record Once, Replay Forever
 *
 * dsh's snapshots/ directory holds 100+ recorded sessions. The rule
 * (snapshots/AGENTS.md): a committed session JSONL is BOTH the replay
 * input AND the expected persistence output. `pnpm run test:snapshot`
 * replays every scenario with NO API key and diffs the results.
 *
 * The mechanics this chapter builds:
 *
 *   record  run a session -> event log -> SCRUB volatile fields
 *           (timestamps, ids, temp paths -> typed tokens like <TIMESTAMP>)
 *           -> write snapshot file (the expectation)
 *   replay  run the session AGAIN, fresh -> scrub -> byte-diff vs snapshot
 *   regress a one-character change in a tool output -> replay FAILS,
 *           first differing line shown
 *
 * Determinism rules: no unseeded randomness, no wall-clock in logic paths
 * (or scrub it), stable iteration order - same rules as snapshots/AGENTS.md.
 *
 * Usage: node s10_deterministic_replay/code.ts   (offline, deterministic)
 */

import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Event = { seq: number; type: string; data: Record<string, unknown> };

// ---------------------------------------------------------------------------
// 1. A session runner: deterministic logic, volatile periphery
// ---------------------------------------------------------------------------

function runSession(opts: { buggy?: boolean } = {}): Event[] {
	const sessionId = `sess-${Math.floor(Math.random() * 1e9)}`; // volatile!
	const startedAt = new Date().toISOString(); // volatile!
	const workspace = mkdtempSync(join(tmpdir(), "mini-dsh-s10-")); // volatile!
	const events: Event[] = [];
	let seq = 0;
	const add = (type: string, data: Record<string, unknown>): void => {
		events.push({ seq: ++seq, type, data });
	};

	add("session.started", { sessionId, startedAt, workspace });
	add("user.message_added", { text: "List the files and summarize." });
	add("assistant.message_added", { text: "Listing.", toolCalls: ["c1"] });
	add("tool.result_added", {
		toolCallId: "c1",
		content: opts.buggy ? "alpha betA" : "alpha beta", // the regression
	});
	add("assistant.message_added", { text: "Two entries: alpha and beta.", toolCalls: [] });
	add("session.ended", { reason: "completed" });
	return events;
}

// ---------------------------------------------------------------------------
// 2. Scrubbing: volatile fields become typed tokens
// ---------------------------------------------------------------------------

function scrub(events: Event[]): string[] {
	return events.map((e) =>
		JSON.stringify(e, (key, value) => {
			const s = String(value);
			if (key === "sessionId") return "<SESSION_ID>";
			if (key === "startedAt") return "<TIMESTAMP>";
			if (s.includes("mini-dsh-s10-")) return "<TMPDIR>";
			return value;
		}),
	);
}

// ---------------------------------------------------------------------------
// 3. Record / replay / diff
// ---------------------------------------------------------------------------

function record(): string {
	const snapshotDir = mkdtempSync(join(tmpdir(), "mini-dsh-s10-snap-"));
	const snapshotFile = join(snapshotDir, "session.snapshot.jsonl");
	writeFileSync(snapshotFile, `${scrub(runSession()).join("\n")}\n`);
	return snapshotFile;
}

function replay(snapshotFile: string, opts: { buggy?: boolean }): { ok: boolean; firstDiff?: string } {
	const expected = readFileSync(snapshotFile, "utf8").split("\n").filter(Boolean);
	const actual = scrub(runSession(opts));
	for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
		if (expected[i] !== actual[i]) {
			return {
				ok: false,
				firstDiff: `line ${i + 1}\n    expected: ${expected[i] ?? "(missing)"}\n    actual:   ${actual[i] ?? "(extra)"}`,
			};
		}
	}
	return { ok: true };
}

// ---------------------------------------------------------------------------
// 4. Demo: green replay, then a one-character regression caught red-handed
// ---------------------------------------------------------------------------

function main() {
	console.log("s10: Deterministic Replay\n");

	// -- record once ----------------------------------------------------------
	const snapshotFile = record();
	console.log(`\x1b[32m[record]\x1b[0m session recorded -> ${snapshotFile.split("/").pop()}`);
	console.log("  scrubbed: <SESSION_ID>, <TIMESTAMP>, <TMPDIR> - volatile fields become typed tokens\n");
	console.log("  snapshot content:");
	for (const line of readFileSync(snapshotFile, "utf8").trim().split("\n")) {
		console.log(`    \x1b[2m${line.slice(0, 100)}\x1b[0m`);
	}

	// -- replay: identical run, no LLM key, byte-diff --------------------------
	console.log(`\n\x1b[1m[replay #1]\x1b[0m fresh run, scrubbed, diffed against the snapshot`);
	const r1 = replay(snapshotFile);
	console.log(`  ${r1.ok ? "\x1b[32m✓ PASS - byte-identical\x1b[0m" : "\x1b[31m✗ FAIL\x1b[0m"}`);

	console.log(`\n\x1b[1m[replay #2]\x1b[0m a one-character regression sneaks into a tool output`);
	const r2 = replay(snapshotFile, { buggy: true });
	if (!r2.ok) {
		console.log(`  \x1b[31m✗ FAIL\x1b[0m`);
		console.log(`    \x1b[31m${r2.firstDiff}\x1b[0m`);
	}

	console.log("\nWhy this matters:");
	console.log("  - the snapshot needs NO api key, NO network, NO wall-clock - it runs in CI forever");
	console.log("  - the event log is simultaneously the INPUT and the EXPECTED OUTPUT");
	console.log("  - dsh ships 100+ such scenarios: fs-edit, ptc-turn, subagent, compaction-recovery...");
	console.log("    (snapshots/ + `pnpm run test:snapshot`)");
}

main();
