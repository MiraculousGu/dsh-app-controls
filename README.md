<a name="english"></a>

**Language / 语言:** [English](#english) · [中文](#中文)

# dsh-app-controls

Adds two controls to the DeepSeek Harness (DSH) Web GUI: **quit the local `dsh web` service** and **check / update DSH**, plus a settings panel with optional **safe cache cleanup**. The update flow installs a newer version through a staging copy and an atomic swap, shows a progress dialog, then exits the service and closes the window.

## Plugin information

| Field | Value |
| --- | --- |
| Name | `dsh-app-controls` (DeepSeek Harness app controls) |
| Version | `0.5.2` |
| Author | Tianrun Gu ([@MiraculousGu](https://github.com/MiraculousGu)) |
| Environment | DeepSeek Harness `0.2.2-rc.x` **Web profile** (currently `0.2.2-rc.4`); Linux + KDE desktop, Chrome `--app` window; Node.js 20+ |
| Features | ① **Check and update DSH**: confirm, download/install in the background, progress dialog with phase / percent / elapsed time / npm activity, atomic swap, exit and close the window. ② **Quit DSH**: confirm, gracefully stop the whole local `dsh web` service, and close the window. ③ **KDE system tray** (`tray/dsh-tray.py`): status, open, check/update, restart, stop, logs, copy URL and notifications; its menu follows the DSH light/dark theme, and silent 30-minute background checks only notify when an update exists. ④ **Plugin settings**: tray on/off, per-feature visibility, a remembered default window size and **safe cache cleanup**. |
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

### KDE system tray (`tray/dsh-tray.py`)

A PyQt5 tray helper shows the service in the KDE panel and controls it without
opening the Web GUI:

- Tooltip: state, installed version, address, uptime, update availability and
  update progress.
- Left click: open/focus the Web GUI (starts the service if needed).
- Right-click menu: **Open**, **Open Plugins**, **Plugin settings**, **Check for
  updates / Update to vX**, **Restart service**, **Stop service** (the open page
  closes its window itself), **Open logs**, **Copy URL**, **Quit tray**.
- Notifications: update available/completed, service stopped, start failure. Background checks run every 30 minutes; when the installed version is already current no notification is shown.
- Restarting waits for the old service to release its port before launching the replacement, so a graceful shutdown cannot leave a half-started service.
- The tray menu follows the DSH light/dark theme (reading the `ui-theme` preference and the system palette) and rebuilds its icons when the theme changes.
- At login the helper waits for Plasma's tray to become ready and pins itself into the KDE panel's shown items, so KDE does not leave it in the expanded/overflow area.
- The helper talks to the host over
  `~/.local/state/dsh-app-controls/control.sock` (mode 0600); no browser token
  or cookie is stored in it.

Prerequisites: Python 3 + PyQt5 (`python3-pyqt5` on Arch/CachyOS) and a KDE
Plasma session (`xembedsniproxy` is part of the default Plasma 6 session).
Start it with `python3 tray/dsh-tray.py`, diagnose with
`python3 tray/dsh-tray.py --check`, and enable autostart from the tray menu.

### Plugin settings

Open **Plugins → DeepSeek Harness 应用控制** and use the settings section at the bottom (the tray menu's **Plugin settings** opens it too):

- **System tray icon** — enables/disables the tray helper and its login autostart.
- **Button visibility** — check/update button, quit button, conversation-header entry and main-interface top-right entry.
- **Default window size** — width/height, **Remember current size** and **Use automatic size**. Applied the next time a window opens.

Settings live in `~/.local/state/dsh-app-controls/settings.json` and are shared by the host, tray and launcher. Tray enable/disable and the window size are applied on the next DSH start/window launch; button visibility changes immediately. The launcher uses a dedicated Chrome profile (`~/.local/share/dsh-web-chrome`) so the saved `--window-size` is reliably applied; DSH authentication is still seeded by the launch token.

### Cache cleanup

Open the same settings section and use **Cache cleanup** (`GET /api/dsh-app-controls/cache` to scan, `POST /api/dsh-app-controls/cache/clean` to clean). Each category is optional:

- **Application cache** — DSH attachment-image cache (`~/.dsh/cache/attachments`); safe to rebuild.
- **npx install cache** — obsolete temporary installs under `~/.npm/_npx`; the version currently running is detected and kept.
- **npm download cache** — `~/.npm/_cacache`; packages are re-downloaded when needed.
- **Uninstalled-plugin cache** — `pnpm store prune`; removes store packages no project references, without touching installed plugins.
- **Update leftovers** — runtime backups/staging directories older than 7 days.

Only regenerable caches are removed. The running DSH installation, plugin source, installed plugins, settings, sessions, credentials and browser cookies/local storage are never targets. Package-cache cleanup is refused while npm/pnpm/npx is running, and cache cleanup is refused during an update. A category that fails or is in use is skipped without aborting the others.

## Install

```sh
# From npm (recommended)
dsh plugin --profile web add dsh-app-controls

# From a local checkout (link: install)
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
- Cache cleanup only touches the paths listed above; active npx installs, installed plugins and user data are excluded. Package-cache categories are blocked while a package manager is running.

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

为 DeepSeek Harness（DSH）Web 界面增加两个控制：「**退出本地 `dsh web` 服务**」和「**检查并更新 DSH**」，并提供包含可选**安全缓存清理**的设置面板。更新通过副本安装 + 原子切换完成，带进度弹窗，完成后退出服务并自动关窗。

## 插件信息

| 项目 | 内容 |
| --- | --- |
| 名称 | `dsh-app-controls`（DeepSeek Harness 应用控制） |
| 版本 | `0.5.2` |
| 作者 | Tianrun Gu（[@MiraculousGu](https://github.com/MiraculousGu)） |
| 适用环境 | DeepSeek Harness `0.2.2-rc.x` 的 **Web profile**（当前 `0.2.2-rc.4`）；Linux + KDE 桌面、Chrome `--app` 应用窗口；Node.js 20+ |
| 功能 | ① **检查并更新 DSH**：确认后后台下载安装，进度弹窗显示阶段 / 百分比 / 已用时 / npm 活动日志，完成后原子切换、退出服务并自动关窗。② **退出 DSH**：确认后优雅结束整个本地 `dsh web` 服务并自动关窗。③ **KDE 系统托盘**（`tray/dsh-tray.py`）：状态、打开、检查/更新、重启、停止、日志、复制地址与通知；菜单随 DSH 明暗主题切换，后台每 30 分钟静默检查，只有发现新版本才通知。④ **插件设置**：托盘开关、各功能显示/隐藏、可记住的默认启动窗口大小，以及**安全缓存清理**。 |
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

### KDE 系统托盘（`tray/dsh-tray.py`）

一个 PyQt5 托盘 helper，在 KDE 面板里显示服务状态并直接控制，不需要打开网页：

- Tooltip：状态、版本、地址、运行时长、可更新版本与更新进度；
- 左键：打开/聚焦 Web 界面（服务未运行时先启动）；
- 右键菜单：**打开**、**打开插件管理**、**插件设置**、**检查更新 / 更新到 vX**、**重启服务**、**停止服务**（打开中的页面会自行关闭窗口）、**打开日志**、**复制访问地址**、**退出托盘**；
- 通知：更新可用/完成、服务停止、启动失败；后台每 30 分钟检查一次，已是最新版本时不弹通知；
- 重启时会先等待旧服务释放端口，再启动新服务，避免正常退出过程中出现服务没有真正重启的情况；
- 托盘菜单随 DSH 明暗主题切换（读取 `ui-theme` 偏好并结合系统调色板），主题变化时重建图标；
- 登录时如果 Plasma 面板/系统托盘尚未就绪，会等待并自动把图标固定到面板显示项，不会被 KDE 收进折叠区。
- 托盘通过 `~/.local/state/dsh-app-controls/control.sock`（权限 0600）与宿主通信，不保存浏览器 token/cookie。

前置条件：Python 3 + PyQt5（Arch/CachyOS 上是 `python3-pyqt5`）、KDE Plasma 会话（`xembedsniproxy` 属于默认 Plasma 6 会话）。启动：`python3 tray/dsh-tray.py`；诊断：`python3 tray/dsh-tray.py --check`；开机自启可在托盘菜单里切换。

### 插件设置

打开 **插件 → DeepSeek Harness 应用控制**，使用详情底部的设置区（托盘菜单的 **插件设置** 也会打开这里）：

- **系统托盘图标**：启用/停用托盘 helper 及登录自启；
- **按钮显示**：检查更新按钮、退出按钮、对话标题栏入口、主界面右上角入口；
- **默认启动窗口大小**：宽度/高度、**记住当前窗口大小**、**恢复自动**；下次打开窗口时生效。

设置保存在 `~/.local/state/dsh-app-controls/settings.json`，由宿主、托盘和启动器共享。托盘开关与窗口大小在下次启动 DSH / 打开窗口时生效，按钮显示/隐藏立即生效。启动器使用独立的 Chrome 配置目录（`~/.local/share/dsh-web-chrome`），确保保存的 `--window-size` 可靠生效；DSH 鉴权仍通过启动令牌完成。

### 缓存清理

在同一设置区使用 **缓存清理**（扫描：`GET /api/dsh-app-controls/cache`；清理：`POST /api/dsh-app-controls/cache/clean`）。各类型可单独选择：

- **应用缓存**：DSH 附件图片缓存（`~/.dsh/cache/attachments`），可安全重建；
- **npx 安装缓存**：`~/.npm/_npx` 中旧的临时安装，会自动识别并保留当前正在运行的版本；
- **npm 下载缓存**：`~/.npm/_cacache`，需要时会重新下载；
- **卸载插件的缓存**：执行 `pnpm store prune`，只移除没有任何项目引用的 store 包，不动已安装插件；
- **更新残留**：7 天前的运行时备份 / 临时副本。

只删除可重新生成的缓存；运行中的 DSH、插件源码、已安装插件、设置、会话、凭据以及浏览器 Cookie / Local Storage 均不会被删除。npm/pnpm/npx 运行时拒绝清理包缓存，更新进行中拒绝清理；单项失败或被占用时跳过，不影响其他项。

## 安装

```sh
# 从 npm 安装（推荐）
dsh plugin --profile web add dsh-app-controls

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
- 缓存清理只处理上面列出的路径；运行中的 npx 安装、已安装插件和用户数据不在清理范围内。包管理器运行时会拒绝清理包缓存。

## 开发与测试

无构建步骤：客户端半为手写 lazy-CJS bundle。

```sh
node test/mock.test.mjs
```

日志：`~/.local/state/dsh-app-controls/app-controls.log`。

## 许可证

MIT © 2026 Tianrun Gu，详见 [LICENSE](LICENSE)。
