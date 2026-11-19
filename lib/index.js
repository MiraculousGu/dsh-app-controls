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
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { CACHE_CATEGORIES, cleanCache, packageManagerBusy, scanCache } from './cache.js'
import { checkUpdates, fetchReleaseNotes, locateInstall, updateTo } from './update.js'
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
const UPDATE_DEFER_PATH = '/api/dsh-app-controls/update/defer'
const STATE_PATH = '/api/dsh-app-controls/state'
const SETTINGS_PATH = '/api/dsh-app-controls/settings'
const CACHE_PATH = '/api/dsh-app-controls/cache'
const CACHE_CLEAN_PATH = '/api/dsh-app-controls/cache/clean'
const VIEW_HANDLED_PATH = '/api/dsh-app-controls/view-handled'
const UPDATE_DEFER_FILE = path.join(STATE_DIR, 'update-defer.json')

const UPDATE_CACHE_TTL_MS = 5 * 60 * 1000
const AUTO_CHECK_INTERVAL_MS = 30 * 60 * 1000
const VIEW_TTL_MS = 30 * 1000
const AUTO_CHECK_DISABLED = process.env.DSH_APP_CONTROLS_DISABLE_AUTO_UPDATE === '1'
const UPDATE_EXIT_DELAY_MS = 3000
const TRAY_UPDATE_EXIT_DELAY_MS = 4500
const QUIT_EXIT_DELAY_MS = 800
const TRAY_QUIT_EXIT_DELAY_MS = 4500
const SERVER_STARTED_AT = Date.now()
let cacheRunning = false
let pendingView = null
let viewSequence = 0
let autoCheckTimer = null

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
const releaseNotesCache = new Map()
const quitState = { requested: false }

/** Persist "remind me later" across the service restart/update flow. */
function readUpdateDefer() {
  try {
    const parsed = JSON.parse(readFileSync(UPDATE_DEFER_FILE, 'utf8'))
    const until = Number(parsed.until)
    return Number.isFinite(until) && until > Date.now() ? until : 0
  } catch {
    return 0
  }
}

let updateDeferUntil = readUpdateDefer()

function setUpdateDefer(until) {
  updateDeferUntil = Number.isFinite(until) && until > Date.now() ? Math.round(until) : 0
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
    const temporary = `${UPDATE_DEFER_FILE}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ until: updateDeferUntil })}\n`, { mode: 0o600 })
    renameSync(temporary, UPDATE_DEFER_FILE)
  } catch (error) {
    log('could not persist update deferral', error)
  }
}

function clearUpdateDefer() {
  setUpdateDefer(0)
}

function activeWorkSnapshot(ctx) {
  const items = []
  const seen = new Set()
  let available = false
  try {
    const agents = ctx.get('agents')
    if (agents !== undefined && agents !== null && typeof agents.list === 'function') {
      available = true
      for (const agent of agents.list()) {
        if (agent === null || typeof agent !== 'object' || agent.status !== 'running') continue
        const id = String(agent.id ?? 'turn')
        if (seen.has(`turn:${id}`)) continue
        seen.add(`turn:${id}`)
        items.push({ kind: 'turn', id, label: '进行中的对话' })
      }
    }
  } catch {
    // the agent service is optional in embedded hosts
  }
  try {
    const sessions = ctx.get('sessions')
    const jobs = ctx.get('jobs')
    if (jobs !== undefined && jobs !== null && typeof jobs.list === 'function') {
      available = true
      const callers = [undefined]
      if (sessions !== undefined && sessions !== null && typeof sessions.list === 'function') {
        for (const session of sessions.list()) callers.push(session.id)
      }
      for (const caller of callers) {
        let rows
        try {
          rows = jobs.list(caller)
        } catch {
          continue
        }
        for (const row of rows) {
          if (row === null || typeof row !== 'object') continue
          if (row.status !== 'running' && row.status !== 'stopping') continue
          const id = String(row.id ?? 'job')
          if (seen.has(`job:${id}`)) continue
          seen.add(`job:${id}`)
          items.push({ kind: 'job', id, label: String(row.label ?? '后台任务') })
        }
      }
    }
  } catch {
    // the jobs service is optional in embedded hosts
  }
  return {
    available,
    active: items.length > 0,
    count: items.length,
    turns: items.filter((item) => item.kind === 'turn').length,
    jobs: items.filter((item) => item.kind === 'job').length,
    items: items.slice(0, 8),
  }
}

function updateStatusFor(ctx, value) {
  if (value === null || typeof value !== 'object') return value
  return {
    ...value,
    activity: activeWorkSnapshot(ctx),
    updateDeferUntil: updateDeferUntil > Date.now() ? updateDeferUntil : null,
  }
}

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

function currentPendingView() {
  if (pendingView === null) return null
  if (Date.now() - pendingView.at > VIEW_TTL_MS) {
    pendingView = null
    return null
  }
  return pendingView
}

function queueView(view) {
  viewSequence += 1
  pendingView = {
    id: `view-${Date.now()}-${viewSequence}`,
    view,
    at: Date.now(),
  }
  return pendingView
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
    update: updateStatusFor(ctx, updateCache.value),
    updateCheckedAt: updateCache.checkedAt || null,
    updateDeferUntil: updateDeferUntil > Date.now() ? updateDeferUntil : null,
    activity: activeWorkSnapshot(ctx),
    pendingView: currentPendingView(),
  }
}

async function releaseNotesFor(version) {
  if (typeof version !== 'string' || version === '') return null
  const cached = releaseNotesCache.get(version)
  if (cached !== undefined && Date.now() - cached.at < 6 * 60 * 60 * 1000) return cached.value
  let value = null
  try {
    value = await fetchReleaseNotes({ to: version, timeoutMs: 2500 })
  } catch {
    value = null
  }
  if (value !== null) releaseNotesCache.set(version, { at: Date.now(), value })
  return value
}

async function getUpdateStatus(ctx, force) {
  if (!force && updateCache.value !== null && Date.now() - updateCache.checkedAt < UPDATE_CACHE_TTL_MS) {
    return updateStatusFor(ctx, updateCache.value)
  }
  let value = await checkUpdates()
  if (value !== null && typeof value === 'object' && value.updateAvailable === true && typeof value.candidate === 'string') {
    const notes = await releaseNotesFor(value.candidate)
    if (notes !== null) value = { ...value, releaseNotes: notes }
  }
  updateCache.value = value
  updateCache.checkedAt = Date.now()
  return updateStatusFor(ctx, value)
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
  clearUpdateDefer()
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
        const value = await getUpdateStatus(ctx, true)
        return { ...base, ok: true, update: value }
      }
      case 'defer-update': {
        const minutes = Number(request.minutes ?? 60)
        if (!Number.isFinite(minutes) || minutes < 5 || minutes > 7 * 24 * 60) {
          return { ...base, ok: false, error: 'invalid-defer', message: '推迟时间必须在 5 分钟到 7 天之间。' }
        }
        const until = Date.now() + Math.round(minutes * 60 * 1000)
        setUpdateDefer(until)
        log(`update deferred for ${minutes} minutes`)
        return { ...base, ok: true, updateDeferUntil: until }
      }
      case 'update': {
        if (job.active) {
          return { ...base, ok: false, error: 'update-in-progress', message: '已有更新正在进行。' }
        }
        if (cacheRunning) {
          return { ...base, ok: false, error: 'cache-clean-in-progress', message: '正在清理缓存，请稍后再更新。' }
        }
        if (appExit === undefined) {
          return { ...base, ok: false, error: 'no-exit-hook', message: '当前宿主没有退出接口。' }
        }
        const value = await getUpdateStatus(ctx, true)
        if (!value.updateAvailable) {
          return { ...base, ok: false, error: 'up-to-date', update: value, message: `已是最新版本（${value.current}）。` }
        }
        log(`tray started update ${value.current} -> ${value.candidate}`)
        void runUpdateJob(ctx, appExit, value, 'tray')
        return { ...base, ok: true, started: true, from: value.current, to: value.candidate }
      }
      case 'open-view': {
        const view = typeof request.view === 'string' ? request.view : ''
        if (view !== 'plugins' && view !== 'settings') {
          return { ...base, ok: false, error: 'invalid-view', message: `未知视图：${view}` }
        }
        const pending = queueView(view)
        log(`tray requested view ${view}`)
        return { ...base, ok: true, pendingView: pending }
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

function startUpdateAutoCheck(ctx) {
  if (AUTO_CHECK_DISABLED || autoCheckTimer !== null) return
  const tick = async () => {
    try {
      if (readSettings().update.autoCheck) await getUpdateStatus(ctx, true)
    } catch (error) {
      log('background update check failed', error)
    }
    autoCheckTimer = setTimeout(tick, AUTO_CHECK_INTERVAL_MS)
    if (typeof autoCheckTimer.unref === 'function') autoCheckTimer.unref()
  }
  autoCheckTimer = setTimeout(tick, 15 * 1000)
  if (typeof autoCheckTimer.unref === 'function') autoCheckTimer.unref()
}

export function apply(ctx) {
  startUpdateAutoCheck(ctx)
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
          return json(200, await getUpdateStatus(ctx, false))
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
      if (cacheRunning) {
        return json(409, {
          ok: false,
          error: 'cache-clean-in-progress',
          message: '正在清理缓存，请稍后再更新。',
        })
      }
      try {
        const status = await getUpdateStatus(ctx, true)
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
          activity: status.activity,
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
    path: UPDATE_DEFER_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const refusal = remoteRefusal(ctx)
      if (refusal !== undefined) return refusal
      if (job.active) {
        return json(409, {
          ok: false,
          error: 'update-in-progress',
          message: '更新已经开始，无法再推迟。',
        })
      }
      let body
      try {
        body = await request.json()
      } catch {
        return json(400, { ok: false, error: 'invalid-json', message: '推迟请求不是合法 JSON。' })
      }
      const minutes = Number(body?.minutes ?? 60)
      if (!Number.isFinite(minutes) || minutes < 5 || minutes > 7 * 24 * 60) {
        return json(400, { ok: false, error: 'invalid-defer', message: '推迟时间必须在 5 分钟到 7 天之间。' })
      }
      const until = Date.now() + Math.round(minutes * 60 * 1000)
      setUpdateDefer(until)
      log(`web update deferred for ${minutes} minutes`)
      return json(200, { ok: true, updateDeferUntil: until })
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
    path: VIEW_HANDLED_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const refusal = remoteRefusal(ctx)
      if (refusal !== undefined) return refusal
      let body
      try {
        body = await request.json()
      } catch {
        return json(400, { ok: false, error: 'invalid-json', message: '导航确认不是合法 JSON。' })
      }
      const id = body !== null && typeof body === 'object' && typeof body.id === 'string' ? body.id : ''
      if (pendingView !== null && pendingView.id === id) pendingView = null
      return json(200, { ok: true })
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
        trayIcon: { ...current.trayIcon, ...(patch.trayIcon ?? {}) },
        update: { ...current.update, ...(patch.update ?? {}) },
      })
      writeSettings(next)
      applyTraySettings(next, log)
      log('settings updated')
      return json(200, { ok: true, settings: next })
    },
  })

  ctx.connection.fetch.register({
    path: CACHE_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      try {
        return json(200, await scanCache())
      } catch (error) {
        log('cache scan failed', error)
        return json(500, {
          ok: false,
          error: 'cache-scan-failed',
          message: `读取缓存信息失败：${describe(error)}`,
        })
      }
    },
  })

  ctx.connection.fetch.register({
    path: CACHE_CLEAN_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const refusal = remoteRefusal(ctx)
      if (refusal !== undefined) return refusal
      if (job.active) {
        return json(409, {
          ok: false,
          error: 'update-in-progress',
          message: '正在更新 DeepSeek Harness，请等待更新完成。',
        })
      }
      if (cacheRunning) {
        return json(409, {
          ok: false,
          error: 'cache-clean-in-progress',
          message: '已有缓存清理正在执行，请稍候。',
        })
      }
      let body
      try {
        body = await request.json()
      } catch {
        return json(400, { ok: false, error: 'invalid-json', message: '清理请求不是合法 JSON。' })
      }
      const categories = body !== null && typeof body === 'object' && Array.isArray(body.categories)
        ? [...new Set(body.categories.filter((id) => typeof id === 'string'))]
        : []
      if (categories.length === 0) {
        return json(400, { ok: false, error: 'invalid-categories', message: '请至少选择一种缓存类型。' })
      }
      const unknown = categories.filter((id) => !CACHE_CATEGORIES.includes(id))
      if (unknown.length > 0) {
        return json(400, {
          ok: false,
          error: 'invalid-categories',
          message: `未知缓存类型：${unknown.join(', ')}`,
        })
      }
      const packageCategories = new Set(['npx', 'npm', 'pnpm'])
      if (categories.some((id) => packageCategories.has(id)) && packageManagerBusy()) {
        return json(409, {
          ok: false,
          error: 'package-manager-busy',
          message: '有 npm/pnpm/npx 进程正在运行，请等待其结束后再清理包缓存。',
        })
      }
      cacheRunning = true
      try {
        const result = await cleanCache(categories)
        const inventory = await scanCache()
        log('cache cleaned', { categories, freedBytes: result.freedBytes })
        return json(200, { ...result, inventory })
      } catch (error) {
        log('cache clean failed', error)
        return json(409, {
          ok: false,
          error: error.code ?? 'cache-clean-failed',
          message: `缓存清理失败：${describe(error)}`,
        })
      } finally {
        cacheRunning = false
      }
    },
  })

  ctx.effect(() => createControlServer(ctx, () => exitHook(ctx)), 'dsh-app-controls: control socket')
  applyTraySettings(readSettings(), log)
}
