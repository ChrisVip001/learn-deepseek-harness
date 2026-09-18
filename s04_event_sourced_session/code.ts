#!/usr/bin/env node
/**
 * s04_event_sourced_session.ts - Model-Visible Means Logged
 *
 * dsh's core invariant (AGENTS.md / docs/architecture.md):
 *
 *   ANYTHING that enters a model request MUST be reconstructable from the
 *   session log. There are no side channels. If a message reached the
 *   model without being an event, that is a BUG - and the runtime can
 *   prove it, because every request is hashed against the log.
 *
 * This chapter builds:
 *   - an append-only SessionEvent log (typed event map, frozen events)
 *   - deriveMessages(): the projection from events -> model request
 *   - the invariant checker: for every logged request, recompute the
 *     projection from the log prefix and compare hashes
 *   - a tamper demo: one unlogged mutation is caught immediately
 *
 * Usage: node s04_event_sourced_session/code.ts   (offline, deterministic)
 */

// ---------------------------------------------------------------------------
// 1. The typed event vocabulary (declaration-merged style map)
// ---------------------------------------------------------------------------

interface SessionEventMap {
	"turn.started": { turnId: number };
	"user.message_added": { text: string };
	"assistant.message_added": { text: string; toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> };
	"tool.result_added": { toolCallId: string; content: string };
	"request.prepared": { hash: string }; // proof: what the model is about to see
}

type SessionEvent = {
	[key in keyof SessionEventMap]: { seq: number; type: key; data: SessionEventMap[key] };
}[keyof SessionEventMap];

// ---------------------------------------------------------------------------
// 2. The append-only log: events are frozen the moment they land
// ---------------------------------------------------------------------------

class SessionLog {
	private events: SessionEvent[] = [];
	private seq = 0;

	append<K extends keyof SessionEventMap>(type: K, data: SessionEventMap[K]): SessionEvent {
		const event = Object.freeze({ seq: ++this.seq, type, data }) as SessionEvent;
		this.events.push(event);
		return event;
	}

	slice(prefixLength: number): SessionEvent[] {
		return this.events.slice(0, prefixLength);
	}

	get length(): number {
		return this.events.length;
	}

	/** Read-only view - the log itself is never exposed for mutation. */
	readonly view: readonly SessionEvent[] = this.events;
}

// ---------------------------------------------------------------------------
// 3. deriveMessages: the single projection the request assembles from
// ---------------------------------------------------------------------------

type ModelMessage = { role: "user" | "assistant" | "toolResult"; content: string };

function deriveMessages(events: SessionEvent[]): ModelMessage[] {
	const messages: ModelMessage[] = [];
	for (const event of events) {
		switch (event.type) {
			case "user.message_added":
				messages.push({ role: "user", content: event.data.text });
				break;
			case "assistant.message_added": {
				const calls = event.data.toolCalls.map((c) => `[${c.name}]`).join(" ");
				messages.push({ role: "assistant", content: `${event.data.text}${calls ? ` ${calls}` : ""}` });
				break;
			}
			case "tool.result_added": {
				const paired = messages.some((m) => m.role === "assistant" && m.content.includes(`[${event.data.toolCallId}]`));
				messages.push({ role: "toolResult", content: paired ? event.data.content : `${event.data.content} (orphan!)` });
				break;
			}
			default:
				break; // turn.started / request.prepared are metadata, not model-visible
		}
	}
	return messages;
}

function hash(messages: ModelMessage[]): string {
	let h = 2166136261;
	const s = JSON.stringify(messages);
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0).toString(16);
}

// ---------------------------------------------------------------------------
// 4. The invariant checker: every logged request must re-derive from the log
// ---------------------------------------------------------------------------

function checkInvariant(events: SessionEvent[]): Array<{ seq: number; ok: boolean; detail: string }> {
	const report: Array<{ seq: number; ok: boolean; detail: string }> = [];
	for (let i = 0; i < events.length; i++) {
		const event = events[i]!;
		if (event.type !== "request.prepared") continue;
		const recomputed = hash(deriveMessages(events.slice(0, i))); // log prefix BEFORE this proof
		const ok = recomputed === event.data.hash;
		report.push({
			seq: event.seq,
			ok,
			detail: ok ? `request #${event.seq} rebuilt from log prefix ✓` : `request #${event.seq} MISMATCH: logged ${event.data.hash} vs derived ${recomputed}`,
		});
	}
	return report;
}

// ---------------------------------------------------------------------------
// 5. A mini session: the loop logs EVERYTHING it shows the model
// ---------------------------------------------------------------------------

function main() {
	console.log("s04: Event-Sourced Session\n");
	const log = new SessionLog();

	// The loop's contract: prepare request -> hash it -> LOG the proof -> send.
	const prepare = (label: string): void => {
		const messages = deriveMessages(log.view as SessionEvent[]);
		log.append("request.prepared", { hash: hash(messages) });
		console.log(`  \x1b[2m${label}: request = ${messages.length} messages (hash ${log.view.at(-1)!.data.hash})\x1b[0m`);
	};

	log.append("turn.started", { turnId: 1 });
	log.append("user.message_added", { text: "What's in the workspace?" });
	prepare("turn 1 request 1");

	log.append("assistant.message_added", { text: "Checking.", toolCalls: [{ id: "c1", name: "bash", arguments: { command: "ls" } }] });
	log.append("tool.result_added", { toolCallId: "c1", content: "a.txt b.txt" });
	prepare("turn 1 request 2");

	log.append("assistant.message_added", { text: "Two files: a.txt and b.txt.", toolCalls: [] });

	// -- the invariant holds --------------------------------------------------
	console.log("\n\x1b[1m--- invariant check (honest session) ---\x1b[0m");
	for (const row of checkInvariant(log.view as SessionEvent[])) {
		console.log(`  ${row.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${row.detail}`);
	}

	// -- tamper: someone delivers a message WITHOUT logging it ----------------
	console.log("\n\x1b[1m--- tamper demo: an unlogged mutation ---\x1b[0m");
	const tampered = (log.view as SessionEvent[]).filter((e) => e.type !== "tool.result_added"); // sneaky!
	console.log("  (a tool result reached the model but was never logged as an event)");
	for (const row of checkInvariant(tampered)) {
		console.log(`  ${row.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${row.detail}`);
	}

	console.log("\nThe second request no longer re-derives: the runtime can PROVE a side channel exists.");
	console.log("In real dsh this is not a test - it is a runtime invariant, asserted on every request.");
	console.log(`\nlog: ${log.length} events, append-only, frozen - fork/resume/telemetry all derive from these.`);
}

main();
