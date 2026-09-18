# s10: Deterministic Replay — Record Once, Replay Forever

[English](README.md) · [中文](README.zh.md)

[s09](../s09_ptc_mode/) → `s10` (end)
> *"Record once, replay forever."* — A committed session JSONL is both the replay input and the expected output. No API key, no network, no flake — in CI forever.

---

## The Problem

How do you test an agent? Live LLM calls are slow, expensive, and non-deterministic — the same prompt returns different tool calls on every run. Mocking the model by hand loses the thing you actually want to test: the *whole session*, persistence included, exactly as it happened.

## The Solution

dsh turns the s04 invariant into a testing strategy. Since every request is reconstructable from the log, a **recorded session** can be replayed end-to-end — and the replayed persistence output must match the recording byte-for-byte:

```
record:  run session -> event log -> SCRUB volatile fields -> snapshot file
replay:  fresh run -> scrub -> line-diff against snapshot
pass:    byte-identical        fail: first differing line printed
```

Scrubbing is the key discipline: volatile periphery (session ids, timestamps, temp paths) becomes **typed tokens** (`<SESSION_ID>`, `<TIMESTAMP>`, `<TMPDIR>`) — exactly what `snapshots/AGENTS.md` prescribes: identity replaced by typed tokens, system prompts and tool schemas tokenized, `workspace.expected/` as a separate oracle.

## How It Works

**Step 1 — determinism rules.** No unseeded randomness, no wall-clock in logic paths (scrub what remains), stable iteration order. The session runner in this chapter is deterministic *except* its deliberate periphery — which is precisely the part scrubbing removes.

**Step 2 — record.** One run produces the event log; scrubbing normalizes it; the snapshot file becomes the expectation.

**Step 3 — replay.** A fresh run, scrubbed identically, is diffed line by line. Green means: same tools fired, same order, same outputs, same persistence shape.

**Step 4 — regression capture.** One character changes in a tool output (`beta` → `betA`) — the replay fails and prints the exact line. In real dsh, `pnpm run test:snapshot` runs 100+ such scenarios: fs-edit, ptc-turn, subagent-*, compaction-recovery, hook-cc-*…

**Why it's cheap.** The replay never calls a model: the recorded log *is* the model's behavior. That's the payoff of s04 — "model-visible means logged" makes the log sufficient to reproduce everything.

## In Real dsh

| Course concept | Real location |
|---|---|
| Snapshot doctrine (roles, scrubbing, naming) | `snapshots/AGENTS.md` |
| 100+ recorded scenarios | `snapshots/session/` (fs-edit, ptc-turn, subagent-*, ralph-loop, compaction-recovery…) |
| Profile-specific snapshot surfaces | `snapshots/sdk/`, `snapshots/web/`, `snapshots/acp/` |
| The replay test command | `pnpm run test:snapshot` (no key required) |
| LLM mock infrastructure for live-ish tests | `packages/test-support/` |
| Performance budgets (a different kind of gate) | `benchmarks/` + `BENCHMARK.md` |
| Session format guarantees behind replay | `packages/session/session-format*/` (adjacent migration chain) |

## Try It

```sh
node s10_deterministic_replay/code.ts
```

Watch the record pass (scrubbed snapshot printed), then replay #1 pass byte-identical, then replay #2 fail on exactly one line — the `betA` regression, caught by a test that costs zero API tokens and runs in milliseconds.

## What's Next

You have rebuilt dsh's architecture from first principles: composition runtime → loop as plugin → tool pipeline → event-sourced sessions → generation files → capability seams → sandbox & approval → shadow compaction → PTC → deterministic replay.

- **Read the real doctrine.** `docs/architecture.md`, then `docs/capability-seams.md`, then the `cordis-tutorial/` series.
- **Run the real thing.** `npx @deepseek-ai/dsh web` — and try the Python SDK (`python/sdk/`) to drive sessions programmatically.
- **Compare all three courses.** Claude Code builds mechanisms in; pi pushes them into extensions; dsh composes them from plugins with an event-sourced memory. Three philosophies, one loop — and you've now read all three.

**No privileged core. The model will do the rest.**
