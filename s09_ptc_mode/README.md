# s09: PTC Mode — Code Is the Tool-Calling Protocol

[English](README.md) · [中文](README.zh.md)

[s08](../s08_shadow_compaction/) → `s09` → [s10](../s10_deterministic_replay/) → s10
> *"Code is the tool-calling protocol."* — The model writes a program against a generated SDK; one round-trip replaces many; intermediates cost zero tokens.

---

## The Problem

Native tool-calling has a structural tax:

- Every request carries **every tool schema** — dozens of tools means kilobytes of JSON repeated forever.
- Multi-step work costs a **round-trip per call**: list files, then read, then search — each waiting for the model to emit the next block.
- Intermediate values that the model never needs still flow through the conversation as tool results, paying tokens.

## The Solution

PTC (Program-Tooled-Code) is dsh's second tool-consumption path — alongside native blocks, not instead of them:

```
model sees:   ONE transport tool  run_code { code, justification? }
runtime:      a TypeScript SDK GENERATED from the visible tool schemas
execution:    the model's program calls SDK functions -> SAME s03 pipeline
visible:      only console output + return value enter the conversation
```

A tool declared `mode: native | ptc | both` chooses which paths expose it.

## How It Works

**Step 1 — generate the SDK.** From the visible tool schemas, `generateSdkSource` emits typed declarations (`bash(command: string): Promise<string>`). The model reads the SDK, not dozens of schema blobs.

**Step 2 — execute the program.** `runCode` compiles the program with `new Function`, injecting the SDK runtime and a capturing console. The program is plain async JavaScript — so **`Promise.all` parallelism is just JavaScript**, no special protocol.

**Step 3 — the pipeline still rules.** SDK functions route through the exact same execution pipeline as native calls. The demo's program calls `bash("rm -rf /")` — and dies at the policy exactly as a native call would. PTC is a transport change, not a bypass.

**Step 4 — wide permissions need justification.** A program declaring wide `sandbox_permissions` without a non-empty `justification` is rejected; with one, it goes to approval (fail-closed, s07).

**Step 5 — token economics.** Schema cost: N tools (~40 tokens in the demo) vs 1 transport (~8). Round-trips: N+1 vs 1. Intermediates: SDK results live inside the program and cost **zero tokens** unless printed.

## In Real dsh

| Course concept | Real location |
|---|---|
| PTC bridge on the tool runtime | `packages/core/tools/src/ptc.ts` |
| Generated TS/Python SDK from tool schemas | `packages/core/tools/src/ts-types.ts`, `py-types.ts` |
| Sandboxed program execution | `packages/ptc-runtime/ptc-runtime-node/` (+ experimental CPython backend) |
| `justification` + approval for wide permissions | `docs/subsystems/ptc-runtime.md`, `docs/subsystems/approval.md` |
| Per-tool mode (`native | ptc | both`) | `packages/core/tools/src/schema.ts` |
| Snapshot coverage of PTC turns | `snapshots/session/` (ptc-turn scenarios) |

## Try It

```sh
node s09_ptc_mode/code.ts
```

Read the generated SDK, then compare the two modes' ledgers: native (3 schemas in every request, 4 round-trips) vs PTC (1 schema, 1 round-trip). The demo program runs three calls — including parallel-friendly code — and the model sees only the captured output. Then watch the safety check fire *inside* the program.

## What's Next

Every chapter so far ran against a scripted LLM — free and deterministic. dsh turns that property into its testing strategy: **recorded sessions that replay as test suites**. s10 builds the replay harness.
