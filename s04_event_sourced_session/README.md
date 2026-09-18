# s04: Event-Sourced Session — Model-Visible Means Logged

[English](README.md) · [中文](README.zh.md)

[s03](../s03_tool_pipeline/) → `s04` → [s05](../s05_generation_files/) → ... → s10
> *"Model-visible means logged."* — Anything that enters a model request must be reconstructable from the session log. No side channels, ever — and the runtime can prove it.

---

## The Problem

Agent runtimes accumulate state in a dozen places: a messages array here, a tool-results cache there, a "system reminder" injected directly into the request. Then comes the day you need to answer: *what exactly did the model see?* — to debug a bad turn, to resume a session, to replay for tests, to audit an incident. If state lives in scattered mutable objects, the honest answer is "nobody knows".

## The Solution

dsh's answer is strict event sourcing with a runtime-enforced invariant:

```
SessionEvent (append-only, frozen)  ──deriveMessages()──►  model request
        ▲                                                     │
        └───────────── every request logs a hash proof ───────┘
```

- The **log** is the only source of truth: append-only, frozen on write, typed (`SessionEventMap`).
- The **request** is always a *projection* (`deriveMessages`), never a mutated object.
- Every prepared request logs a **hash proof** (`request.prepared`). The checker recomputes the projection from the log prefix and compares — any unlogged mutation is mathematically detectable.

This one invariant is what makes dsh's fork, resume, transcript export, telemetry, and — s10's — deterministic replay all *derive* rather than *re-implement*.

## How It Works

**Step 1 — typed events.** `SessionEventMap` maps event names to payloads; unknown event types are rejected unless marked ignorable — forward-compatibility without silent corruption.

**Step 2 — frozen on append.** `Object.freeze` at write time. The log exposes only a read-only view; there is no API to "edit history".

**Step 3 — the single projection.** `deriveMessages` walks events and builds model messages. It is the *only* function that turns log into request — no second code path can drift.

**Step 4 — the proof.** Before sending, the loop logs `request.prepared { hash }` where hash = H(deriveMessages(logPrefix)). The checker recomputes from the prefix. Honest session: both hashes match. Tampered session (a tool result delivered but never logged): mismatch — the runtime has *proven* a side channel exists.

## In Real dsh

| Course concept | Real location |
|---|---|
| Append-only session log (`ctx.sessions`) | `packages/core/session/` |
| Typed events via declaration merging (`SessionEventMap`) | `packages/core/session/` — unknown types rejected unless `ignorable` |
| `deriveMessages` projection | `packages/core/session/` |
| The invariant (asserted, not just tested) | `packages/core/agent-loop/src/invariant.ts` + `AGENTS.md` ("Model-visible ⟺ logged") |
| Projections & incremental folding | `packages/session/session-projection/` (+ cache: `session-projection-cache/`) |
| Subsystems doc | `docs/subsystems/session.md` (69KB) |

## Try It

```sh
node s04_event_sourced_session/code.ts
```

Watch the session build event by event with a request proof after each model call. The honest invariant check passes twice. Then the tamper demo deletes one `tool.result_added` event — the second request's hash no longer re-derives and the checker flags it in red. That red flag is dsh's architecture working as designed.

## What's Next

The log lives in memory and dies with the process. s05 persists it to **generation files** — versioned, immutable once committed, exclusively locked, with crash repair for turns that died mid-flight.
