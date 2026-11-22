# pi-background-shell

给 pi 补上**后台任务**能力的扩展：模型把长命令丢到后台跑，立刻继续干别的，
任务结束时 agent 被自动唤醒。

## 做什么

- `bash_background`：把预计要跑几十秒以上的命令（`npm test`、`cargo build`、`npm run dev`）
  丢到后台，**立刻**返回 `task_id` 和输出文件的绝对路径
- 进程退出时，扩展往对话里投一条 `<bg-task-notification>`（进 LLM 时是 user 角色），
  **把 agent 唤醒**；模型用 `read` 读输出文件，再决定下一步
- `bg_kill`：模型自己停掉不再需要的任务（比如 dev server）
- `/background`：底部弹出任务列表（和 pi 内置选择器一样占编辑器的位置）；`enter` 打开详情浮层，
  可滚动查看输出尾部（`↑↓` / `PgUp` `PgDn` / `Home` `End` / 滚轮，停在底部时像 `tail -f` 一样跟随新输出），
  `esc` 回到列表；`x x` kill 运行中的任务（列表和详情里都行）：第一次 `x` 只进入确认态，
  再按 `x` 才 kill，按其他任何键都只取消
- 和 pi-hud 联动：第一行末尾显示 `| 1 shell`；全屏模式下点击它打开 `/background` 列表

## 安装

```bash
cd pi-background-shell
npm install
pi install npm:@aoshizuku/pi-background-shell                # 从 npm 安装
pi install git:github.com/AoShizuku/pi-background-shell     # 或从 GitHub 安装
pi install ./pi-background-shell
```

只试一次：

```bash
pi -e ./pi-background-shell/src/index.ts
```

## 关键行为

| 点 | 做法 |
|---|---|
| 执行 | 用和内置 `bash` 相同的 shell（Windows 上是 Git Bash），stdout/stderr 直接落盘到 `<sessionDir>/bg-tasks/<sessionId>/<taskId>.output` |
| 通知内容 | **只给路径和状态，不给输出** |
| 合并唤醒 | agent 空闲：3s 固定窗口合并（没有其他任务在跑就立刻发）；agent 忙：缓冲到 turn 边界合并成一条。每批任务只唤醒一次 |
| 不通知的情况 | 模型自己 `bg_kill` 的任务、session 结束时被杀的任务 |
| 限制 | 同时最多 8 个任务；单任务输出超过 32MB 会被 kill 并在文件尾标记截断；可选 `timeout`（秒） |
| 清理 | session 结束（退出、`/new`、`/resume`、`/fork`、`/reload`）一律杀掉后台进程；3 天前的输出文件在启动时删除 |
| 一次性模式 | `pi -p` / `--mode json` 下不启用这两个工具（pi 跑完就退出，通知送不到） |

**不做 monitor**（每行 stdout 一条通知）——上下文成本高、会打断推理。
要"等某个条件"，用 `bash_background` 跑 `until <check>; do sleep 2; done`。

Windows 上有几处特殊处理（输出文件打开模式、Git Bash 的 MSYS 子进程脱离进程树、taskkill 慢），
见 [DESIGN.md](./DESIGN.md) §4.4。

## 配置

`~/.pi/agent/pi-background-shell.json`（可选，session 开始时读取）：

```json
{
  "confirmKill": true
}
```

`confirmKill`：`/background` 列表和详情浮层里 `x` 要按两次才 kill（类似 vim 的 `dd`）。第一次 `x` 让选中行变成红色竖标加错误底色，
提示行换成 `press x again to kill · any other key cancels`；`↑↓` 取消并移动，其他任何键（包括 `esc`、`enter`）只取消。
默认 `true`，设为 `false` 回到按一次就 kill。文件不存在、读不了或值类型不对时用默认值。

已经发出 kill、进程还没退出的任务（Windows 上 taskkill 约 1s）显示为 `killing`，这期间 `x` 不再响应。

## 开发

```bash
npm install
npm run typecheck
npm test        # 会真实 spawn 进程；Windows 上需要 Git Bash
```

## 文档

- **[DESIGN.md](./DESIGN.md)** —— 设计方案：问题定义、Claude Code 调研、通知投递策略、
  生命周期与 kill、平台差异、失败模式、实现清单

## 许可

MIT

---

本插件属于 Shizuku 系列 pi 插件（[pi-shizuku](https://github.com/AoShizuku/pi-shizuku)）：共用的左栏、设计语言与跨插件约定见总仓库。贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。
