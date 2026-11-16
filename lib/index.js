/**
 * dsh-app-controls — host half.
 *
 * Registers three authenticated exact Fetch routes below `/api`:
 *
 *   POST /api/dsh-app-controls/quit
 *     Gracefully stops the whole dsh web process through the launcher's
 *     `appExit` service (the same path SIGTERM uses).
 *
 *   GET  /api/dsh-app-controls/update
 *     Reports the installed and newest installable DeepSeek Harness version.
 *   POST /api/dsh-app-controls/update
 *     Starts a background update job (staging copy + npm install + atomic
 *     swap). Returns immediately; the job exits the process once it succeeds.
 *
 *   GET  /api/dsh-app-controls/update-progress
 *     Poll target for the update dialog: phase, percent, activity and elapsed
 *     time.
 *
 * Exact Fetch routes on the shared `/api` channel inherit Connection's
 * Host/Origin fence, signed browser cookie, and owner-peer check, so only the
 * authenticated local Web UI can reach them.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkUpdates, updateTo } from './update.js'

export const name = 'dsh-app-controls'

/** Wait for Connection before registering routes; it owns the `/api` carrier. */
export const inject = ['connection']

const STATE_DIR = path.join(
  process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'),
  'dsh-app-controls',
)
const LOG_FILE = path.join(STATE_DIR, 'app-controls.log')

const QUIT_PATH = '/api/dsh-app-controls/quit'
const UPDATE_PATH = '/api/dsh-app-controls/update'
const PROGRESS_PATH = '/api/dsh-app-controls/update-progress'

/** Exit grace after a successful update so the page can read `done` and close. */
const UPDATE_EXIT_DELAY_MS = 3000
/** Exit grace after a quit request so the response reaches the page. */
const QUIT_EXIT_DELAY_MS = 500

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

/** One process-local update job; the Web UI polls its snapshot. */
const job = {
  started: false,
  active: false,
  done: false,
  error: null,
  phase: 'idle',
  percent: 0,
  message: '',
  activity: '',
  startedAt: 0,
  finishedAt: 0,
  elapsedMs: 0,
  from: null,
  to: null,
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
    phase: job.phase,
    percent: job.percent,
    message: job.message,
    activity: job.activity,
    elapsedMs,
    from: job.from,
    to: job.to,
  }
}

async function runUpdateJob(ctx, appExit, status) {
  Object.assign(job, {
    started: true,
    active: true,
    done: false,
    error: null,
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
      if (typeof event.elapsedMs === 'number') job.elapsedMs = event.elapsedMs
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
    if (exitScheduled) scheduleExit(ctx, appExit, UPDATE_EXIT_DELAY_MS)
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
      log('quit requested from the Web UI')
      scheduleExit(ctx, appExit, QUIT_EXIT_DELAY_MS)
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
          return json(200, await checkUpdates())
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
        const status = await checkUpdates()
        if (!status.updateAvailable) {
          return json(409, {
            ok: false,
            error: 'up-to-date',
            current: status.current,
            message: `已是最新版本（${status.current}）。`,
          })
        }
        log(`starting update ${status.current} -> ${status.candidate}`)
        void runUpdateJob(ctx, appExit, status)
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
      try {
        return json(200, jobSnapshot())
      } catch (error) {
        return json(500, {
          ok: false,
          error: 'progress-failed',
          message: `无法读取更新进度：${describe(error)}`,
        })
      }
    },
  })
}
