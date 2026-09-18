# s04: 事件溯源会话 — 模型可见即已落日志

[English](README.md) · [中文](README.zh.md)

[s03](../s03_tool_pipeline/) → `s04` → [s05](../s05_generation_files/) → ... → s10
> *"模型可见即已落日志。"* —— 任何进入模型请求的内容都必须能从会话日志重建。永远没有旁路——而且运行时能证明这一点。

---

## 问题

Agent 运行时在十几个地方累积状态：这边一个 messages 数组、那边一个工具结果缓存、还有直接注入请求的"系统提醒"。然后某一天你需要回答：*模型到底看到了什么？*——为了调试一个坏回合、恢复会话、为测试做回放、审计一次事故。如果状态散落在可变对象里，诚实的答案是"没人知道"。

## 解决方案

dsh 的答案是严格的事件溯源，外加一条运行时强制的不变量：

```
SessionEvent（追加式、冻结）  ──deriveMessages()──►  模型请求
        ▲                                            │
        └──────── 每个请求记录一个哈希证明 ──────────┘
```

- **日志**是唯一真相源：追加式、写入即冻结、类型化（`SessionEventMap`）。
- **请求**永远是*投影*（`deriveMessages`），从不是被改出来的对象。
- 每个准备好的请求记录一条**哈希证明**（`request.prepared`）。校验器从日志前缀重算投影并比对——任何未落日志的改动都能被数学化地侦测到。

这一条不变量，正是 dsh 的 fork、resume、转录导出、遥测、以及 s10 的确定性回放全部能*派生*而不需要*重新实现*的原因。

## 工作原理

**第 1 步 —— 类型化事件。** `SessionEventMap` 把事件名映射到载荷；未知事件类型直接拒绝，除非标记为 ignorable——前向兼容，但绝不静默损坏。

**第 2 步 —— 写入即冻结。** `Object.freeze` 在写入时生效。日志只暴露只读视图；不存在"修改历史"的 API。

**第 3 步 —— 唯一投影。** `deriveMessages` 遍历事件、构建模型消息。它是把日志变成请求的**唯一**函数——不存在会漂移的第二条代码路径。

**第 4 步 —— 证明。** 发送之前，循环记录 `request.prepared { hash }`，其中 hash = H(deriveMessages(logPrefix))。校验器从日志前缀重算。诚实的会话：两个哈希一致。被篡改的会话（一个工具结果送到了模型却从未落日志）：不一致——运行时**证明**了旁路的存在。

## 对照真实 dsh

| 课程概念 | 真实位置 |
|---|---|
| 追加式会话日志（`ctx.sessions`） | `packages/core/session/` |
| declaration merging 的类型化事件（`SessionEventMap`） | `packages/core/session/` —— 未知类型拒绝，除非 `ignorable` |
| `deriveMessages` 投影 | `packages/core/session/` |
| 不变量（运行时断言，不只是测试） | `packages/core/agent-loop/src/invariant.ts` + `AGENTS.md`（"Model-visible ⟺ logged"） |
| 投影与增量折叠 | `packages/session/session-projection/`（+ 缓存：`session-projection-cache/`） |
| 子系统文档 | `docs/subsystems/session.md`（69KB） |

## 试一下

```sh
node s04_event_sourced_session/code.ts
```

看会话逐事件构建、每次模型调用后都有一条请求证明。诚实的校验两次通过。然后篡改演示删掉一条 `tool.result_added` 事件——第二个请求的哈希无法再重算出来，校验器用红色标出。那面红旗就是 dsh 架构在按设计工作。

## 接下来

日志活在内存里，进程一死就没了。s05 把它持久化到**代际文件**——版本化、一旦提交不可变、独占锁定，并对中途死掉的回合做崩溃修复。
