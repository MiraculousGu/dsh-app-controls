#!/usr/bin/env python3
"""DeepSeek Harness — KDE system tray controller.

A small PyQt5 tray icon that talks to the running dsh-app-controls host over
the loopback Unix socket (`~/.local/state/dsh-app-controls/control.sock`).

Features: status/tooltip, open/focus the Web GUI, open the plugin/plugins-settings
pages, check for updates, update with progress, restart/stop the service (the
open page closes itself), open logs, copy the URL and notifications. The tray
enable/disable and autostart state are managed by the plugin settings panel;
the icon waits for Plasma's tray at login and pins itself into the panel.
"""
from __future__ import annotations

import fcntl
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit

from PyQt5.QtCore import QLineF, QObject, QPointF, QRectF, QTimer, QUrl, Qt
from PyQt5.QtGui import QColor, QGuiApplication, QIcon, QPainter, QPalette, QPen, QPixmap
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
THEME_INTERVAL_MS = 3000
REQUEST_TIMEOUT_MS = 4000
CHECK_TIMEOUT_MS = 30000
START_TIMEOUT_SECONDS = 45
RESTART_POLL_MS = 250
RESTART_TIMEOUT_SECONDS = 30
DSH_PATCH = HOME / ".dsh/profiles/web/cordis.patch.yml"

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


def dsh_theme_preference() -> str:
    """Read the DSH Web profile's theme preference without requiring PyYAML."""
    try:
        text = DSH_PATCH.read_text(encoding="utf-8")
    except Exception:
        return "system"

    # The preference lives in the `ui-theme` loader entry in the profile patch.
    # A YAML parser is preferred, but the patch may contain loader tags that a
    # plain safe_load rejects, so fall back to a narrow block scan.
    try:
        import yaml  # type: ignore

        document = yaml.safe_load(text)
        for item in document if isinstance(document, list) else []:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or "")
            if item.get("id") != "ui-theme" and not name.endswith("dsh-client-ui-theme"):
                continue
            config = item.get("config")
            preference = config.get("preference") if isinstance(config, dict) else None
            if preference in ("light", "dark", "system"):
                return str(preference)
    except Exception:
        pass

    block = re.search(r"(?ms)^\s*-\s*id:\s*['\"]?ui-theme['\"]?\s*$.*?(?=^\s*-\s*id:|\Z)", text)
    if block:
        preference = re.search(r"(?m)^\s+preference:\s*['\"]?(light|dark|system)['\"]?\s*$", block.group(0))
        if preference:
            return preference.group(1)
    return "system"


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
        self.restart_waiting = False
        self.restart_deadline = 0.0
        self.tray_update = False
        self.suppress_stop_notice = False
        self.last_job_finished = None
        self.last_notified_update = None
        self.requests = set()
        self._request_id = 0
        self.state = "stopped"
        self.dark = False
        self._theme_key = None
        self._theme_pref = None
        self.check_result = None
        self.check_result_deadline = 0.0

        self.dark = self._resolve_dark()
        self.menu = QMenu()
        self.menu.setToolTipsVisible(True)
        self.menu.setMinimumWidth(272)
        self._build_menu()
        self._apply_theme(force=True)
        self.setContextMenu(self.menu)
        self.activated.connect(self._on_activated)
        self._apply_state("stopped")
        self.show()
        QTimer.singleShot(1200, self._ensure_visible)
        QTimer.singleShot(6000, self._ensure_visible)

        self.poll_timer = QTimer(self)
        self.poll_timer.timeout.connect(self.poll)
        self.poll_timer.start(STATUS_INTERVAL_MS)
        self.check_timer = QTimer(self)
        self.check_timer.timeout.connect(lambda: self.request_check(mode="auto"))
        self.check_timer.start(UPDATE_INTERVAL_MS)
        self.theme_timer = QTimer(self)
        self.theme_timer.timeout.connect(self._sync_theme)
        self.theme_timer.start(THEME_INTERVAL_MS)
        QTimer.singleShot(400, self.poll)
        QTimer.singleShot(1800, lambda: self.request_check(mode="auto"))

    # ── theme and menu ──────────────────────────────────────────────────────
    def _resolve_dark(self) -> bool:
        try:
            preference = dsh_theme_preference()
        except Exception:
            preference = "system"
        self._theme_pref = preference
        if preference == "dark":
            return True
        if preference == "light":
            return False
        return self.app.palette().color(QPalette.Window).lightness() < 128

    def _colors(self) -> dict[str, str]:
        if self.dark:
            return {
                "bg": "#24262d",
                "text": "#f2f3f5",
                "muted": "#969ba6",
                "border": "#3a3e47",
                "hover": "#343842",
                "accent": "#6d8cff",
                "danger": "#ff8181",
            }
        return {
            "bg": "#ffffff",
            "text": "#20242c",
            "muted": "#777d88",
            "border": "#e1e4ea",
            "hover": "#f0f3f8",
            "accent": "#4d6bfe",
            "danger": "#cf4d4d",
        }

    def _menu_style(self) -> str:
        c = self._colors()
        return f"""
        QMenu {{
            background-color: {c['bg']};
            color: {c['text']};
            border: 1px solid {c['border']};
            border-radius: 10px;
            padding: 6px;
        }}
        QMenu::item {{
            padding: 8px 22px 8px 10px;
            margin: 1px 2px;
            border-radius: 6px;
            color: {c['text']};
            background: transparent;
        }}
        QMenu::item:selected {{
            background-color: {c['hover']};
            color: {c['text']};
        }}
        QMenu::item:disabled {{
            color: {c['muted']};
            background: transparent;
        }}
        QMenu::separator {{
            height: 1px;
            background: {c['border']};
            margin: 5px 8px;
        }}
        """

    def _apply_theme(self, force: bool = False) -> None:
        try:
            preference = dsh_theme_preference()
            base = self.app.palette().color(QPalette.Window)
            dark = True if preference == "dark" else False if preference == "light" else base.lightness() < 128
            key = (preference, dark, base.name())
            if not force and key == self._theme_key:
                return
            self._theme_pref = preference
            self.dark = dark
            self._theme_key = key
            self.menu.setStyleSheet(self._menu_style())
            self._apply_action_icons()
            self._refresh_menu()
            log(f"tray theme: {preference} ({'dark' if dark else 'light'})")
        except Exception as error:
            log(f"could not apply tray theme: {error}")

    def _sync_theme(self) -> None:
        self._apply_theme()

    def _menu_icon(self, kind: str, color: str | None = None) -> QIcon:
        c = QColor(color or self._colors()["text"])
        size = 18
        pixmap = QPixmap(size, size)
        pixmap.fill(Qt.transparent)
        painter = QPainter(pixmap)
        painter.setRenderHint(QPainter.Antialiasing)
        pen = QPen(c, 1.7, Qt.SolidLine, Qt.RoundCap, Qt.RoundJoin)
        painter.setPen(pen)
        painter.setBrush(Qt.NoBrush)

        if kind == "open":
            painter.drawRoundedRect(QRectF(2.5, 3.5, 13, 11), 2, 2)
            painter.drawLine(QLineF(2.5, 7, 15.5, 7))
            painter.setBrush(c)
            painter.drawEllipse(QPointF(4.8, 5.2), 0.7, 0.7)
        elif kind == "plugins":
            for x, y in ((3, 3), (10, 3), (3, 10), (10, 10)):
                painter.drawRoundedRect(QRectF(x, y, 5, 5), 1.5, 1.5)
        elif kind == "settings":
            for y, knob in ((5, 6), (9, 12), (13, 8)):
                painter.drawLine(3, y, 15, y)
                painter.setBrush(c)
                painter.drawEllipse(QPointF(knob, y), 1.6, 1.6)
        elif kind in ("update", "restart"):
            painter.drawArc(3, 3, 12, 12, 45 * 16, 270 * 16)
            painter.drawLine(13, 3, 15, 6)
            painter.drawLine(15, 6, 11, 6)
            if kind == "restart":
                painter.setBrush(c)
                painter.drawEllipse(8, 8, 2, 2)
        elif kind == "stop":
            painter.setBrush(c)
            painter.drawRoundedRect(QRectF(4, 4, 10, 10), 2, 2)
        elif kind == "logs":
            painter.drawRoundedRect(QRectF(3, 2.5, 12, 13), 2, 2)
            for y in (6, 9, 12):
                painter.drawLine(6, y, 12, y)
        elif kind == "copy":
            painter.drawRoundedRect(QRectF(5, 3, 9, 11), 1.5, 1.5)
            painter.drawRoundedRect(QRectF(3, 6, 9, 11), 1.5, 1.5)
        elif kind == "quit":
            painter.drawArc(3, 3, 12, 12, 45 * 16, 270 * 16)
            painter.drawLine(9, 2, 9, 9)
        painter.end()
        icon = QIcon()
        icon.addPixmap(pixmap, QIcon.Normal)
        icon.addPixmap(pixmap, QIcon.Active)
        icon.addPixmap(pixmap, QIcon.Disabled)
        return icon

    def _apply_action_icons(self) -> None:
        c = self._colors()
        self.open_action.setIcon(self._menu_icon("open", c["accent"]))
        self.plugins_action.setIcon(self._menu_icon("plugins", c["text"]))
        self.settings_action.setIcon(self._menu_icon("settings", c["text"]))
        self.update_action.setIcon(self._menu_icon("update", c["accent"]))
        self.restart_action.setIcon(self._menu_icon("restart", c["text"]))
        self.stop_action.setIcon(self._menu_icon("stop", c["danger"]))
        self.logs_action.setIcon(self._menu_icon("logs", c["text"]))
        self.copy_action.setIcon(self._menu_icon("copy", c["text"]))
        self.quit_action.setIcon(self._menu_icon("quit", c["danger"]))
        self.status_action.setIcon(self._status_icon())

    def _status_icon(self) -> QIcon:
        color = QColor(_STATE_COLORS.get(self.state, _STATE_COLORS["running"]))
        size = 18
        pixmap = QPixmap(size, size)
        pixmap.fill(Qt.transparent)
        painter = QPainter(pixmap)
        painter.setRenderHint(QPainter.Antialiasing)
        painter.setPen(QPen(color, 1.2))
        painter.setBrush(QColor(color.red(), color.green(), color.blue(), 55))
        painter.drawEllipse(QRectF(3, 3, 12, 12))
        painter.setPen(Qt.NoPen)
        painter.setBrush(color)
        painter.drawEllipse(QPointF(9, 9), 2.5, 2.5)
        painter.end()
        icon = QIcon()
        icon.addPixmap(pixmap, QIcon.Normal)
        icon.addPixmap(pixmap, QIcon.Active)
        icon.addPixmap(pixmap, QIcon.Disabled)
        return icon

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

    def request_check(self, mode: str = "auto") -> None:
        """Check in the background; only an available update raises a notification."""
        if self.checking:
            return
        self.checking = True
        self.check_result = None
        self.check_result_deadline = 0.0
        self._refresh_menu()

        def done(response: dict) -> None:
            self.checking = False
            if response.get("ok") and response.get("update"):
                self.update = response["update"]
                if self.update.get("updateAvailable"):
                    candidate = self.update.get("candidate")
                    if candidate != self.last_notified_update:
                        self.last_notified_update = candidate
                        self._notify(
                            "有可用更新",
                            f"DeepSeek Harness {candidate}（当前 {self.update.get('current')}）",
                        )
                elif mode == "manual":
                    self._set_check_result("已是最新版本")
            elif mode == "manual":
                self._set_check_result("检查失败")
            self._refresh_menu()

        self._request({"command": "check-update"}, done, timeout_ms=CHECK_TIMEOUT_MS)

    def _set_check_result(self, text: str) -> None:
        self.check_result = text
        self.check_result_deadline = time.time() + 5.0
        QTimer.singleShot(5200, self._clear_check_result)

    def _clear_check_result(self) -> None:
        if self.check_result is None:
            return
        if time.time() < self.check_result_deadline:
            return
        self.check_result = None
        self._refresh_menu()

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
            self._begin_restart_wait()
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

    def _service_port_open(self) -> bool:
        """Whether the Web service's TCP port is still accepting connections."""
        parts = urlsplit(URL)
        host = parts.hostname or "127.0.0.1"
        port = parts.port or (443 if parts.scheme == "https" else 80)
        try:
            with socket.create_connection((host, port), timeout=0.2):
                return True
        except OSError:
            return False

    def _begin_restart_wait(self) -> None:
        if self.restart_waiting or not self.restart_pending:
            return
        self.restart_waiting = True
        self.restart_deadline = time.time() + RESTART_TIMEOUT_SECONDS
        log("restart: waiting for the old service to release the port")
        QTimer.singleShot(RESTART_POLL_MS, self._restart_tick)

    def _restart_tick(self) -> None:
        if not self.restart_waiting:
            return
        if not self.restart_pending:
            self.restart_waiting = False
            return
        if not self._service_port_open():
            self.restart_waiting = False
            self.restart_pending = False
            log("restart: old service stopped; launching a new one")
            self.launch()
            return
        if time.time() >= self.restart_deadline:
            self.restart_waiting = False
            self.restart_pending = False
            log("restart: timed out waiting for the old service to stop")
            self._notify("重启失败", "旧服务没有及时退出，请查看日志后重试。")
            self._apply_state("stopped")
            return
        QTimer.singleShot(RESTART_POLL_MS, self._restart_tick)

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
        self.restart_waiting = False
        self._apply_state("stopping")
        self._request({"command": "quit"}, self._on_quit_response)

    def restart_dsh(self) -> None:
        if self.status is None:
            if not self.restart_waiting:
                self.launch()
            return
        if self.restart_waiting:
            return
        self.suppress_stop_notice = True
        self.restart_pending = True
        self._apply_state("stopping")
        self._request({"command": "quit"}, self._on_quit_response)

    def _on_quit_response(self, response: dict) -> None:
        if response.get("ok"):
            return
        message = response.get("message") or response.get("error") or "未知错误"
        self.restart_waiting = False
        if self.restart_pending:
            self.restart_pending = False
            self._notify("重启失败", message)
        else:
            self._notify("停止失败", message)

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
            self.request_check(mode="manual")

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

    def _pin_in_panel(self) -> None:
        """KDE may put a new SNI/XEmbed icon in the expanded tray; pin it."""
        desktop = os.environ.get("XDG_CURRENT_DESKTOP", "")
        if "KDE" not in desktop.upper() and "PLASMA" not in desktop.upper():
            return
        qdbus = shutil.which("qdbus6") or shutil.which("qdbus")
        if not qdbus:
            return
        script = r'''
var ps = panels();
for (var pi = 0; pi < ps.length; pi++) {
  var ws = ps[pi].widgets();
  for (var i = 0; i < ws.length; i++) {
    var w = ws[i];
    if (w.type === "org.kde.plasma.systemtray") {
      w.currentConfigGroup = ["General"];
      function add(key, item) {
        var raw = String(w.readConfig(key) || "");
        var arr = raw.length ? raw.split(",") : [];
        if (arr.indexOf(item) === -1) arr.push(item);
        w.writeConfig(key, arr.filter(function(x){ return x.length > 0; }).join(","));
      }
      add("shownItems", "dsh-tray");
      add("knownItems", "dsh-tray");
      add("extraItems", "dsh-tray");
      var hidden = String(w.readConfig("hiddenItems") || "").split(",").filter(function(x){ return x.length > 0 && x !== "dsh-tray"; });
      w.writeConfig("hiddenItems", hidden.join(","));
      w.reloadConfig();
    }
  }
}
'''
        try:
            subprocess.run(
                [qdbus, "org.kde.plasmashell", "/PlasmaShell", "org.kde.PlasmaShell.evaluateScript", script],
                timeout=8,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            log("pinned tray icon in KDE panel")
        except Exception as error:
            log(f"could not pin tray icon: {error}")

    def _ensure_visible(self) -> None:
        try:
            if QSystemTrayIcon.isSystemTrayAvailable():
                if not self.isVisible():
                    self.show()
                self._pin_in_panel()
        except Exception as error:
            log(f"could not ensure tray visibility: {error}")

    def _on_activated(self, reason) -> None:
        if reason in (QSystemTrayIcon.Trigger, QSystemTrayIcon.MiddleClick):
            self.open_dsh()

    # ── presentation ────────────────────────────────────────────────────────
    def _apply_state(self, state: str) -> None:
        self.state = state
        self.setIcon(self._make_icon(state))
        self.setToolTip(self._tooltip(state))
        self._refresh_menu()

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
        elif self.check_result:
            self.update_action.setText(self.check_result)
            self.update_action.setEnabled(False)
        else:
            self.update_action.setText("检查更新")
            self.update_action.setEnabled(True)

        self.status_action.setIcon(self._status_icon())
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
    holder = {}

    def wait_for_tray(attempt: int = 0) -> None:
        if QSystemTrayIcon.isSystemTrayAvailable():
            holder["tray"] = Tray(app)
            return
        if attempt < 30:
            if attempt == 0:
                log("system tray not ready; waiting")
            QTimer.singleShot(2000, lambda: wait_for_tray(attempt + 1))
            return
        log("system tray is not available")
        print("system tray is not available", file=sys.stderr)
        app.quit()

    QTimer.singleShot(0, wait_for_tray)
    try:
        return app.exec_()
    finally:
        try:
            TRAY_PID_FILE.unlink()
        except Exception:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
