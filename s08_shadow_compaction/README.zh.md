# s08: 影子压缩 — 影子替换，绝不抹除

[English](README.md) · [中文](README.zh.md)

[s07](../s07_sandbox_approval/) → `s08` → [s09](../s09_ptc_mode/) → ... → s10
> *"影子替换，绝不抹除。"* —— 压缩追加影子事件；请求投影缩小；日志只增不减。

---

## 问题

上下文会溢出——但 s04 宣布日志神圣，s05 让它在磁盘上不可变。经典修法（改写历史：删旧消息、拼摘要）直接违反两者。你只能二选一：紧凑的上下文，或可信的日志。dsh 拒绝二选一。

## 解决方案

dsh 的压缩家族（`packages/compaction/`，五个包）**绝不改写任何东西**。它追加*影子化*事件：

```
tool.result_pruned {toolCallId, tokens}     标记旧的过大工具输出
history.summarized {shadowedUpTo, summary}  用一条摘要影子化整个前缀
```

投影（`deriveMessages`）尊重影子：被影子的事件从**请求**中消失，但在**日志**中逐字节保留。回放、导出、审计依然能看到一切。

```
token:   [====== 1245 ======] → 修剪 → [=== 800 ===] → 摘要 → [= 350 =]
日志：    一直在增长 —— 历史从未被碰过
```

## 工作原理

**第 1 步 —— 从日志测量。** token meter 从持久化事件（回放感知）推导数字，而不是从内存中的活对象——测量因此能在进程重启后存活，并与 s04 不变量所保证的内容一致。

**第 2 步 —— 先做便宜的修剪。** 过大的工具输出（惯犯）被标记为 `tool.result_pruned`，投影里替换成一行占位符。便宜、精准、语义上可逆。

**第 3 步 —— 摘要剩余部分。** 还是超预算？`history.summarized` 把某个序号之前的全部事件影子化，只留最近的事件加一条摘要消息。

**第 4 步 —— 投影是唯一消费者。** 运行时其他部分完全不需要知道压缩发生过：会话恢复、回放运行、分叉分支——全部来自同一份未动的日志。

真实 dsh 还有第四个家族成员：**图片卸载**——当 provider 因图片预算拒绝请求时，超预算图片以*事件*的形式被替换为占位符，请求重新发起。

## 对照真实 dsh

| 课程概念 | 真实位置 |
|---|---|
| 共享压缩契约（`ctx.compaction`） | `packages/compaction/compaction/` |
| 自动压力触发压缩 | `packages/compaction/compaction-basic/` |
| 工具结果修剪器（`ctx.toolResultPruner`） | `packages/compaction/compaction-tool-result-pruner/` |
| provider 拒绝时的图片卸载 | `packages/compaction/compaction-image-offload/` |
| 手动 `/compact`（与运行中回合串行化） | `packages/compaction/command-compact/` |
| 从持久化日志测量 token | `packages/llm/token-meter/`（`ctx.tokenMeter`） |
| 相关：超大输出溢出到磁盘 | `packages/spill/` |
| 子系统文档 | `docs/subsystems/compaction.md`（19KB） |

## 试一下

```sh
node s08_shadow_compaction/code.ts
```

一个重型会话超出 250 token 预算。看三个快照：9 条消息 / 250+ token → 修剪器标记三个大输出 → 摘要器影子化前缀 → 最终请求里是一条紫色摘要和被修剪的占位符。然后读完整日志：每条原始事件都还在，只追加了两个紫色影子事件。请求缩小了；日志只增长了。

## 接下来

工具调用有个隐藏成本：每次调用都是独立的模型往返，还要带上完整的 schema 开销。s09 构建 dsh 的第二条工具消费路径：**PTC 模式**——模型写代码、调用生成的 SDK。
