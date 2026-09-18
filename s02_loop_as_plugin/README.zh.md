# s02: 循环即插件 — 连循环都是插件

[English](README.md) · [中文](README.zh.md)

[s01](../s01_composition_runtime/) → `s02` → [s03](../s03_tool_pipeline/) → ... → s10
> *"连循环都是插件。"* —— 默认 agent 循环把自己注册到服务注册表；消费者按 id 解析；换循环只是一行配置。

---

## 问题

在大多数框架里，agent 循环是你唯一不能碰的东西。它 import 你的工具、占有你的状态机、写死了对话何时开始、继续、结束。想要步数上限？想要不同的停止策略？去 patch 循环——然后成为这个框架里最危险文件的维护者。

dsh 的答案直接来自 s01：既然每个贡献都是可逆的副作用，循环当然也可以是。

## 解决方案

```
core 插件      提供  ctx.agents（AgentRegistry）
llm 插件       提供  ctx.llm    （faux，脚本化）
tools 插件     提供  ctx.tools
react-loop-v1  在 ctx.agents 上注册 AgentFactory "react-loop-v1"
goal-guard     监听 "turn/stopping" → 工件缺失时行使否决
react-loop-v2  注册 "react-loop-v2"（给 v1 包一层步数上限）

消费者：resolve(CONFIG.agent)  <- 从不 import 任何循环
```

两个词汇撑起本章（来自 `docs/architecture.md`）：

- **step** = 一次模型请求 + 它做出的工具调用
- **turn** = 零或多个 step；只要有工具还欠着工作就继续，而且只能通过串行的 **`turn/stopping`** 事件停止——监听者可以否决。

## 工作原理

**第 1 步 —— 循环是注册，不是导出。** `reactLoopV1Plugin` consume `ctx.agents` 并注册一个工厂。任何消费者都不 import 循环文件。

**第 2 步 —— step 一直走到无所欠。** 每次迭代：`agent/request` → LLM 回应 → 工具执行 → 再循环。只要工具结果还需要后续推理，turn 就继续。

**第 3 步 —— 停止是一个可否决的事件。** 模型不再调用工具时，循环在停止*之前*向插件 context 发射 `turn/stopping`。`goal-guard` 插件检查 `summary.txt` 是否存在；不存在 → 设 `veto.flagged` → 循环进入下一个 step。dsh 的 goal/plan 包正是用这种方式让 agent 守住任务，而不需要在循环里写死"你确定吗？"。

**第 4 步 —— 替换就是配置。** `react-loop-v2` 包住 v1 的 generator、加一个步数上限（拦截 `step/start`）。翻转 `CONFIG.agent`，同样的消费者代码跑上了另一个循环。真实 dsh 中这就是 profile 里的一行配置。

## 对照真实 dsh

| 课程概念 | 真实位置 |
|---|---|
| 默认循环插件（`ReactLoopAgent`） | `packages/core/agent-loop/src/index.ts` + `src/agent.ts` |
| `Agent` 接口 + 注册表 | `packages/core/agent/` |
| 作用域注册（每 agent 的服务） | `packages/core/scope/` |
| turn/step 流程图 | `docs/architecture.md`（turn flow） |
| inbox 认领 / 回合中途的输入 | `packages/core/agent-loop/src/inbox.ts` |
| 串行 `turn-stopping` 语义 | `docs/architecture.md` —— 事件列表 |
| Preset：每会话的 agent 组合 | `packages/preset/` |

真实 dsh 还加了持久化集成（循环是写句柄的获取点）、KV-cache 友好的请求组装、取消语义——注册/替换模式是骨架。

## 试一下

```sh
node s02_loop_as_plugin/code.ts
```

第一次运行：step 1 读 readme；step 2 给出最终文本——但 guard **否决了停止**（`summary.txt` 缺失），回合继续；step 3 写入文件；step 4 的停止被接受。第二次运行：配置翻到 `react-loop-v2`，同样的消费者代码、步数上限生效。注意：消费者文件里没有任何一行 import 循环。

## 接下来

循环按名字查表执行工具——但没有管线。模型参数直接灌进 handler；没有任何东西能检查、允许、拒绝、转换一次工具调用。s03 构建 dsh 的五道闸门执行管线。
