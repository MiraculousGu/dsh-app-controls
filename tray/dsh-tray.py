#!/usr/bin/env python3
"""DeepSeek Harness — KDE system tray controller.

A small PyQt5 tray icon that talks to the running dsh-app-controls host over
the loopback Unix socket (`~/.local/state/dsh-app-controls/control.sock`).

Features: status/tooltip, open/focus the Web GUI, open the plugin/plugins-settings
pages, check for updates, update with progress, restart/stop the service (the
open page closes itself), open logs, copy the URL and notifications. The tray
enable/disable and autostart state are managed by the plugin settings panel.
"""
from __future__ import annotations

import fcntl
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from PyQt5.QtCore import QObject, QTimer, QUrl, Qt
from PyQt5.QtGui import QColor, QGuiApplication, QIcon, QPainter, QPen, QPixmap
from PyQt5.QtNetwork import QLocalSocket
from PyQt5.QtWidgets import QAction, QApplication, QMenu, QMessageBox, QSystemTrayIcon

HOME = Path.home()
PLUGIN_DIR = Path(__file__).resolve().parent.parent
STATE_DIR = Path(os.environ.get("XDG_STATE_HOME", HOME / ".local/state")) / "dsh-app-controls"
SOCKET_PATH = STATE_DIR / "control.sock"
TRAY_LOG = STATE_DIR / "tray.log"
TRAY_PID_FILE = STATE_DIR / "tray.pid"
WEB_LOG = HOME / ".local/state/dsh-web/web.log"
LAUNCHER = os.environ.get("DSH_WEB_LAUNCHER", str(HOME / ".local/bin/dsh-web-launch"))
URL = os.environ.get("DSH_WEB_URL", "http://127.0.0.1:3080/")
AUTOSTART = HOME / ".config/autostart/dsh-tray.desktop"
LOCK_FILE = STATE_DIR / "tray.lock"
ICON_SVG = PLUGIN_DIR / "icon.svg"

STATUS_INTERVAL_MS = 2000
UPDATE_INTERVAL_MS = 30 * 60 * 1000
REQUEST_TIMEOUT_MS = 4000
CHECK_TIMEOUT_MS = 30000
START_TIMEOUT_SECONDS = 45

_STATE_COLORS = {
    "running": "#3fae63",
    "stopped": "#8a8f98",
    "starting": "#f0a020",
    "updating": "#f0a020",
    "stopping": "#8a8f98",
    "error": "#e5484d",
}


def log(message: str) -> None:
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
        with open(TRAY_LOG, "a", encoding="utf-8") as handle:
            handle.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}\n")
    except Exception:
        pass


def probe_status(timeout: float = 2.0) -> dict:
    """Synchronous status probe used by --check (no Qt event loop needed)."""
    import socket as pysocket

    try:
        with pysocket.socket(pysocket.AF_UNIX, pysocket.SOCK_STREAM) as sock:
            sock.settimeout(timeout)
            sock.connect(str(SOCKET_PATH))
            sock.sendall(json.dumps({"command": "status", "id": 1}).encode() + b"\n")
            data = b""
            while b"\n" not in data:
                chunk = sock.recv(65536)
                if not chunk:
                    break
                data += chunk
            line = data.split(b"\n", 1)[0]
            return json.loads(line.decode("utf-8", "replace"))
    except Exception as error:
        return {"ok": False, "error": "unreachable", "message": str(error)}


class ControlRequest(QObject):
    """One newline-delimited JSON request over the host's Unix socket."""

    def __init__(self, parent, payload: dict, timeout_ms: int, callback):
        super().__init__(parent)
        self.payload = payload
        self.callback = callback
        self.done = False
        self.buffer = bytearray()
        self.socket = QLocalSocket(self)
        self.socket.connected.connect(self._on_connected)
        self.socket.readyRead.connect(self._on_ready)
        self.socket.errorOccurred.connect(self._on_error)
        self.timer = QTimer(self)
        self.timer.setSingleShot(True)
        self.timer.timeout.connect(lambda: self._finish({"ok": False, "error": "timeout"}))
        self.timer.start(timeout_ms)
        self.socket.connectToServer(str(SOCKET_PATH))

    def _on_connected(self) -> None:
        try:
            self.socket.write(json.dumps(self.payload).encode("utf-8") + b"\n")
        except Exception:
            self._finish({"ok": False, "error": "write-failed"})

    def _on_ready(self) -> None:
        self.buffer.extend(bytes(self.socket.readAll()))
        index = self.buffer.find(b"\n")
        if index < 0:
            return
        line = bytes(self.buffer[:index]).decode("utf-8", "replace")
        try:
            response = json.loads(line)
        except Exception:
            response = {"ok": False, "error": "bad-response"}
        self._finish(response)

    def _on_error(self, _error) -> None:
        self._finish({"ok": False, "error": "unreachable"})

    def _finish(self, response: dict) -> None:
        if self.done:
            return
        self.done = True
        self.timer.stop()
        try:
            self.socket.abort()
        except Exception:
            pass
        callback = self.callback
        try:
            callback(response)
        finally:
            self.deleteLater()


class Tray(QSystemTrayIcon):
    def __init__(self, app: QApplication):
        super().__init__()
        self.app = app
        self.status = None
        self.job = None
        self.update = None
        self.checking = False
        self.polling = False
        self.starting = False
        self.start_deadline = 0.0
        self.restart_pending = False
        self.tray_update = False
        self.suppress_stop_notice = False
        self.last_job_finished = None
        self.last_notified_update = None
        self.requests = set()
        self._request_id = 0

        self.menu = QMenu()
        self._build_menu()
        self.setContextMenu(self.menu)
        self.activated.connect(self._on_activated)
        self._apply_state("stopped")
        self.show()

        self.poll_timer = QTimer(self)
        self.poll_timer.timeout.connect(self.poll)
        self.poll_timer.start(STATUS_INTERVAL_MS)
        self.check_timer = QTimer(self)
        self.check_timer.timeout.connect(lambda: self.request_check(notify=True))
        self.check_timer.start(UPDATE_INTERVAL_MS)
        QTimer.singleShot(400, self.poll)
        QTimer.singleShot(1800, lambda: self.request_check(notify=False))

    # ── menu ────────────────────────────────────────────────────────────────
    def _build_menu(self) -> None:
        self.open_action = QAction("打开 DeepSeek Harness", self)
        self.open_action.triggered.connect(self.open_dsh)
        self.menu.addAction(self.open_action)

        self.plugins_action = QAction("打开插件管理", self)
        self.plugins_action.triggered.connect(self.open_plugins)
        self.menu.addAction(self.plugins_action)

        self.settings_action = QAction("插件设置", self)
        self.settings_action.triggered.connect(self.open_settings)
        self.menu.addAction(self.settings_action)

        self.status_action = QAction("状态：正在连接…", self)
        self.status_action.setEnabled(False)
        self.menu.addAction(self.status_action)
        self.menu.addSeparator()

        self.update_action = QAction("检查更新", self)
        self.update_action.triggered.connect(self.on_update_action)
        self.menu.addAction(self.update_action)

        self.restart_action = QAction("重启服务", self)
        self.restart_action.triggered.connect(self.restart_dsh)
        self.menu.addAction(self.restart_action)

        self.stop_action = QAction("停止服务", self)
        self.stop_action.triggered.connect(self.stop_dsh)
        self.menu.addAction(self.stop_action)

        self.logs_action = QAction("打开日志", self)
        self.logs_action.triggered.connect(self.open_logs)
        self.menu.addAction(self.logs_action)

        self.copy_action = QAction("复制访问地址", self)
        self.copy_action.triggered.connect(self.copy_url)
        self.menu.addAction(self.copy_action)
        self.menu.addSeparator()

        self.quit_action = QAction("退出托盘", self)
        self.quit_action.triggered.connect(self.app.quit)
        self.menu.addAction(self.quit_action)
        self._refresh_menu()

    # ── socket ──────────────────────────────────────────────────────────────
    def _request(self, payload: dict, callback, timeout_ms: int = REQUEST_TIMEOUT_MS) -> None:
        self._request_id += 1
        payload = dict(payload)
        payload.setdefault("id", self._request_id)
        holder = {}

        def done(response: dict) -> None:
            self.requests.discard(holder.get("request"))
            callback(response)

        request = ControlRequest(self, payload, timeout_ms, done)
        holder["request"] = request
        self.requests.add(request)

    def poll(self) -> None:
        if self.polling:
            return
        self.polling = True
        self._request({"command": "status"}, self._on_status, timeout_ms=3000)

    def request_check(self, notify: bool) -> None:
        if self.checking:
            return
        self.checking = True
        self._refresh_menu()

        def done(response: dict) -> None:
            self.checking = False
            if response.get("ok") and response.get("update"):
                self.update = response["update"]
                if notify:
                    if self.update.get("updateAvailable"):
                        self._notify(
                            "有可用更新",
                            f"DeepSeek Harness {self.update.get('candidate')}（当前 {self.update.get('current')}）",
                        )
                    else:
                        self._notify("已是最新版本", f"DeepSeek Harness {self.update.get('current')}")
            elif notify:
                self._notify("检查更新失败", response.get("message") or response.get("error") or "无法连接服务")
            self._refresh_menu()

        self._request({"command": "check-update"}, done, timeout_ms=CHECK_TIMEOUT_MS)

    # ── status handling ─────────────────────────────────────────────────────
    def _on_status(self, response: dict) -> None:
        self.polling = False
        if not response.get("ok"):
            self._handle_unreachable()
            return
        had_status = self.status is not None
        self.status = response
        self.starting = False
        self.start_deadline = 0.0
        self.job = response.get("job") if isinstance(response.get("job"), dict) else None
        if isinstance(response.get("update"), dict):
            self.update = response["update"]
        if not had_status:
            log("connected to DeepSeek Harness control socket")

        if self.job and self.job.get("active"):
            self._apply_state("updating")
        elif response.get("quitRequested"):
            self._apply_state("stopping")
        else:
            self._apply_state("running")

        if self.job and self.job.get("done") and self.job.get("finishedAt") != self.last_job_finished:
            self.last_job_finished = self.job.get("finishedAt")
            if self.job.get("error"):
                self._notify("更新失败", self.job.get("message") or "更新失败")
            elif self.job.get("source") == "tray":
                self._notify("更新完成", f"已更新到 {self.job.get('to')}，服务即将退出")
                self.suppress_stop_notice = True
            self.tray_update = False

        if (
            isinstance(self.update, dict)
            and self.update.get("updateAvailable")
            and self.update.get("candidate") != self.last_notified_update
        ):
            self.last_notified_update = self.update.get("candidate")
            self._notify(
                "有可用更新",
                f"DeepSeek Harness {self.update.get('candidate')}（当前 {self.update.get('current')}）",
            )
        self._refresh_menu()

    def _handle_unreachable(self) -> None:
        was_running = self.status is not None
        self.status = None
        self.job = None
        if self.starting:
            if time.time() > self.start_deadline:
                self.starting = False
                self._notify("启动失败", "DeepSeek Harness 未在预期时间内启动，请查看日志。")
            else:
                self._apply_state("starting")
                return
        if was_running and not self.suppress_stop_notice and not self.tray_update:
            self._notify("DeepSeek Harness 已停止", "本地服务已退出。")
        self.suppress_stop_notice = False
        self._apply_state("stopped")
        if self.restart_pending:
            self.restart_pending = False
            self.launch()
        self._refresh_menu()

    # ── actions ─────────────────────────────────────────────────────────────
    def open_dsh(self) -> None:
        if self.status is not None:
            self._run_launcher()
        else:
            self.launch()

    def open_plugins(self) -> None:
        if self.status is None:
            self._notify("服务未运行", "请先点击托盘图标启动 DeepSeek Harness。")
            return
        self._run_launcher("dsh-app-controls/plugins")

    def open_settings(self) -> None:
        if self.status is None:
            self._notify("服务未运行", "请先点击托盘图标启动 DeepSeek Harness。")
            return
        self._run_launcher("dsh-app-controls/settings")

    def launch(self) -> None:
        if self.starting:
            return
        self.starting = True
        self.start_deadline = time.time() + START_TIMEOUT_SECONDS
        self.suppress_stop_notice = False
        self._apply_state("starting")
        try:
            subprocess.Popen(
                [LAUNCHER],
                cwd=str(HOME),
                start_new_session=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except Exception as error:
            self.starting = False
            self._notify("启动失败", f"无法运行启动器：{error}")
            self._apply_state("stopped")
            return
        self._refresh_menu()
        QTimer.singleShot(START_TIMEOUT_SECONDS * 1000, self._start_timeout)

    def _start_timeout(self) -> None:
        if self.starting and self.status is None:
            self.starting = False
            self._notify("启动失败", "DeepSeek Harness 未启动成功，请查看日志。")
            self._apply_state("stopped")
            self._refresh_menu()

    def _run_launcher(self, hash_value: str | None = None) -> None:
        env = dict(os.environ)
        if hash_value:
            env["DSH_WEB_HASH"] = hash_value
        else:
            env.pop("DSH_WEB_HASH", None)
        try:
            subprocess.Popen(
                [LAUNCHER],
                cwd=str(HOME),
                env=env,
                start_new_session=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except Exception as error:
            self._notify("无法打开窗口", str(error))

    def stop_dsh(self) -> None:
        if self.status is None:
            return
        answer = QMessageBox.question(
            None,
            "停止 DeepSeek Harness",
            "停止本地 DeepSeek Harness 服务并关闭窗口？",
            QMessageBox.Yes | QMessageBox.No,
            QMessageBox.No,
        )
        if answer != QMessageBox.Yes:
            return
        self.suppress_stop_notice = True
        self.restart_pending = False
        self._apply_state("stopping")
        self._request({"command": "quit"}, self._on_quit_response)

    def restart_dsh(self) -> None:
        if self.status is None:
            self.launch()
            return
        self.suppress_stop_notice = True
        self.restart_pending = True
        self._apply_state("stopping")
        self._request({"command": "quit"}, self._on_quit_response)

    def _on_quit_response(self, response: dict) -> None:
        if not response.get("ok"):
            self._notify("停止失败", response.get("message") or response.get("error") or "未知错误")

    def on_update_action(self) -> None:
        if self.job and self.job.get("active"):
            return
        if isinstance(self.update, dict) and self.update.get("updateAvailable"):
            candidate = self.update.get("candidate")
            answer = QMessageBox.question(
                None,
                "更新 DeepSeek Harness",
                f"更新到 {candidate}（当前 {self.update.get('current')}）？\n更新完成后服务会退出，需要重新启动。",
                QMessageBox.Yes | QMessageBox.No,
                QMessageBox.No,
            )
            if answer != QMessageBox.Yes:
                return
            self.tray_update = True
            self._request({"command": "update"}, self._on_update_start, timeout_ms=CHECK_TIMEOUT_MS)
        else:
            self.request_check(notify=True)

    def _on_update_start(self, response: dict) -> None:
        if not response.get("ok"):
            self.tray_update = False
            self._notify("无法开始更新", response.get("message") or response.get("error") or "未知错误")
            return
        self._notify("开始更新", f"DeepSeek Harness {response.get('from')} → {response.get('to')}")

    def open_logs(self) -> None:
        target = WEB_LOG if WEB_LOG.exists() else TRAY_LOG
        if not target.exists():
            target = STATE_DIR
        from PyQt5.QtGui import QDesktopServices

        QDesktopServices.openUrl(QUrl.fromLocalFile(str(target)))

    def copy_url(self) -> None:
        QGuiApplication.clipboard().setText(URL)
        self._notify("已复制访问地址", URL)

    def _on_activated(self, reason) -> None:
        if reason in (QSystemTrayIcon.Trigger, QSystemTrayIcon.MiddleClick):
            self.open_dsh()

    # ── presentation ────────────────────────────────────────────────────────
    def _apply_state(self, state: str) -> None:
        self.setIcon(self._make_icon(state))
        self.setToolTip(self._tooltip(state))

    def _make_icon(self, state: str) -> QIcon:
        pixmap = QPixmap(64, 64)
        pixmap.fill(Qt.transparent)
        painter = QPainter(pixmap)
        painter.setRenderHint(QPainter.Antialiasing)
        painter.setPen(Qt.NoPen)
        base = QColor("#4D6BFE")
        if state == "stopped":
            base = QColor("#5b6068")
        painter.setBrush(base)
        painter.drawRoundedRect(4, 4, 56, 56, 16, 16)
        painter.setPen(QPen(QColor("#ffffff"), 5, Qt.SolidLine, Qt.RoundCap, Qt.RoundJoin))
        painter.drawLine(32, 16, 32, 33)
        painter.drawArc(16, 18, 32, 32, 40 * 16, 280 * 16)
        dot = QColor(_STATE_COLORS.get(state, _STATE_COLORS["running"]))
        painter.setPen(QPen(QColor("#ffffff"), 2))
        painter.setBrush(dot)
        painter.drawEllipse(43, 43, 16, 16)
        painter.end()
        return QIcon(pixmap)

    def _tooltip(self, state: str) -> str:
        lines = ["DeepSeek Harness"]
        if self.status is not None:
            version = self.status.get("version") or "?"
            port = self.status.get("port")
            where = f"127.0.0.1:{port}" if port else URL
            uptime = self._format_uptime(self.status.get("uptimeMs") or 0)
            lines.append(f"运行中 · {version} · {where} · 已运行 {uptime}")
        else:
            lines.append("已停止")
        if self.job and self.job.get("active"):
            lines.append(f"更新中 · {self.job.get('percent', 0)}%")
        elif isinstance(self.update, dict) and self.update.get("updateAvailable"):
            lines.append(f"可更新到 {self.update.get('candidate')}")
        lines.append("左键打开 · 右键菜单")
        return "\n".join(lines)

    @staticmethod
    def _format_uptime(ms: int) -> str:
        total = max(0, round(ms / 1000))
        hours, remainder = divmod(total, 3600)
        minutes, seconds = divmod(remainder, 60)
        if hours:
            return f"{hours}h {minutes:02d}m"
        if minutes:
            return f"{minutes}m {seconds:02d}s"
        return f"{seconds}s"

    def _refresh_menu(self) -> None:
        running = self.status is not None
        if running:
            version = self.status.get("version") or "?"
            port = self.status.get("port")
            text = f"运行中 · {version}" + (f" · :{port}" if port else "")
        else:
            text = "已停止"
        if self.job and self.job.get("active"):
            text = f"更新中 · {self.job.get('percent', 0)}%"
        elif self.status is not None and self.status.get("quitRequested"):
            text = "正在退出…"
        self.status_action.setText(f"状态：{text}")

        if self.checking:
            self.update_action.setText("正在检查更新…")
            self.update_action.setEnabled(False)
        elif self.job and self.job.get("active"):
            self.update_action.setText(f"正在更新 {self.job.get('percent', 0)}%")
            self.update_action.setEnabled(False)
        elif isinstance(self.update, dict) and self.update.get("updateAvailable"):
            self.update_action.setText(f"更新到 {self.update.get('candidate')}")
            self.update_action.setEnabled(True)
        else:
            self.update_action.setText("检查更新")
            self.update_action.setEnabled(True)

        self.restart_action.setText("重启服务" if running else "启动服务")
        self.plugins_action.setEnabled(running)
        self.settings_action.setEnabled(running)
        self.stop_action.setEnabled(running)
        self.copy_action.setEnabled(running)
        self.logs_action.setEnabled(True)

    def _notify(self, title: str, message: str) -> None:
        log(f"{title}: {message}")
        if QSystemTrayIcon.supportsMessages():
            self.showMessage(title, message, QSystemTrayIcon.Information, 6000)


def run_check() -> int:
    app = QApplication.instance() or QApplication(sys.argv)
    print(f"python: {sys.version.split()[0]}")
    print(f"qt platform: {app.platformName()}")
    print(f"tray available: {QSystemTrayIcon.isSystemTrayAvailable()}")
    print(f"socket: {SOCKET_PATH}")
    print(f"autostart: {AUTOSTART} exists={AUTOSTART.exists()}")
    print(f"status: {json.dumps(probe_status(), ensure_ascii=False)}")
    return 0


def main() -> int:
    if "--check" in sys.argv:
        return run_check()
    STATE_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = open(LOCK_FILE, "w", encoding="utf-8")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("dsh-tray is already running", file=sys.stderr)
        return 0
    try:
        TRAY_PID_FILE.write_text(str(os.getpid()), encoding="utf-8")
    except Exception:
        pass
    app = QApplication(sys.argv)
    app.setApplicationName("dsh-tray")
    app.setQuitOnLastWindowClosed(False)
    if not QSystemTrayIcon.isSystemTrayAvailable():
        log("system tray is not available")
        print("system tray is not available", file=sys.stderr)
        try:
            TRAY_PID_FILE.unlink()
        except Exception:
            pass
        return 1
    tray = Tray(app)
    try:
        return app.exec_()
    finally:
        try:
            TRAY_PID_FILE.unlink()
        except Exception:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
