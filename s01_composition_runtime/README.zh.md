# s01: 组合运行时 — 注册即副作用

[English](README.md) · [中文](README.zh.md)

`s01` → [s02](../s02_loop_as_plugin/) → ... → s10
> *"注册即副作用。"* —— 每次 `ctx.on`、每次 `ctx.effect`、每个服务的注册都返回自己的撤销操作。可逆性是"没有特权核心"的地基。

---

## 问题

设想一个插件系统：插件能加事件监听、注册服务、起定时器、改行为。现在回答：**卸载一个插件时会发生什么？** 大多数系统的答案都不妙——监听器泄漏、服务悬空、定时器继续跑。于是插件变成"永生"的，"可移除"意味着"我们从不真的移除"。

dsh 的核心主张——*一切皆插件，连 agent 循环也是*——只有当"移除天然安全"时才成立。

## 解决方案

Cordis（dsh 中 vendored 为 `@deepseek-ai/cordis`）押了一个大注：

```
ctx.on(event, listener)   返回一个 disposer（注销函数）
ctx.effect(() => cleanup) 把清理与副作用绑定注册
ctx.provide(key, impl)    服务是"贡献"，不是"安装"
plugin = (ctx) => void | Dispose
```

插件是一个普通函数，拿到一个 context、通过它做贡献。因为**每个贡献都自带撤销**，运行时可以在任意时刻停止或替换任意插件——dispose 按逆序执行累积的清理。没有泄漏；没有永生。

## 工作原理

**第 1 步 —— 监听器是一次性的。** `ctx.on` 返回注销函数，*并*把它注册进 context 的 disposer 列表。不需要额外的"记得清理"纪律。

**第 2 步 —— `ctx.effect` 把它泛化。** 任何副作用（定时器、文件句柄、订阅）都以 `effect(() => undoIt)` 的形式声明，context 收集这些撤销操作。

**第 3 步 —— 服务来了又走。** `ctx.provide("logger", impl)` 发布；`ctx.consume("logger")` 读取**此刻**的值（可能是 `undefined`）；`service:logger` 事件在出现/撤回时触发。依赖方**优雅降级**而非崩溃——这正是 dsh 热切换能力提供者的方式。

**第 4 步 —— 插件有自己的 context。** `runtime.use(name, plugin)` 创建子 context；`unload(name)` 将其 dispose——逆序执行该插件注册过的每个 disposer。

**第 5 步 —— stop 只是批量销毁。** 逆序处理所有插件，最后是根。运行时自己从不销毁任何东西；它只请求每个贡献撤销自己。

## 对照真实 dsh

| 课程概念 | 真实位置 |
|---|---|
| Cordis 运行时（vendored） | `deepseek-harness/vendor/` |
| 教程系列（7 篇：第一个插件 → 组合） | `deepseek-harness/docs/cordis-tutorial/01…07` |
| 框架 API 参考 | `docs/cordis-api/`（context/events/fiber/registry/service） |
| Profile = 有序插件列表 | `docs/architecture.md` —— web、headless、sdk、sdk-minimal、acp |
| 时空可组合性论文 | Cordis 设计源头，见 `docs/architecture.md` |

真实 Cordis 还加了 fiber（协程调度）、配置解析、HMR——disposer 纪律才是承重墙。

## 试一下

```sh
node s01_composition_runtime/code.ts
```

看这份"可逆性账本"：`logger` 加载 → greet 有日志；**卸载 `logger`** 执行其 effect 清理并撤回服务——`commands` 插件*收到通知*并优雅降级（greet 照常工作，只是没了日志）；重新安装后日志恢复；`runtime.stop()` 逆序销毁一切，`metrics` 在清理中打出最终报告——**清理本身可以是有意义的工作**。

## 接下来

你拥有了一个任何插件都能被替换的运行时。s02 兑现承诺：**agent 循环本身**变成插件，注册进服务注册表、可被另一个实现替换——外加驱动每一次对话的 turn/step 状态机。
