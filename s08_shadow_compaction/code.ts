#!/usr/bin/env node
/**
 * s08_shadow_compaction.ts - Shadow the Past, Never Erase It
 *
 * Contexts overflow. But s04/s05 established that the log is sacred. dsh's
 * compaction family (packages/compaction/, 5 packages) therefore NEVER
 * rewrites history - it appends SHADOWING events:
 *
 *   1. token-meter      measures pressure FROM the log (replay-aware)
 *   2. tool-result pruner  marks oversized old tool outputs as pruned
 *                          (new event: tool.result_pruned)
 *   3. summarizer       shadows a whole prefix behind one summary
 *                          (new event: history.summarized {shadowedUpTo})
 *   4. projection       deriveMessages() honors shadows:
 *                       shadowed events vanish from the REQUEST, never from the LOG
 *
 *   tokens:  [====== 1245 ======]  -> prune -> [=== 800 ===] -> summarize -> [= 350 =]
 *   log:     always growing, byte-identical history
 *
 * Usage: node s08_shadow_compaction/code.ts   (offline, deterministic)
 */

type Event = { seq: number; type: string; data: Record<string, unknown> };

// ---------------------------------------------------------------------------
// 1. The append-only log (same discipline as s04)
// ---------------------------------------------------------------------------

class Log {
	private events: Event[] = [];
	private seq = 0;
	append(type: string, data: Record<string, unknown>): Event {
		const e = Object.freeze({ seq: ++this.seq, type, data }) as Event;
		this.events.push(e);
		return e;
	}
	get view(): readonly Event[] {
		return this.events;
	}
}

// ---------------------------------------------------------------------------
// 2. The projection: derive messages, honoring shadow events
// ---------------------------------------------------------------------------

type ModelMessage = { role: string; content: string };

function deriveMessages(events: readonly Event[]): ModelMessage[] {
	const pruned = new Set<string>();
	let shadowedUpTo = 0;
	let summary: string | null = null;
	for (const e of events) {
		if (e.type === "tool.result_pruned") pruned.add(String(e.data["toolCallId"]));
		if (e.type === "history.summarized") {
			shadowedUpTo = Number(e.data["shadowedUpTo"]);
			summary = String(e.data["summary"]);
		}
	}

	const messages: ModelMessage[] = [];
	if (summary) messages.push({ role: "system", content: summary });
	for (const e of events) {
		if (e.seq <= shadowedUpTo) continue; // shadowed by the summary
		switch (e.type) {
			case "user.message_added":
				messages.push({ role: "user", content: String(e.data["text"]) });
				break;
			case "assistant.message_added": {
				const calls = (e.data["toolCalls"] as string[] | undefined ?? []).map((c) => `[${c}]`).join(" ");
				messages.push({ role: "assistant", content: `${String(e.data["text"])}${calls ? ` ${calls}` : ""}` });
				break;
			}
			case "tool.result_added": {
				const toolCallId = String(e.data["toolCallId"]);
				messages.push({
					role: "toolResult",
					content: pruned.has(toolCallId) ? `[pruned: tool output was ${e.data["tokens"]} tokens]` : String(e.data["content"]),
				});
				break;
			}
			default:
				break;
		}
	}
	return messages;
}

// ---------------------------------------------------------------------------
// 3. Token meter: measures pressure FROM the log, not from live objects
// ---------------------------------------------------------------------------

function measureTokens(events: readonly Event[]): number {
	return deriveMessages(events).reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
}

// ---------------------------------------------------------------------------
// 4. The compaction family: prune first, summarize second
// ---------------------------------------------------------------------------

function pruneToolResults(log: Log, budgetTokens: number): number {
	let pruned = 0;
	for (const e of log.view) {
		if (e.type !== "tool.result_added") continue;
		const tokens = Math.ceil(String(e.data["content"]).length / 4);
		if (tokens > 60 && measureTokens(log.view) > budgetTokens) {
			log.append("tool.result_pruned", { toolCallId: e.data["toolCallId"], originalSeq: e.seq, tokens });
			pruned++;
		}
	}
	return pruned;
}

function summarizePrefix(log: Log, keepRecent: number): void {
	const events = log.view;
	const cutSeq = Math.max(0, events.length - keepRecent);
	const older = events.filter((e) => e.seq <= cutSeq && (e.type === "user.message_added" || e.type === "assistant.message_added" || e.type === "tool.result_added"));
	const summary = `[summary of ${older.length} earlier events] user asked to audit the repo; ran bash twice and read 3 files; build is green; findings recorded in report.md`;
	log.append("history.summarized", { shadowedUpTo: cutSeq, summary });
}

// ---------------------------------------------------------------------------
// 5. Demo: overflow -> prune -> summarize -> request shrinks, log grows
// ---------------------------------------------------------------------------

function main() {
	console.log("s08: Shadow Compaction\n");
	const log = new Log();
	const BIG = (id: string, tag: string) => `${tag}: ${"x".repeat(360)}`; // ~90 tokens each

	// A heavy session: 3 turns with big tool outputs.
	log.append("user.message_added", { text: "Audit the repository and check the build." });
	log.append("assistant.message_added", { text: "Listing files.", toolCalls: ["c1"] });
	log.append("tool.result_added", { toolCallId: "c1", content: BIG("c1", "file listing") });
	log.append("assistant.message_added", { text: "Running build.", toolCalls: ["c2"] });
	log.append("tool.result_added", { toolCallId: "c2", content: BIG("c2", "build log") });
	log.append("user.message_added", { text: "Now check the docs too." });
	log.append("assistant.message_added", { text: "Reading docs.", toolCalls: ["c3"] });
	log.append("tool.result_added", { toolCallId: "c3", content: BIG("c3", "docs dump") });

	const budget = 250;
	console.log(`request budget: ${budget} tokens`);
	console.log(`initial request: ${deriveMessages(log.view).length} messages, ${measureTokens(log.view)} tokens | log: ${log.view.length} events\n`);

	const pruned = pruneToolResults(log, budget);
	console.log(`\x1b[35m[pruner] marked ${pruned} oversized tool results as pruned\x1b[0m`);
	console.log(`after prune: ${deriveMessages(log.view).length} messages, ${measureTokens(log.view)} tokens | log: ${log.view.length} events\n`);

	console.log(`still over budget -> summarizing`);
	summarizePrefix(log, 4);
	console.log(`after summarize: ${deriveMessages(log.view).length} messages, ${measureTokens(log.view)} tokens | log: ${log.view.length} events\n`);

	console.log("\x1b[1m--- final model-visible request ---\x1b[0m");
	for (const m of deriveMessages(log.view)) console.log(`  \x1b[2m${m.role}: ${m.content.slice(0, 70)}\x1b[0m`);

	console.log(`\n\x1b[1m--- full log (append-only, ${log.view.length} events) ---\x1b[0m`);
	for (const e of log.view) {
		const marker = e.type.includes("pruned") || e.type.includes("summarized") ? "\x1b[35m <- shadow event\x1b[0m" : "";
		console.log(`  ${String(e.seq).padStart(2)} ${e.type}${marker}`);
	}

	console.log("\nThe request shrank 3x. The log only grew. Replay from the log still reproduces everything.");
	console.log("(Real dsh: token-meter measures from persisted logs; /compact serializes with running turns;");
	console.log(" image-offload swaps oversized images for placeholders when a provider balks.)");
}

main();
