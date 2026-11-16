/**
 * Version check and update helpers for the DeepSeek Harness Web GUI buttons.
 *
 * This module intentionally has no DeepSeek Harness imports: it only uses
 * Node.js builtins and the global fetch/Response/AbortSignal APIs, so it can
 * be unit-tested with plain `node`. The host plugin (./index.js) wires it to
 * authenticated `/api` routes.
 *
 * Update semantics follow npm: the running installation is located from
 * `process.argv[1]` (the `dsh` bin), and the candidate is the newest published
 * version that satisfies the dependency spec recorded by that installation.
 * The update itself is an `npm install` into the installation root, i.e. the
 * npx cache directory for `npx @deepseek-ai/dsh` installations.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const PACKAGE_NAME = '@deepseek-ai/dsh'

const REGISTRY = 'https://registry.npmjs.org'
const VIEW_TIMEOUT_MS = 60_000
const INSTALL_TIMEOUT_MS = 900_000
const OUTPUT_LIMIT = 200_000
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
const STATE_DIR = path.join(
  process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'),
  'dsh-app-controls',
)
const TIMING_FILE = path.join(STATE_DIR, 'update-timing.json')
const DEFAULT_INSTALL_MS = 5 * 60 * 1000
const MIN_EXPECTED_MS = 20 * 1000
const MAX_EXPECTED_MS = 30 * 60 * 1000
const ANSI = /\u001b\[[0-9;]*m/gu

/**
 * Locate the running DSH installation.
 *
 * @param {string} [argv1] - launcher script path; defaults to `process.argv[1]`.
 * @returns {{ root: string, packageDir: string, version: string, range: string | undefined }}
 *   `root` is the npm project that dependencies live under (the npx cache
 *   directory for npx installs), `packageDir` the `@deepseek-ai/dsh` package.
 */
export function locateInstall(argv1 = process.argv[1]) {
  if (!argv1) throw new Error('无法定位 DSH 安装：process.argv[1] 为空')
  const realBin = fs.realpathSync(argv1)
  const packageDir = path.resolve(path.dirname(realBin), '..')
  const installed = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'))
  const root = path.dirname(path.dirname(path.dirname(packageDir)))
  let range
  try {
    const rootPackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    const spec = rootPackage?.dependencies?.[PACKAGE_NAME]
    if (typeof spec === 'string') range = spec
  } catch {
    // The root may be a global prefix or a read-only location; the version
    // check falls back to the `latest` dist-tag in that case.
  }
  return { root, packageDir, version: String(installed.version), range }
}

function parseVersion(value) {
  const match = SEMVER.exec(String(value).trim())
  if (match === null) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

function comparePrerelease(left, right) {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index]
    const b = right[index]
    const aNumeric = /^\d+$/.test(a)
    const bNumeric = /^\d+$/.test(b)
    if (aNumeric && bNumeric) {
      const numericA = Number(a)
      const numericB = Number(b)
      if (numericA !== numericB) return numericA < numericB ? -1 : 1
      continue
    }
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
    if (a !== b) return a < b ? -1 : 1
  }
  if (left.length === right.length) return 0
  return left.length < right.length ? -1 : 1
}

/**
 * Compare two semantic versions.
 *
 * @param {string} left - version A.
 * @param {string} right - version B.
 * @returns {-1 | 0 | 1} negative when A is older, 0 when equal, positive when newer.
 */
export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === undefined || b === undefined) throw new Error(`无法解析版本号：${a === undefined ? left : right}`)
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  return comparePrerelease(a.prerelease, b.prerelease)
}

function findNpmCli() {
  const candidates = []
  if (process.env.npm_execpath) candidates.push(process.env.npm_execpath)
  candidates.push(path.join(path.dirname(process.execPath), 'npm'))
  for (const dir of String(process.env.PATH ?? '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, 'npm'))
  }
  for (const candidate of candidates) {
    try {
      const real = fs.realpathSync(candidate)
      if (fs.statSync(real).isFile()) return real
    } catch {
      // try the next candidate
    }
  }
  return undefined
}

/**
 * Run the npm CLI in a child process, collecting bounded output.
 *
 * @param {string[]} args - npm arguments.
 * @param {{ timeoutMs?: number, onLine?: (line: string) => void }} [options]
 *   timeout override, plus an optional complete-line callback (used to show the
 *   last npm activity in the update progress dialog).
 * @returns {Promise<{ ok: boolean, code: number | null, timedOut: boolean, stdout: string, stderr: string }>}
 */
export function runNpm(args, options = {}) {
  const timeoutMs = options.timeoutMs ?? VIEW_TIMEOUT_MS
  const onLine = typeof options.onLine === 'function' ? options.onLine : undefined
  return new Promise((resolve) => {
    const cli = findNpmCli()
    if (cli === undefined) {
      resolve({ ok: false, code: null, timedOut: false, stdout: '', stderr: '找不到 npm 可执行文件' })
      return
    }
    let child
    try {
      child = spawn(process.execPath, [cli, ...args], {
        env: { ...process.env, npm_config_update_notifier: 'false', NO_UPDATE_NOTIFIER: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      resolve({ ok: false, code: null, timedOut: false, stdout: '', stderr: String(error) })
      return
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const buffers = { stdout: '', stderr: '' }
    const feedLines = (stream, text) => {
      if (onLine === undefined) return
      buffers[stream] += text
      if (buffers[stream].length > 4096) buffers[stream] = buffers[stream].slice(-2048)
      let index = buffers[stream].indexOf('\n')
      while (index >= 0) {
        const line = buffers[stream].slice(0, index).replace(ANSI, '').trim()
        buffers[stream] = buffers[stream].slice(index + 1)
        if (line !== '') {
          try {
            onLine(line)
          } catch {
            // progress reporting must never break the install
          }
        }
        index = buffers[stream].indexOf('\n')
      }
    }
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString('utf8')
      if (stdout.length < OUTPUT_LIMIT) stdout += text
      feedLines('stdout', text)
    })
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString('utf8')
      if (stderr.length < OUTPUT_LIMIT) stderr += text
      feedLines('stderr', text)
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.once('error', (error) => {
      finish({ ok: false, code: null, timedOut: false, stdout, stderr: stderr + String(error) })
    })
    child.once('close', (code) => {
      finish({ ok: !timedOut && code === 0, code, timedOut, stdout, stderr })
    })
  })
}

function tail(text, limit = 1500) {
  const trimmed = String(text ?? '').trim()
  if (trimmed.length <= limit) return trimmed
  return trimmed.slice(-limit)
}

function firstLine(text) {
  const line = String(text ?? '').trim().split(/\r?\n/u).find((item) => item.trim() !== '')
  return line === undefined ? '' : line.trim()
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/** Expected npm-install duration learned from the previous successful update. */
function expectedInstallMs() {
  try {
    const data = JSON.parse(fs.readFileSync(TIMING_FILE, 'utf8'))
    if (typeof data?.installMs === 'number' && Number.isFinite(data.installMs)) {
      return clampNumber(data.installMs, MIN_EXPECTED_MS, MAX_EXPECTED_MS)
    }
  } catch {
    // no saved timing yet
  }
  return DEFAULT_INSTALL_MS
}

function recordInstallMs(installMs) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
    fs.writeFileSync(TIMING_FILE, `${JSON.stringify({ installMs: Math.round(installMs), at: new Date().toISOString() })}\n`)
  } catch {
    // a missing estimate is a nicety; never fail the update over it
  }
}

/**
 * Ask npm which published versions satisfy one spec.
 *
 * @param {string} spec - package or package range, e.g. `@deepseek-ai/dsh@^0.2.2-rc.1`.
 * @returns {Promise<{ ok: true, versions: string[] } | { ok: false, error: string }>}
 */
export async function npmViewVersions(spec) {
  const result = await runNpm(['view', spec, 'version', '--json'], { timeoutMs: VIEW_TIMEOUT_MS })
  if (!result.ok) {
    return { ok: false, error: firstLine(result.stderr) || `npm view 退出码 ${String(result.code)}` }
  }
  const text = result.stdout.trim()
  if (text === '') return { ok: false, error: 'npm view 没有返回内容' }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: 'npm view 返回了非 JSON 内容' }
  }
  const versions = (Array.isArray(parsed) ? parsed : [parsed])
    .filter((item) => typeof item === 'string')
    .sort(compareVersions)
  if (versions.length === 0) return { ok: false, error: 'npm view 没有返回版本号' }
  return { ok: true, versions }
}

/**
 * Read the newest published version that the running installation may install,
 * plus the current version.
 *
 * @param {string} [argv1] - launcher script path override (tests).
 * @returns {Promise<object>} status payload for the button.
 */
export async function checkUpdates(argv1 = process.argv[1]) {
  const install = locateInstall(argv1)
  let versions = []
  let source = 'range'
  if (install.range !== undefined) {
    const view = await npmViewVersions(`${PACKAGE_NAME}@${install.range}`)
    if (view.ok) versions = view.versions
  }
  if (versions.length === 0) {
    source = 'latest'
    const view = await npmViewVersions(`${PACKAGE_NAME}@latest`)
    if (!view.ok) throw new Error(view.error)
    versions = view.versions
  }
  const candidate = versions[versions.length - 1]
  let tags
  try {
    const response = await fetch(`${REGISTRY}/-/package/${PACKAGE_NAME}/dist-tags`, {
      signal: AbortSignal.timeout(8000),
    })
    if (response.ok) tags = await response.json()
  } catch {
    // dist-tags are a display nicety only
  }
  const channel = tags !== undefined && candidate === tags.next
    ? 'next'
    : tags !== undefined && candidate === tags.latest
      ? 'latest'
      : 'published'
  return {
    ok: true,
    current: install.version,
    candidate,
    updateAvailable: compareVersions(candidate, install.version) > 0,
    channel,
    source,
    range: install.range ?? null,
    versions: versions.slice(-8),
  }
}

function runCp(source, target, extraArgs) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('cp', ['-a', ...extraArgs, source, target], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ ok: false, error: String(error) })
      return
    }
    let stderr = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.once('error', (error) => finish({ ok: false, error: String(error) }))
    child.once('close', (code) => finish(code === 0 ? { ok: true } : { ok: false, error: tail(stderr, 800) || `cp 退出码 ${String(code)}` }))
  })
}

/**
 * Copy an installation root into a sibling staging directory. The live copy is
 * never touched during the (slow) install, so a running server keeps working
 * until the final atomic swap.
 *
 * @param {string} root - installation root to copy.
 * @param {string} staging - destination directory (must not matter if present).
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export async function copyInstallRoot(root, staging) {
  fs.rmSync(staging, { recursive: true, force: true })
  let result = await runCp(root, staging, ['--reflink=auto'])
  if (!result.ok) {
    fs.rmSync(staging, { recursive: true, force: true })
    result = await runCp(root, staging, [])
  }
  return result
}

/**
 * Atomically re-point the installation root at a staged directory. The previous
 * copy is renamed aside first and restored when the second rename fails.
 *
 * @param {string} root - live installation root.
 * @param {string} staging - prepared replacement.
 * @returns {{ ok: true, backup: string } | { ok: false, error: string }}
 */
export function swapInstallRoot(root, staging) {
  const backup = `${root}.backup-${Date.now()}`
  try {
    fs.renameSync(root, backup)
  } catch (error) {
    return { ok: false, error: `无法备份当前安装：${error.message}` }
  }
  try {
    fs.renameSync(staging, root)
  } catch (error) {
    try {
      fs.renameSync(backup, root)
    } catch {
      // leave the backup in place; the updater reports the failure
    }
    return { ok: false, error: `无法启用新安装：${error.message}` }
  }
  return { ok: true, backup }
}

function removeDetached(target) {
  try {
    const child = spawn('rm', ['-rf', target], { detached: true, stdio: 'ignore' })
    child.unref()
  } catch {
    // a leftover backup directory only costs disk space
  }
}

/**
 * Install `candidate` next to the running installation and swap it in.
 *
 * The new version is installed into a staging copy while the live files stay
 * untouched; only after the staged version is verified does the root get
 * renamed into place. The caller must exit the process afterwards: the running
 * code and the files below it now disagree.
 *
 * Progress events drive the Web UI dialog. The install phase is estimated from
 * the previous successful update (or five minutes), because npm has no
 * machine-readable percentage.
 *
 * @param {string} candidate - exact version to install.
 * @param {string} [argv1] - launcher script path override (tests).
 * @param {(event: { phase: string, percent: number, message: string, activity?: string, elapsedMs?: number }) => void} [onProgress] - progress sink.
 * @returns {Promise<object>} outcome payload.
 */
export async function updateTo(candidate, argv1 = process.argv[1], onProgress) {
  const emit = (phase, percent, message, extra = {}) => {
    if (typeof onProgress !== 'function') return
    try {
      onProgress({ phase, percent, message, ...extra })
    } catch {
      // progress reporting must never break the update
    }
  }
  const install = locateInstall(argv1)
  if (compareVersions(candidate, install.version) <= 0) {
    return { ok: true, updated: false, current: install.version, to: install.version }
  }
  const fail = (error, detail) => ({
    ok: false,
    error,
    detail,
    current: install.version,
    candidate,
  })
  const cleanup = () => {
    try {
      fs.rmSync(staging, { recursive: true, force: true })
    } catch {
      // a leftover staging directory only costs disk space
    }
  }
  const staging = `${install.root}.staging-${Date.now()}-${process.pid}`
  let ticker
  try {
    emit('copy', 3, '正在准备运行时副本…')
    const copy = await copyInstallRoot(install.root, staging)
    if (!copy.ok) {
      cleanup()
      emit('failed', 3, `准备失败：${copy.error}`)
      return fail('copy-failed', copy.error)
    }
    const expectedMs = expectedInstallMs()
    const installStartedAt = Date.now()
    let installMs = 0
    let lastActivity = ''
    emit('install', 8, '正在下载并安装依赖…', { elapsedMs: 0 })
    ticker = setInterval(() => {
      installMs = Date.now() - installStartedAt
      const fraction = Math.min(1, installMs / expectedMs)
      const percent = Math.round(8 + 84 * fraction)
      const message = fraction >= 1
        ? '正在下载并安装依赖（比预计更久，仍在进行）…'
        : '正在下载并安装依赖…'
      emit('install', percent, message, { activity: lastActivity, elapsedMs: installMs })
    }, 1000)
    const result = await runNpm(
      ['install', '--prefix', staging, '--no-audit', '--no-fund', '--loglevel=info', `${PACKAGE_NAME}@${candidate}`],
      {
        timeoutMs: INSTALL_TIMEOUT_MS,
        onLine: (line) => {
          lastActivity = line.length > 160 ? line.slice(0, 160) : line
        },
      },
    )
    clearInterval(ticker)
    ticker = undefined
    installMs = Date.now() - installStartedAt
    if (!result.ok) {
      cleanup()
      emit('failed', 8, result.timedOut ? '安装超时' : '安装失败')
      return fail(result.timedOut ? 'update-timeout' : 'update-failed', tail(result.stderr) || tail(result.stdout))
    }
    emit('verify', 92, '正在校验新版本…', { elapsedMs: installMs })
    let version
    try {
      version = String(JSON.parse(fs.readFileSync(path.join(staging, 'node_modules', PACKAGE_NAME, 'package.json'), 'utf8')).version)
    } catch {
      cleanup()
      return fail('version-unreadable', tail(result.stdout))
    }
    if (compareVersions(version, install.version) <= 0) {
      cleanup()
      return fail('version-unchanged', tail(result.stdout))
    }
    emit('swap', 96, '正在切换到新版本…', { elapsedMs: installMs })
    const swap = swapInstallRoot(install.root, staging)
    if (!swap.ok) {
      cleanup()
      return fail('swap-failed', swap.error)
    }
    removeDetached(swap.backup)
    recordInstallMs(installMs)
    emit('done', 100, `更新完成：${version}`, { elapsedMs: installMs })
    return { ok: true, updated: true, from: install.version, to: version, detail: tail(result.stdout) }
  } catch (error) {
    emit('failed', 0, `更新异常：${error instanceof Error ? error.message : String(error)}`)
    cleanup()
    return fail('update-failed', error instanceof Error ? error.message : String(error))
  } finally {
    if (ticker !== undefined) clearInterval(ticker)
  }
}
