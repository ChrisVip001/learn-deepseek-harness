# s03: Tool Pipeline — One Pipeline, Five Gates

[English](README.md) · [中文](README.zh.md)

[s02](../s02_loop_as_plugin/) → `s03` → [s04](../s04_event_sourced_session/) → ... → s10
> *"One pipeline, five gates."* — Every tool call crosses the same fixed pipeline; policy lives in plugins; guards are final; bad arguments are just error results.

---

## The Problem

s02's loop executed tools with a bare name lookup. Consequences: model arguments hit handlers unvalidated; every safety policy must be invented per-tool; nothing can inspect or normalize results; a slow tool hangs the turn forever.

What's needed is not "a permission system" — it's a **fixed pipeline** with well-defined gates, so policy authors hook in at the right place instead of patching handlers.

## The Solution

dsh's tool execution pipeline (`docs/tool-execution-pipeline.md`):

```
1. tools/pre-execute    extensible waterfall: allow / deny / ask
2. monotonic guard      ctx.tools.guard(fn) - AFTER pre-execute, deny-only, final
3. tools/execute        wrapped dispatch: schema check, timeout, retry
4. tools/post-execute   inspect / replace the result
5. tools/result         read-only notification
```

Two subtle rules make this pipeline trustworthy:

- **deny > ask > allow.** Multiple pre-execute listeners each cast a decision; a single deny wins, an ask survives only if nobody denied.
- **Guards are monotonic.** A guard runs *after* the extensible waterfall and **cannot be overturned** — a deployment-level "credentials are off-limits" cannot be undone by a plugin returning "allow".

## How It Works

**Gate 1 — the waterfall.** Each listener inspects `{name, arguments}` and returns a decision or nothing. This is where "deny `rm -rf`" and "ask before network access" live — as ordinary plugins.

**The ask branch.** `ask` delegates to the approval service. In the demo the headless answerer denies anything matching /network/i. (s07 builds the full fail-closed approval semantics.)

**Gate 2 — the guard.** `rt.guard(fn)` returns a denial reason or null. In the demo, `secret_read` sails through every pre-execute listener — and still dies at the guard. Policy layering: extensible judgment first, inviolable deployment rules second.

**Gate 3 — wrapped execution.** Schema check first (missing/wrong-typed arguments → error result, turn continues — the model can correct itself). Then the handler runs under a timeout via `Promise.race`. `slow_task` (500ms work, 100ms budget) dies cleanly instead of hanging the turn.

**Gates 4+5 — result shaping.** post-execute listeners may replace the result (the audit plugin appends `(exit=0)` to bash output); the result event is read-only. Note what the model never sees: `execute`, timeouts, guards — only the projected schema (`schemasForModel`).

## In Real dsh

| Course concept | Real location |
|---|---|
| `ToolRuntime` service, registration, restriction masks | `packages/core/tools/src/index.ts` |
| `defineTool` DSL + typed schema inference | `packages/core/tools/src/schema.ts` |
| `tools/pre-execute` / `execute` / `post-execute` / `result` events | `packages/core/tools/src/index.ts` (typed event map) |
| Monotonic guards | `ctx.tools.guard()` — "once denied, cannot be overturned" |
| Pipeline stage invariants (stage ordering checked at runtime) | `packages/core/tools/src/invariant.ts` |
| Full visual walkthrough | `docs/tool-execution-pipeline.md` |
| Tool catalog (generated, 91KB) | `docs/tool-catalog.md` |
| Cookbook: adding a tool | `docs/cookbook/adding-a-tool.md` |

## Try It

```sh
node s03_tool_pipeline/code.ts
```

Six scripted calls, six outcomes: ① `ls` executes and comes back post-enriched with `(exit=0)`. ② `rm -rf` denied at pre-execute. ③ `curl` asked → approval says no. ④ `secret_read` passes every listener — the **guard** kills it. ⑤ `slow_task` hits the timeout. ⑥ `write_file` with a missing argument fails schema validation *before* any handler runs. The trace at the end shows exactly which gates each call crossed.

## What's Next

Every result so far lived in memory. dsh's central invariant — *model-visible means logged* — requires that any request ever sent to a model can be rebuilt from a durable log. s04 builds the event-sourced session.
