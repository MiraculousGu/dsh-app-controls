<a name="english"></a>

**Language / 语言:** [English](#english) · [中文](#中文)

# dsh-app-controls

Adds two controls to the DeepSeek Harness (DSH) Web GUI: **quit the local `dsh web` service** and **check / update DSH**. The update flow installs a newer version through a staging copy and an atomic swap, shows a progress dialog, then exits the service and closes the window.

## Plugin information

| Field | Value |
| --- | --- |
| Name | `dsh-app-controls` (DeepSeek Harness app controls) |
| Version | `0.2.0` |
| Author | Tianrun Gu ([@MiraculousGu](https://github.com/MiraculousGu)) |
| Environment | DeepSeek Harness `0.2.2-rc.x` **Web profile** (currently `0.2.2-rc.3`); Linux + KDE desktop, Chrome `--app` window; Node.js 20+ |
| Features | ① **Check and update DSH**: confirm, download/install in the background, progress dialog with phase / percent / elapsed time / npm activity, atomic swap, exit and close the window. ② **Quit DSH**: confirm, gracefully stop the whole local `dsh web` service, and close the window. |
| Repository | https://github.com/MiraculousGu/dsh-app-controls |
| License | MIT |

## Where the buttons appear

- **While a conversation is open**: the right side of the conversation title bar.
- **Main interface / Plugins page / other pages**: a floating control at the top-right of the window (just left of the right-sidebar toggle).
- Only one entry point is shown at a time — the two placements never duplicate each other.

## Features

### Check and update DeepSeek Harness

1. Queries the npm registry and determines the newest version allowed by the running installation (this install tracks `^0.2.2-rc.1`, which currently resolves to `0.2.2-rc.3`).
2. Shows the current → new version in a dialog; after confirmation a progress dialog appears with phase, percentage, elapsed time and the latest npm activity line.
3. Installs the new version into a **staging copy** of the installation root, verifies the version, then atomically swaps it in. The live files stay untouched until that final swap.
4. On success the service exits and the window closes; relaunch with the desktop shortcut to run the new version.

> The install-phase percentage is estimated from the previous successful update duration (npm exposes no fine-grained progress). The phase, elapsed time and npm log line are real.

### Quit DeepSeek Harness

After a confirmation dialog it calls DSH's `appExit(0)` to gracefully shut down the whole local service (HTTP/WebSocket, session flush, child processes), then closes the window automatically. In a normal browser tab (where scripts cannot close the tab) the screen shows a manual-close hint instead.

## Install

```sh
# From a local directory (link: install)
dsh plugin --profile web add /path/to/dsh-app-controls

# Or from GitHub (git spec, when supported)
dsh plugin --profile web add github:MiraculousGu/dsh-app-controls
```

Restart `dsh web` once after installing (or wait for HMR recomposition and refresh the page). Uninstall with:

```sh
dsh plugin --profile web remove dsh-app-controls
```

## Security and limitations

- The buttons call exact routes below `/api`; they inherit DSH's Host/Origin fence, signed browser cookie and owner-peer checks. Unauthenticated requests receive 401.
- Quit and update are refused when the deployment accepts non-loopback authorities (`trustedHosts` / remote access).
- Quitting or updating interrupts every open session and any in-flight agent turn; persisted session history is kept.
- The update targets the installation root of the running process. This project's desktop launcher uses the stable directory `~/.local/share/dsh-runtime`, so updates are not reverted by npx's `latest`-tag resolution.
- The main-interface overlay is hidden automatically whenever the conversation-header controls are mounted (CSS `:has()`).

## Development and tests

No build step: the client half is a hand-written lazy-CJS bundle.

```sh
node test/mock.test.mjs
```

Logs: `~/.local/state/dsh-app-controls/app-controls.log`.

## License

MIT © 2026 Tianrun Gu. See [LICENSE](LICENSE).

---

<a name="中文"></a>

**Language / 语言:** [English](#english) · **中文**

# 中文说明

为 DeepSeek Harness（DSH）Web 界面增加两个控制：「**退出本地 `dsh web` 服务**」和「**检查并更新 DSH**」。更新通过副本安装 + 原子切换完成，带进度弹窗，完成后退出服务并自动关窗。

## 插件信息

| 项目 | 内容 |
| --- | --- |
| 名称 | `dsh-app-controls`（DeepSeek Harness 应用控制） |
| 版本 | `0.2.0` |
| 作者 | Tianrun Gu（[@MiraculousGu](https://github.com/MiraculousGu)） |
| 适用环境 | DeepSeek Harness `0.2.2-rc.x` 的 **Web profile**（当前 `0.2.2-rc.3`）；Linux + KDE 桌面、Chrome `--app` 应用窗口；Node.js 20+ |
| 功能 | ① **检查并更新 DSH**：确认后后台下载安装，进度弹窗显示阶段 / 百分比 / 已用时 / npm 活动日志，完成后原子切换、退出服务并自动关窗。② **退出 DSH**：确认后优雅结束整个本地 `dsh web` 服务并自动关窗。 |
| 仓库 | https://github.com/MiraculousGu/dsh-app-controls |
| 许可证 | MIT |

## 按钮位置

- **对话打开时**：对话标题栏右侧的工具区。
- **主界面 / 插件页等其他页面**：窗口右上角的悬浮控件（位于右侧边栏开关左侧）。
- 同一时间只显示一处，不会重复出现。

## 功能

### 检查并更新 DeepSeek Harness

1. 查询 npm registry，确定当前安装允许更新的最新版本（本安装跟踪 `^0.2.2-rc.1`，当前解析为 `0.2.2-rc.3`）。
2. 弹窗显示当前版本 → 新版本；确认后进入进度弹窗（阶段、百分比、已用时、npm 活动日志）。
3. 把新版本安装到安装根目录的**副本**中，校验版本后原子切换；切换前运行中的文件不受影响。
4. 成功后自动退出服务并关闭窗口，用桌面快捷方式重新启动即为新版本。

> 安装阶段的百分比按上一次成功更新的耗时估算（npm 不提供细粒度进度）；阶段、耗时与 npm 日志是真实信息。

### 退出 DeepSeek Harness

确认后调用 DSH 的 `appExit(0)` 优雅结束整个本地服务（关闭 HTTP/WebSocket、落盘会话、终止子进程），随后自动关闭窗口。若窗口是普通浏览器标签页（脚本不允许关闭），会显示手动关闭提示。

## 安装

```sh
# 本地目录安装（link: 方式）
dsh plugin --profile web add /path/to/dsh-app-controls

# 或从 GitHub 安装（支持 git spec 时）
dsh plugin --profile web add github:MiraculousGu/dsh-app-controls
```

安装后重启一次 `dsh web`（或等待 HMR 重组并刷新页面）。卸载：

```sh
dsh plugin --profile web remove dsh-app-controls
```

## 安全与限制

- 按钮对应的路由位于 `/api` 下，继承 DSH 的 Host/Origin 防护、签名 cookie 与 owner 校验；未认证请求返回 401。
- 当部署允许非本机 authority（`trustedHosts` / 远程访问）时，退出与更新会被拒绝。
- 退出或更新会中断所有会话与正在生成的回合；会话历史已持久化。
- 更新目标为当前进程所在的安装根目录。本项目的桌面启动器使用稳定目录 `~/.local/share/dsh-runtime`，因此不会被 npx 的 `latest` 标签校验回退。
- 当会话标题栏控件挂载时，主界面右上角的悬浮控件会通过 CSS `:has()` 自动隐藏。

## 开发与测试

无构建步骤：客户端半为手写 lazy-CJS bundle。

```sh
node test/mock.test.mjs
```

日志：`~/.local/state/dsh-app-controls/app-controls.log`。

## 许可证

MIT © 2026 Tianrun Gu，详见 [LICENSE](LICENSE)。
