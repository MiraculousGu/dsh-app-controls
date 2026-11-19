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
import { pathToFileURL } from 'node:url'

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
const LAST_GOOD_FILE = path.join(STATE_DIR, 'last-good.json')
const DEFAULT_RELEASE_TIMEOUT_MS = 5000
const MAX_RELEASE_TIMEOUT_MS = 30_000
const RELEASE_NOTES_LIMIT = 4000
const GITHUB_API = 'https://api.github.com'
const RELEASE_USER_AGENT = 'dsh-app-controls-update-check'

/** Public repository used when package.json carries no usable repository. */
export const DEFAULT_REPOSITORY = 'https://github.com/MiraculousGu/dsh-app-controls'

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

// ---------------------------------------------------------------------------
// Release notes (GitHub releases / tags)
// ---------------------------------------------------------------------------

function cleanRepositorySlug(owner, repo) {
  const name = repo.replace(/\.git$/iu, '')
  const valid = (part) => /^[A-Za-z0-9_.-]+$/u.test(part) && part !== '.' && part !== '..'
  if (!valid(owner) || !valid(name)) return null
  return `${owner}/${name}`
}

/**
 * Normalize a repository reference to `owner/repo` for GitHub API calls.
 *
 * Accepts package.json `repository` objects, `git+https://…`, `git@…:…`,
 * `github:owner/repo` and plain `owner/repo` shorthands. Non-GitHub hosts and
 * malformed values return `null`, so callers skip notes instead of failing.
 *
 * @param {string | { url?: string } | null | undefined} repository
 * @returns {string | null} `owner/repo` or `null`.
 */
export function normalizeRepository(repository = DEFAULT_REPOSITORY) {
  const raw = repository !== null && typeof repository === 'object' ? repository.url : repository
  if (typeof raw !== 'string') return null
  let value = raw.trim()
  if (value === '') return null
  value = value.replace(/[?#].*$/u, '').replace(/\/+$/u, '')
  if (value.toLowerCase().startsWith('github:')) value = value.slice('github:'.length)
  if (/^github\.com\//iu.test(value)) value = value.slice('github.com/'.length)
  if (value.startsWith('git@github.com:')) value = value.slice('git@github.com:'.length)
  if (/^[a-z][a-z+.-]*:\/\//iu.test(value)) {
    let url
    try {
      url = new URL(value.replace(/^git\+/iu, ''))
    } catch {
      return null
    }
    const host = url.hostname.toLowerCase()
    if (host !== 'github.com' && host !== 'www.github.com') return null
    value = url.pathname.replace(/^\/+/u, '')
  }
  const parts = value.split('/').filter((part) => part !== '')
  if (parts.length !== 2) return null
  return cleanRepositorySlug(parts[0], parts[1])
}

/** Read `repository` (or `homepage`) from the plugin's own package.json. */
function packageRepository() {
  try {
    const data = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    if (data !== null && typeof data === 'object') {
      return data.repository ?? data.homepage ?? DEFAULT_REPOSITORY
    }
  } catch {
    // packaged files may not ship package.json next to lib/; fall back below
  }
  return DEFAULT_REPOSITORY
}

function clampReleaseTimeout(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return DEFAULT_RELEASE_TIMEOUT_MS
  return Math.min(MAX_RELEASE_TIMEOUT_MS, Math.max(50, Math.round(number)))
}

/** `v1.4.0` -> `1.4.0`, `null` for empty/non-string input. */
function normalizeTag(value) {
  if (typeof value !== 'string') return null
  const text = value.trim().replace(/^[vV]/u, '')
  return text === '' ? null : text
}

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function safeCompare(left, right) {
  try {
    return compareVersions(left, right)
  } catch {
    return null
  }
}

function versionOfEntry(entry) {
  if (entry === null || typeof entry !== 'object') return null
  return normalizeTag(entry.tag_name ?? entry.name)
}

function pickNewest(entries) {
  let best = entries[0]
  let bestVersion = versionOfEntry(best)
  for (let index = 1; index < entries.length; index += 1) {
    const entry = entries[index]
    const version = versionOfEntry(entry)
    if (version === null) continue
    if (bestVersion === null || (safeCompare(version, bestVersion) ?? 0) > 0) {
      best = entry
      bestVersion = version
    }
  }
  return best
}

function pickEntry(entries, { from, want }) {
  if (want !== null) {
    return entries.find((entry) => versionOfEntry(entry) === want) ?? null
  }
  if (from === null) return entries[0] ?? null
  const newer = entries.filter((entry) => {
    const version = versionOfEntry(entry)
    return version !== null && (safeCompare(version, from) ?? 0) > 0
  })
  return newer.length === 0 ? null : pickNewest(newer)
}

function truncateNotes(value) {
  const text = trimmed(value)
  if (text.length <= RELEASE_NOTES_LIMIT) return text
  return `${text.slice(0, RELEASE_NOTES_LIMIT - 1).trimEnd()}…`
}

function tagCandidates(version) {
  return [version, `v${version}`]
}

function tagPageUrl(slug, name) {
  const encoded = name.split('/').map((part) => encodeURIComponent(part)).join('/')
  return `https://github.com/${slug}/tree/${encoded}`
}

function releaseResult(release) {
  if (release === null || typeof release !== 'object') return null
  const tag = typeof release.tag_name === 'string' ? release.tag_name : ''
  const version = normalizeTag(tag) ?? normalizeTag(release.name)
  if (version === null) return null
  const url = typeof release.html_url === 'string' && /^https?:\/\//u.test(release.html_url)
    ? release.html_url
    : null
  return {
    version,
    title: trimmed(release.name) || tag || version,
    notes: truncateNotes(release.body),
    url,
    publishedAt: trimmed(release.published_at) || trimmed(release.created_at) || null,
  }
}

async function tagResult(tag, slug, getJson) {
  if (tag === null || typeof tag !== 'object' || typeof tag.name !== 'string') return null
  const version = normalizeTag(tag.name) ?? tag.name
  let notes = ''
  let url = tagPageUrl(slug, tag.name)
  const commitUrl = typeof tag.commit?.url === 'string' ? tag.commit.url : null
  if (commitUrl !== null) {
    const commit = await getJson(commitUrl)
    if (commit !== null && typeof commit === 'object') {
      if (typeof commit.commit?.message === 'string') notes = commit.commit.message
      if (typeof commit.html_url === 'string' && /^https?:\/\//u.test(commit.html_url)) url = commit.html_url
    }
  }
  return {
    version,
    title: tag.name,
    notes: truncateNotes(notes),
    url,
    publishedAt: null,
  }
}

/**
 * Fetch the GitHub release notes for an update.
 *
 * Queries releases first and falls back to tags (using the tag commit message
 * as notes). Every network, parsing and timeout problem resolves to `null`:
 * release notes must never block or fail an update. The whole call is bounded
 * by `timeoutMs` (default 5 s, capped at 30 s).
 *
 * @param {{
 *   from?: string,
 *   to?: string,
 *   repository?: string | { url?: string } | null,
 *   timeoutMs?: number,
 *   apiBase?: string,
 * }} [options] - `to` picks an exact release/tag; without it the newest release
 *   newer than `from` is used. `repository` defaults to this package's
 *   `repository` field, then `DEFAULT_REPOSITORY`. `apiBase` is for tests or
 *   GitHub Enterprise.
 * @returns {Promise<{ version: string, title: string, notes: string, url: string | null, publishedAt: string | null } | null>}
 */
export async function fetchReleaseNotes(options = {}) {
  const settings = options !== null && typeof options === 'object' ? options : {}
  const slug = normalizeRepository(settings.repository == null ? packageRepository() : settings.repository)
  if (slug === null) return null
  const base = String(settings.apiBase ?? GITHUB_API).replace(/\/+$/u, '')
  const deadline = Date.now() + clampReleaseTimeout(settings.timeoutMs)
  const want = normalizeTag(settings.to)
  const from = normalizeTag(settings.from)
  const getJson = async (url) => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return undefined
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': RELEASE_USER_AGENT,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(remaining),
      })
      if (!response.ok) return undefined
      return await response.json()
    } catch {
      return undefined
    }
  }
  try {
    const releases = await getJson(`${base}/repos/${slug}/releases?per_page=50`)
    if (Array.isArray(releases)) {
      const rows = releases.filter((release) =>
        release !== null && typeof release === 'object' && release.draft !== true && versionOfEntry(release) !== null)
      const picked = pickEntry(rows, { from, want })
      if (picked !== null) {
        const result = releaseResult(picked)
        if (result !== null) return result
      }
    }
    if (want !== null) {
      for (const candidate of tagCandidates(want)) {
        const release = await getJson(`${base}/repos/${slug}/releases/tags/${encodeURIComponent(candidate)}`)
        if (release !== null && typeof release === 'object' && release.draft !== true) {
          const result = releaseResult(release)
          if (result !== null) return result
        }
      }
    }
    const tags = await getJson(`${base}/repos/${slug}/tags?per_page=100`)
    if (Array.isArray(tags)) {
      const rows = tags.filter((tag) => tag !== null && typeof tag === 'object' && versionOfEntry(tag) !== null)
      const picked = pickEntry(rows, { from, want })
      if (picked !== null) return await tagResult(picked, slug, getJson)
    }
  } catch {
    // release notes are a display nicety only
  }
  return null
}

// ---------------------------------------------------------------------------
// Backup discovery, rollback and last-good bookkeeping
// ---------------------------------------------------------------------------

function requirePath(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} 必须是非空路径字符串`)
  }
  if (value.includes('\0')) throw new TypeError(`${label} 不能包含空字符`)
  return path.resolve(value.trim())
}

function isInside(child, parent) {
  const relative = path.relative(parent, child)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function readInstalledVersion(root) {
  for (const file of [path.join(root, 'package.json'), path.join(root, 'node_modules', PACKAGE_NAME, 'package.json')]) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      const version = trimmed(data?.version)
      if (version !== '') return version
    } catch {
      // try the next candidate
    }
  }
  return null
}

/**
 * Find the newest `«installRoot».backup-<timestamp>` sibling left on disk.
 *
 * Read-only. `updateTo` deletes its backup after a successful atomic swap, so
 * this normally finds nothing then; it recovers backups left behind by an
 * interrupted/failed swap (or retained by a future updater). It returns the
 * newest candidate sorted by the timestamp embedded in the directory name.
 *
 * @param {string} installRoot - installation root the updater swaps.
 * @returns {{ path: string, name: string, timestamp: number, mtimeMs: number, version: string | null } | null}
 */
export function findLatestBackup(installRoot) {
  const root = requirePath(installRoot, 'installRoot')
  const parent = path.dirname(root)
  const base = path.basename(root)
  const prefix = `${base}.backup-`
  let entries
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true })
  } catch {
    return null
  }
  const backups = []
  for (const entry of entries) {
    if (!entry.name.startsWith(prefix)) continue
    const suffix = entry.name.slice(prefix.length)
    if (!/^\d+$/u.test(suffix)) continue
    const backupPath = path.join(parent, entry.name)
    let stat
    try {
      stat = fs.statSync(backupPath)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    backups.push({ path: backupPath, name: entry.name, timestamp: Number(suffix), mtimeMs: stat.mtimeMs })
  }
  if (backups.length === 0) return null
  backups.sort((left, right) => right.timestamp - left.timestamp || right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name))
  const latest = backups[0]
  return { ...latest, version: readInstalledVersion(latest.path) }
}

/**
 * Restore a sibling backup directory produced by `swapInstallRoot`.
 *
 * Safety checks: both arguments must be non-empty paths, the backup must be a
 * directory next to the installation root and must be named
 * `«installRoot».backup-…`; the two paths must not overlap. The current
 * installation root (if present) is renamed aside rather than deleted and is
 * returned as `displaced`, so a failed restore never destroys data. `updateTo`
 * never calls this; rollback is an explicit host action.
 *
 * @param {string} backupRoot - absolute or relative path of `*.backup-*`.
 * @param {string} installRoot - installation root to restore into.
 * @returns {{ ok: true, installRoot: string, backupRoot: string, displaced: string | null, version: string | null }}
 * @throws {TypeError | Error} with a readable message when validation or the
 *   rename fails.
 */
export function restoreBackup(backupRoot, installRoot) {
  const backup = requirePath(backupRoot, 'backupRoot')
  const root = requirePath(installRoot, 'installRoot')
  if (backup === root) throw new Error(`备份目录与安装目录不能相同：${backup}`)
  if (isInside(backup, root) || isInside(root, backup)) {
    throw new Error(`备份目录与安装目录不能互相包含：${backup} / ${root}`)
  }
  const base = path.basename(root)
  if (path.dirname(backup) !== path.dirname(root)) {
    throw new Error(`备份目录必须与安装目录同级：${backup}`)
  }
  if (!path.basename(backup).startsWith(`${base}.backup-`) || !/^\d+$/u.test(path.basename(backup).slice(base.length + '.backup-'.length))) {
    throw new Error(`备份目录必须是由 ${base} 生成的 .backup-<时间戳> 目录：${backup}`)
  }
  let stat
  try {
    stat = fs.statSync(backup)
  } catch {
    throw new Error(`备份目录不存在：${backup}`)
  }
  if (!stat.isDirectory()) throw new Error(`备份路径不是目录：${backup}`)
  let hasRoot = false
  try {
    fs.lstatSync(root)
    hasRoot = true
  } catch {
    // a missing live root is fine: the backup simply fills the gap
  }
  let displaced = null
  if (hasRoot) {
    displaced = `${root}.pre-restore-${Date.now()}`
    try {
      fs.renameSync(root, displaced)
    } catch (error) {
      throw new Error(`无法移开当前安装目录：${error.message}`)
    }
  }
  try {
    fs.renameSync(backup, root)
  } catch (error) {
    if (displaced !== null) {
      try {
        fs.renameSync(displaced, root)
      } catch {
        // keep the displaced copy on disk; the thrown error names it below
      }
    }
    throw new Error(`无法恢复备份：${error.message}`)
  }
  return { ok: true, installRoot: root, backupRoot: backup, displaced, version: readInstalledVersion(root) }
}

/**
 * Persist the last known-good version (and installation root). Non-throwing:
 * returns `null` when the version is unknown or the state file is unwritable.
 * `updateTo` does not write this; a host should record it after it has seen the
 * running version boot successfully.
 *
 * @param {string | { version?: string, root?: string }} [input] - version string
 *   or object; missing fields fall back to the running installation.
 * @returns {{ version: string, root: string | null, recordedAt: string } | null}
 */
export function recordLastGood(input = {}) {
  let version
  let root
  if (typeof input === 'string') {
    version = input.trim()
  } else if (input !== null && typeof input === 'object') {
    version = trimmed(input.version)
    if (typeof input.root === 'string' && input.root.trim() !== '') root = path.resolve(input.root.trim())
  }
  let install
  if (version === '' || version === undefined || root === undefined) {
    try {
      install = locateInstall()
    } catch {
      install = null
    }
  }
  if (version === '' || version === undefined) version = install?.version
  if (root === undefined) root = install?.root
  if (version === undefined || version === '') return null
  const record = { version, root: root ?? null, recordedAt: new Date().toISOString() }
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
    const temporary = `${LAST_GOOD_FILE}.${process.pid}.tmp`
    fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 })
    fs.renameSync(temporary, LAST_GOOD_FILE)
  } catch {
    return null
  }
  return record
}

/**
 * Read the record written by `recordLastGood`.
 *
 * @returns {{ version: string, root: string | null, recordedAt: string | null } | null}
 */
export function readLastGood() {
  try {
    const data = JSON.parse(fs.readFileSync(LAST_GOOD_FILE, 'utf8'))
    if (data === null || typeof data !== 'object') return null
    const version = trimmed(data.version)
    if (version === '') return null
    return {
      version,
      root: typeof data.root === 'string' && data.root !== '' ? data.root : null,
      recordedAt: typeof data.recordedAt === 'string' && data.recordedAt !== '' ? data.recordedAt : null,
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Background update-check policy (pure, no I/O)
// ---------------------------------------------------------------------------

/**
 * Decide what a background update check should do. Pure function; no state,
 * timers or filesystem access, so the host and the tray can share the policy.
 *
 * @param {object | null | undefined} checkResult - `checkUpdates()` payload.
 * @param {{ deferUntil?: number, now?: number }} [options] - persisted
 *   "remind me later" timestamp and injectable clock (tests).
 * @returns {{ available: boolean, version: string | null, deferred: boolean, reason: 'no-result' | 'up-to-date' | 'deferred' | 'available' }}
 */
export function evaluateUpdate(checkResult, options = {}) {
  const parsedNow = Number(options?.now)
  const now = Number.isFinite(parsedNow) ? parsedNow : Date.now()
  const parsedUntil = Number(options?.deferUntil)
  const deferUntil = Number.isFinite(parsedUntil) ? parsedUntil : 0
  const result = checkResult !== null && typeof checkResult === 'object' ? checkResult : null
  if (result === null) return { available: false, version: null, deferred: false, reason: 'no-result' }
  const candidate = trimmed(result.candidate) || null
  const current = trimmed(result.current) || null
  let available = result.updateAvailable === true
  if (typeof result.updateAvailable !== 'boolean' && candidate !== null && current !== null) {
    available = (safeCompare(candidate, current) ?? 0) > 0
  }
  const version = candidate ?? current
  if (!available) return { available: false, version, deferred: false, reason: 'up-to-date' }
  const deferred = deferUntil > now
  return { available: true, version, deferred, reason: deferred ? 'deferred' : 'available' }
}

// ---------------------------------------------------------------------------
// Self-test (`node lib/update.js`), no network required
// ---------------------------------------------------------------------------

async function runSelfTest() {
  const assert = (await import('node:assert/strict')).default
  const net = await import('node:net')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileAsync = promisify(execFile)
  let passed = 0
  const run = async (name, fn) => {
    try {
      await fn()
    } catch (error) {
      console.error(`not ok - ${name}`)
      throw error
    }
    passed += 1
    console.log(`ok ${passed} - ${name}`)
  }

  await run('evaluateUpdate: deferred while reminder is pending', () => {
    assert.deepEqual(
      evaluateUpdate({ updateAvailable: true, candidate: '0.6.0', current: '0.5.2' }, { deferUntil: 2000, now: 1000 }),
      { available: true, version: '0.6.0', deferred: true, reason: 'deferred' },
    )
  })
  await run('evaluateUpdate: available once the reminder expired', () => {
    assert.deepEqual(
      evaluateUpdate({ updateAvailable: true, candidate: 'v0.6.0', current: '0.5.2' }, { deferUntil: 1000, now: 2000 }),
      { available: true, version: 'v0.6.0', deferred: false, reason: 'available' },
    )
  })
  await run('evaluateUpdate: up to date and no result', () => {
    assert.deepEqual(
      evaluateUpdate({ updateAvailable: false, candidate: '0.5.2', current: '0.5.2' }),
      { available: false, version: '0.5.2', deferred: false, reason: 'up-to-date' },
    )
    assert.deepEqual(evaluateUpdate(null), { available: false, version: null, deferred: false, reason: 'no-result' })
  })
  await run('evaluateUpdate: infers availability and ignores bad defer values', () => {
    assert.deepEqual(
      evaluateUpdate({ candidate: '0.6.0', current: '0.5.2' }, { deferUntil: Number.NaN }),
      { available: true, version: '0.6.0', deferred: false, reason: 'available' },
    )
  })
  await run('normalizeRepository: supported shapes', () => {
    assert.equal(normalizeRepository('git+https://github.com/MiraculousGu/dsh-app-controls.git'), 'MiraculousGu/dsh-app-controls')
    assert.equal(normalizeRepository({ url: 'git@github.com:MiraculousGu/dsh-app-controls.git' }), 'MiraculousGu/dsh-app-controls')
    assert.equal(normalizeRepository('github:MiraculousGu/dsh-app-controls'), 'MiraculousGu/dsh-app-controls')
    assert.equal(normalizeRepository('https://github.com/MiraculousGu/dsh-app-controls#readme'), 'MiraculousGu/dsh-app-controls')
    assert.equal(normalizeRepository('https://gitlab.com/MiraculousGu/dsh-app-controls'), null)
    assert.equal(normalizeRepository('not a repo'), null)
  })

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-update-selftest-'))
  try {
    await run('findLatestBackup: newest sibling backup, version and validation', () => {
      const root = path.join(temp, 'root')
      fs.mkdirSync(path.join(root, 'node_modules', PACKAGE_NAME), { recursive: true })
      fs.writeFileSync(path.join(root, 'node_modules', PACKAGE_NAME, 'package.json'), JSON.stringify({ version: '1.0.0' }))
      fs.mkdirSync(path.join(temp, 'root.backup-1000'))
      const newer = path.join(temp, 'root.backup-2000')
      fs.mkdirSync(newer)
      fs.writeFileSync(path.join(newer, 'package.json'), JSON.stringify({ version: '0.9.0' }))
      fs.mkdirSync(path.join(temp, 'root.backup-not-a-number'))
      const found = findLatestBackup(root)
      assert.equal(found?.path, newer)
      assert.equal(found?.timestamp, 2000)
      assert.equal(found?.version, '0.9.0')
      assert.equal(findLatestBackup(path.join(temp, 'missing-root')), null)
      assert.throws(() => findLatestBackup('   '), TypeError)
      assert.throws(() => findLatestBackup(path.join(temp, 'bad\0root')), TypeError)
    })

    await run('restoreBackup: rejects unsafe paths and repairs the install root', () => {
      const root = path.join(temp, 'install')
      fs.mkdirSync(root)
      fs.writeFileSync(path.join(root, 'marker.txt'), 'new')
      const backup = path.join(temp, 'install.backup-3000')
      fs.mkdirSync(backup)
      fs.writeFileSync(path.join(backup, 'marker.txt'), 'old')
      assert.throws(() => restoreBackup('', root), TypeError)
      assert.throws(() => restoreBackup(path.join(temp, 'other', 'install.backup-1'), root), /同级/u)
      assert.throws(() => restoreBackup(path.join(temp, 'wrong.backup-1'), path.join(temp, 'other-install')), /必须是由/u)
      assert.throws(() => restoreBackup(path.join(temp, 'install.backup-9999'), root), /不存在/u)
      assert.throws(() => restoreBackup(path.join(temp, 'install.backup-file'), root), /必须是由/u)
      fs.writeFileSync(path.join(temp, 'install.backup-4000'), 'not a directory')
      assert.throws(() => restoreBackup(path.join(temp, 'install.backup-4000'), root), /备份目录必须是由|不是目录/u)
      const restored = restoreBackup(backup, root)
      assert.equal(restored.ok, true)
      assert.equal(fs.readFileSync(path.join(root, 'marker.txt'), 'utf8'), 'old')
      assert.equal(fs.existsSync(backup), false)
      assert.ok(restored.displaced !== null && fs.readFileSync(path.join(restored.displaced, 'marker.txt'), 'utf8') === 'new')
    })

    await run('recordLastGood/readLastGood: isolated state round-trip', async () => {
      const script = [
        `import { recordLastGood, readLastGood } from ${JSON.stringify(new URL(import.meta.url).href)}`,
        "const written = recordLastGood({ version: '9.9.9', root: '/tmp/dsh-selftest-root' })",
        'const read = readLastGood()',
        "if (written === null || read === null || read.version !== '9.9.9' || read.root !== '/tmp/dsh-selftest-root') process.exit(1)",
      ].join('\n')
      await execFileAsync(process.execPath, ['--input-type=module', '--eval', script], {
        env: { ...process.env, XDG_STATE_HOME: path.join(temp, 'state') },
      })
    })

    await run('fetchReleaseNotes: timeout and unreachable endpoint return null', async () => {
      const sockets = new Set()
      const server = net.createServer((socket) => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
      })
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      const port = server.address().port
      const started = Date.now()
      try {
        const hanging = await fetchReleaseNotes({
          repository: DEFAULT_REPOSITORY,
          timeoutMs: 150,
          apiBase: `http://127.0.0.1:${port}`,
        })
        assert.equal(hanging, null)
        assert.ok(Date.now() - started < 5000)
        assert.equal(await fetchReleaseNotes({ repository: DEFAULT_REPOSITORY, timeoutMs: 200, apiBase: 'http://127.0.0.1:9' }), null)
        assert.equal(await fetchReleaseNotes({ repository: 'https://gitlab.com/a/b' }), null)
      } finally {
        for (const socket of sockets) socket.destroy()
        await new Promise((resolve) => server.close(resolve))
      }
    })
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }

  console.log(`update.js self-test: ${passed} passed`)
}

const isMain = typeof process.argv[1] === 'string' && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (isMain) await runSelfTest()
