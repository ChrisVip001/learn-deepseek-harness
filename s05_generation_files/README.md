# s05: Generation Files — Committed Generations Never Change

[English](README.md) · [中文](README.zh.md)

[s04](../s04_event_sourced_session/) → `s05` → [s06](../s06_capability_seams/) → ... → s10
> *"Committed generations never change."* — Sessions persist as immutable, version-named JSONL files, guarded by an exclusive write lock, with synthetic closers for turns that died mid-flight.

---

## The Problem

s04's event log is the truth — but it lives in memory. Persisting an append-only log sounds easy (just append to a file!) until the hard questions arrive:

- What if **two processes** open the same session for write?
- What if the process **crashes mid-turn** — after dispatching a tool, before logging its result?
- What if a "helpful" optimization rewrites or compacts yesterday's file — and a replica still reads it?

Naive single-file persistence answers all three badly.

## The Solution

dsh's JSONL persistence treats each writing session as a **generation**:

```
session.jsonl        gen 1  committed, immutable forever
session.v2.jsonl     gen 2  committed, immutable forever
session.v3.jsonl     gen 3  ACTIVE write target (published on open-for-write)
write.lock           exclusive flock while a writer exists
```

Rules:

1. **Open-for-write publishes a successor.** A writer never appends to a committed file; it starts a new version-named generation.
2. **One writer at a time.** An exclusive lock (a real native `flock` binding in `native/system`) rejects the second writer immediately.
3. **Commit = close.** Once committed, a generation is never renamed, overwritten, or deleted.
4. **Crash repair with synthetic closers.** An uncommitted generation with an open turn gets: a synthesized tool result (`ABORTED_BEFORE_DISPATCH`) for any dispatched-but-unresolved call, and `turn.ended{interrupted:true}`. The log stays truthful about the crash — it does not pretend the turn finished.

## How It Works

**The lock.** `acquireLock()` uses `O_EXCL` create as a stand-in for the real `flock` binding; a second writer's open throws. When a process dies, the kernel releases the real flock — the demo's `simulateCrashCleanup` mimics that.

**The repair.** `repair()` scans generations newest-first for a turn that started but never ended. Because the last generation was *never committed*, appending closers to it is legal — the immutability rule protects committed generations, not abandoned ones.

**The checkpoint discipline.** dsh's checkpoint policy guarantees that before the next action, the model request, top-level tool side effects, and completed steps are already on disk — so a crash loses nothing that the model "saw" (per s04's invariant).

## In Real dsh

| Course concept | Real location |
|---|---|
| Generation-file JSONL backend | `packages/session/session-persistence-jsonl/` |
| Persistence interface (create/open/stat/list/export) | `packages/session/session-persistence/` |
| Exclusive write via native flock | `native/system/` (`@deepseek-ai/node-addon-system`) |
| Checkpoint policy | `packages/session/session-checkpoint-policy/` |
| Interrupted-turn closers | agent layer, referenced in `docs/subsystems/persistence.md` |
| Every persisted format change logged | `docs/persistence-changes/` |
| Catalog of persistence types (generated) | `docs/persistence-catalog.md` (229KB) |

## Try It

```sh
node s05_generation_files/code.ts
```

Watch four acts: ① gen 1 commits cleanly. ② While gen 2 is open, a second writer **fails on the lock**. ③ The "process crashes" — turn 2 left mid-flight. ④ Recovery reopens, synthesizes the aborted tool result and the interrupted turn-ender, and commits. The final disk listing shows three generations — including gen 1, byte-identical to the moment it committed.

## What's Next

Every tool so far touched the *local* file system directly. dsh routes all such powers through **capability seams** — so the same agent code can run against a remote machine. s06 builds the seams.
