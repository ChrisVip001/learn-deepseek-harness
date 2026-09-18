# s07: 沙箱与审批 — 默认拒绝，一次性提权

[English](README.md) · [中文](README.zh.md)

[s06](../s06_capability_seams/) → `s07` → [s08](../s08_shadow_compaction/) → ... → s10
> *"默认拒绝，一次性提权。"* —— 基于模式的沙箱决策、沉默绝不等于同意的审批瀑布、打完一发就过期的提权。

---

## 问题

"危险操作前问一下用户"不是设计。问题会接连出现：*每次*写入都问，还是只问工作区外的？没人在场时怎么办——agent 继续（fail-open）还是停下（fail-closed）？批准一次之后，agent 是不是就永远被信任了？

安全性就活在这些默认值上。dsh 的答案非常明确：**沙箱负责拒绝；审批是唯一的门；而这扇门在构造上就是关着的。**

## 解决方案

三层机制：

```
1. 沙箱模式   read-only | workspace-write | danger-full-access
              （由真 OS 沙箱执行：Landlock / Seatbelt / 受限令牌）
2. 审批       ctx.approval.request(justification) -> answerer 瀑布
              零 answerer（或全部弃权）=> 拒绝
3. 提权       被拒的调用可在显式批准后重试一次，
              然后沙箱弹回原模式
```

## 工作原理

**第 1 步 —— 基于模式的检查。** `Sandbox` 根据模式 + 目标决策：读免费；`workspace-write` 下工作区写放行；工作区外写入与联网命令被拒，**并附带提权提示**——包括一个现成的 `justification` 字符串，因为不给活路的拒绝就是死胡同。

**第 2 步 —— 瀑布。** `ApprovalService` 依序走过注册的 answerer；第一个不弃权的裁决生效。演示里有两个：允许 build-output 路径的 `sessionPolicy`，以及兜底的 `humanStandIn`。answerer 可以各司其职——会话策略对联网弃权，交由人类层。

**第 3 步 —— 构造上的 fail-closed。** 没注册 answerer？全部弃权？**拒绝。** 沉默永远不等于同意。这是全章最重要的一行。

**第 4 步 —— 一次性提权。** 批准后，为*恰好一次操作*构造一个 `danger-full-access` 沙箱，然后执行器回到原模式继续。演示显示：第一次提权用掉之后，第二次工作区外写入再次被拒。

## 对照真实 dsh

| 课程概念 | 真实位置 |
|---|---|
| 沙箱模式 + 真 OS 后端（Linux bwrap/Landlock、macOS Seatbelt、Windows ACL） | `packages/sandbox/sandbox-local/`、`sandbox-windows-acl/` + `docs/subsystems/sandbox.md` |
| 被 fs/subprocess/ptc 消费的共享策略族 | `packages/sandbox/sandbox-policy/`（`ctx.sandboxPolicy`） |
| 审批服务 + answerer 瀑布 | `packages/interaction/user-approval/` |
| 权限预设（模式 + 政策合成一个选择器） | `packages/interaction/permission-presets/` |
| 一次性提权编排 | `docs/subsystems/approval.md` |
| 原生原语（landlock-run 启动器） | `native/system/` |
| 顶层责任声明 | `SAFETY.md` —— "不作为不可信工作负载的安全边界" |

## 试一下

```sh
node s07_sandbox_approval/code.ts
```

六个操作、一本完整的决策账：① 免费读、② 工作区写放行、③ 工作区外写 → 提权 → `sessionPolicy` 批准 → **一次提权写入**、沙箱弹回、④ `/etc/hosts` → 提权 → 人类层拒绝、⑤ `curl` → 批准一次（联网）、⑥ `nc` → 这次没人批准。然后是 fail-closed 尾声：零 answerer 的审批服务按名字拒绝一切。

## 接下来

上下文会满——而压缩绝不能弄脏追加式日志。s08 构建 dsh 的影子压缩：先修剪工具结果、再摘要，全部作为*新事件*去影子化旧事件，历史一个字节都不改写。
