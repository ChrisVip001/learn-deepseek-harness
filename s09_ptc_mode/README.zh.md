# s09: PTC 模式 — 代码本身就是工具调用协议

[English](README.md) · [中文](README.zh.md)

[s08](../s08_shadow_compaction/) → `s09` → [s10](../s10_deterministic_replay/) → s10
> *"代码本身就是工具调用协议。"* —— 模型对着生成的 SDK 写程序；一次往返替代多次；中间值零 token 成本。

---

## 问题

原生工具调用有一笔结构性的税：

- 每个请求都要携带**全部工具 schema**——几十个工具意味着成千上万的 JSON 永远重复。
- 多步工作**每次调用一个往返**：先列文件、再读、再搜索——每一步都等模型吐出下一个块。
- 模型根本不需要的中间值也要作为工具结果流经对话，白白烧 token。

## 解决方案

PTC（Program-Tooled-Code）是 dsh 的第二条工具消费路径——与原生块并存，而非取代：

```
模型看到：   唯一的传输工具  run_code { code, justification? }
运行时：     从可见工具 schema 生成的 TypeScript SDK
执行：       模型的程序调用 SDK 函数 -> 同一条 s03 管线
可见的：     只有 console 输出 + 返回值进入对话
```

工具声明 `mode: native | ptc | both`，选择自己从哪条路径暴露。

## 工作原理

**第 1 步 —— 生成 SDK。** 从可见工具 schema，`generateSdkSource` 产出类型化声明（`bash(command: string): Promise<string>`）。模型读的是 SDK，而不是几十坨 schema。

**第 2 步 —— 执行程序。** `runCode` 用 `new Function` 编译程序，注入 SDK 运行时和一个捕获型 console。程序就是普通异步 JavaScript——所以 **`Promise.all` 并行就是 JavaScript 本身**，不需要特殊协议。

**第 3 步 —— 管线依然说了算。** SDK 函数走的是与原生调用完全相同的执行管线。演示程序调用 `bash("rm -rf /")`——和原生调用一样死在政策手上。PTC 改变的是传输方式，不是绕过手段。

**第 4 步 —— 宽权限要说明理由。** 声明宽 `sandbox_permissions` 却没有非空 `justification` 的程序直接被拒；有理由则进审批（fail-closed，见 s07）。

**第 5 步 —— token 经济学。** Schema 成本：N 个工具（演示约 40 token）对比 1 个传输工具（约 8）。往返：N+1 对比 1。中间值：SDK 结果活在程序内部，不打印就**零 token**。

## 对照真实 dsh

| 课程概念 | 真实位置 |
|---|---|
| 工具运行时上的 PTC 桥 | `packages/core/tools/src/ptc.ts` |
| 从工具 schema 生成的 TS/Python SDK | `packages/core/tools/src/ts-types.ts`、`py-types.ts` |
| 沙箱化程序执行 | `packages/ptc-runtime/ptc-runtime-node/`（+ 实验性 CPython 后端） |
| 宽权限的 `justification` + 审批 | `docs/subsystems/ptc-runtime.md`、`docs/subsystems/approval.md` |
| 每工具模式（`native | ptc | both`） | `packages/core/tools/src/schema.ts` |
| PTC 回合的快照覆盖 | `snapshots/session/`（ptc-turn 场景） |

## 试一下

```sh
node s09_ptc_mode/code.ts
```

读一读生成的 SDK，然后对比两种模式的账本：原生（每个请求 3 份 schema、4 个往返）对比 PTC（1 份 schema、1 个往返）。演示程序跑了三个调用——包括天然适合并行的代码——而模型只看到捕获的输出。然后看安全检查在*程序内部*触发。

## 接下来

前面每一章都跑在脚本化 LLM 上——免费且确定。dsh 把这个性质变成了自己的测试战略：**录制的会话作为测试套件回放**。s10 构建回放框架。
