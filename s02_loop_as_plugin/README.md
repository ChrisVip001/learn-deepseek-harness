# s02: Loop as Plugin — Even the Loop Is a Plugin

[English](README.md) · [中文](README.zh.md)

[s01](../s01_composition_runtime/) → `s02` → [s03](../s03_tool_pipeline/) → ... → s10
> *"Even the loop is a plugin."* — The default agent loop registers itself on a service registry; consumers resolve it by id; swapping it is a config line.

---

## The Problem

In most frameworks the agent loop is the one piece you cannot touch. It imports your tools, owns your state machine, and hard-codes when a conversation starts, continues, and ends. Want a step cap? A different stopping policy? Patch the loop — and become the maintainer of the framework's most dangerous file.

dsh's answer follows directly from s01: if every contribution is a reversible side effect, the loop can be one too.

## The Solution

```
core plugin      provides  ctx.agents (AgentRegistry)
llm plugin       provides  ctx.llm     (faux, scripted)
tools plugin     provides  ctx.tools
react-loop-v1    registers AgentFactory "react-loop-v1" on ctx.agents
goal-guard       listens  "turn/stopping" -> vetoes when artifact missing
react-loop-v2    registers "react-loop-v2" (wraps v1 with a step cap)

consumer: resolve(CONFIG.agent)  <- never imports any loop
```

Two vocabulary words carry the chapter (from `docs/architecture.md`):

- **step** = one model request + the tool calls it made
- **turn** = zero or more steps; it continues while tools still owe work, and it may only stop through the serial **`turn/stopping`** event — which listeners can veto.

## How It Works

**Step 1 — the loop registers, not exports.** `reactLoopV1Plugin` consumes `ctx.agents` and registers a factory. No consumer ever imports the loop file.

**Step 2 — steps until nothing is owed.** Each iteration: `agent/request` → LLM response → tool executions → loop again. The turn keeps going as long as tool results demand follow-up reasoning.

**Step 3 — stopping is a vetoable event.** When the model produces no tool calls, the loop emits `turn/stopping` on the plugin context *before* stopping. The `goal-guard` plugin checks whether `summary.txt` exists; it doesn't → sets `veto.flagged` → the loop continues into another step. This is how dsh's goal/plan packages keep agents on task without a hard-coded "are you sure?" in the loop.

**Step 4 — swapping is configuration.** `react-loop-v2` wraps v1's generator and adds a step cap (intercepting `step/start`). Flip `CONFIG.agent` and the same consumer code runs a different loop. In real dsh this is literally a config line in a profile.

## In Real dsh

| Course concept | Real location |
|---|---|
| Default loop plugin (`ReactLoopAgent`) | `packages/core/agent-loop/src/index.ts` + `src/agent.ts` |
| `Agent` interface + registry | `packages/core/agent/` |
| Scoped registration (per-agent services) | `packages/core/scope/` |
| Turn/step flow diagram | `docs/architecture.md` (turn flow) |
| Inbox claiming / mid-turn inputs | `packages/core/agent-loop/src/inbox.ts` |
| Serial `turn-stopping` semantics | `docs/architecture.md` — event list |
| Presets: per-session agent composition | `packages/preset/` |

Real dsh adds persistence integration (the loop is the write-handle acquisition point), KV-cache-aware request assembly, and cancellation — the registry/swap pattern is the skeleton.

## Try It

```sh
node s02_loop_as_plugin/code.ts
```

Run 1: step 1 reads the readme; step 2 produces a final text — but the guard **vetoes the stop** (`summary.txt` missing), so the turn continues; step 3 writes the file; step 4's stop is accepted. Run 2: config flipped to `react-loop-v2`, same consumer code, the step cap fires. Note the consumer file contains zero imports of any loop.

## What's Next

The loop executes tools by name lookup — but with no pipeline. Model arguments go straight into handlers; nothing can inspect, allow, deny, or transform a tool call. s03 builds dsh's five-gate execution pipeline.
