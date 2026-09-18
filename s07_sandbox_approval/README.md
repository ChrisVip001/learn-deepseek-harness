# s07: Sandbox & Approval — Fail Closed, Escalate Once

[English](README.md) · [中文](README.zh.md)

[s06](../s06_capability_seams/) → `s07` → [s08](../s08_shadow_compaction/) → ... → s10
> *"Fail closed, escalate once."* — Mode-based sandbox decisions, an approval waterfall where silence never means yes, and elevation that expires after a single shot.

---

## The Problem

"Ask the user before dangerous things" is not a design. Questions multiply: ask before *every* write, or only outside the workspace? What if no one is around to answer — does the agent proceed (fail-open) or stop (fail-closed)? After one approval, is the agent now trusted forever?

Safety lives or dies on these defaults. dsh's answer is explicit: **the sandbox denies; approval is the only door; the door is closed by construction.**

## The Solution

Three mechanisms, layered:

```
1. Sandbox modes   read-only | workspace-write | danger-full-access
                   (enforced by real OS sandboxes: Landlock / Seatbelt / restricted tokens)
2. Approval        ctx.approval.request(justification) -> answerer waterfall
                   zero answerers (or all abstain) => DENY
3. Elevation       a denied call may retry ONCE after explicit approval,
                   then the sandbox snaps back to its mode
```

## How It Works

**Step 1 — mode-based checks.** The `Sandbox` decides from the mode + target: reads are free; workspace writes pass in `workspace-write`; outside writes and network commands are denied **with an escalation hint** — including a ready-made `justification` string, because a denial without a way to ask is a dead end.

**Step 2 — the waterfall.** `ApprovalService` walks registered answerers in order; the first non-abstaining verdict wins. The demo has two: a `sessionPolicy` that allows build-output paths, and a `humanStandIn` for everything else. Answerers can specialize — the session policy abstains on network, the human layer takes it.

**Step 3 — fail-closed by construction.** No answerer registered? All abstain? **Deny.** Silence can never mean yes. This is the single most important line of the chapter.

**Step 4 — one-shot elevation.** A granted approval constructs a `danger-full-access` sandbox *for exactly one operation*, then the executor continues under the original mode. The demo shows a second outside write being denied again after the first grant was used.

## In Real dsh

| Course concept | Real location |
|---|---|
| Sandbox modes + real OS backends (Linux bwrap/Landlock, macOS Seatbelt, Windows ACL) | `packages/sandbox/sandbox-local/`, `sandbox-windows-acl/` + `docs/subsystems/sandbox.md` |
| Shared policy family consumed by fs/subprocess/ptc | `packages/sandbox/sandbox-policy/` (`ctx.sandboxPolicy`) |
| Approval service + answerer waterfall | `packages/interaction/user-approval/` |
| Permission presets (mode + policy as one selector) | `packages/interaction/permission-presets/` |
| One-shot elevation orchestration | `docs/subsystems/approval.md` |
| Native primitives (landlock-run launcher) | `native/system/` |
| Top-level responsibility statement | `SAFETY.md` — "not a security boundary for untrusted workloads" |

## Try It

```sh
node s07_sandbox_approval/code.ts
```

Six operations, a full decision ledger: ① free read, ② workspace write allowed, ③ outside write → escalation → `sessionPolicy` grants → **one elevated write**, sandbox snaps back, ④ `/etc/hosts` → escalation → human layer denies, ⑤ `curl` → granted once (network), ⑥ `nc` → this time nobody grants. Then the fail-closed epilogue: an approval service with zero answerers denies everything, by name.

## What's Next

Contexts fill up — and compaction must not corrupt the append-only log. s08 builds dsh's shadow compaction: prune tool results first, then summarize, all as *new events* that shadow old ones without ever rewriting history.
