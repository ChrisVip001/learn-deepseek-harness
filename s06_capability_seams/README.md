# s06: Capability Seams — Define the Seam, Swap the World

[English](README.md) · [中文](README.zh.md)

[s05](../s05_generation_files/) → `s06` → [s07](../s07_sandbox_approval/) → ... → s10
> *"Define the seam, swap the world."* — Filesystem, shell, terminal, SSH: every power lives behind an interface with three roles. Point the seams at a remote machine and the whole agent moves — tools never notice.

---

## The Problem

Agent tools hard-code their environment: `fs.readFile("/workspace/x")`, `child_process.exec(...)` — always the local machine. Now the requirements arrive: run the agent against a **remote build host**, a **container**, a **cloud sandbox**. The naive fix forks every tool (`read_file_remote`, `bash_remote`) — doubling maintenance and halving trust.

## The Solution

dsh's `docs/capability-seams.md` (55KB!) formalizes each power as a seam with **three roles**:

```
Service Definition   the interface + its key       "what exists"
Service Provider     a registered implementation    "who serves it"  <- swappable
Consumer             a model-facing tool            "who uses it"    <- world-blind
```

And one more rule with outsized consequences: file decisions are made by a **shared policy family** (`ctx.sandboxPolicy`), consumed by *every* file-touching capability — fs, subprocess, PTC. Policy is not per-tool duct tape; it is one decision point, enforced identically in every world.

## How It Works

**Step 1 — define the seams.** `FsSeam` and `ShellSeam` are plain interfaces plus service keys. Nothing about them mentions local or remote.

**Step 2 — build providers.** `createLocalWorld()` serves real files and a real shell from a temp dir; `createRemoteWorld()` simulates a build host with its own virtual filesystem and an ssh-flavored exec. Both satisfy the same interfaces.

**Step 3 — assemble from config.** `assembleWorld("local" | "remote")` picks providers and registers them under the seam keys. This is a dsh deployment decision, not a code change.

**Step 4 — consumers stay world-blind.** `read_file` / `write_file` / `bash` consume the seams. The scripted model issues **identical calls** in both worlds — and the outputs genuinely differ, because different worlds answered.

**Step 5 — the shared policy fires everywhere.** `read_file("/etc/shadow")` is denied identically in both worlds by the same `WorkspacePolicy` — the tools never each had to "remember" to check.

## In Real dsh

| Course concept | Real location |
|---|---|
| The full seam catalog (55KB of doctrine) | `docs/capability-seams.md` |
| fs seam + sandboxed fs provider | `packages/fs/` + `docs/subsystems/filesystem.md` |
| shell / subprocess / PTY seams | `packages/shell/`, `packages/subprocess/`, `packages/terminal/` |
| SSH as just another world | `packages/ssh/` |
| Shared policy family | `packages/sandbox/sandbox-policy/` (`ctx.sandboxPolicy`) |
| Whole-capability replacement (remote executor) | `packages/e2b/` |
| LSP behind a seam | `packages/lsp/` |

## Try It

```sh
node s06_capability_seams/code.ts
```

The same four tool calls run twice. Local world: real files, real `ls` output. Remote world: `deploy.log`, `build-host-07`, ssh flavor — same tool code. And in **both** worlds, `/etc/shadow` dies at the shared policy. That is the whole trick: swap providers, never consumers.

## What's Next

Seams route powers; they don't bound them. s07 adds the enforcement layer: sandbox modes, fail-closed approval, and one-shot elevation.
