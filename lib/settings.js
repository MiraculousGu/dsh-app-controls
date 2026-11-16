/**
 * Persistent settings for dsh-app-controls.
 *
 * The Web settings panel, the launcher and the tray helper share one JSON file
 * under the XDG state directory so a setting saved in the UI is effective on
 * the next DSH start/launch without editing the profile patch.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const STATE_DIR = path.join(
  process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'),
  'dsh-app-controls',
)
export const SETTINGS_FILE = path.join(STATE_DIR, 'settings.json')
export const TRAY_PID_FILE = path.join(STATE_DIR, 'tray.pid')
export const AUTOSTART_FILE = path.join(os.homedir(), '.config', 'autostart', 'dsh-tray.desktop')
export const PACKAGE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const TRAY_SCRIPT = path.join(PACKAGE_DIR, 'tray', 'dsh-tray.py')
const ICON_FILE = path.join(PACKAGE_DIR, 'icon.svg')
const TRAY_DISABLED = process.env.DSH_APP_CONTROLS_DISABLE_TRAY === '1'
const PYTHON = process.env.DSH_TRAY_PYTHON ?? '/usr/bin/python3'

export const DEFAULT_SETTINGS = {
  version: 1,
  trayEnabled: true,
  features: {
    updateButton: true,
    quitButton: true,
    headerControls: true,
    mainOverlay: true,
  },
  window: {
    width: 1400,
    height: 900,
  },
}

function asBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function asSize(value) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number <= 0) return 0
  return Math.min(10000, Math.max(600, Math.round(number)))
}

/** Accept partial user input and return a complete, validated settings object. */
export function normalizeSettings(input) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const features = source.features !== null && typeof source.features === 'object' ? source.features : {}
  const window = source.window !== null && typeof source.window === 'object' ? source.window : {}
  let width = asSize(window.width)
  let height = asSize(window.height)
  if (width === 0 || height === 0) {
    width = 0
    height = 0
  }
  return {
    version: 1,
    trayEnabled: asBoolean(source.trayEnabled, DEFAULT_SETTINGS.trayEnabled),
    features: {
      updateButton: asBoolean(features.updateButton, DEFAULT_SETTINGS.features.updateButton),
      quitButton: asBoolean(features.quitButton, DEFAULT_SETTINGS.features.quitButton),
      headerControls: asBoolean(features.headerControls, DEFAULT_SETTINGS.features.headerControls),
      mainOverlay: asBoolean(features.mainOverlay, DEFAULT_SETTINGS.features.mainOverlay),
    },
    window: { width, height },
  }
}

export function readSettings() {
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
    return normalizeSettings(parsed)
  } catch {
    return normalizeSettings(DEFAULT_SETTINGS)
  }
}

export function writeSettings(settings) {
  const normalized = normalizeSettings(settings)
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  chmodSync(STATE_DIR, 0o700)
  const temporary = `${SETTINGS_FILE}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, SETTINGS_FILE)
  try {
    chmodSync(SETTINGS_FILE, 0o600)
  } catch {
    // best effort
  }
  return normalized
}

function readTrayPid() {
  try {
    const pid = Number(readFileSync(TRAY_PID_FILE, 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

function pidIsAlive(pid) {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function autostartContent() {
  return (
    '[Desktop Entry]\n'
    + 'Type=Application\n'
    + 'Name=DeepSeek Harness Tray\n'
    + 'Comment=DeepSeek Harness status and controls in the system tray\n'
    + `Exec=${PYTHON} "${TRAY_SCRIPT}"\n`
    + `Icon=${ICON_FILE}\n`
    + 'Terminal=false\n'
    + 'X-KDE-autostart-after=panel\n'
    + 'OnlyShowIn=KDE;\n'
  )
}

function enableTray(log) {
  try {
    mkdirSync(path.dirname(AUTOSTART_FILE), { recursive: true })
    writeFileSync(AUTOSTART_FILE, autostartContent(), { mode: 0o644 })
  } catch (error) {
    log('failed to write tray autostart entry', error)
  }
  const pid = readTrayPid()
  if (pidIsAlive(pid)) return
  if (!existsSync(TRAY_SCRIPT)) {
    log('tray script is missing', TRAY_SCRIPT)
    return
  }
  try {
    const child = spawn(PYTHON, [TRAY_SCRIPT], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    })
    child.unref()
    log('tray started')
  } catch (error) {
    log('failed to start tray', error)
  }
}

function disableTray(log) {
  try {
    rmSync(AUTOSTART_FILE, { force: true })
  } catch (error) {
    log('failed to remove tray autostart entry', error)
  }
  const pid = readTrayPid()
  if (pidIsAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM')
      log('tray stopped')
    } catch (error) {
      log('failed to stop tray', error)
    }
  }
  try {
    rmSync(TRAY_PID_FILE, { force: true })
  } catch {
    // best effort
  }
}

/** Apply tray enable/disable and the login autostart entry from settings. */
export function applyTraySettings(settings, log = () => {}) {
  if (TRAY_DISABLED) return
  if (settings.trayEnabled) enableTray(log)
  else disableTray(log)
}
