# s06: 能力接缝 — 定义接缝，替换世界

[English](README.md) · [中文](README.zh.md)

[s05](../s05_generation_files/) → `s06` → [s07](../s07_sandbox_approval/) → ... → s10
> *"定义接缝，替换世界。"* —— 文件系统、shell、终端、SSH：每种能力都藏在三角色接口后面。把接缝指向远程机器，整个 agent 搬家——工具浑然不觉。

---

## 问题

Agent 工具把环境写死：`fs.readFile("/workspace/x")`、`child_process.exec(...)`——永远是本机。然后需求来了：让 agent 跑在**远程构建机**、**容器**、**云沙箱**上。天真的修法是给每个工具做分叉（`read_file_remote`、`bash_remote`）——维护翻倍、信任减半。

## 解决方案

dsh 的 `docs/capability-seams.md`（55KB！）把每种能力形式化为带**三个角色**的接缝：

```
服务定义（Definition）   接口 + 服务键          "存在什么"
服务提供者（Provider）   注册的实现              "谁来服务"  <- 可替换
消费者（Consumer）       面向模型的工具           "谁来使用"  <- 对世界无感
```

还有一条影响深远的附加规则：文件决策由**共享策略族**（`ctx.sandboxPolicy`）做出，被*每一个*碰文件的能力消费——fs、subprocess、PTC。政策不是每个工具自己贴的胶布；它是唯一的决策点，在每个世界里同样执行。

## 工作原理

**第 1 步 —— 定义接缝。** `FsSeam` 和 `ShellSeam` 就是普通接口加服务键。它们身上没有任何一个字提到本地或远程。

**第 2 步 —— 构建提供者。** `createLocalWorld()` 从临时目录提供真实文件和真实 shell；`createRemoteWorld()` 模拟一台构建主机，有自己的虚拟文件系统和 ssh 风味的 exec。两者满足同样的接口。

**第 3 步 —— 从配置组装。** `assembleWorld("local" | "remote")` 挑选提供者、注册到接缝键下。这是 dsh 的部署决策，不是代码变更。

**第 4 步 —— 消费者对世界无感。** `read_file` / `write_file` / `bash` 只消费接缝。脚本化的模型在两个世界里发出**一模一样的调用**——而输出真的不同，因为是不同的世界在应答。

**第 5 步 —— 共享策略在所有地方生效。** `read_file("/etc/shadow")` 在两个世界里被同一个 `WorkspacePolicy` 同样拒绝——工具们从来不需要各自"记得"去检查。

## 对照真实 dsh

| 课程概念 | 真实位置 |
|---|---|
| 接缝全集（55KB 的教义） | `docs/capability-seams.md` |
| fs 接缝 + 沙箱化 fs 提供者 | `packages/fs/` + `docs/subsystems/filesystem.md` |
| shell / subprocess / PTY 接缝 | `packages/shell/`、`packages/subprocess/`、`packages/terminal/` |
| SSH 只是另一个世界 | `packages/ssh/` |
| 共享策略族 | `packages/sandbox/sandbox-policy/`（`ctx.sandboxPolicy`） |
| 整能力替换（远程执行器） | `packages/e2b/` |
| 接缝之后的 LSP | `packages/lsp/` |

## 试一下

```sh
node s06_capability_seams/code.ts
```

同样的四次工具调用跑两遍。本地世界：真实文件、真实 `ls` 输出。远程世界：`deploy.log`、`build-host-07`、ssh 风味——同样的工具代码。而且**两个**世界里 `/etc/shadow` 都死在共享策略手上。这就是全部诀窍：换提供者，永不换消费者。

## 接下来

接缝路由能力；接缝不约束能力。s07 加上执行层：沙箱模式、默认拒绝的审批、一次性提权。
