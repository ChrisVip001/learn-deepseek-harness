# s08: Shadow Compaction — Shadow the Past, Never Erase It

[English](README.md) · [中文](README.zh.md)

[s07](../s07_sandbox_approval/) → `s08` → [s09](../s09_ptc_mode/) → ... → s10
> *"Shadow the past, never erase it."* — Compaction appends shadowing events; the request projection shrinks; the log only grows.

---

## The Problem

Contexts overflow — but s04 declared the log sacred and s05 made it immutable on disk. The classic fix (rewrite history: drop old messages, splice in a summary) directly violates both. You'd have to choose: a compact context or a trustworthy log. dsh refuses the choice.

## The Solution

dsh's compaction family (`packages/compaction/`, five packages) **never rewrites anything**. It appends *shadowing* events:

```
tool.result_pruned {toolCallId, tokens}     marks an old oversized tool output
history.summarized {shadowedUpTo, summary}  shadows an entire prefix behind one summary
```

The projection (`deriveMessages`) honors shadows: shadowed events vanish from the **request** but remain byte-identical in the **log**. Replay, export, and audit still see everything.

```
tokens:  [====== 1245 ======] → prune → [=== 800 ===] → summarize → [= 350 =]
log:     always growing — history is never touched
```

## How It Works

**Step 1 — measure from the log.** The token meter derives its numbers from persisted events (replay-aware), not from live in-memory objects — so the measurement survives process restarts and matches what s04's invariant guarantees.

**Step 2 — prune cheap first.** Oversized tool outputs (the usual offenders) get marked `tool.result_pruned`. The projection replaces each with a one-line placeholder. Cheap, surgical, reversible-in-meaning.

**Step 3 — summarize what remains.** Still over budget? `history.summarized` shadows everything up to a sequence number, leaving only recent events plus the summary message.

**Step 4 — the projection is the only consumer.** Nothing else in the runtime needs to know compaction happened: sessions resume, replays run, forks branch — all from the same untouched log.

Real dsh adds a fourth family member: **image offload** — when a provider rejects a request for image-budget reasons, oversized images are swapped for placeholders *as events*, and the request is re-issued.

## In Real dsh

| Course concept | Real location |
|---|---|
| Shared compaction contracts (`ctx.compaction`) | `packages/compaction/compaction/` |
| Automatic pressure-triggered compaction | `packages/compaction/compaction-basic/` |
| Tool-result pruner (`ctx.toolResultPruner`) | `packages/compaction/compaction-tool-result-pruner/` |
| Image offload on provider rejection | `packages/compaction/compaction-image-offload/` |
| Manual `/compact` (serialized with running turns) | `packages/compaction/command-compact/` |
| Token measurement from persisted logs | `packages/llm/token-meter/` (`ctx.tokenMeter`) |
| Related: spill-to-disk for huge outputs | `packages/spill/` |
| Subsystem doc | `docs/subsystems/compaction.md` (19KB) |

## Try It

```sh
node s08_shadow_compaction/code.ts
```

A heavy session overflows a 250-token budget. Watch three snapshots: 9 messages / ~250+ tokens → pruner marks the three big outputs → summarizer shadows the prefix → the final request shows a purple summary line and pruned placeholders. Then read the full log: every original event is still there, with two purple shadow events appended. The request shrank; the log only grew.

## What's Next

Tool-calling has a hidden cost: every tool call is a separate model round-trip with its full schema overhead. s09 builds dsh's second tool-consumption path: **PTC mode**, where the model writes code against a generated SDK.
