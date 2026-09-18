# s10: 确定性回放 — 录一次，永远回放

[English](README.md) · [中文](README.zh.md)

[s09](../s09_ptc_mode/) → `s10`（完）
> *"录一次，永远回放。"* —— 一份已提交的会话 JSONL 既是回放输入，又是期望输出。无 API key、无网络、无抖动——在 CI 里跑到永远。

---

## 问题

Agent 怎么测试？真实 LLM 调用又慢又贵还不确定——同一个 prompt 每次返回不同的工具调用。手工 mock 模型又会丢掉你真正想测的东西：**完整的会话**，包括持久化，按原样。

## 解决方案

dsh 把 s04 的不变量变成了测试战略。既然每个请求都能从日志重建，一段**录制的会话**就可以端到端回放——且回放出的持久化输出必须与录制逐字节一致：

```
录制：  跑会话 -> 事件日志 -> 脱敏易变字段 -> 快照文件
回放：  全新运行 -> 脱敏 -> 与快照逐行 diff
通过：  逐字节一致        失败：打印第一处差异行
```

脱敏是关键纪律：易变的外围（会话 id、时间戳、临时路径）变成**类型化令牌**（`<SESSION_ID>`、`<TIMESTAMP>`、`<TMPDIR>`）——这正是 `snapshots/AGENTS.md` 的规定：身份替换为类型化令牌、system prompt 与工具 schema 令牌化、`workspace.expected/` 作为独立 oracle。

## 工作原理

**第 1 步 —— 确定性规则。** 逻辑路径上没有未播种的随机数、没有挂钟时间（剩下的就脱敏）、迭代顺序稳定。本章的会话 runner 除刻意保留的外围之外完全确定——而那部分正是脱敏要除掉的。

**第 2 步 —— 录制。** 一次运行产出事件日志；脱敏归一化；快照文件成为期望。

**第 3 步 —— 回放。** 全新运行、同样的脱敏、逐行 diff。绿色意味着：同样的工具、同样的顺序、同样的输出、同样的持久化形态。

**第 4 步 —— 捕获回归。** 工具输出改了一个字符（`beta` → `betA`）——回放失败并打印精确的行。真实 dsh 中，`pnpm run test:snapshot` 会跑 100+ 个这样的场景：fs-edit、ptc-turn、subagent-*、compaction-recovery、hook-cc-*……

**为什么便宜。** 回放从不调用模型：录制的日志*就是*模型的行为。这就是 s04 的回报——"模型可见即已落日志"让日志足以重现一切。

## 对照真实 dsh

| 课程概念 | 真实位置 |
|---|---|
| 快照教义（角色、脱敏、命名） | `snapshots/AGENTS.md` |
| 100+ 个录制场景 | `snapshots/session/`（fs-edit、ptc-turn、subagent-*、ralph-loop、compaction-recovery……） |
| 各 profile 的快照面 | `snapshots/sdk/`、`snapshots/web/`、`snapshots/acp/` |
| 回放测试命令 | `pnpm run test:snapshot`（无需 key） |
| 半真实测试的 LLM mock 基础设施 | `packages/test-support/` |
| 性能预算（另一种门禁） | `benchmarks/` + `BENCHMARK.md` |
| 回放背后的会话格式保证 | `packages/session/session-format*/`（相邻迁移链） |

## 试一下

```sh
node s10_deterministic_replay/code.ts
```

看录制通过（打印脱敏快照）、回放 #1 逐字节通过、回放 #2 恰好在一行上失败——`betA` 回归，被一个零 API 成本、毫秒级完成的测试逮个正着。

## 接下来

你已经从第一性原理重建了 dsh 的架构：组合运行时 → 循环即插件 → 工具管线 → 事件溯源会话 → 代际文件 → 能力接缝 → 沙箱与审批 → 影子压缩 → PTC → 确定性回放。

- **读真正的教义。** `docs/architecture.md`，然后 `docs/capability-seams.md`，然后 `cordis-tutorial/` 系列。
- **跑真东西。** `npx @deepseek-ai/dsh web`——再用 Python SDK（`python/sdk/`）以编程方式驱动会话。
- **三门课对照着看。** Claude Code 把机制造进去；pi 把机制推进扩展；dsh 用插件组合一切、记忆事件溯源。三种哲学，同一个循环——而你三门都读完了。

**没有特权核心。模型自会完成剩下的一切。**
