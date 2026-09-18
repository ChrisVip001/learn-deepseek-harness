# s01: Composition Runtime — Registration Is a Side Effect

[English](README.md) · [中文](README.zh.md)

`s01` → [s02](../s02_loop_as_plugin/) → ... → s10
> *"Registration is a side effect."* — Every `ctx.on`, every `ctx.effect`, every service provision returns its own undo. Reversibility is the foundation of "no privileged core".

---

## The Problem

Imagine a plugin system where plugins can add event listeners, register services, spawn timers, and patch behavior. Now answer: **what happens when you uninstall a plugin?** In most systems the answer is nothing good — listeners leak, services dangle, timers keep firing. So plugins become immortal, and "removable" means "we never actually remove".

dsh's core claim — *everything is a plugin, even the agent loop* — is only credible if removal is safe by construction.

## The Solution

Cordis (vendored in dsh as `@deepseek-ai/cordis`) makes one big bet:

```
ctx.on(event, listener)   returns a disposer
ctx.effect(() => cleanup) registers cleanup alongside every side effect
ctx.provide(key, impl)    services are contributions, not installations
plugin = (ctx) => void | Dispose
```

A plugin is a plain function that receives a context and contributes through it. Because **every contribution carries its own undo**, the runtime can stop or swap any plugin at any time — dispose runs the accumulated cleanups in reverse order. Nothing leaks; nothing is immortal.

## How It Works

**Step 1 — listeners are disposable.** `ctx.on` returns an unlisten function *and* registers it in the context's disposer list. No separate "remember to clean up" discipline.

**Step 2 — `ctx.effect` generalizes it.** Any side effect (a timer, a file handle, a subscription) is declared as `effect(() => undoIt)`. The context collects the undos.

**Step 3 — services come and go.** `ctx.provide("logger", impl)` publishes; `ctx.consume("logger")` reads *right now* (may be `undefined`); `service:logger` events fire on appear/withdraw. Dependents **degrade gracefully** instead of crashing — this is how dsh hot-swaps capability providers.

**Step 4 — plugins get their own context.** `runtime.use(name, plugin)` creates a child context; `unload(name)` disposes it — running every disposer the plugin ever registered, in reverse.

**Step 5 — stop is just mass disposal.** Reverse order over all plugins, then the root. The runtime itself never destroys anything; it only asks each contribution to undo itself.

## In Real dsh

| Course concept | Real location |
|---|---|
| Cordis runtime (vendored) | `deepseek-harness/vendor/` |
| Tutorial series (7 parts, first plugin → composition) | `deepseek-harness/docs/cordis-tutorial/01…07` |
| Framework API reference | `docs/cordis-api/` (context/events/fiber/registry/service) |
| Profile = ordered plugin list | `docs/architecture.md` — profiles: web, headless, sdk, sdk-minimal, acp |
| Spatiotemporal composability paper | Cordis design origin, referenced in `docs/architecture.md` |

Real Cordis adds fibers (coroutine scheduling), config resolution, and HMR — the disposer discipline is the load-bearing idea.

## Try It

```sh
node s01_composition_runtime/code.ts
```

Watch the reversibility ledger: `logger` loads → greet logs; **unloading `logger`** runs its effect-cleanups and withdraws the service — the `commands` plugin is *notified* and degrades (greet still works, silently); re-installing restores logging; `runtime.stop()` disposes everything in reverse, and `metrics` prints its final report *as part of cleanup* — cleanup can be meaningful work.

## What's Next

You have a runtime where any plugin can be swapped. s02 delivers on the promise: the **agent loop itself** becomes a plugin, registered in a service registry, replaceable by another implementation — with the turn/step state machine that drives every conversation.
