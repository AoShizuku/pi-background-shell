# pi-background-shell 设计方案

> 状态：**Phase 1、Phase 2 已实现**（`src/`），Phase 3 待做。实现清单见 §7。

## 0. 目标与结论

### 0.1 目标

给 pi 补上**非对称时长任务**的能力：模型可以把一个预计要跑几分钟的命令丢到后台，
立刻拿到 task id 继续干别的；任务结束时 agent 被**自动唤醒**，读输出文件，再决定下一步。

三类目标场景：

| 场景 | 例子 | 现在怎么做 | 问题 |
|---|---|---|---|
| 长测试 / 构建 | `npm test`、`cargo build`、等 CI | 前台跑，或 `sleep && cat` 轮询 | 占着 turn、烧 token、有超时风险 |
| 长驻服务 | `npm run dev`、`docker compose up`、隧道 | `cmd &` | 进程随 shell 一起死，或变成无人管的孤儿；模型不知道它死了 |
| 一次性重活 | 抓日志、等端口起来、等文件出现 | 轮询 | 同上 |

### 0.2 核心结论

1. **只做 background shell，不做 monitor。** 逐行推送型 monitor 语义陷阱多
   （"stream ended" ≠ "条件满足"），它的价值 ≈ background shell + 一个 `until` 循环。→ §2.7
2. **独立工具 `bash_background` + `bg_kill`，不改内置 `bash`。** 常驻服务场景下模型必须能自己
   收尾，所以 kill 工具放在 Phase 1，不是 Phase 3。→ §3.2、§4.3
3. **通知按 agent 状态分两条路投递，每批任务只唤醒一次。** pi 的 steer 队列默认一轮只取一条
   （`steeringMode: "one-at-a-time"`），逐条 `sendMessage` 会让 N 个任务占 N 轮 LLM。
   - agent 空闲：合并窗口 3s，从第一个任务结束起算、固定不滑动；没有其他任务在跑时立刻发。
   - agent 忙：扩展自己缓冲，在 `turn_end` / `agent_before_settle` 边界合并成**一条**
     `custom_message` 一次性排出。→ §3.5
4. **通知只给路径，不给输出。** 模型用内置 `read` 自己决定读多少。→ §3.4
5. **输出落盘到 `<sessionDir>/bg-tasks/<sessionId>/<taskId>.output`。** 同一 cwd 的所有会话共用
   `sessionDir`，必须再按 session id 分一层，否则不同会话的 `bg-1` 会互相覆盖。→ §3.4
6. **输出上限靠监视文件大小来执行。** 子进程直接写 fd，扩展拦不到写入，"超限停写"做不到；
   改为每 2s 检查文件大小，超过 32MB 就 kill 任务并在文件尾追加截断标记。→ §3.4
7. **任务状态双写**：内存 Map（实时）+ `pi.appendEntry()`（跨 resume 重建）。→ §3.3
8. **session 结束一律杀掉后台进程，不提供 `keepAlive`。** `keepAlive` 意味着恢复后拿不到子进程
   句柄、只能轮询 pid、有 pid 复用风险、还会留孤儿——为一个少用的功能付出太多。→ §3.7
9. **Windows 是一等平台。** 本仓库主要在 Windows 上用（Git Bash）。Windows 上有三个
   POSIX 上不存在的坑，都已处理并有测试覆盖。→ §4.4
10. **system prompt 规则写成静态 `promptGuidelines`**，并且不能自相矛盾：禁止的是在 `bash`
    里用 `sleep` 等待，在 `bash_background` 里跑 `until …; do sleep 2; done` 是推荐做法。→ §3.6

---

## 1. 问题定义

### 1.1 pi 现状（代码事实）

| 事实 | 位置 |
|---|---|
| `bash` 工具 schema 只有 `command` + `timeout`（秒，可选，**无默认超时**），**没有** `run_in_background` | `pi/packages/coding-agent/src/core/tools/bash.ts:39-42` |
| bash 前台阻塞：`execute` 一直 await 到子进程退出才返回 | `bash.ts:110-194` |
| tool call **默认并行**——并行解决"同时跑"，不解决"不等" | `pi/packages/agent/src/agent-loop.ts:518-533` |
| 默认工具集在 Windows 上也是 `bash`（Git Bash），不是 `powershell` | `settings-manager.ts:85`、`utils/shell.ts` `getShellConfig()` |
| `getShellConfig()` 已从包入口导出；`killProcessTree` / `getShellEnv` **没有** | `pi/packages/coding-agent/src/index.ts:502` |
| session 目录按 cwd 共享（默认 `~/.pi/agent/sessions/<encoded-cwd>/`） | `session-manager.ts:1145` |
| `read` 支持绝对路径 → 模型可以直接读后台输出文件 | `pi/packages/coding-agent/src/core/tools/read.ts:14-18` |
| custom message 进 LLM 时转成 **`role: "user"`** | `pi/packages/coding-agent/src/core/messages.ts:162` |
| 空闲时 `sendMessage(..., { triggerTurn: true })` 直接起一轮 | `agent-session.ts:2481` |
| steer 队列默认**一轮只取一条**（`steeringMode: "one-at-a-time"`） | `settings-defaults.ts:7`、`agent/src/agent.ts:255` |
| `turn_end` / `agent_before_settle` 可以返回 `custom_message` 草稿 + `continue: true` | `docs/extensions.md:715-750`、`extensions/types.ts` `BoundaryResult` |
| `agent_settled` 时 `ctx.isIdle()` 为真，此时请求的新 run 在所有 settled handler 之后开始 | `docs/extensions.md:663-695` |
| `pi.appendEntry` 可持久化**不进 LLM 上下文**的数据 | `docs/extensions.md:1683-1699` |
| `pi.events` 是**扩展之间**共享的事件总线（同步分发） | `pi/packages/coding-agent/src/core/event-bus.ts` |

推论：**pi 的 agent 在一次 turn 里必须等所有前台 tool call 返回才能继续思考。**
并行 tool call 让它能同时发 3 个 bash，但最慢的那个不返回，它就没有下一步。

### 1.2 Claude Code 有、pi 没有的

| 能力 | Claude Code | pi |
|---|---|---|
| 命令可以后台跑 | `Bash` 工具带 `run_in_background: true` | 无 |
| 前台命令超时后自动转后台 | 按命令判定是否允许自动后台化 + 超时触发 | 无 |
| 任务注册表 | 全局任务表，可列出所有后台任务 | 无 |
| 任务状态 | app state 里保存着每个任务的状态 | 无 |
| 输出落盘 | 每个任务对应一个输出文件 | 只有 bash 自己的截断文件 `full_output_path` |
| 完成通知回灌模型 | `<task-notification>` XML 消息 | 无 |
| 用户侧查看 | `/tasks`（别名 `/bashes`）+ 底部 pill | 无 |
| 手动 kill | 模型可调用的 kill 工具 + 详情面板 `x` 键 | 只有 abort 当前 tool call |

### 1.3 现有绕法的代价

| 绕法 | 代价 |
|---|---|
| `sleep 60 && cat log` 前台轮询 | 每次轮询 = 一次 tool call + 一轮 LLM；token 线性增长；工具本身可能先超时 |
| `cmd &`（让 shell 自己后台） | 进程是 shell 的子进程，shell 退出后行为取决于实现；**没有任何完成信号**；模型只能继续瞎等 |
| 拆成多个短 tool call 轮询 | 同第一条 |
| 干脆不等，跑完整个项目再看 | 粒度太粗，改一点就要重跑 |

主流编码 CLI 直接把这条路堵死：`sleep N`（N ≥ 2）作为首命令会被工具校验层拒绝，
并明确告诉模型 "Run blocking commands in the background with `run_in_background: true`"。

---

## 2. 上游调研：Claude Code 的 background shell

调研对象：Claude Code 的公开可用行为。**本文档只记录行为层面的结论。**

### 2.1 任务注册表

**可用的任务类型是固定的一组，不是运行时动态长出来的。** 从使用上看，后台任务列表按类型分区
展示（本地 shell 命令、agent 任务等），可选能力要么出现在列表里，要么整个不见。

- **常驻类型**：本地 shell 命令、本地 agent、远端 agent 等，一直都在。
- **可选类型**：工作流类、monitor 类任务，只有对应能力可用时才会出现在列表里。
  两者都是「有则加入、无则跳过」，缺失不会报错。

**shell 任务的状态是"一个对象"，不是"两套机制"。** 每个 shell 任务的状态 =
「所有任务共有的公共字段」+ 下列 shell 专属信息：

| 信息 | 含义 |
|---|---|
| 命令原文 | 模型当初传进来的那条命令字符串 |
| 执行结果 | **只在进程结束后才存在**：含退出码，以及"被打断"与"跑完但失败"的区分。没有结果 = 还在跑 |
| 是否已后台化 | `false` = 还在前台跑着；`true` = 已转入后台 |
| UI 变体 | 可选，取「bash」或「monitor」；**纯展示层差异**，两者共用同一套执行机制 |

关键点：**后台化和前台是同一个任务对象的两种状态**，不是两套机制。
把一个已在跑的前台任务转后台是**原地改状态**而不是重新 spawn。

### 2.2 后台化的触发路径

1. 模型显式传 `run_in_background: true`
2. 命令跑超时 → 自动转后台（只对"允许自动后台化"的命令）
3. 用户按 Ctrl+B → 前台任务被后台化

### 2.3 输出落盘

- 每个任务一个输出文件 `<task dir>/<taskId>.output`
- 上限 5GB，超了追加截断标记；可以按 offset 增量读

**模型拿到的永远是一个路径，不是一坨输出。**

### 2.4 完成通知

```
<task-notification>
<task-id>abc123</task-id>
<tool-use-id>toolu_xxx</tool-use-id>
<output-file>/path/to/abc123.output</output-file>
<status>completed</status>
<summary>Background command "npm test" completed (exit code 0)</summary>
</task-notification>
```

- 走 **user 角色**的消息通道 → 对模型来说"用户又说话了"，是最不容易漏的信号
- 状态只有三种：`completed` / `failed` / `killed`，文案区分得很死
- 每个任务只会被通知一次
- monitor 的文案被刻意拆开：`Monitor "x" stream ended` ≠ `Background command "x" completed`

### 2.5 看门狗

- 每 5s 检查输出文件大小，45s 没增长就算"停滞"
- 停滞时 tail 最后 1024 字节，匹配 `y/n`、`Press any key`、`Continue?` 等交互提示特征
- 命中就给模型发一条"这条命令可能在等交互输入"的告警 + 最后输出
- monitor 类型的任务直接跳过

本设计列为 Phase 3。

### 2.6 用户侧查看

- `/tasks`（别名 `/bashes`）→ 打开后台任务面板
- 详情面板：状态、运行时长、输出 tail，`x` 杀掉运行中的任务
- 底部 pill：一行计数摘要，形如 `1 shell, 1 monitor`

### 2.7 Monitor：明确不做

| | bash | monitor |
|---|---|---|
| 语义 | 等它跑完（一次性通知） | stdout **每一行**都是一条通知 |
| 完成文案 | `completed` / `failed` / `was stopped` | `stream ended` / `script failed` / `stopped` |
| 看门狗 | 有 | 无 |

**不做它的三个理由**：

1. **逐行通知会炸上下文**。`tail -f` 一个啰嗦的日志就能淹掉 context。
2. **打断推理**。每一行都是一次插入，频率远高于"任务结束"这种一次性事件。
   （bash 通知同样走 steer、同样会插在两次工具调用之间，但一个任务只插一次，
   而且这时完成信息本身就有用——这是有意的取舍，不是双重标准。）
3. **官方自己还没默认开放**。

真正有价值的用法是"等到某个条件出现"，用 `bash_background` + `until cmd; do sleep 2; done`
就能拿到 80% 的价值，零新机制。

> 未来若要补 monitor，正确形态是**带 pattern 过滤 + 批量聚合 + 总量上限**，而不是逐行推送。

### 2.8 可借鉴 / 不可借鉴

| Claude Code 的做法 | 借鉴？ | 说明 |
|---|---|---|
| 任务注册表 + 状态机 | ✅ | pi 没有 app state，用内存 Map + `appendEntry` 代替 |
| 输出落盘 + 只给路径 | ✅ | |
| 完成通知走 user 消息 | ✅ | `pi.sendMessage` / boundary `custom_message`，进 LLM 时都是 user 角色 |
| 通知文案区分 completed / failed / killed | ✅ | 另加 `timeout` |
| 模型可调用的 kill 工具 | ✅ | `bg_kill` |
| `/tasks` 面板 + 详情 + `x` kill | ✅ | `/background` |
| 底部 pill 计数 | ✅ | `setStatus` + pi-hud 第一行 `\| 1 shell` |
| 看门狗（停滞检测） | 🕐 Phase 3 | |
| 单独的"读任务输出"工具 | ❌ | pi 用 `read` 就行 |
| 逐行 monitor 推送 | ❌ | 见 §2.7 |

---

## 3. 设计方案

### 3.1 数据流

```
模型                     扩展 (pi-background-shell)                操作系统
 │                              │                                     │
 │ bash_background(cmd)         │                                     │
 ├─────────────────────────────>│ spawn(stdout/stderr → 文件 fd)       │
 │                              ├────────────────────────────────────>│
 │ <─ {task_id, output_path} ───┤ 立刻返回，不等进程                    │
 │                              │                                     │
 │ (模型继续干别的)              │                                     │
 │                              │      进程退出                        │
 │                              │<────────────────────────────────────┤
 │                              │ 空闲：3s 窗口合并 → sendMessage       │
 │                              │ 忙：缓冲 → turn_end 边界一次排出       │
 │ <──── user 消息：<bg-task-notification> … ─────────────────────────┤
 │                              │                                     │
 │ read(output_path)            │                                     │
```

### 3.2 工具

#### `bash_background`

```ts
Type.Object({
  command: Type.String(),
  description: Type.Optional(Type.String()),   // 给用户看的短标签
  timeout: Type.Optional(Type.Number()),       // 秒，默认不限
})
```

返回（模型可见的 `content` 要短）：

```
Started background task bg-1: npm test
task_id: bg-1
output: C:\Users\me\.pi\agent\sessions\<enc-cwd>\bg-tasks\<sessionId>\bg-1.output
You will be notified automatically when it exits. Do not poll or sleep; continue with other work and read the output file once notified.
```

执行细节（`src/process.ts`）：

- shell 用 `getShellConfig(pi.getSettings().shellPath)`，和内置 bash 一致（Windows 上是 Git Bash）；
  旧版 WSL bash 走 stdin 传命令，同样支持
- stdout/stderr 直接接到输出文件的 fd，**不经 Node 管道**；父进程 spawn 后立刻关掉自己那份 fd
- 输出文件用 `"w"` 打开，**不能用 `"a"`**（§4.4）
- POSIX：`detached: true`，子进程自成进程组，kill 时对 `-pid` 发信号
- Windows：不 detached（只会多一个 console），`windowsHide: true`
- `child.unref()`：后台任务不拖住 pi 退出；pi 活着时 exit 事件照常到达
- 校验：空命令、cwd 不存在（否则 spawn 报的是误导性的 `spawn bash ENOENT`）、非法 timeout 直接报错

并发与配额：

| 限制 | 默认值 | 理由 |
|---|---|---|
| 同时运行的后台任务上限 | 8 | 超了报错，错误信息里列出正在跑的 id，提示用 `bg_kill` |
| 单任务输出文件上限 | 32 MB | 超了 kill 任务（§3.4） |
| 任务 id | `bg-<n>`，按会话递增，resume 后接着编号 | 短、好念 |

#### `bg_kill`

```ts
Type.Object({ task_id: Type.String() })
```

- kill 后最多等 5s 让进程退出，返回最终状态和运行时长
- 任务已经结束：返回它的最终状态，不报错；未知 id：报错并列出已知 id
- **模型自己 kill 的任务不再发完成通知**——它已经知道了，再唤醒一次纯属浪费

### 3.3 任务注册表

内存：`Map<taskId, BgTask>`（`src/task.ts`）：

```ts
interface BgTask {
  taskId: string
  command: string
  description?: string
  status: "running" | "completed" | "failed" | "killed" | "timeout"
  exitCode?: number
  reason?: string          // 非正常结束的原因（kill 来源、spawn 错误）
  startedAt: number
  endedAt?: number
  outputPath: string
  pid?: number
  notified: boolean        // 只在内存里，不持久化
}
```

持久化：`pi.appendEntry("bg-task", snapshot)`，启动和结束各写一条，**不进 LLM 上下文**。

恢复：`session_start` 时扫 `getEntries()`（不是 `getBranch()`：任务是进程级事实，不随分支变），
每个 task 取最后一条。还标着 `running` 的说明上一个 pi 进程已经没了（session 结束必杀，§3.7），
统一改成 `killed`（reason: `session ended`）并补写一条 entry。编号从最大的 `bg-<n>` 之后继续。

为什么不放在 tool result 的 `details` 里：`details` 会随分支重建、也会被渲染器扫到，
任务状态是纯 UI 关注点，用 `appendEntry` + `pi.events` 更干净。

### 3.4 输出文件

- 路径：`<sessionDir>/bg-tasks/<sessionId>/<taskId>.output`
  - `sessionDir` 是**按 cwd 共享**的，不按 session id 分层的话，新会话的 `bg-1` 会覆盖旧会话的 `bg-1`
- 格式：纯文本，stdout + stderr 混合（同一个 fd，顺序天然正确）
- 模型侧用内置 `read`，通知里是绝对路径
- **大小上限**：子进程直接写 fd，扩展拦不到写入，原设计的"超限停写"做不到。实际做法：
  有任务在跑时每 2s `stat` 一次输出文件，超过 32MB 就 kill（reason: `output exceeded the size limit`），
  进程退出后在文件尾追加 `[output truncated: exceeded 32MB, task killed]`。
  文件会略超 32MB（最多多出 2s 的输出），可以接受
- 清理：`session_start` 时异步扫 `bg-tasks/` 下**其他会话**的目录，删 3 天前的 `.output` / `.pid`，
  删空目录；当前会话目录不动；所有文件系统错误忽略

### 3.5 完成通知

文案（`formatNotification`）：

```
<bg-task-notification>
<task>
<task-id>bg-1</task-id>
<command>npm test</command>
<status>completed</status>
<exit-code>0</exit-code>
<duration>42s</duration>
<output-file>/abs/path/bg-1.output</output-file>
</task>
</bg-task-notification>

Background task bg-1 "npm test" completed (exit code 0).
Read the output file with the read tool if you need the result.
```

- 一条消息里可以有多个 `<task>` 块，摘要行每个任务一行
- 不放输出内容；命令超过 200 字符截断；XML 特殊字符转义
- 状态文案各不相同：`completed (exit code 0)` / `failed (exit code N)` /
  `was killed after reaching its timeout` / `was killed (stopped by the user)` 等
- `duration` 给绝对时长，不让模型做减法
- TUI 里用 `registerMessageRenderer` 渲染成一行：`● bg-1 npm test completed · 42s`，展开显示路径
- 两个工具的调用行用 `renderShell: "self"` 画成和 pi 紧凑工具行对齐的一行（`src/render.ts`），不套背景框：
  `● Background Bash (描述) · bg-1 running in background`、
  `● Background Interrupted (bg-7 · 描述) · Stopped · 1h11m`；展开（Ctrl+O）后显示完整命令和 output 路径。
  `bg_kill` 的 details 带 `label` / `runtimeMs` / `wasRunning`，没有这些字段的旧会话从结果文本第一行解析

**投递策略**（`src/batcher.ts` + `index.ts`）——这是本设计最关键的部分：

问题：pi 的 steer 队列默认一轮只取一条消息。例子：agent 正在干活，`build`、`lint`、`test`
三个后台任务先后结束，如果各自 `sendMessage(steer)`，模型要连续三轮各看到一条通知，
三次 LLM 调用。合并窗口在这里不起作用，因为三条消息已经进了 pi 的队列。

解法：**扩展自己持有缓冲，不把消息交给 pi 的队列，直到确定能一次送达。**

| agent 状态 | 行为 |
|---|---|
| 空闲，且没有其他任务在跑 | 立刻发：`sendMessage(..., { triggerTurn: true, deliverAs: "steer" })`——没有可合并的对象，等待纯属延迟 |
| 空闲，还有其他任务在跑 | 开一个 **3s 固定窗口**（从第一个任务结束起算，后来的任务不顺延）。窗口内结束的任务并入同一批；窗口内最后一个在跑的任务也结束了就提前发 |
| 忙（`!ctx.isIdle()`） | 不发，只进缓冲 |
| 忙 → `turn_end`（outcome 为 `completed`） | 缓冲非空时返回 `{ entries: [...event.entries, custom_message], continue: true }`，整批变成**一条** user 消息，下一次 LLM 调用就能看到 |
| 忙 → `agent_before_settle` | 同上（覆盖最后一个 turn_end 之后才结束的任务） |
| `agent_settled` | 缓冲仍非空（例如结束在 settle 之后）就 `sendMessage` 唤醒；如果这次 run 是用户 **Esc 中断**的，用 `triggerTurn: false` 只记入会话、不自动起新 run，模型在用户下一次输入时看到 |
| 窗口到点时 agent 已变忙 | 留在缓冲里，交给下一个边界 |

为什么窗口是 3s 而不是 250ms：后台任务通常跑几十秒到几分钟，多等 3s 不到 5%；而一起启动的任务
（build + lint、并行测试分片）经常在几秒内先后结束，250ms 基本合并不到，每漏一个就多一轮 LLM。
"没有其他任务在跑就立刻发"保证单任务场景零延迟。

哪些结束**不**通知模型：

| 结束方式 | 通知？ | 理由 |
|---|---|---|
| 自然退出（completed / failed） | ✅ | |
| timeout | ✅ | |
| 输出超限被 kill | ✅ | 模型需要知道结果被截断了 |
| 用户在 `/background` 面板 kill | ✅ | 模型可能以为 dev server 还活着 |
| 模型用 `bg_kill` kill | ❌ | 它自己做的 |
| session 结束被 kill | ❌ | 没有人可以通知了 |

每个任务只通知一次：交付时置 `notified`；manager 的 `finish` 本身也只会执行一次。

### 3.6 System prompt 规则

`promptSnippet` 让两个工具出现在 `<tools>` 段；`promptGuidelines` 挂到 `<rules>`，每条都点名工具：

```
- Use bash_background for commands expected to take more than ~30 seconds (builds, test suites, dev servers, deploys); it returns immediately with a task id and an output file path.
- When a bash_background task exits you are notified automatically with a <bg-task-notification> message. Do not poll it and do not run sleep in bash to wait for it; continue with other work or end your turn.
- Read a bash_background task's output with the read tool on the output file path from the notification; for long output read only the end.
- Use bash, not bash_background, for commands that finish within a few seconds; a background task costs an extra turn when it is reported.
- To wait for a condition such as a port opening, a file appearing or a log line, run a loop like `until <check>; do sleep 2; done` with bash_background. Never use sleep in bash to wait.
- Use bg_kill to stop a bash_background task you no longer need, such as a dev server, before you finish.
```

原设计里"不要用 `sleep N`"和"用 `until …; do sleep 5; done` 等条件"两条放在一起会让模型犹豫。
现在写清楚：禁止的是**在 `bash` 里** sleep 等待；在 `bash_background` 里用 sleep 循环是推荐做法。

规则是静态文本，不影响 prefix cache（§4.1）。pi 不改核心做不到硬拦 `sleep N`，靠 prompt 覆盖。

### 3.7 生命周期

| 事件 | 行为 |
|---|---|
| 工具启动 | spawn，登记任务，`appendEntry(running)`，广播状态 |
| 进程退出 | 置终态 → `appendEntry` → 广播状态 → 按 §3.5 进缓冲 |
| 到达 `timeout` | kill → 状态 `timeout` → 通知 |
| 模型 abort 当前 turn | **不影响**已后台的任务 |
| `session_shutdown`（quit / reload / new / resume / fork） | kill 所有在跑任务，不通知；清空缓冲；关闭后不再碰旧的 `pi` / `ctx` |
| pi 进程退出（含信号、崩溃前的正常 exit 路径） | `process.on("exit")` 里**同步** kill 所有仍在跑的任务 |
| pi 被 `kill -9` / 任务管理器强杀 | 子进程变孤儿（**已知限制**，§5） |
| `pi -p` / `--mode json` | 一次性运行，回合结束 pi 就退出、任务被杀，通知不可能送达 → `session_start` 时把两个工具从 active tools 里移除 |

kill 的实现（`killTree` / `killTreesSync`）：

- **POSIX**：`process.kill(-pid, SIGTERM)`，2s 后 `SIGKILL`；退出钩子里直接 `SIGKILL`
- **Windows**：两步，缺一不可（§4.4）
  1. Git Bash 启动时第一行写出自己的 MSYS pid（`printf '%s' "$$" > <taskId>.pid`），
     kill 时执行 `bash -c "kill -9 -- -<pgid>"`——MSYS 里 `$$` 就是进程组 id，能杀到
     taskkill 看不见的 MSYS 子进程，约 45ms
  2. `taskkill /F /T /PID <launcher>`，杀原生子进程（node、cargo 等）
  - 两个 killer 都 `detached` + `unref()` 启动：`session_shutdown` 之后 pi 可能马上退出，killer 必须活得比 pi 久
  - 退出钩子里用 `spawnSync`，多个任务合并成一次 MSYS kill + 一次 taskkill
- 每个任务只发一次 kill：taskkill 在本机单次约 1.1s，输出监视器每 2s 一查，不去重会叠出一串 taskkill
- 关闭会话后，`exit` 钩子保留到最后一个被 kill 的任务真正退出才摘掉

### 3.8 用户侧：`/background` 面板与状态

界面约定（与 pi-subagent 一致）：**选择列表在底部，长内容详情用浮层。**

- 列表短、只用来挑任务：放在编辑器的位置（`ctx.ui.custom()` 不带 `overlay`，和 pi 内置的
  选择器一样），上方的对话记录保持可见；关闭后 pi 恢复编辑器和其中的文字
- 详情是长内容（输出可能上千行）：需要限定高度、自己滚动、支持滚轮，所以用浮层
  （`overlay: true`，宽 90%、高至多 80%、居中）。浮层关闭时 pi 把焦点还给打开它之前的组件，
  也就是列表——列表不用关闭再重开，选中项也不变

列表（`src/panel.ts`），在底部：

```
─ Background tasks ──────────────── 1 running, 3 total ─

▎ bg-1   running     2m13s  npm run dev
  bg-2   completed     42s  npm test
  bg-3   failed         3s  cargo build

↑↓ select · enter details · x kill · esc close
```

按下第一次 `x` 后（kill 确认，见本节末尾），选中行和提示行变成：

```
▎ bg-1   running     2m13s  npm run dev          ← error 色竖标，toolErrorBg 底色

press x again to kill · any other key cancels    ← error 色
```

选中行用两层标记：行首的 accent 竖标 `▎`，加上铺满整行的主题选中底色（`selectedBg`）。
这是和 `/agents` 列表、HUD 焦点模式选中行同一套写法（约定见 `pi-hud/DESIGN.md` §2.1）；底色上的弱化文字用 `muted`，
否则比终端背景浅的底色会让它糊掉——时长是这样，状态色本身是 `dim` 的 `killing` 也是这样。
状态色按 pi-shizuku 的 `design_style.md` §3：`running` accent，`completed` success，`failed` / `timeout` error，`killed` warning（没跑完，但不是失败）。

详情浮层（`src/detail.ts`），盖在列表上：

```
╭─ Shell details · bg-1 ──────────────────────────────────────╮
│ Status   running                                            │
│ Runtime  2m13s                                              │
│ Command  npm run dev                                        │
│ Output   /…/bg-tasks/<sessionId>/bg-1.output                │
│ ── output · 1840 lines ──                                   │
│   VITE v5.4.0  ready in 312 ms                              │
│   ➜  Local:   http://localhost:5173/                        │
│ …                                                           │
│ paused at 1200/1840 · end to follow · ↑↓/wheel scroll · …   │
╰─────────────────────────────────────────────────────────────╯
```

- 列表每秒刷新运行时长；`esc` / `q` 关闭面板
- 列表限高，和 `/agents` 一样：pi 不限制编辑器位置组件的高度，任务一多会把对话区顶出屏幕。一次最多显示
  `min(10, 终端行数 × 40%)` 个任务（至少 3 个），窗口跟着选中行走，被挡住的数量用 `↑ N more` / `↓ N more` 标出
- `enter` 打开选中任务的详情浮层；同一时间只开一个
- 详情：表头是状态、退出码、原因、运行时长、命令、标签、输出路径，下面是输出 tail
  - 读文件尾 256KB、最多 2000 行，去掉 ANSI / OSC 转义和控制字符，tab 换成空格；
    从文件中间开始读时丢掉第一行残行，并在顶部提示前面还有输出和完整日志的路径
  - 长行按浮层宽度折行，不截断
  - 浮层固定高度（终端行数的 80%）：居中的浮层若随输出变高，每来一行就会上下跳。
    表头固定，输出区滚动；终端太矮时先让出表头，输出区至少留 3 行
  - `↑↓` / `PgUp` `PgDn` / `Home` `End` / 滚轮滚动
  - 跟随模式（tail -f）：打开时停在底部，有新输出就继续贴底；向上滚动后停止跟随，
    提示行显示 `paused at 行/总行 · end to follow`；按 `End` 或滚回底部恢复跟随
  - 每秒刷新；文件大小和修改时间都没变时不重读
  - `esc` / `q` 只关闭详情，回到列表
- `x x` kill 选中的运行中任务（列表和详情里都可以），见下面的「kill 确认」
- 非 TUI 模式（RPC）：`/background` 用 `notify` 输出纯文本列表

**kill 确认：`x x`**

问题：`x` 一按就 kill，dev server 这类任务被误杀后要重新起，正在跑的构建、测试也白跑了。

取舍：确认键用 `x` 而不是 `y`。连按两次同一个键（同 vim 的 `dd`）手指不用动，提示一句话讲清楚；
`y` 在这个界面里没有别的用处，读起来像弹了一个 y/n 对话框，太重。按住 `x` 时键盘自动重复会连发，
但自动重复要按住约 0.25–0.5 秒才开始，不做防抖。和 pi-subagent 的停止确认是同一套规则（它的 `docs/07-ui.md` §4.4），
状态机在两个包里各写一份（`src/kill-confirm.ts`），不为几十行代码引入共享依赖。

1. **确认态的样子**：选中行竖标从 accent 换成 `error` 色，选中底色从 `selectedBg` 换成主题已有的 `toolErrorBg`
   （明度和 `selectedBg` 同级，选中行里弱化文字升 `muted` 的规则照样适用）；提示行整行换成 error 色的
   `press x again to kill · any other key cancels`。详情浮层没有选中行，只换提示行。不自己算"深一级"的底色：深浅主题方向相反。
2. **确认态下的按键**：`x` kill；`↑↓`（详情里还有 `PgUp` `PgDn` `Home` `End` 和滚轮）取消并照常移动；
   其他任何键只取消——`esc` / `q` 不关列表或浮层，`enter` 不打开详情（手指正处在"确认"状态，`enter` 很可能是下意识按的）。
3. **确认绑在 taskId 上，不绑行号**。下面任一情况发生就自动取消：任务自己退出了、别处（`bg_kill`、超时、输出超限）已经发出 kill、
   选中项变了、列表或浮层关闭。
4. **不加超时**：确认态足够醒目；有超时反而会出现"第二次按慢了，又进了一次确认"。
5. **已发出 kill 的任务不能再确认**：kill 是异步的，Windows 上 taskkill 约 1s，这期间 `status` 仍是 `running`。
   `TaskManager.canKill()` 看 runtime 上是否已有 kill 原因；已有时列表状态列和详情 Status 显示 `killing`（列表里用弱化色），
   提示行不再给 `x kill`，`x` 什么也不做。
6. **开关**：`~/.pi/agent/pi-background-shell.json` 的 `confirmKill`，默认 `true`，session 开始时读取；设为 `false` 回到一次就 kill。

状态：`ctx.ui.setStatus("pi-background-shell", "1 shell")`，没有任务在跑时清除。
内置 footer 会显示它；装了 pi-hud 时 footer 被替换，由 pi-hud 自己显示（§3.9）。

### 3.9 HUD 集成

pi-hud 的工具行只统计"顶层工具调用"，`bash_background` 返回后就算完成，看不到"还有几个在跑"。

跨扩展通信用 `pi.events`：

| 频道 | 方向 | 载荷 |
|---|---|---|
| `bg:state` | pi-background-shell → 订阅者 | `{ running: number }`，每次任务数变化、会话开始和结束时发 |
| `bg:state:request` | 订阅者 → pi-background-shell | 无；收到后立即重发一次 `bg:state` |
| `bg:open` | 订阅者 → pi-background-shell | 无；打开 `/background` 列表，等同执行该命令。列表已经打开、或不在 TUI 模式时忽略 |

加载顺序不确定：pi-hud 的 `session_start` 可能在本插件广播之后才订阅。所以 pi-hud 订阅后
主动发一次 `bg:state:request`；两种顺序都能拿到当前值。两边都在 `session_shutdown` 退订。

pi-hud 在**第一行末尾**追加，只在有任务在跑时显示：

```
[deepseek/deepseek-flash | max] | demo-app git:(main) | 1 shell
[deepseek/deepseek-flash | max] | demo-app git:(main) | 2 shells
```

全屏模式下点击 `N shells`，pi-hud 发 `bg:open`，弹出 `/background` 列表。只做点击，不做悬停态：
pi-tui 不给组件发"指针离开"事件，要判断离开只能补丁渲染器的私有方法，太脆弱。

没装本插件时 pi-hud 收不到事件，行为不变。

### 3.10 明确不做的事

| 不做 | 理由 |
|---|---|
| monitor（逐行推送） | §2.7 |
| `keepAlive`（session 结束后保留进程） | §0.2 结论 8 |
| 给内置 `bash` 加 `run_in_background` | 需要动 pi 核心（§4.3） |
| 停滞看门狗 | Phase 3（§2.5） |
| 任务优先级 / 并发上限的自适应 | YAGNI |
| 把输出内容塞进通知 | §0.2 结论 4 |
| 自然退出后清理残留子进程 | 与 POSIX 和 Claude Code 行为一致：shell 正常退出就算任务结束，它自己 `&` 出去的进程归它自己 |

---

## 4. 约束与取舍

### 4.1 prompt cache 是硬约束

pi 的 system prompt 是 sections + diff 机制，只有 section 变了才发 patch。

→ **本设计的动态内容一律不进 system prompt**：规则文本静态；任务状态、通知全部走对话消息（末尾）。
print / json 模式移除工具发生在 `session_start`，第一次请求之前，不会产生额外 patch。

### 4.2 上下文成本

每次唤醒的固定成本 ≈ 通知 XML（~80 token / 任务）+ 模型读输出的内容。
通知本身会触发一次 LLM 调用，所以有"短命令别后台化"的规则（§3.6），
以及"每批任务只唤醒一次"的投递策略（§3.5）。

### 4.3 为什么不改内置 bash

| 方案 | 评价 |
|---|---|
| 扩展里注册独立工具 `bash_background` | ✅ 采用。语义清晰、零侵入、可独立测试 |
| 改 pi 核心给 `bash` 加 `run_in_background` | 最干净，但要动 submodule；可以后续在 pi 上游提 PR |
| 用 `tool_call` 事件拦截内置 bash、改写参数 | ❌ 内置 bash schema 没有这个字段，模型不会传；硬塞要重写整条执行路径 |
| 包装内置 bash（`ctx.executeTool("bash", …)`） | ❌ 内置 bash 是阻塞的，包一层还是阻塞 |

### 4.4 平台差异

Windows（Git Bash）上实测发现三个 POSIX 上不存在的坑，均有测试覆盖：

| 坑 | 现象 | 处理 |
|---|---|---|
| 追加模式句柄 | 用 `"a"` 打开的文件句柄没有 `FILE_WRITE_DATA`，MSYS 程序写不进去：`echo hi` 直接 exit 1、输出为空 | 输出文件用 `"w"` 打开（文件名按任务唯一，不存在追加需求） |
| MSYS 进程脱离 Windows 进程树 | Git Bash 启动 `sleep`、`tail` 等 MSYS 程序时经过一个立即退出的中间进程，子进程的父 pid 指向已不存在的进程，`taskkill /T` 找不到它。实测 `sleep 30; echo` 被 kill 后 `sleep.exe` 仍在；`tail -f` 会永久泄漏。原生程序（node、npm、cargo）不受影响 | §3.7 的两步 kill：MSYS 进程组 kill + taskkill |
| taskkill 慢 | 单次约 1.1s | 每任务只发一次 kill；killer detached 启动；退出钩子合并成一次调用 |

| | POSIX | Windows |
|---|---|---|
| spawn | `detached: true` → 新进程组 | 不 detached，`windowsHide: true` |
| kill 整组 | `kill(-pid, SIGTERM)`，2s 后 `SIGKILL` | MSYS `kill -9 -- -<pgid>` + `taskkill /F /T` |
| shell | `getShellConfig()` | `getShellConfig()`（Git Bash，与内置 bash 一致） |

测试在 Windows 上实跑通过（本仓库主力平台）；POSIX 分支代码路径更简单，但本次没有在 Linux/macOS 上实跑。

### 4.5 安全边界

- 扩展执行的是**模型本来就能用 `bash` 执行的命令**，不引入新的执行面
- 输出文件写在 session 目录（用户自己的目录），不写 `/tmp` 共享目录
- session 结束必杀，不留后台进程
- 不做任何网络访问

### 4.6 与用户手打 `!` 的关系

pi 的 `!` / `!!` 是**用户**在前台执行的 shell，不走本插件。

---

## 5. 失败模式与边界

| 情况 | 后果 | 缓解 |
|---|---|---|
| pi 被 `kill -9` / 强杀 | `exit` 钩子不运行，子进程变孤儿 | 无（**已知限制**） |
| 任务刚启动几毫秒就被 kill（Windows） | shell 还没写出 MSYS pid、或正在创建子进程，新子进程可能落在 taskkill 的快照之外 | 正常使用中极少发生；pi 内置 bash 的 abort 也有同样的竞态 |
| 任务自己 `setsid` / 改进程组 | MSYS 组 kill 和 POSIX 组 kill 都够不到 | 无（**已知限制**） |
| 输出极大（日志狂刷） | 占磁盘 | 32MB 上限 + kill + 截断标记；最多多出 2s 的输出 |
| 模型丢下一堆后台任务不管 | 资源占用 | 并发上限 8；`/background` 面板 kill；session 结束全杀 |
| 通知时模型正在跑一个长阻塞的前台 tool call | 通知等到这个 turn 结束才送达 | 与 steer 语义相同，记录为已知限制 |
| 任务在 compaction 期间结束 | — | 期间 `isIdle()` 为假，进缓冲，compaction 后的边界送达；输出文件在磁盘上 |
| 同一命令被反复后台化（多个 dev server 抢端口） | 后一个失败退出 | 通知里有退出码，模型自己处理 |
| 后台任务改了工作区文件，模型同时在改 | 竞态 | 不做保护（后台任务不是 tool，不参与文件队列） |
| `/reload` | 扩展实例重建，后台任务被 kill | 与 `/new` 一致；跨实例保留子进程句柄得不偿失 |

---

## 6. 与上游的关系

本设计**不替代** pi 任何现有机制，是叠加：

- pi 的 `bash`（前台）→ 本插件补上"**不阻塞**"的那一维
- pi 的 `read` → 直接复用读取输出文件
- pi 的 `sendMessage` / boundary 草稿 / `appendEntry` / `events` → 分别对应
  空闲通知 / 忙时通知 / 任务持久化 / 状态分发

与本仓库其它插件的关系：

- `pi-hud`：可选集成（§3.9），双方互不依赖
- `pi-timepass`：`session_shutdown` 的清理时机类似，但互不干涉

---

## 7. 实现清单

### Phase 1 · 纯扩展，零上游改动 ✅

- [x] `bash_background`：spawn + 输出直接落盘 + 立刻返回 task id / 路径
- [x] `bg_kill`：模型自己收尾；自杀的任务不再通知
- [x] 任务注册表：内存 Map + `appendEntry` 持久化 + `session_start` 重建、续编号
- [x] 通知投递：空闲 3s 固定窗口 / 无其他任务立刻发 / 忙时缓冲到 `turn_end`、`agent_before_settle` 一次排出 / `agent_settled` 兜底 / Esc 中断不自动起 run
- [x] `promptSnippet` + 六条 `promptGuidelines`
- [x] `timeout` 参数 + 超时 kill
- [x] session 结束全杀；`exit` 钩子同步兜底
- [x] 并发上限 8；输出 32MB 上限（监视文件大小 + kill + 截断标记）
- [x] Windows：`"w"` 打开输出文件；MSYS 进程组 kill + taskkill；killer detached
- [x] print / json 模式移除两个工具
- [x] `renderCall` / `renderResult` / 通知的 message renderer

### Phase 2 · 用户可见性 ✅

- [x] `/background` 面板：底部列表 + 详情浮层（可滚动的输出 tail、跟随模式、滚轮）、`x` 直接 kill；非 TUI 输出纯文本
- [x] `ctx.ui.setStatus()`：`1 shell` / `2 shells`
- [x] `pi.events`：`bg:state` + `bg:state:request`；pi-hud 第一行追加 `| 1 shell`
- [x] 输出文件按天清理（启动时扫其他会话目录，删 3 天前的 `.output` / `.pid`）

### Phase 3 · 可选 / 需要上游

- [ ] 停滞看门狗（§2.5）：45s 无增长 → tail 1024B → 匹配交互提示 → 告警
- [ ] `bg_list` 工具：长会话里模型忘了 id 时用（目前靠通知和 `bg_kill` 的报错列出已知 id）
- [ ] 扩展内置 `bash`：超时自动转后台（需要上游改动）
- [ ] 给 pi 核心提 PR：`bash` 工具加 `run_in_background`

### 测试（`npm test`，vitest，Windows 实跑通过）

- `batcher.test.ts`：空闲立刻发、固定窗口合并且不顺延、最后一个任务结束提前发、忙时不发只等边界、窗口到点时已变忙则留给边界
- `manager.test.ts`（真实进程）：完成/失败/超时、`bg_kill` 不通知、用户 kill 通知、整棵进程树被杀、Windows 上 taskkill 看不见的 MSYS 进程被杀且 `.pid` 文件被删、并发上限、非法参数、输出超限 kill + 截断标记、shutdown 不通知、restore 关闭遗留任务并续编号
- `index.test.ts`（假 `pi` + 真实进程）：两个任务只唤醒一次、忙时 `turn_end` 合并成一条 `custom_message` 且不重复、Esc 中断只记录不起 run、`bg_kill` 不通知、print 模式移除工具、`bg:state` 广播与 request 重发
- `task.test.ts`：时长格式、通知不含输出、各状态文案、多任务合并、XML 转义
- `cleanup.test.ts`：删旧留新、跳过当前会话、删空目录、根目录不存在
- `panel.test.ts`（假 `ctx.ui.custom`）：列表不带 overlay 打开、`enter` 以浮层参数打开详情且列表不关、不重复打开、详情 `esc` / `q` 只关详情且选中项不变、`x` 直接 kill、非 TUI 文本
- `detail.test.ts`：浮层高度为终端 80% 且不超出、矮终端让出表头、跟随模式随输出贴底 / 上滚停止 / `End` 与滚回底部恢复、翻页 / `Home` / 滚轮、折行与截断提示、`x` 直接 kill、`esc` / `q` 关闭；`readTail` 去转义、丢残行、行数上限；缓存只在文件变化时重读

尚未覆盖：在真实 pi 进程里跑完整唤醒链路（需要真实模型）；POSIX 平台实跑。

---

## 8. 参考

### pi（`pi`，v1.5.2）

| 主题 | 路径 |
|---|---|
| bash 工具 | `pi/packages/coding-agent/src/core/tools/bash.ts` |
| shell 配置 / 进程树 kill | `pi/packages/coding-agent/src/utils/shell.ts` |
| `sendCustomMessage` 投递语义 | `pi/packages/coding-agent/src/core/agent-session.ts:2447-2496` |
| custom message → user 角色 | `pi/packages/coding-agent/src/core/messages.ts:162` |
| steer 队列与 turn 边界 | `pi/packages/agent/src/agent-loop.ts:180-310`、`agent/src/agent.ts:255` |
| 默认 `steeringMode` | `pi/packages/coding-agent/src/core/settings-defaults.ts:7` |
| 事件总线 | `pi/packages/coding-agent/src/core/event-bus.ts` |
| 扩展 API 文档 | `pi/packages/coding-agent/docs/extensions.md` |
| TUI 组件文档 | `pi/packages/coding-agent/docs/tui.md` |

### 相关仓库

| 主题 | 位置 |
|---|---|
| 插件约定 | [pi-shizuku](https://github.com/AoShizuku/pi-shizuku) 的 `README.md` |
| HUD 插件（可选集成方） | [pi-hud](https://github.com/AoShizuku/pi-hud) |

## 9. 设置面板接入

`pi-background-shell.json` 唯一的字段 `confirmKill` 通过 pi-shizuku-settings 协议（`src/shizuku-settings.ts`，从 pi-shizuku-settings 原样复制）暴露给 `/shizuku` 面板。
面板改值时只覆盖这一个字段、保留文件里的其他键，写回 `~/.pi/agent/pi-background-shell.json` 后同时替换当前会话的配置，即时生效；文件存在但不是合法 JSON 对象时拒绝写入，避免覆盖手写内容。
