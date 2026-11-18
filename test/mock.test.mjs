// Read-only mock tests for the dsh-app-controls plugin.
//
// Run with: node test/mock.test.mjs
// - the real DSH install is only *read* (locate + version), and a registry
//   version check is performed; nothing is installed and no server routes are
//   touched. The quit route is exercised against a mocked appExit.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function findDshBin() {
  const candidates = [process.env.DSH_BIN, path.join(os.homedir(), '.local/share/dsh-runtime/node_modules/.bin/dsh')]
  try {
    for (const entry of fs.readdirSync(path.join(os.homedir(), '.npm/_npx'))) {
      candidates.push(path.join(os.homedir(), '.npm/_npx', entry, 'node_modules/.bin/dsh'))
    }
  } catch {
    // no npx cache
  }
  return candidates.find((candidate) => typeof candidate === 'string' && fs.existsSync(candidate))
}

const dshBin = findDshBin()
if (dshBin === undefined) {
  console.log('SKIP: no dsh installation found (set DSH_BIN to the dsh bin path)')
  process.exit(0)
}
// Simulate being loaded from the running dsh process: locateInstall() reads
// process.argv[1] to find the installation root.
process.argv[1] = dshBin
process.env.DSH_APP_CONTROLS_DISABLE_SOCKET = '1'
process.env.DSH_APP_CONTROLS_DISABLE_TRAY = '1'

const update = await import(path.join(root, 'lib/update.js'))

let passed = 0
function ok(name, detail) {
  passed += 1
  console.log(`ok ${passed} - ${name}${detail === undefined ? '' : `: ${detail}`}`)
}

// ── version helpers ─────────────────────────────────────────────────────────
assert.equal(update.compareVersions('0.2.2-rc.1', '0.2.2-rc.3'), -1)
assert.equal(update.compareVersions('0.2.2-rc.3', '0.2.2-rc.1'), 1)
assert.equal(update.compareVersions('0.2.2', '0.2.2-rc.3'), 1)
assert.equal(update.compareVersions('0.2.2-rc.2', '0.2.2-rc.10'), -1)
assert.equal(update.compareVersions('1.0.0', '1.0.0'), 0)
ok('compareVersions')

function installedVersionFor(bin) {
  const real = fs.realpathSync(bin)
  const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(real), '..', 'package.json'), 'utf8'))
  return pkg.version
}

const install = update.locateInstall(dshBin)
assert.equal(install.version, installedVersionFor(dshBin))
assert.match(install.range, /^\^0\.2\.2-rc\./u)
assert.equal(path.basename(install.packageDir), 'dsh')
assert.equal(fs.existsSync(path.join(install.packageDir, 'lib', 'bin.js')), true)
ok('locateInstall', `${install.version} at ${install.root}`)


// The desktop launcher's stable runtime copy, when present, must locate too.
const runtimeBin = '/home/flex/.local/share/dsh-runtime/node_modules/.bin/dsh'
if (fs.existsSync(runtimeBin)) {
  const runtime = update.locateInstall(runtimeBin)
  assert.equal(runtime.version, installedVersionFor(runtimeBin))
  assert.equal(path.basename(runtime.packageDir), 'dsh')
  assert.match(runtime.root, /dsh-runtime$/u)
  ok('locateInstall(runtime)', runtime.root)
}

// ── staging copy and atomic swap helpers ───────────────────────────────────
{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-app-controls-test-'))
  try {
    const live = path.join(tmpRoot, 'runtime')
    fs.mkdirSync(live)
    fs.writeFileSync(path.join(live, 'package.json'), '{"marker":"live"}\n')
    const staging = path.join(tmpRoot, 'runtime.staging-test')
    const copied = await update.copyInstallRoot(live, staging)
    assert.equal(copied.ok, true, copied.ok ? '' : copied.error)
    fs.writeFileSync(path.join(staging, 'package.json'), '{"marker":"staged"}\n')
    const swapped = update.swapInstallRoot(live, staging)
    assert.equal(swapped.ok, true, swapped.ok ? '' : swapped.error)
    assert.equal(JSON.parse(fs.readFileSync(path.join(live, 'package.json'), 'utf8')).marker, 'staged')
    assert.equal(JSON.parse(fs.readFileSync(path.join(swapped.backup, 'package.json'), 'utf8')).marker, 'live')
    ok('copyInstallRoot + swapInstallRoot')
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
}

// ── package metadata and locale descriptions ───────────────────────────────
{
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'dsh-app-controls')
  assert.equal(pkg.version, '0.5.2')
  assert.equal(pkg.author.name, 'Tianrun Gu')
  assert.match(pkg.author.email, /MiraculousGu@users\.noreply\.github\.com$/u)
  assert.ok(pkg.description.includes('DeepSeek Harness'))
  assert.equal(pkg.license, 'MIT')
  assert.equal(pkg.engines.dsh, '^0.2.2-rc.1')
  assert.ok(pkg.repository.url.includes('MiraculousGu/dsh-app-controls'))
  assert.ok(fs.existsSync(path.join(root, 'icon.svg')))
  for (const locale of ['en', 'zh']) {
    const meta = JSON.parse(fs.readFileSync(path.join(root, 'locale', `${locale}.json`), 'utf8')).meta
    assert.equal(typeof meta.title, 'string')
    assert.ok(meta.title.length > 0)
    assert.equal(typeof meta.description, 'string')
    assert.ok(meta.description.length > 40)
  }
  ok('package metadata and locale descriptions')
}

// ── real registry check (network; no install) ──────────────────────────────
const versions = await update.npmViewVersions(`${update.PACKAGE_NAME}@${install.range}`)
assert.equal(versions.ok, true, versions.ok ? '' : versions.error)
assert.ok(versions.versions.length > 0)
for (const version of versions.versions) assert.match(version, /^\d+\.\d+\.\d+/u)
for (let index = 1; index < versions.versions.length; index += 1) {
  assert.equal(update.compareVersions(versions.versions[index - 1], versions.versions[index]) <= 0, true)
}
assert.ok(versions.versions.includes(install.version))
ok('npmViewVersions', versions.versions.join(', '))

const status = await update.checkUpdates(dshBin)
assert.equal(status.ok, true)
assert.equal(status.current, install.version)
assert.ok(status.versions.includes(status.candidate))
assert.equal(status.updateAvailable, update.compareVersions(status.candidate, status.current) > 0)
assert.ok(['latest', 'next', 'published'].includes(status.channel))
ok('checkUpdates', `current=${status.current} candidate=${status.candidate} channel=${status.channel}`)

// ── cache inventory and safe cleanup (isolated temp roots) ─────────────────
{
  const cache = await import(path.join(root, 'lib/cache.js'))
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-app-controls-cache-'))
  try {
    const dshHome = path.join(tmpRoot, '.dsh')
    const npmDir = path.join(tmpRoot, '.npm')
    const localShare = path.join(tmpRoot, '.local', 'share')
    const attachments = path.join(dshHome, 'cache', 'attachments')
    const npxEntry = path.join(npmDir, '_npx', 'test-hash')
    const backup = path.join(localShare, 'dsh-runtime.backup-old')
    fs.mkdirSync(attachments, { recursive: true })
    fs.mkdirSync(path.join(npxEntry, 'node_modules', 'pkg'), { recursive: true })
    fs.mkdirSync(backup, { recursive: true })
    fs.writeFileSync(path.join(attachments, 'image.png'), Buffer.alloc(2048))
    fs.writeFileSync(path.join(npxEntry, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
    fs.writeFileSync(path.join(backup, 'file'), 'old runtime backup\n')
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    fs.utimesSync(backup, old, old)
    const options = {
      home: tmpRoot,
      dshHome,
      npmDir,
      localShare,
      pnpmStore: path.join(tmpRoot, 'pnpm-store'),
      pnpmCommand: path.join(tmpRoot, 'missing-pnpm'),
    }
    const inventory = await cache.scanCache(options)
    assert.deepEqual(inventory.categories.map((entry) => entry.id), ['app', 'npx', 'npm', 'pnpm', 'backups'])
    assert.ok(inventory.categories.find((entry) => entry.id === 'app').sizeBytes > 0)
    assert.ok(inventory.categories.find((entry) => entry.id === 'backups').sizeBytes > 0)
    const busy = cache.packageManagerBusy()
    const savedArgv1 = process.argv[1]
    process.argv[1] = path.join(npxEntry, 'node_modules', '.bin', 'dsh')
    const protectedInventory = await cache.scanCache(options)
    process.argv[1] = savedArgv1
    const protectedNpx = protectedInventory.categories.find((entry) => entry.id === 'npx')
    assert.equal(protectedNpx.available, false, 'active npx hash must be protected')
    const npxCategory = inventory.categories.find((entry) => entry.id === 'npx')
    if (busy) assert.equal(npxCategory.available, false)
    else assert.ok(npxCategory.sizeBytes > 0)
    const selected = ['app', 'backups']
    if (!busy) selected.push('npx')
    const cleaned = await cache.cleanCache(selected, options)
    assert.ok(cleaned.freedBytes > 0)
    assert.equal(fs.existsSync(path.join(attachments, 'image.png')), false)
    assert.equal(fs.existsSync(backup), false)
    if (!busy) assert.equal(fs.existsSync(npxEntry), false)
    assert.equal(fs.existsSync(attachments), true, 'the cache directory itself must remain')
    await assert.rejects(() => cache.cleanCache(['unknown'], options), /无效的缓存类型/u)
    ok('cache inventory + safe cleanup in temp roots')
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
}

// ── host plugin routes with a mocked Cordis context ────────────────────────
const { apply } = await import(path.join(root, 'lib/index.js'))
const routes = []
const exitCalls = []
const hostCtx = {
  connection: {
    allowsRemoteAuthorities: false,
    fetch: {
      register(route) {
        routes.push(route)
        return () => Promise.resolve()
      },
    },
  },
  get(service) {
    return service === 'appExit' ? (code) => exitCalls.push(code) : undefined
  },
  effect() {},
}
apply(hostCtx)
assert.equal(routes.length, 7)
const quitRoute = routes.find((route) => route.path === '/api/dsh-app-controls/quit')
const updateRoute = routes.find((route) => route.path === '/api/dsh-app-controls/update')
const progressRoute = routes.find((route) => route.path === '/api/dsh-app-controls/update-progress')
const stateRoute = routes.find((route) => route.path === '/api/dsh-app-controls/state')
const settingsRoute = routes.find((route) => route.path === '/api/dsh-app-controls/settings')
const cacheRoute = routes.find((route) => route.path === '/api/dsh-app-controls/cache')
const cacheCleanRoute = routes.find((route) => route.path === '/api/dsh-app-controls/cache/clean')
assert.ok(quitRoute)
assert.ok(updateRoute)
assert.ok(progressRoute)
assert.ok(stateRoute)
assert.ok(settingsRoute)
assert.ok(cacheRoute)
assert.ok(cacheCleanRoute)
assert.deepEqual(quitRoute.methods, ['POST'])
assert.deepEqual(updateRoute.methods, ['GET', 'POST'])
assert.deepEqual(progressRoute.methods, ['GET'])
assert.deepEqual(stateRoute.methods, ['GET'])
assert.deepEqual(settingsRoute.methods, ['GET', 'POST'])
assert.deepEqual(cacheRoute.methods, ['GET'])
assert.deepEqual(cacheCleanRoute.methods, ['POST'])
ok('routes registered')

const stateResponse = await stateRoute.fetch(
  new Request('http://127.0.0.1:3080/api/dsh-app-controls/state', { method: 'GET' }),
)
const stateBody = await stateResponse.json()
assert.equal(stateResponse.status, 200)
assert.equal(stateBody.ok, true)
assert.equal(stateBody.running, true)
assert.equal(stateBody.quitRequested, false)
assert.equal(stateBody.job.active, false)
ok('GET state route')

const settingsResponse = await settingsRoute.fetch(
  new Request('http://127.0.0.1:3080/api/dsh-app-controls/settings', { method: 'GET' }),
)
const settingsBody = await settingsResponse.json()
assert.equal(settingsResponse.status, 200)
assert.equal(settingsBody.ok, true)
assert.equal(typeof settingsBody.settings.trayEnabled, 'boolean')
assert.equal(typeof settingsBody.settings.features.updateButton, 'boolean')
assert.equal(typeof settingsBody.settings.window.width, 'number')
ok('GET settings route')

const cacheResponse = await cacheRoute.fetch(
  new Request('http://127.0.0.1:3080/api/dsh-app-controls/cache', { method: 'GET' }),
)
const cacheBody = await cacheResponse.json()
assert.equal(cacheResponse.status, 200)
assert.equal(cacheBody.ok, true)
assert.equal(Array.isArray(cacheBody.categories), true)
assert.deepEqual(cacheBody.categories.map((entry) => entry.id), ['app', 'npx', 'npm', 'pnpm', 'backups'])
ok('GET cache inventory')

const emptyClean = await cacheCleanRoute.fetch(
  new Request('http://127.0.0.1:3080/api/dsh-app-controls/cache/clean', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ categories: [] }),
  }),
)
assert.equal(emptyClean.status, 400)
assert.equal((await emptyClean.json()).error, 'invalid-categories')
ok('POST cache clean rejects empty selection')

const idleProgress = await progressRoute.fetch(
  new Request('http://127.0.0.1:3080/api/dsh-app-controls/update-progress', { method: 'GET' }),
)
const idleBody = await idleProgress.json()
assert.equal(idleProgress.status, 200)
assert.equal(idleBody.active, false)
assert.equal(idleBody.done, false)
ok('GET update-progress idle snapshot')

const statusResponse = await updateRoute.fetch(
  new Request('http://127.0.0.1:3080/api/dsh-app-controls/update', { method: 'GET' }),
)
const statusBody = await statusResponse.json()
assert.equal(statusResponse.status, 200)
assert.equal(statusBody.current, install.version)
assert.ok(typeof statusBody.candidate === 'string' && statusBody.candidate.length > 0)
ok('GET update route', `${statusBody.current} -> ${statusBody.candidate}`)

const quitResponse = await quitRoute.fetch(
  new Request('http://127.0.0.1:3080/api/dsh-app-controls/quit', { method: 'POST' }),
)
assert.equal(quitResponse.status, 202)
assert.equal((await quitResponse.json()).ok, true)
assert.deepEqual(exitCalls, [], 'exit must be scheduled, not immediate')
await new Promise((resolve) => setTimeout(resolve, 800))
assert.deepEqual(exitCalls, [0])
ok('POST quit route schedules appExit(0)')

// ── client bundle format with a fake module loader and React ───────────────
const clientSource = fs.readFileSync(path.join(root, 'lib/client.js'), 'utf8')
let loaded
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(entry) {
        loaded = entry
      },
    },
    confirm: () => false,
    alert: () => {},
  },
  document: {
    baseURI: 'http://127.0.0.1:3080/',
    getElementById: () => null,
    createElement: (tag) => ({ tag, children: [], appendChild(child) { this.children.push(child) } }),
    head: { appendChild() {} },
    body: { appendChild() {} },
  },
  URL,
  console,
}
vm.createContext(sandbox)
vm.runInContext(clientSource, sandbox, { filename: 'client.js' })
assert.ok(loaded, 'client bundle must call window.__ModuleLoader__.load')
assert.equal(loaded.id, 'dsh-app-controls')
ok('client bundle registers module id')

const reactCalls = []
const fakeReact = {
  createElement(type, props, ...children) {
    reactCalls.push(type)
    return { type, props: props ?? {}, children: children.flat(Infinity) }
  },
}
const clientModule = loaded.factory((specifier) => {
  assert.equal(specifier, 'react')
  return fakeReact
})
assert.equal(typeof clientModule.apply, 'function')
assert.deepEqual(Array.from(clientModule.inject), ['slots'])
ok('client module exports apply/inject')

const registered = []
const injectedSlots = []
const clientCtx = {
  slots: {
    inject(slotName, callback) {
      injectedSlots.push(slotName)
      callback()
      return () => {}
    },
    register(options, component) {
      registered.push({ options, component })
      return () => {}
    },
  },
  effect(factory) {
    factory()
  },
}
clientModule.apply(clientCtx)
assert.deepEqual(injectedSlots, ['conversation.session.header.utilities', 'shell.overlay', 'plugins.bundle.config'])
assert.equal(registered.length, 3)
const headerEntry = registered.find((entry) => entry.options.name === 'conversation.session.header.utilities')
const overlayEntry = registered.find((entry) => entry.options.name === 'shell.overlay')
const settingsEntry = registered.find((entry) => entry.options.name === 'plugins.bundle.config')
assert.ok(headerEntry)
assert.ok(overlayEntry)
assert.ok(settingsEntry)
assert.equal(settingsEntry.options.key, 'dsh-app-controls')
assert.equal(headerEntry.options.id, 'dsh-app-controls')
assert.equal(headerEntry.options.order, 100)
assert.equal(overlayEntry.options.id, 'dsh-app-controls-overlay')
ok('client registers into header utilities, shell.overlay and plugin settings slots')

function buttonChildren(tree) {
  return tree.children
}
const headerTree = headerEntry.component()
assert.equal(headerTree.type, 'div')
assert.equal(headerTree.props['data-dsh-ac-utilities'], '')
const headerButtons = buttonChildren(headerTree)
assert.equal(headerButtons.length, 2)
assert.equal(headerButtons[0].type.name, 'IconButton')
assert.equal(headerButtons[1].type.name, 'IconButton')
assert.match(headerButtons[0].props.title, /更新/u)
assert.match(headerButtons[1].props.title, /退出/u)

const overlayTree = overlayEntry.component()
assert.equal(overlayTree.type, 'div')
assert.equal(overlayTree.props.className, 'dsh-ac-overlay')
assert.equal(overlayTree.children.length, 1)
const overlayGroup = overlayTree.children[0]
assert.equal(overlayGroup.type, 'div')
assert.equal(overlayGroup.props.className, 'dsh-ac-overlay-group')
assert.equal(overlayGroup.children.length, 2)
assert.equal(overlayGroup.children[0].type.name, 'IconButton')
assert.equal(overlayGroup.children[1].type.name, 'IconButton')
ok('header and overlay controls render update and quit buttons')

console.log(`\n${passed} checks passed`)
