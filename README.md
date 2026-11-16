# dsh-app-controls

DeepSeek Harness（DSH）Web 界面的工具栏扩展：一键 **退出本地服务**，以及 **检查并更新 DSH**。

## 插件信息

| 项目 | 内容 |
| --- | --- |
| 名称 | dsh-app-controls（DeepSeek Harness 应用控制） |
| 版本 | 0.2.0 |
| 作者 | Tianrun Gu（[@MiraculousGu](https://github.com/MiraculousGu)） |
| 适用环境 | DeepSeek Harness `0.2.2-rc.x` 的 **Web profile**（当前 0.2.2-rc.3）；Linux + KDE 桌面、Chrome `--app` 应用窗口；Node.js 20+ |
| 功能 | ① **检查并更新 DSH**：确认后后台下载安装，带阶段/百分比/耗时/日志的进度弹窗，完成后原子切换并退出服务、自动关窗；② **退出 DSH**：确认后优雅结束整个 `dsh web` 服务并自动关窗 |
| 仓库 | https://github.com/MiraculousGu/dsh-app-controls |
| 许可证 | MIT |

## 按钮位置

- **对话打开时**：对话标题栏右侧的工具区。
- **主界面 / 插件页等其他页面**：窗口右上角的悬浮控件（位于右侧边栏开关左侧）。
- 同一时间只显示一处，不会重复出现。

## 功能

### 检查并更新 DeepSeek Harness

1. 查询 npm registry，确定当前安装允许更新的最新版本（本安装为 `0.2.2-rc.1` 的 `^` 范围，可更新到 `0.2.2-rc.3`）；
2. 弹窗显示当前版本 → 新版本，确认后进入进度弹窗（阶段、百分比、已用时、npm 活动日志）；
3. 更新先把新版本安装到运行时目录的**副本**，校验版本后原子切换，运行中的文件直到切换前都不受影响；
4. 成功后自动退出服务并关闭窗口，用桌面快捷方式重新启动即为新版本。

> 安装阶段的百分比按上一次成功更新的耗时估算（npm 不提供细粒度进度）；阶段、耗时与 npm 日志是真实信息。

### 退出 DeepSeek Harness

确认后通过 DSH 的 `appExit(0)` 优雅结束整个本地服务（关闭 HTTP/WebSocket、落盘会话、终止子进程），随后自动关闭窗口。若窗口是普通浏览器标签页（脚本不允许关闭），会提示手动关闭。

## 安装

```sh
# 本地目录安装（link: 方式）
dsh plugin --profile web add /path/to/dsh-app-controls

# 或从 GitHub 安装（支持 git spec 的安装方式）
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
- 更新目标为当前进程所在的安装根目录；本仓库的桌面启动器使用稳定目录 `~/.local/share/dsh-runtime`，因此更新不会因 npx 的 `latest` 标签校验而回退。

## 开发与测试

无构建步骤：客户端半为手写 lazy-CJS bundle。

```sh
node test/mock.test.mjs
```

日志：`~/.local/state/dsh-app-controls/app-controls.log`。

## English

**dsh-app-controls** adds two controls to the DeepSeek Harness Web GUI: a
**quit** button that gracefully stops the local `dsh web` service, and a
**check/update** button that installs the newest version allowed by the
running installation through a staged, atomic swap while showing a progress
dialog. The buttons appear in the conversation header and in the top-right of
the main interface. Requires DSH `0.2.2-rc.1` Web profile, Linux + KDE, Chrome
app window, Node.js 20+. Licensed under MIT.
