/**
 * Opt-in cache cleanup for dsh-app-controls.
 *
 * Only regenerable caches are addressed here; the running DSH installation,
 * the profile's installed plugins, settings, sessions, credentials and the
 * plugin source tree are never targets. Every path is derived from fixed
 * locations and validated before a destructive operation.
 *
 * Categories:
 *   app     DSH attachment-image cache (``~/.dsh/cache/attachments``)
 *   npx     obsolete ``~/.npm/_npx`` installations (active ones are kept)
 *   npm     ``~/.npm/_cacache`` download cache
 *   pnpm    unreferenced packages in the pnpm store (``pnpm store prune``)
 *   backups old runtime backups/staging copies left by the updater
 *
 * The module is host-side only. The Web panel calls the scan/clean routes
 * registered in index.js; the tray helper may use the same routes later.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const CACHE_CATEGORIES = ['app', 'npx', 'npm', 'pnpm', 'backups']
const PACKAGE_CATEGORIES = new Set(['npx', 'npm', 'pnpm'])
const BACKUP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const COMMAND_TIMEOUT_MS = 15_000
const PNPM_TIMEOUT_MS = 120_000

function rootsFrom(options = {}) {
  const home = options.home ?? os.homedir()
  const dshHome = options.dshHome ?? process.env.DSH_HOME ?? path.join(home, '.dsh')
  return {
    home,
    dshHome,
    npmDir: options.npmDir ?? path.join(home, '.npm'),
    localShare: options.localShare ?? path.join(home, '.local', 'share'),
    pnpmStore: options.pnpmStore,
    pnpmCommand: options.pnpmCommand ?? process.env.DSH_APP_CONTROLS_PNPM,
  }
}

async function isDirectory(target) {
  try {
    const stat = await fsp.lstat(target)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

async function isFile(target) {
  try {
    const stat = await fsp.lstat(target)
    return stat.isFile() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

/** Apparent bytes of a directory/file, using du(1) and falling back to 0. */
async function duBytes(target) {
  if (!(await isFile(target)) && !(await isDirectory(target))) return 0
  try {
    const { stdout } = await execFileAsync('du', ['-sb', '--', target], {
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    })
    const bytes = Number.parseInt(String(stdout).split('\t')[0], 10)
    return Number.isFinite(bytes) && bytes > 0 ? bytes : 0
  } catch {
    return 0
  }
}

async function directoryEntries(target) {
  if (!(await isDirectory(target))) return []
  try {
    return await fsp.readdir(target)
  } catch {
    return []
  }
}

async function removeTree(target, removed = []) {
  let stat
  try {
    stat = await fsp.lstat(target)
  } catch {
    return removed
  }
  if (stat.isSymbolicLink()) {
    await fsp.unlink(target)
  } else if (stat.isDirectory()) {
    await fsp.rm(target, { recursive: true, force: true })
  } else if (stat.isFile()) {
    await fsp.unlink(target)
  } else {
    return removed
  }
  removed.push(target)
  return removed
}

/** Remove children but keep the cache directory itself. */
async function removeContents(target) {
  const removed = []
  for (const name of await directoryEntries(target)) {
    const child = path.join(target, name)
    try {
      await removeTree(child, removed)
    } catch {
      // A file may disappear between readdir and rm; continue with siblings.
    }
  }
  return removed
}

function readProcCmdlines() {
  const result = []
  try {
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/u.test(entry)) continue
      try {
        const raw = fs.readFileSync(`/proc/${entry}/cmdline`)
        if (raw.length === 0) continue
        result.push(raw.toString('utf8').split('\u0000').filter(Boolean).join(' '))
      } catch {
        // process exited or is not readable
      }
    }
  } catch {
    // non-Linux hosts have no /proc
  }
  return result
}

/** True when an npm/pnpm/npx/yarn command is currently running. */
export function packageManagerBusy() {
  return readProcCmdlines().some((line) => {
    const first = line.trim().split(/\s+/u)[0] ?? ''
    const base = path.basename(first)
    if (/^(npm|pnpm|npx|yarn)(?:\.cjs|\.js)?$/u.test(base)) return true
    return /(^|[\s/])(npm|pnpm|npx|yarn)(?:\.cjs|\.js)?(?:\s|$)/u.test(line)
  })
}

function npxHashInText(text, npmDir) {
  const marker = `${path.join(npmDir, '_npx')}${path.sep}`
  let rest = ''
  const direct = text.indexOf(marker)
  if (direct >= 0) rest = text.slice(direct + marker.length)
  else {
    const relative = text.indexOf('_npx/')
    if (relative < 0) return null
    rest = text.slice(relative + '_npx/'.length)
  }
  const hash = rest.split(/[/\s]/u)[0]
  return hash !== '' && /^[A-Za-z0-9._-]+$/u.test(hash) ? hash : null
}

/** npx cache directories currently referenced by a process. */
function activeNpxHashes(roots) {
  const hashes = new Set()
  const own = process.argv[1]
  if (typeof own === 'string' && own !== '') {
    const hash = npxHashInText(path.resolve(own), roots.npmDir)
    if (hash !== null) hashes.add(hash)
  }
  for (const line of readProcCmdlines()) {
    const hash = npxHashInText(line, roots.npmDir)
    if (hash !== null) hashes.add(hash)
  }
  return hashes
}

async function npxEntries(roots) {
  const root = path.join(roots.npmDir, '_npx')
  const active = activeNpxHashes(roots)
  const entries = []
  for (const name of await directoryEntries(root)) {
    const entry = path.join(root, name)
    if (!(await isDirectory(entry)) || active.has(name)) continue
    entries.push({ name, path: entry, size: await duBytes(entry) })
  }
  return entries
}

async function findPnpmStore(roots) {
  if (typeof roots.pnpmStore === 'string' && roots.pnpmStore !== '') return roots.pnpmStore
  const configured = process.env.DSH_APP_CONTROLS_PNPM_STORE
  if (typeof configured === 'string' && configured !== '') return configured
  const fallback = path.join(roots.home, '.local', 'share', 'pnpm', 'store')
  if (await isDirectory(fallback)) return fallback
  const command = await findPnpmCommand(roots)
  if (command === null) return null
  try {
    const { stdout } = await execFileAsync(command, ['store', 'path'], {
      cwd: roots.home,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    })
    const value = String(stdout).trim()
    return value !== '' ? value : null
  } catch {
    return null
  }
}

function executableOnPath(name) {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (directory === '') continue
    const candidate = path.join(directory, name)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      // not in this directory
    }
  }
  return null
}

function fnmPnpmCandidates(home) {
  const candidates = []
  const versions = path.join(home, '.local', 'share', 'fnm', 'node-versions')
  try {
    for (const entry of fs.readdirSync(versions)) {
      candidates.push(path.join(versions, entry, 'installation', 'bin', 'pnpm'))
    }
  } catch {
    // fnm is optional
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  if (uid !== null) {
    const multishells = `/run/user/${uid}/fnm_multishells`
    try {
      for (const entry of fs.readdirSync(multishells)) {
        candidates.push(path.join(multishells, entry, 'bin', 'pnpm'))
      }
    } catch {
      // fnm multishell directory is normal on systems without fnm
    }
  }
  return candidates
}

function isExecutableFile(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK)
    return fs.statSync(candidate).isFile()
  } catch {
    return false
  }
}

async function findPnpmCommand(roots) {
  const candidates = [
    roots.pnpmCommand,
    process.env.DSH_APP_CONTROLS_PNPM,
    'pnpm',
    path.join(roots.home, '.local', 'share', 'pnpm', 'pnpm'),
    ...fnmPnpmCandidates(roots.home),
  ]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '') continue
    if (candidate === 'pnpm') {
      const found = executableOnPath('pnpm')
      if (found !== null) return found
      continue
    }
    if (candidate.includes('/') && isExecutableFile(candidate)) return candidate
  }
  const found = executableOnPath('pnpm')
  return found
}

async function categoryApp(roots) {
  const target = path.join(roots.dshHome, 'cache', 'attachments')
  return {
    id: 'app',
    sizeBytes: await duBytes(target),
    available: await isDirectory(target),
    reason: (await isDirectory(target)) ? '' : '缓存目录不存在',
    target,
  }
}

async function categoryNpx(roots) {
  const entries = await npxEntries(roots)
  return {
    id: 'npx',
    sizeBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    available: entries.length > 0,
    reason: entries.length > 0 ? '' : '没有可清理的 npx 旧安装',
    count: entries.length,
  }
}

async function categoryNpm(roots) {
  const target = path.join(roots.npmDir, '_cacache')
  const exists = await isDirectory(target)
  return {
    id: 'npm',
    sizeBytes: exists ? await duBytes(target) : 0,
    available: exists,
    reason: exists ? '' : 'npm 缓存目录不存在',
    target,
  }
}

async function categoryPnpm(roots) {
  const store = await findPnpmStore(roots)
  const command = await findPnpmCommand(roots)
  const available = store !== null && command !== null && (await isDirectory(store))
  return {
    id: 'pnpm',
    sizeBytes: available ? await duBytes(store) : 0,
    available,
    reason: available ? '' : command === null ? '未找到 pnpm 命令' : '未找到 pnpm store',
    store,
  }
}

async function categoryBackups(roots) {
  const entries = []
  for (const name of await directoryEntries(roots.localShare)) {
    if (!/^dsh-runtime\.(?:backup|staging)-/u.test(name)) continue
    const target = path.join(roots.localShare, name)
    if (!(await isDirectory(target))) continue
    try {
      const stat = await fsp.stat(target)
      if (Date.now() - stat.mtimeMs < BACKUP_MAX_AGE_MS) continue
      entries.push({ path: target, size: await duBytes(target) })
    } catch {
      // disappeared while scanning
    }
  }
  return {
    id: 'backups',
    sizeBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    available: entries.length > 0,
    reason: entries.length > 0 ? '' : '没有 7 天前的更新残留',
    count: entries.length,
  }
}

const SCANNERS = {
  app: categoryApp,
  npx: categoryNpx,
  npm: categoryNpm,
  pnpm: categoryPnpm,
  backups: categoryBackups,
}

/** Inventory for the settings panel. Sizes are apparent bytes. */
export async function scanCache(options = {}) {
  const roots = rootsFrom(options)
  const categories = await Promise.all(CACHE_CATEGORIES.map((id) => SCANNERS[id](roots)))
  const busy = packageManagerBusy()
  for (const category of categories) {
    if (busy && PACKAGE_CATEGORIES.has(category.id) && category.available) {
      category.available = false
      category.reason = '有 npm/pnpm/npx 进程正在运行'
    }
  }
  return {
    ok: true,
    scannedAt: new Date().toISOString(),
    totalBytes: categories.reduce((sum, category) => sum + category.sizeBytes, 0),
    categories,
  }
}

async function cleanApp(roots) {
  const target = path.join(roots.dshHome, 'cache', 'attachments')
  const before = await duBytes(target)
  const removed = await removeContents(target)
  const after = await duBytes(target)
  return { freedBytes: Math.max(0, before - after), removed }
}

async function cleanNpx(roots) {
  const entries = await npxEntries(roots)
  const removed = []
  let freedBytes = 0
  for (const entry of entries) {
    try {
      const before = await duBytes(entry.path)
      await removeTree(entry.path, removed)
      freedBytes += before
    } catch {
      // Keep going: a single locked entry must not abort the other caches.
    }
  }
  return { freedBytes, removed }
}

async function cleanNpm(roots) {
  const target = path.join(roots.npmDir, '_cacache')
  const before = await duBytes(target)
  const removed = await removeTree(target)
  const after = await duBytes(target)
  return { freedBytes: Math.max(0, before - after), removed }
}

async function cleanPnpm(roots) {
  const store = await findPnpmStore(roots)
  const command = await findPnpmCommand(roots)
  if (store === null || command === null || !(await isDirectory(store))) {
    throw Object.assign(new Error('未找到 pnpm store 或 pnpm 命令'), { code: 'pnpm-unavailable' })
  }
  const before = await duBytes(store)
  try {
    await execFileAsync(command, ['store', 'prune', '--yes'], {
      cwd: roots.home,
      timeout: PNPM_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    })
  } catch (error) {
    throw Object.assign(new Error(`pnpm store prune 失败：${error.message}`), { code: 'pnpm-failed' })
  }
  const after = await duBytes(store)
  return { freedBytes: Math.max(0, before - after), removed: [] }
}

async function cleanBackups(roots) {
  const removed = []
  let freedBytes = 0
  for (const name of await directoryEntries(roots.localShare)) {
    if (!/^dsh-runtime\.(?:backup|staging)-/u.test(name)) continue
    const target = path.join(roots.localShare, name)
    if (!(await isDirectory(target))) continue
    try {
      const stat = await fsp.stat(target)
      if (Date.now() - stat.mtimeMs < BACKUP_MAX_AGE_MS) continue
      const before = await duBytes(target)
      await removeTree(target, removed)
      freedBytes += before
    } catch {
      // disappeared or locked; continue
    }
  }
  return { freedBytes, removed }
}

const CLEANERS = {
  app: cleanApp,
  npx: cleanNpx,
  npm: cleanNpm,
  pnpm: cleanPnpm,
  backups: cleanBackups,
}

/**
 * Clean the requested categories. Returns per-category results; one failure
 * does not abort the remaining categories. Callers must pass validated ids.
 */
export async function cleanCache(ids, options = {}) {
  const selected = Array.isArray(ids) ? [...new Set(ids)] : []
  const unknown = selected.filter((id) => !CACHE_CATEGORIES.includes(id))
  if (selected.length === 0 || unknown.length > 0) {
    throw Object.assign(new Error('无效的缓存类型'), { code: 'invalid-categories' })
  }
  if (selected.some((id) => PACKAGE_CATEGORIES.has(id)) && packageManagerBusy()) {
    throw Object.assign(new Error('有 npm/pnpm/npx 进程正在运行，请稍后再清理'), {
      code: 'package-manager-busy',
    })
  }
  const roots = rootsFrom(options)
  const results = []
  let freedBytes = 0
  for (const id of selected) {
    try {
      const result = await CLEANERS[id](roots)
      freedBytes += result.freedBytes
      results.push({ id, ok: true, freedBytes: result.freedBytes, removed: result.removed ?? [] })
    } catch (error) {
      results.push({ id, ok: false, error: error.code ?? 'clean-failed', message: error.message })
    }
  }
  return {
    ok: results.some((result) => result.ok),
    freedBytes,
    results,
  }
}
