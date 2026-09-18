# s03: 工具管线 — 一条管线，五道闸门

[English](README.md) · [中文](README.zh.md)

[s02](../s02_loop_as_plugin/) → `s03` → [s04](../s04_event_sourced_session/) → ... → s10
> *"一条管线，五道闸门。"* —— 每次工具调用走同一条固定管线；政策住在插件里；guard 一锤定音；坏参数只是普通错误结果。

---

## 问题

s02 的循环用裸名字查表执行工具。后果：模型参数未校验就灌进 handler；每条安全政策都要按工具重新发明；没有任何东西能检查或规范化结果；一个慢工具把回合挂到永远。

需要的不是"一套权限系统"——而是一条**固定管线**、闸门定义清晰，让政策作者在正确的位置挂钩子，而不是去 patch handler。

## 解决方案

dsh 的工具执行管线（`docs/tool-execution-pipeline.md`）：

```
1. tools/pre-execute    可扩展瀑布：allow / deny / ask
2. 单调 guard           ctx.tools.guard(fn) —— 在 pre-execute 之后，只能拒绝，不可翻案
3. tools/execute        包裹式分发：schema 检查、超时、重试
4. tools/post-execute   检查 / 替换结果
5. tools/result         只读通知
```

两条微妙的规则让这条管线值得信任：

- **deny > ask > allow。** 多个 pre-execute 监听者各自投票；一个 deny 即胜出；ask 只有在无人拒绝时才存活。
- **guard 是单调的。** guard 在可扩展瀑布**之后**运行，**不可被推翻**——部署级的"凭据不可访问"不会因为某插件返回"allow"而失效。

## 工作原理

**闸门 1 —— 瀑布。** 每个监听者检查 `{name, arguments}`，返回决策或不返回。"拒绝 rm -rf"、"联网前先询问"都住在这里——作为普通插件。

**ask 分支。** `ask` 委托给审批服务。演示中无头 answerer 拒绝一切匹配 /network/i 的请求。（s07 构建完整的默认拒绝审批语义。）

**闸门 2 —— guard。** `rt.guard(fn)` 返回拒绝理由或 null。演示中 `secret_read` 顺利通过所有 pre-execute 监听者——然后死在 guard 手里。政策分层：先可扩展判断，后不可逾越的部署规则。

**闸门 3 —— 包裹执行。** 先做 schema 检查（缺参/类型错 → 错误结果、回合继续——模型可以自我修正）。然后 handler 在 `Promise.race` 超时保护下运行。`slow_task`（500ms 的活、100ms 的预算）干净利落地死掉，而不是把回合吊死。

**闸门 4+5 —— 结果塑形。** post-execute 监听者可以替换结果（audit 插件给 bash 输出追加 `(exit=0)`）；result 事件只读。注意模型永远看不到的东西：`execute`、超时、guard——只有投影出来的 schema（`schemasForModel`）。

## 对照真实 dsh

| 课程概念 | 真实位置 |
|---|---|
| `ToolRuntime` 服务、注册、限制掩码 | `packages/core/tools/src/index.ts` |
| `defineTool` DSL + 类型化 schema 推导 | `packages/core/tools/src/schema.ts` |
| `tools/pre-execute` / `execute` / `post-execute` / `result` 事件 | `packages/core/tools/src/index.ts`（类型化事件表） |
| 单调 guard | `ctx.tools.guard()` —— "一旦拒绝，不可翻案" |
| 管线阶段不变量（运行时校验阶段顺序） | `packages/core/tools/src/invariant.ts` |
| 全流程可视化讲解 | `docs/tool-execution-pipeline.md` |
| 工具目录（生成，91KB） | `docs/tool-catalog.md` |
| 手册：新增一个工具 | `docs/cookbook/adding-a-tool.md` |

## 试一下

```sh
node s03_tool_pipeline/code.ts
```

六次脚本化调用、六种结局：① `ls` 执行并带着 `(exit=0)` 回来（post 增强）。② `rm -rf` 在 pre-execute 被拒。③ `curl` 走 ask → 审批说不。④ `secret_read` 通过所有监听者——**guard** 干掉了它。⑤ `slow_task` 撞上超时。⑥ 缺参数的 `write_file` 在任何 handler 运行*之前*就倒在 schema 校验。结尾的 trace 显示每次调用穿过了哪些闸门。

## 接下来

到目前为止所有结果都活在内存里。dsh 的核心不变量——*模型可见即已落日志*——要求任何发给模型的请求都能从持久日志重建。s04 构建事件溯源会话。
