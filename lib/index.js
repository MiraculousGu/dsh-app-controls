/**
 * dsh-app-controls — host half.
 *
 * Web routes below `/api` (authenticated by Connection):
 *   POST /api/dsh-app-controls/quit
 *   GET|POST /api/dsh-app-controls/update
 *   GET  /api/dsh-app-controls/update-progress
 *   GET  /api/dsh-app-controls/state
 *
 * A local Unix-socket control channel for the KDE tray helper
 * (`~/.local/state/dsh-app-controls/control.sock`, mode 0600) exposes the
 * same operations without storing browser credentials in the helper:
 *   status | check-update | update | quit
 *
 * Quit/update requests reach the open Web page through the `state` route's
 * `quitRequested` flag, so the tray can close the window as well as stop the
 * service (and restart it later).
 */
import { appendFileSync, chmodSync, mkdirSync, unlinkSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { checkUpdates, locateInstall, updateTo } from './update.js'
import { applyTraySettings, normalizeSettings, readSettings, writeSettings } from './settings.js'

export const name = 'dsh-app-controls'

/** Wait for Connection before registering routes; it owns the `/api` carrier. */
export const inject = ['connection']

const STATE_DIR = path.join(
  process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'),
  'dsh-app-controls',
)
const LOG_FILE = path.join(STATE_DIR, 'app-controls.log')
const CONTROL_SOCKET = path.join(STATE_DIR, 'control.sock')
const CONTROL_DISABLED = process.env.DSH_APP_CONTROLS_DISABLE_SOCKET === '1'

const QUIT_PATH = '/api/dsh-app-controls/quit'
const UPDATE_PATH = '/api/dsh-app-controls/update'
const PROGRESS_PATH = '/api/dsh-app-controls/update-progress'
const STATE_PATH = '/api/dsh-app-controls/state'
const SETTINGS_PATH = '/api/dsh-app-controls/settings'

const UPDATE_CACHE_TTL_MS = 5 * 60 * 1000
const UPDATE_EXIT_DELAY_MS = 3000
const TRAY_UPDATE_EXIT_DELAY_MS = 4500
const QUIT_EXIT_DELAY_MS = 800
const TRAY_QUIT_EXIT_DELAY_MS = 4500
const SERVER_STARTED_AT = Date.now()

function describe(value) {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.message
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function log(message, detail) {
  const suffix = detail === undefined ? '' : ` ${describe(detail)}`
  const line = `${new Date().toISOString()} ${message}${suffix}`
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
    appendFileSync(LOG_FILE, `${line}\n`)
  } catch {
    // Logging must never break a quit/update request.
  }
  console.log(`[dsh-app-controls] ${line}`)
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/** Refuse destructive actions from deployments that accept non-loopback authorities. */
function remoteRefusal(ctx) {
  if (ctx.connection.allowsRemoteAuthorities) {
    return json(403, {
      ok: false,
      error: 'remote-access-not-allowed',
      message: '当前部署允许远程访问：界面退出/更新仅限本机使用。',
    })
  }
  return undefined
}

/** The launcher-provided exit service; optional so embedded hosts answer cleanly. */
function exitHook(ctx) {
  const appExit = ctx.get('appExit')
  return typeof appExit === 'function' ? appExit : undefined
}

function scheduleExit(ctx, appExit, delayMs) {
  setTimeout(() => {
    try {
      appExit(0)
    } catch (error) {
      log('appExit threw', error)
    }
  }, delayMs)
}

function messageForUpdateError(result) {
  switch (result.error) {
    case 'update-timeout':
      return '更新超时：下载或安装耗时过长，请检查网络后重试。'
    case 'copy-failed':
      return `准备更新副本失败：${result.detail || '未知错误'}`
    case 'swap-failed':
      return `切换新版本失败：${result.detail || '未知错误'}`
    case 'version-unchanged':
      return '安装后版本未变化，更新未生效。'
    case 'version-unreadable':
      return '无法读取新版本信息，更新未生效。'
    default:
      return `更新失败：${result.detail || result.error}`
  }
}

/** One process-local update job; the Web UI/tray polls its snapshot. */
const job = {
  started: false,
  active: false,
  done: false,
  error: null,
  source: null,
  phase: 'idle',
  percent: 0,
  message: '',
  activity: '',
  startedAt: 0,
  finishedAt: 0,
}

function jobSnapshot() {
  const now = Date.now()
  const elapsedMs = job.startedAt === 0
    ? 0
    : (job.finishedAt !== 0 ? job.finishedAt : now) - job.startedAt
  return {
    ok: true,
    started: job.started,
    active: job.active,
    done: job.done,
    error: job.error,
    source: job.source,
    phase: job.phase,
    percent: job.percent,
    message: job.message,
    activity: job.activity,
    elapsedMs,
    from: job.from,
    to: job.to,
  }
}

const updateCache = { checkedAt: 0, value: null }
const quitState = { requested: false }

function installedVersion() {
  try {
    return locateInstall(process.argv[1]).version
  } catch {
    return null
  }
}

function serverFacts(ctx) {
  try {
    const webServer = ctx.get('webServer')
    if (webServer !== undefined && webServer !== null) {
      return { host: webServer.host ?? null, port: webServer.port ?? null }
    }
  } catch {
    // the listener may not be bound yet
  }
  return { host: null, port: null }
}

function statusSnapshot(ctx) {
  const facts = serverFacts(ctx)
  return {
    ok: true,
    running: true,
    pid: process.pid,
    version: installedVersion(),
    host: facts.host,
    port: facts.port,
    uptimeMs: Math.max(0, Date.now() - SERVER_STARTED_AT),
    quitRequested: quitState.requested,
    job: jobSnapshot(),
    update: updateCache.value,
    updateCheckedAt: updateCache.checkedAt || null,
  }
}

async function getUpdateStatus(force) {
  if (!force && updateCache.value !== null && Date.now() - updateCache.checkedAt < UPDATE_CACHE_TTL_MS) {
    return updateCache.value
  }
  const value = await checkUpdates()
  updateCache.value = value
  updateCache.checkedAt = Date.now()
  return value
}

function requestQuit(ctx, appExit, source, delayMs) {
  quitState.requested = true
  log(`quit requested (${source})`)
  scheduleExit(ctx, appExit, delayMs)
}

async function runUpdateJob(ctx, appExit, status, source) {
  Object.assign(job, {
    started: true,
    active: true,
    done: false,
    error: null,
    source,
    phase: 'copy',
    percent: 1,
    message: '正在准备更新…',
    activity: '',
    startedAt: Date.now(),
    finishedAt: 0,
    from: status.current,
    to: status.candidate,
  })
  let exitScheduled = false
  try {
    const result = await updateTo(status.candidate, undefined, (event) => {
      job.phase = event.phase
      job.percent = Math.max(0, Math.min(100, Math.round(event.percent ?? 0)))
      job.message = event.message ?? ''
      job.activity = event.activity ?? ''
    })
    if (!result.ok) {
      job.error = result.error
      job.message = messageForUpdateError(result)
      log('update failed', result)
    } else {
      job.phase = 'done'
      job.percent = 100
      job.message = `更新完成：DeepSeek Harness ${result.to}`
      job.to = result.to
      job.error = null
      exitScheduled = true
      if (source === 'tray') quitState.requested = true
      log(`updated ${result.from} -> ${result.to}; stopping to apply the new version`)
    }
  } catch (error) {
    job.error = 'update-failed'
    job.message = `更新失败：${describe(error)}`
    log('update crashed', error)
  } finally {
    job.active = false
    job.done = true
    job.finishedAt = Date.now()
    if (exitScheduled) {
      scheduleExit(ctx, appExit, source === 'tray' ? TRAY_UPDATE_EXIT_DELAY_MS : UPDATE_EXIT_DELAY_MS)
    }
  }
}

/* ── local control socket for the KDE tray helper ───────────────────────── */

function writeControlResponse(socket, payload) {
  try {
    socket.write(`${JSON.stringify(payload)}\n`)
  } catch {
    // the tray may have gone away
  }
}

async function handleControlCommand(ctx, appExit, request) {
  const base = {}
  if (request.id !== undefined) base.id = request.id
  const command = typeof request.command === 'string' ? request.command : ''
  try {
    switch (command) {
      case 'status':
        return { ...base, ...statusSnapshot(ctx) }
      case 'check-update': {
        const value = await getUpdateStatus(true)
        return { ...base, ok: true, update: value }
      }
      case 'update': {
        if (job.active) {
          return { ...base, ok: false, error: 'update-in-progress', message: '已有更新正在进行。' }
        }
        if (appExit === undefined) {
          return { ...base, ok: false, error: 'no-exit-hook', message: '当前宿主没有退出接口。' }
        }
        const value = await getUpdateStatus(true)
        if (!value.updateAvailable) {
          return { ...base, ok: false, error: 'up-to-date', update: value, message: `已是最新版本（${value.current}）。` }
        }
        log(`tray started update ${value.current} -> ${value.candidate}`)
        void runUpdateJob(ctx, appExit, value, 'tray')
        return { ...base, ok: true, started: true, from: value.current, to: value.candidate }
      }
      case 'quit': {
        if (job.active) {
          return { ...base, ok: false, error: 'update-in-progress', message: '正在更新，请等待完成。' }
        }
        if (appExit === undefined) {
          return { ...base, ok: false, error: 'no-exit-hook', message: '当前宿主没有退出接口。' }
        }
        requestQuit(ctx, appExit, 'tray', TRAY_QUIT_EXIT_DELAY_MS)
        return { ...base, ok: true, message: '正在停止 DeepSeek Harness。' }
      }
      default:
        return { ...base, ok: false, error: 'unknown-command', message: `未知命令：${command}` }
    }
  } catch (error) {
    log('control command failed', error)
    return { ...base, ok: false, error: 'command-failed', message: describe(error) }
  }
}

function createControlServer(ctx, getAppExit) {
  if (CONTROL_DISABLED) return () => {}
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
    chmodSync(STATE_DIR, 0o700)
  } catch {
    // the directory may already exist with the right permissions
  }
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8')
    let buffer = ''
    let chain = Promise.resolve()
    socket.on('data', (chunk) => {
      buffer += chunk
      if (buffer.length > 1_000_000) {
        buffer = ''
        socket.destroy()
        return
      }
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line !== '') {
          chain = chain.then(async () => {
            let request = {}
            try {
              request = JSON.parse(line)
            } catch {
              request = {}
            }
            const response = await handleControlCommand(ctx, getAppExit(), request)
            writeControlResponse(socket, response)
          }).catch(() => {})
        }
        index = buffer.indexOf('\n')
      }
    })
    socket.on('error', () => {})
  })
  server.on('error', (error) => log('control socket error', error))
  try {
    unlinkSync(CONTROL_SOCKET)
  } catch {
    // no stale socket
  }
  try {
    server.listen(CONTROL_SOCKET, () => {
      try {
        chmodSync(CONTROL_SOCKET, 0o600)
      } catch {
        // best effort
      }
      log('control socket listening')
    })
  } catch (error) {
    log('control socket listen failed', error)
  }
  return () => {
    try {
      server.close()
    } catch {
      // already closed
    }
    try {
      unlinkSync(CONTROL_SOCKET)
    } catch {
      // already gone
    }
  }
}

export function apply(ctx) {
  ctx.connection.fetch.register({
    path: QUIT_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async () => {
      const refusal = remoteRefusal(ctx)
      if (refusal !== undefined) return refusal
      if (job.active) {
        return json(409, {
          ok: false,
          error: 'update-in-progress',
          message: '正在更新 DeepSeek Harness，请等待更新完成。',
        })
      }
      const appExit = exitHook(ctx)
      if (appExit === undefined) {
        return json(501, {
          ok: false,
          error: 'no-exit-hook',
          message: '当前宿主没有提供退出接口，无法从界面退出。',
        })
      }
      requestQuit(ctx, appExit, 'web', QUIT_EXIT_DELAY_MS)
      return json(202, { ok: true, message: 'DeepSeek Harness 正在退出。' })
    },
  })

  ctx.connection.fetch.register({
    path: UPDATE_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method === 'GET') {
        try {
          return json(200, await getUpdateStatus(false))
        } catch (error) {
          log('update check failed', error)
          return json(502, {
            ok: false,
            error: 'check-failed',
            message: `检查更新失败：${describe(error)}`,
          })
        }
      }

      const refusal = remoteRefusal(ctx)
      if (refusal !== undefined) return refusal
      const appExit = exitHook(ctx)
      if (appExit === undefined) {
        return json(501, {
          ok: false,
          error: 'no-exit-hook',
          message: '当前宿主没有提供退出接口，无法在更新后重启。',
        })
      }
      if (job.active) {
        return json(409, {
          ok: false,
          error: 'update-in-progress',
          message: '已有更新正在进行，请稍候。',
        })
      }
      try {
        const status = await getUpdateStatus(true)
        if (!status.updateAvailable) {
          return json(409, {
            ok: false,
            error: 'up-to-date',
            current: status.current,
            message: `已是最新版本（${status.current}）。`,
          })
        }
        log(`starting update ${status.current} -> ${status.candidate}`)
        void runUpdateJob(ctx, appExit, status, 'web')
        return json(202, {
          ok: true,
          started: true,
          from: status.current,
          to: status.candidate,
        })
      } catch (error) {
        log('update start failed', error)
        return json(502, {
          ok: false,
          error: 'update-start-failed',
          message: `无法开始更新：${describe(error)}`,
        })
      }
    },
  })

  ctx.connection.fetch.register({
    path: PROGRESS_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      return json(200, jobSnapshot())
    },
  })

  ctx.connection.fetch.register({
    path: STATE_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      return json(200, statusSnapshot(ctx))
    },
  })

  ctx.connection.fetch.register({
    path: SETTINGS_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method === 'GET') {
        return json(200, { ok: true, settings: readSettings() })
      }
      const refusal = remoteRefusal(ctx)
      if (refusal !== undefined) return refusal
      let patch
      try {
        patch = await request.json()
      } catch {
        return json(400, { ok: false, error: 'invalid-json', message: '设置内容不是合法 JSON。' })
      }
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
        return json(400, { ok: false, error: 'invalid-settings', message: '设置内容必须是对象。' })
      }
      const current = readSettings()
      const next = normalizeSettings({
        ...current,
        ...patch,
        features: { ...current.features, ...(patch.features ?? {}) },
        window: { ...current.window, ...(patch.window ?? {}) },
      })
      writeSettings(next)
      applyTraySettings(next, log)
      log('settings updated')
      return json(200, { ok: true, settings: next })
    },
  })

  ctx.effect(() => createControlServer(ctx, () => exitHook(ctx)), 'dsh-app-controls: control socket')
  applyTraySettings(readSettings(), log)
}
