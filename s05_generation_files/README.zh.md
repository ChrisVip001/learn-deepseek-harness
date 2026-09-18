# s05: 代际文件 — 已提交的代永不改写

[English](README.md) · [中文](README.zh.md)

[s04](../s04_event_sourced_session/) → `s05` → [s06](../s06_capability_seams/) → ... → s10
> *"已提交的代永不改写。"* —— 会话以不可变、版本命名的 JSONL 文件持久化，由独占写锁守护，中途死掉的回合用合成收尾者修复。

---

## 问题

s04 的事件日志是真相——但它活在内存里。持久化一个追加式日志听起来简单（往文件里追加就完了！）直到难题到来：

- 如果**两个进程**同时以写模式打开同一个会话怎么办？
- 如果进程**在回合中途崩溃**——工具已派发、结果还没落日志怎么办？
- 如果某个"好心"的优化改写或压缩了昨天的文件——而副本还在读它怎么办？

天真的单文件持久化对这三个问题都给出了糟糕的答案。

## 解决方案

dsh 的 JSONL 持久化把每个写会话当作一个**代（generation）**：

```
session.jsonl        第 1 代  已提交，永远不可变
session.v2.jsonl     第 2 代  已提交，永远不可变
session.v3.jsonl     第 3 代  活跃写目标（open-for-write 时发布）
write.lock           写者存在期间的独占 flock
```

规则：

1. **写打开即发布后继。** 写者绝不向已提交的文件追加；它开启一个新版本命名的代。
2. **一次只有一个写者。** 独占锁（`native/system` 里的真原生 `flock` 绑定）立刻拒绝第二个写者。
3. **提交 = 关闭。** 一旦提交，该代永不重命名、永不覆写、永不删除。
4. **用合成收尾者做崩溃修复。** 带着未闭合回合的未提交代会得到：为已派发但未解决的调用合成一个工具结果（`ABORTED_BEFORE_DISPATCH`），以及 `turn.ended{interrupted:true}`。日志对崩溃保持诚实——它不假装回合完成了。

## 工作原理

**锁。** `acquireLock()` 用 `O_EXCL` 创建模拟真实的 `flock` 绑定；第二个写者的 open 直接抛错。进程死亡时，内核释放真 flock——演示中的 `simulateCrashCleanup` 模拟这一点。

**修复。** `repair()` 从最新到最旧扫描代，找到"开始了却没结束"的回合。因为最后一个代*从未提交*，向它追加收尾者是合法的——不可变规则保护的是已提交的代，不是被遗弃的代。

**检查点纪律。** dsh 的 checkpoint policy 保证在下一个动作之前，模型请求、顶层工具副作用、已完成的 step 都已落盘——崩溃不会丢失模型"看到过"的任何东西（符合 s04 的不变量）。

## 对照真实 dsh

| 课程概念 | 真实位置 |
|---|---|
| 代际文件 JSONL 后端 | `packages/session/session-persistence-jsonl/` |
| 持久化接口（create/open/stat/list/export） | `packages/session/session-persistence/` |
| 原生 flock 的独占写 | `native/system/`（`@deepseek-ai/node-addon-system`） |
| 检查点策略 | `packages/session/session-checkpoint-policy/` |
| 中断回合收尾者 | agent 层，见 `docs/subsystems/persistence.md` |
| 每次持久化格式变更都有记录 | `docs/persistence-changes/` |
| 持久化类型目录（生成） | `docs/persistence-catalog.md`（229KB） |

## 试一下

```sh
node s05_generation_files/code.ts
```

看四幕：① 第 1 代干净提交。② 第 2 代打开期间，第二个写者**倒在锁上**。③ "进程崩溃"——回合 2 悬在半空。④ 恢复流程重新打开、合成被中止的工具结果和中断收尾、提交。最后的磁盘清单显示三代文件——包括第 1 代，与提交那一刻逐字节一致。

## 接下来

到目前为止每个工具都直接摸*本地*文件系统。dsh 把所有这类能力都路由过**能力接缝**——于是同一份 agent 代码可以跑在远程机器上。s06 构建接缝。
