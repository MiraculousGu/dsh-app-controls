// Browser half of dsh-app-controls.
//
// Adds two small controls to the conversation header's right-aligned
// utilities row:
//   - check / update DeepSeek Harness (opens a styled modal, then a progress
//     dialog driven by the host's update job),
//   - quit the local dsh web process (styled confirm, then closes the window
//     after the service stops).
//
// Hand-written in the lazy-CJS bundle protocol (window.__ModuleLoader__.load
// with a factory returning Cordis-plugin exports), so no build step is needed.
// Only the shell's baseline `react` module is required at runtime.
window.__ModuleLoader__.load({
  id: 'dsh-app-controls',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    const SLOT = 'conversation.session.header.utilities'
    const STATUS_ENDPOINT = 'api/dsh-app-controls/update'
    const START_ENDPOINT = 'api/dsh-app-controls/update'
    const DEFER_ENDPOINT = 'api/dsh-app-controls/update/defer'
    const PROGRESS_ENDPOINT = 'api/dsh-app-controls/update-progress'
    const STATE_ENDPOINT = 'api/dsh-app-controls/state'
    const SETTINGS_ENDPOINT = 'api/dsh-app-controls/settings'
    const CACHE_ENDPOINT = 'api/dsh-app-controls/cache'
    const CACHE_CLEAN_ENDPOINT = 'api/dsh-app-controls/cache/clean'
    const VIEW_HANDLED_ENDPOINT = 'api/dsh-app-controls/view-handled'
    const QUIT_ENDPOINT = 'api/dsh-app-controls/quit'
    const STYLE_ID = 'dsh-app-controls-style'
    const MODAL_ID = 'dsh-app-controls-modal'
    const EXIT_ID = 'dsh-app-controls-exit'
    const MINI_ID = 'dsh-app-controls-update-mini'
    const CLOSE_HINT_ID = 'dsh-app-controls-close-hint'
    const POLL_INTERVAL_MS = 800

    let activeModal = null
    let modalDismissible = false
    let modalOnClose = null
    let pollTimer = 0
    let statePollTimer = 0
    let handledViewId = ''
    let updateToast = null
    let notifiedUpdateVersion = ''

    // ── small helpers ────────────────────────────────────────────────────────
    function apiUrl(relative) {
      return new URL(relative, document.baseURI).href
    }

    function errorMessage(error) {
      if (error && typeof error === 'object' && typeof error.message === 'string') return error.message
      return String(error)
    }

    async function readJson(response) {
      try {
        return await response.json()
      } catch {
        return null
      }
    }

    function failureText(body, status) {
      if (body && typeof body === 'object') {
        if (typeof body.message === 'string' && body.message !== '') return body.message
        if (typeof body.error === 'string' && body.error !== '') return body.error
      }
      return `HTTP ${status}`
    }

    function formatDuration(ms) {
      const total = Math.max(0, Math.round(ms / 1000))
      const minutes = Math.floor(total / 60)
      const seconds = total % 60
      if (minutes <= 0) return `${seconds} 秒`
      return `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒`
    }

    function formatBytes(bytes) {
      const value = typeof bytes === 'number' && Number.isFinite(bytes) ? Math.max(0, bytes) : 0
      if (value < 1024) return `${Math.round(value)} B`
      const units = ['KB', 'MB', 'GB', 'TB']
      let size = value / 1024
      let unit = 0
      while (size >= 1024 && unit < units.length - 1) {
        size /= 1024
        unit += 1
      }
      return `${size >= 100 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`
    }

    // ── settings ─────────────────────────────────────────────────────────────
    const SETTINGS_NS = 'dsh-app-controls'
    const DEFAULT_SETTINGS = {
      version: 1,
      trayEnabled: true,
      features: {
        updateButton: true,
        quitButton: true,
        headerControls: true,
        mainOverlay: true,
      },
      window: { width: 1400, height: 900 },
      trayIcon: { style: 'deepseek', customPath: '' },
      update: { autoCheck: true, deferMinutes: 60 },
    }
    const SETTINGS_TEXT = {
      zh: {
        title: '应用控制设置',
        intro: '设置保存在本机，下次启动 DSH 时自动生效；按钮显示/隐藏会立即生效。',
        general: '常规',
        buttons: '按钮显示',
        window: '默认启动窗口大小',
        trayEnabled: '系统托盘图标',
        trayIcon: '托盘图标样式',
        iconStyle: '图标',
        iconDeepseek: 'DeepSeek 鲸鱼（默认）',
        iconClassic: '经典电源图标',
        iconCustom: '自定义图片',
        customPath: '自定义图标路径（PNG/SVG）',
        customPathNote: '填写本机绝对路径；读取失败会自动回退到 DeepSeek 图标。',
        updateSection: '更新设置',
        autoCheck: '后台自动检查更新',
        autoCheckNote: '每 30 分钟静默检查；发现新版本时在界面/托盘提示，已是最新时不打扰。',
        deferMinutes: '推迟更新的默认时长（分钟）',
        deferMinutesNote: '范围 5 到 10080 分钟；托盘和界面共用。',
        updateButton: '检查并更新按钮',
        quitButton: '退出服务按钮',
        headerControls: '对话标题栏入口',
        mainOverlay: '主界面右上角入口',
        windowNote: '宽度和高度留空或填 0 表示让 Chrome 记住；设置在下一次打开窗口时生效。',
        width: '宽度',
        height: '高度',
        rememberCurrent: '记住当前窗口大小',
        autoSize: '恢复自动',
        currentWindow: '当前窗口',
        cache: '缓存清理',
        cacheIntro: '选择要清理的缓存类型。只删除可重新生成的缓存，不会删除运行中的 DSH、插件源码、设置、会话或登录状态。',
        cacheNote: '清理后会重新生成，可能暂时增加一点加载时间；正在运行或正在使用的缓存会被自动跳过。',
        cacheRefresh: '重新扫描',
        cacheClean: '清理选中',
        cacheSelectAll: '全选可清理项',
        cacheScanning: '正在统计缓存…',
        cacheNone: '暂无可清理的缓存。',
        cacheSelected: '已选',
        cacheFreed: '已释放',
        cachePartial: '部分完成，已释放',
        cacheFailed: '清理失败',
        cacheScanFailed: '无法读取缓存信息',
        cacheUnavailable: '不可用',
        cacheCleaning: '清理中…',
        cacheProtected: '已跳过正在使用的项',
        cacheApp: '应用缓存',
        cacheAppDetail: 'DSH 的附件图片缓存，可安全重建',
        cacheNpx: 'npx 安装缓存',
        cacheNpxDetail: '旧版临时安装；保留当前正在运行的版本',
        cacheNpm: 'npm 下载缓存',
        cacheNpmDetail: '下载的包缓存；下次安装时会重新下载',
        cachePnpm: '卸载插件的缓存',
        cachePnpmDetail: 'pnpm store 中未被任何项目引用的包；不会删除已安装插件',
        cacheBackups: '更新残留',
        cacheBackupsDetail: '7 天前的旧运行时备份和临时副本',
        saved: '已保存',
        saving: '保存中…',
        saveFailed: '保存失败',
      },
      en: {
        title: 'App controls settings',
        intro: 'Saved locally and applied on the next DSH start; button visibility changes immediately.',
        general: 'General',
        buttons: 'Button visibility',
        window: 'Default window size',
        trayEnabled: 'System tray icon',
        trayIcon: 'Tray icon style',
        iconStyle: 'Icon',
        iconDeepseek: 'DeepSeek whale (default)',
        iconClassic: 'Classic power icon',
        iconCustom: 'Custom image',
        customPath: 'Custom icon path (PNG/SVG)',
        customPathNote: 'Absolute local path; falls back to the DeepSeek icon if it cannot be read.',
        updateSection: 'Update settings',
        autoCheck: 'Check for updates in the background',
        autoCheckNote: 'Silent check every 30 minutes; notify only when a new version exists.',
        deferMinutes: 'Default defer duration (minutes)',
        deferMinutesNote: '5 to 10080 minutes; shared by the tray and the Web UI.',
        updateButton: 'Check/update button',
        quitButton: 'Quit button',
        headerControls: 'Conversation header entry',
        mainOverlay: 'Main-interface top-right entry',
        windowNote: 'Leave width and height empty or 0 to let Chrome remember; applied the next time a window opens.',
        width: 'Width',
        height: 'Height',
        rememberCurrent: 'Remember current size',
        autoSize: 'Use automatic size',
        currentWindow: 'Current window',
        cache: 'Cache cleanup',
        cacheIntro: 'Choose which caches to clean. Only regenerable caches are deleted; the running DSH, plugin source, settings, sessions and sign-in state are never touched.',
        cacheNote: 'Caches are rebuilt on demand and may add a little loading time after cleanup; active entries are skipped automatically.',
        cacheRefresh: 'Scan again',
        cacheClean: 'Clean selected',
        cacheSelectAll: 'Select all cleanable',
        cacheScanning: 'Scanning caches…',
        cacheNone: 'No cleanable cache found.',
        cacheSelected: 'Selected',
        cacheFreed: 'Freed',
        cachePartial: 'Partially completed, freed',
        cacheFailed: 'Cleanup failed',
        cacheScanFailed: 'Could not read cache information',
        cacheUnavailable: 'Unavailable',
        cacheCleaning: 'Cleaning…',
        cacheProtected: 'Skipped entries currently in use',
        cacheApp: 'Application cache',
        cacheAppDetail: 'DSH attachment-image cache; safe to rebuild',
        cacheNpx: 'npx install cache',
        cacheNpxDetail: 'Obsolete temporary installs; the running version is kept',
        cacheNpm: 'npm download cache',
        cacheNpmDetail: 'Downloaded package cache; re-downloaded on next install',
        cachePnpm: 'Uninstalled-plugin cache',
        cachePnpmDetail: 'Packages in the pnpm store not referenced by any project; installed plugins are untouched',
        cacheBackups: 'Update leftovers',
        cacheBackupsDetail: 'Runtime backups and staging copies older than 7 days',
        saved: 'Saved',
        saving: 'Saving…',
        saveFailed: 'Save failed',
      },
    }

    let clientSettings = normalizeClientSettings(DEFAULT_SETTINGS)
    let clientSettingsLoaded = false
    let clientSettingsLoading = null
    let clientContext = null
    let translate = (key) => SETTINGS_TEXT.zh[key] ?? key
    const CACHE_LABEL_KEYS = {
      app: 'cacheApp',
      npx: 'cacheNpx',
      npm: 'cacheNpm',
      pnpm: 'cachePnpm',
      backups: 'cacheBackups',
    }
    function cacheLabel(id) {
      return translate(CACHE_LABEL_KEYS[id] ?? id)
    }
    function cacheDetail(id) {
      return translate(`${CACHE_LABEL_KEYS[id] ?? id}Detail`)
    }

    function normalizeClientSettings(input) {
      const source = input !== null && typeof input === 'object' ? input : {}
      const features = source.features !== null && typeof source.features === 'object' ? source.features : {}
      const windowSize = source.window !== null && typeof source.window === 'object' ? source.window : {}
      const trayIcon = source.trayIcon !== null && typeof source.trayIcon === 'object' ? source.trayIcon : {}
      const update = source.update !== null && typeof source.update === 'object' ? source.update : {}
      const boolean = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
      const size = (value) => {
        const number = typeof value === 'number' ? value : Number(value)
        if (!Number.isFinite(number) || number <= 0) return 0
        return Math.min(10000, Math.max(600, Math.round(number)))
      }
      let width = size(windowSize.width)
      let height = size(windowSize.height)
      if (width === 0 || height === 0) {
        width = 0
        height = 0
      }
      return {
        version: 1,
        trayEnabled: boolean(source.trayEnabled, DEFAULT_SETTINGS.trayEnabled),
        features: {
          updateButton: boolean(features.updateButton, DEFAULT_SETTINGS.features.updateButton),
          quitButton: boolean(features.quitButton, DEFAULT_SETTINGS.features.quitButton),
          headerControls: boolean(features.headerControls, DEFAULT_SETTINGS.features.headerControls),
          mainOverlay: boolean(features.mainOverlay, DEFAULT_SETTINGS.features.mainOverlay),
        },
        window: { width, height },
        trayIcon: {
          style: ['deepseek', 'classic', 'custom'].includes(trayIcon.style) ? trayIcon.style : DEFAULT_SETTINGS.trayIcon.style,
          customPath: typeof trayIcon.customPath === 'string' ? trayIcon.customPath.trim().slice(0, 1024) : '',
        },
        update: {
          autoCheck: boolean(update.autoCheck, DEFAULT_SETTINGS.update.autoCheck),
          deferMinutes: Number.isFinite(Number(update.deferMinutes))
            ? Math.min(7 * 24 * 60, Math.max(5, Math.round(Number(update.deferMinutes))))
            : DEFAULT_SETTINGS.update.deferMinutes,
        },
      }
    }

    function applyClientSettings(next) {
      clientSettings = normalizeClientSettings(next)
      if (typeof document !== 'undefined' && document.body !== null && document.body.classList) {
        document.body.classList.toggle('dsh-ac-hide-update', !clientSettings.features.updateButton)
        document.body.classList.toggle('dsh-ac-hide-quit', !clientSettings.features.quitButton)
        document.body.classList.toggle('dsh-ac-hide-header', !clientSettings.features.headerControls)
        document.body.classList.toggle('dsh-ac-hide-overlay', !clientSettings.features.mainOverlay)
      }
      return clientSettings
    }

    function clearClientSettingsClasses() {
      if (typeof document === 'undefined' || document.body === null || !document.body.classList) return
      for (const name of ['dsh-ac-hide-update', 'dsh-ac-hide-quit', 'dsh-ac-hide-header', 'dsh-ac-hide-overlay']) {
        document.body.classList.remove(name)
      }
    }

    function canUseFetch() {
      return typeof fetch === 'function' && typeof document !== 'undefined' && typeof document.baseURI === 'string'
    }

    function loadClientSettings() {
      if (clientSettingsLoading !== null) return clientSettingsLoading
      clientSettingsLoading = (async () => {
        if (!canUseFetch()) {
          clientSettingsLoaded = true
          return clientSettings
        }
        try {
          const response = await fetch(apiUrl(SETTINGS_ENDPOINT), {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          })
          const body = await readJson(response)
          if (response.ok && body !== null && body.settings !== undefined) {
            applyClientSettings(body.settings)
          }
        } catch {
          // keep the defaults; the host may be starting
        }
        clientSettingsLoaded = true
        return clientSettings
      })()
      return clientSettingsLoading
    }

    function bindSettingsLocale(ctx) {
      try {
        let locale = undefined
        if (ctx && typeof ctx.get === 'function') locale = ctx.get('locale')
        if (locale === undefined && ctx) locale = ctx.locale
        if (locale && typeof locale.register === 'function' && typeof locale.bind === 'function') {
          locale.register(SETTINGS_NS, SETTINGS_TEXT)
          translate = locale.bind(SETTINGS_NS)
          return
        }
      } catch {
        // fall through to the navigator-based dictionary
      }
      const language = typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'zh'
      const dictionary = language.toLowerCase().startsWith('zh') ? SETTINGS_TEXT.zh : SETTINGS_TEXT.en
      translate = (key) => dictionary[key] ?? key
    }

    function SettingsPanel() {
      const [draft, setDraft] = React.useState(clientSettings)
      const [saving, setSaving] = React.useState(false)
      const [status, setStatus] = React.useState('')
      const [cache, setCache] = React.useState(null)
      const [cacheLoading, setCacheLoading] = React.useState(false)
      const [cacheCleaning, setCacheCleaning] = React.useState(false)
      const [cacheStatus, setCacheStatus] = React.useState('')
      const [selected, setSelected] = React.useState({})

      React.useEffect(() => {
        let cancelled = false
        void loadClientSettings().then(() => {
          if (!cancelled) setDraft(clientSettings)
        })
        return () => {
          cancelled = true
        }
      }, [])

      React.useEffect(() => {
        void loadCache()
      }, [])

      async function loadCache() {
        setCacheLoading(true)
        setCacheStatus('')
        setSelected({})
        try {
          if (!canUseFetch()) throw new Error('host is unavailable')
          const response = await fetch(apiUrl(CACHE_ENDPOINT), {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          })
          const body = await readJson(response)
          if (!response.ok || body === null || !Array.isArray(body.categories)) {
            throw new Error(failureText(body, response.status))
          }
          setCache(body)
        } catch (error) {
          setCacheStatus(`${translate('cacheScanFailed')}：${errorMessage(error)}`)
        } finally {
          setCacheLoading(false)
        }
      }

      async function cleanSelected() {
        const categories = (cache !== null && Array.isArray(cache.categories) ? cache.categories : [])
          .filter((category) => category.available && selected[category.id])
          .map((category) => category.id)
        if (categories.length === 0) return
        setCacheCleaning(true)
        setCacheStatus('')
        try {
          if (!canUseFetch()) throw new Error('host is unavailable')
          const response = await fetch(apiUrl(CACHE_CLEAN_ENDPOINT), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ categories }),
          })
          const body = await readJson(response)
          if (!response.ok || body === null) {
            throw new Error(failureText(body, response.status))
          }
          if (body.inventory !== undefined) setCache(body.inventory)
          setSelected({})
          const freed = formatBytes(body.freedBytes ?? 0)
          const partial = Array.isArray(body.results) && body.results.some((result) => result && result.ok === false)
          setCacheStatus(`${translate(partial ? 'cachePartial' : 'cacheFreed')} ${freed}`)
        } catch (error) {
          setCacheStatus(`${translate('cacheFailed')}：${errorMessage(error)}`)
        } finally {
          setCacheCleaning(false)
        }
      }

      async function commit(next) {
        setDraft(next)
        setSaving(true)
        setStatus('')
        try {
          if (!canUseFetch()) throw new Error('host is unavailable')
          const response = await fetch(apiUrl(SETTINGS_ENDPOINT), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(next),
          })
          const body = await readJson(response)
          if (!response.ok || body === null || body.settings === undefined) {
            throw new Error(failureText(body, response.status))
          }
          applyClientSettings(body.settings)
          setDraft(clientSettings)
          setStatus(translate('saved'))
        } catch (error) {
          setStatus(`${translate('saveFailed')}：${errorMessage(error)}`)
        } finally {
          setSaving(false)
        }
      }

      function patch(partial) {
        const next = normalizeClientSettings({
          ...draft,
          ...partial,
          features: { ...draft.features, ...(partial.features ?? {}) },
          window: { ...draft.window, ...(partial.window ?? {}) },
          trayIcon: { ...draft.trayIcon, ...(partial.trayIcon ?? {}) },
          update: { ...draft.update, ...(partial.update ?? {}) },
        })
        void commit(next)
      }

      function editDraft(partial) {
        setDraft(normalizeClientSettings({
          ...draft,
          ...partial,
          features: { ...draft.features, ...(partial.features ?? {}) },
          window: { ...draft.window, ...(partial.window ?? {}) },
          trayIcon: { ...draft.trayIcon, ...(partial.trayIcon ?? {}) },
          update: { ...draft.update, ...(partial.update ?? {}) },
        }))
      }

      function featureRow(key, label) {
        return h(
          'label',
          { className: 'dsh-ac-settings-row' },
          h('span', null, translate(label)),
          h('input', {
            type: 'checkbox',
            checked: draft.features[key],
            disabled: saving,
            onChange: (event) => patch({ features: { [key]: event.target.checked } }),
          }),
        )
      }

      const currentWidth = typeof window !== 'undefined' ? Math.round(window.outerWidth || window.innerWidth || 0) : 0
      const currentHeight = typeof window !== 'undefined' ? Math.round(window.outerHeight || window.innerHeight || 0) : 0
      const cacheCategories = cache !== null && Array.isArray(cache.categories) ? cache.categories : []
      const selectedBytes = cacheCategories.reduce(
        (sum, category) => sum + (category.available && selected[category.id] ? category.sizeBytes || 0 : 0),
        0,
      )
      const hasSelected = cacheCategories.some((category) => category.available && selected[category.id])
      const cleanable = cacheCategories.some((category) => category.available)

      return h(
        'section',
        { className: 'dsh-ac-settings' },
        h(
          'div',
          { className: 'dsh-ac-settings-heading' },
          h('h3', { className: 'dsh-ac-settings-title' }, translate('title')),
          h('p', { className: 'dsh-ac-settings-intro' }, translate('intro')),
        ),
        h(
          'div',
          { className: 'dsh-ac-settings-group' },
          h('div', { className: 'dsh-ac-settings-group-title' }, translate('general')),
          h(
            'label',
            { className: 'dsh-ac-settings-row' },
            h('span', null, translate('trayEnabled')),
            h('input', {
              type: 'checkbox',
              checked: draft.trayEnabled,
              disabled: saving,
              onChange: (event) => patch({ trayEnabled: event.target.checked }),
            }),
          ),
        ),
        h(
          'div',
          { className: 'dsh-ac-settings-group' },
          h('div', { className: 'dsh-ac-settings-group-title' }, translate('trayIcon')),
          h(
            'label',
            { className: 'dsh-ac-settings-row' },
            h('span', null, translate('iconStyle')),
            h(
              'select',
              {
                value: draft.trayIcon.style,
                disabled: saving,
                onChange: (event) => patch({ trayIcon: { style: event.target.value } }),
              },
              h('option', { value: 'deepseek' }, translate('iconDeepseek')),
              h('option', { value: 'classic' }, translate('iconClassic')),
              h('option', { value: 'custom' }, translate('iconCustom')),
            ),
          ),
          draft.trayIcon.style === 'custom'
            ? h(
                'div',
                { className: 'dsh-ac-settings-field' },
                h('label', null, translate('customPath')),
                h('input', {
                  type: 'text',
                  value: draft.trayIcon.customPath,
                  placeholder: '/home/me/Pictures/icon.png',
                  disabled: saving,
                  onChange: (event) => editDraft({ trayIcon: { customPath: event.target.value } }),
                  onBlur: () => patch({ trayIcon: { customPath: draft.trayIcon.customPath } }),
                }),
                h('p', { className: 'dsh-ac-settings-note' }, translate('customPathNote')),
              )
            : null,
        ),
        h(
          'div',
          { className: 'dsh-ac-settings-group' },
          h('div', { className: 'dsh-ac-settings-group-title' }, translate('updateSection')),
          h(
            'label',
            { className: 'dsh-ac-settings-row' },
            h('span', null, translate('autoCheck')),
            h('input', {
              type: 'checkbox',
              checked: draft.update.autoCheck,
              disabled: saving,
              onChange: (event) => patch({ update: { autoCheck: event.target.checked } }),
            }),
          ),
          h('p', { className: 'dsh-ac-settings-note' }, translate('autoCheckNote')),
          h(
            'div',
            { className: 'dsh-ac-settings-field' },
            h('label', null, translate('deferMinutes')),
            h('input', {
              type: 'number',
              min: 5,
              max: 10080,
              value: String(draft.update.deferMinutes),
              disabled: saving,
              onChange: (event) => editDraft({ update: { deferMinutes: Number(event.target.value) } }),
              onBlur: () => patch({ update: { deferMinutes: draft.update.deferMinutes } }),
            }),
            h('p', { className: 'dsh-ac-settings-note' }, translate('deferMinutesNote')),
          ),
        ),
        h(
          'div',
          { className: 'dsh-ac-settings-group' },
          h('div', { className: 'dsh-ac-settings-group-title' }, translate('buttons')),
          featureRow('updateButton', 'updateButton'),
          featureRow('quitButton', 'quitButton'),
          featureRow('headerControls', 'headerControls'),
          featureRow('mainOverlay', 'mainOverlay'),
        ),
        h(
          'div',
          { className: 'dsh-ac-settings-group' },
          h('div', { className: 'dsh-ac-settings-group-title' }, translate('window')),
          h('p', { className: 'dsh-ac-settings-note' }, translate('windowNote')),
          h(
            'div',
            { className: 'dsh-ac-settings-size' },
            h(
              'label',
              null,
              translate('width'),
              h('input', {
                type: 'number',
                min: 600,
                max: 10000,
                value: draft.window.width === 0 ? '' : String(draft.window.width),
                disabled: saving,
                onChange: (event) => {
                  const value = event.target.value === '' ? 0 : Number(event.target.value)
                  editDraft({ window: { width: value, height: draft.window.height } })
                },
                onBlur: () => patch({ window: { width: draft.window.width, height: draft.window.height } }),
              }),
            ),
            h(
              'label',
              null,
              translate('height'),
              h('input', {
                type: 'number',
                min: 600,
                max: 10000,
                value: draft.window.height === 0 ? '' : String(draft.window.height),
                disabled: saving,
                onChange: (event) => {
                  const value = event.target.value === '' ? 0 : Number(event.target.value)
                  editDraft({ window: { width: draft.window.width, height: value } })
                },
                onBlur: () => patch({ window: { width: draft.window.width, height: draft.window.height } }),
              }),
            ),
            h(
              'button',
              {
                type: 'button',
                disabled: saving,
                onClick: () => patch({ window: { width: currentWidth, height: currentHeight } }),
              },
              translate('rememberCurrent'),
            ),
            h(
              'button',
              {
                type: 'button',
                disabled: saving,
                onClick: () => patch({ window: { width: 0, height: 0 } }),
              },
              translate('autoSize'),
            ),
          ),
          h('p', { className: 'dsh-ac-settings-note' }, `${translate('currentWindow')}: ${currentWidth} × ${currentHeight}`),
        ),
        h(
          'div',
          { className: 'dsh-ac-settings-group dsh-ac-cache-group' },
          h('div', { className: 'dsh-ac-settings-group-title' }, translate('cache')),
          h('p', { className: 'dsh-ac-settings-note' }, translate('cacheIntro')),
          h('p', { className: 'dsh-ac-settings-note' }, translate('cacheNote')),
          h(
            'div',
            { className: 'dsh-ac-cache-summary' },
            cacheLoading
              ? translate('cacheScanning')
              : cache === null
                ? translate('cacheNone')
                : `${translate('cacheSelected')}: ${formatBytes(selectedBytes)}`,
          ),
          cacheCategories.length === 0
            ? h('p', { className: 'dsh-ac-settings-note' }, cacheLoading ? translate('cacheScanning') : translate('cacheNone'))
            : h(
                'div',
                { className: 'dsh-ac-cache-list' },
                cacheCategories.map((category) => h(
                  'label',
                  { key: category.id, className: 'dsh-ac-cache-row' },
                  h('input', {
                    type: 'checkbox',
                    checked: Boolean(selected[category.id]),
                    disabled: cacheLoading || cacheCleaning || !category.available,
                    onChange: (event) => setSelected({ ...selected, [category.id]: event.target.checked }),
                  }),
                  h(
                    'span',
                    { className: 'dsh-ac-cache-copy' },
                    h('span', { className: 'dsh-ac-cache-label' }, cacheLabel(category.id)),
                    h(
                      'span',
                      { className: 'dsh-ac-cache-detail' },
                      category.available ? cacheDetail(category.id) : `${translate('cacheUnavailable')}：${category.reason || ''}`,
                    ),
                  ),
                  h('span', { className: 'dsh-ac-cache-size' }, formatBytes(category.sizeBytes || 0)),
                )),
              ),
          h(
            'div',
            { className: 'dsh-ac-cache-actions' },
            h(
              'button',
              { type: 'button', className: 'dsh-ac-cache-button', disabled: cacheLoading || cacheCleaning, onClick: loadCache },
              translate('cacheRefresh'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-ac-cache-button',
                disabled: cacheLoading || cacheCleaning || !cleanable,
                onClick: () => {
                  const next = {}
                  for (const category of cacheCategories) {
                    if (category.available) next[category.id] = true
                  }
                  setSelected(next)
                },
              },
              translate('cacheSelectAll'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-ac-cache-button dsh-ac-cache-button-primary',
                disabled: cacheLoading || cacheCleaning || !hasSelected,
                onClick: cleanSelected,
              },
              cacheCleaning ? translate('cacheCleaning') : translate('cacheClean'),
            ),
          ),
          h('div', { className: 'dsh-ac-settings-footer', role: 'status' }, cacheStatus),
        ),
        h('div', { className: 'dsh-ac-settings-footer', role: 'status' }, saving ? translate('saving') : status),
      )
    }

    // ── styles ───────────────────────────────────────────────────────────────
    function injectStyles() {
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = [
        '.dsh-app-controls{display:inline-flex;align-items:center;gap:2px;margin-left:2px}',
        '.dsh-ac-overlay{position:fixed;top:calc(var(--dsh-frame-top-clearance, 0px) + 8px);right:12px;z-index:70;display:inline-flex;pointer-events:auto}',
        '.dsh-ac-overlay-group{display:inline-flex;align-items:center;gap:2px}',
        'body:has([data-dsh-ac-utilities]) .dsh-ac-overlay{display:none}',
        '.dsh-app-controls-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:inherit;opacity:.75;cursor:pointer;transition:background-color .12s ease,opacity .12s ease}',
        '.dsh-app-controls-btn:hover{background:rgba(127,127,127,.18);opacity:1}',
        '.dsh-app-controls-btn:active{background:rgba(127,127,127,.28)}',
        '.dsh-app-controls-btn:disabled{opacity:.4;cursor:progress}',
        'body.dsh-ac-hide-update [data-dsh-ac-feature="update"]{display:none!important}',
        'body.dsh-ac-hide-quit [data-dsh-ac-feature="quit"]{display:none!important}',
        'body.dsh-ac-hide-header .dsh-app-controls{display:none!important}',
        'body.dsh-ac-hide-overlay .dsh-ac-overlay{display:none!important}',
        '.dsh-ac-settings{display:flex;flex-direction:column;gap:16px;padding:2px 0;color:var(--dsw-alias-label-primary,inherit);font:13px/1.6 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}',
        '.dsh-ac-settings-heading{display:flex;flex-direction:column;gap:4px}',
        '.dsh-ac-settings-title{margin:0;font-size:16px;line-height:24px;font-weight:600}',
        '.dsh-ac-settings-intro{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,inherit);opacity:.8}',
        '.dsh-ac-settings-group{display:flex;flex-direction:column;gap:8px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:10px}',
        '.dsh-ac-settings-group-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,inherit)}',
        '.dsh-ac-settings-row{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:26px;font-size:13px;color:var(--dsw-alias-label-primary,inherit)}',
        '.dsh-ac-settings-row input[type="checkbox"]{width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-state-business-primary,#4d6bfe);cursor:pointer}',
        '.dsh-ac-settings-size{display:flex;flex-wrap:wrap;align-items:center;gap:8px}',
        '.dsh-ac-settings-size label{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--dsw-alias-label-secondary,inherit)}',
        '.dsh-ac-settings-size input{width:88px;height:30px;box-sizing:border-box;padding:0 8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:6px;background:var(--dsw-alias-bg-l1,transparent);color:var(--dsw-alias-label-primary,inherit);font:inherit}',
        '.dsh-ac-settings-size input:focus{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe));outline-offset:1px}',
        '.dsh-ac-settings-size button{height:30px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:6px;background:var(--dsw-alias-bg-l1,transparent);color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:12px;cursor:pointer}',
        '.dsh-ac-settings-size button:hover{background:var(--dsw-alias-bg-l2,rgba(127,127,127,.12))}',
        '.dsh-ac-settings-size button:disabled{opacity:.55;cursor:default}',
        '.dsh-ac-settings-field{display:flex;flex-direction:column;gap:5px;font-size:13px;color:var(--dsw-alias-label-secondary,inherit)}',
        '.dsh-ac-settings-field input,.dsh-ac-settings-field select{height:30px;box-sizing:border-box;padding:0 8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:6px;background:var(--dsw-alias-bg-l1,transparent);color:var(--dsw-alias-label-primary,inherit);font:inherit}',
        '.dsh-ac-settings-field input:focus,.dsh-ac-settings-field select:focus{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe));outline-offset:1px}',
        '.dsh-ac-settings-field input[type="number"]{width:120px}',
        '.dsh-ac-settings-note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,inherit);opacity:.8}',
        '.dsh-ac-cache-group{gap:6px}',
        '.dsh-ac-cache-summary{font-size:12px;color:var(--dsw-alias-label-tertiary,inherit)}',
        '.dsh-ac-cache-list{display:flex;flex-direction:column;gap:6px;margin-top:2px}',
        '.dsh-ac-cache-row{display:flex;align-items:flex-start;gap:10px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));border-radius:8px;font-size:13px;cursor:pointer}',
        '.dsh-ac-cache-row input[type="checkbox"]{width:16px;height:16px;margin:2px 0 0;flex-shrink:0;accent-color:var(--dsw-alias-state-business-primary,#4d6bfe);cursor:pointer}',
        '.dsh-ac-cache-copy{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}',
        '.dsh-ac-cache-label{font-size:13px;color:var(--dsw-alias-label-primary,inherit)}',
        '.dsh-ac-cache-detail{font-size:12px;line-height:1.45;color:var(--dsw-alias-label-tertiary,inherit);overflow-wrap:anywhere}',
        '.dsh-ac-cache-size{margin-left:auto;flex-shrink:0;font-variant-numeric:tabular-nums;font-size:12px;color:var(--dsw-alias-label-secondary,inherit);white-space:nowrap}',
        '.dsh-ac-cache-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}',
        '.dsh-ac-cache-actions button{height:30px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:12px;cursor:pointer}',
        '.dsh-ac-cache-actions button:hover{background:var(--dsw-alias-bg-l2,rgba(127,127,127,.12))}',
        '.dsh-ac-cache-actions button:disabled{opacity:.5;cursor:default}',
        '.dsh-ac-settings-footer{min-height:18px;font-size:12px;color:var(--dsw-alias-label-tertiary,inherit);opacity:.85}',
        '.dsh-app-controls-btn svg{display:block;width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}',
        '.dsh-ac-backdrop{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(8,10,14,.48);backdrop-filter:blur(3px);animation:dsh-ac-fade .14s ease-out}',
        '.dsh-ac-dialog{width:min(440px,calc(100vw - 40px));max-height:calc(100vh - 48px);overflow:auto;box-sizing:border-box;border-radius:14px;padding:22px 22px 18px;background:#ffffff;color:#1b1f24;box-shadow:0 18px 70px rgba(0,0,0,.34);font:14px/1.65 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;animation:dsh-ac-pop .16s ease-out}',
        'body[data-ds-dark-theme] .dsh-ac-dialog{background:#20242c;color:#e9ebef;box-shadow:0 18px 70px rgba(0,0,0,.55)}',
        '.dsh-ac-title{font-size:16px;font-weight:600;line-height:1.5;margin-bottom:10px;word-break:break-word}',
        '.dsh-ac-message{white-space:pre-wrap;word-break:break-word;opacity:.88;margin-bottom:16px}',
        '.dsh-ac-footer{display:flex;justify-content:flex-end;gap:10px;margin-top:18px}',
        '.dsh-ac-btn{appearance:none;border:1px solid transparent;border-radius:8px;padding:7px 16px;font:inherit;font-size:13px;font-weight:500;cursor:pointer;transition:background-color .12s,opacity .12s;min-width:64px}',
        '.dsh-ac-btn.secondary{background:transparent;border-color:rgba(127,127,127,.42);color:inherit}',
        '.dsh-ac-btn.secondary:hover{background:rgba(127,127,127,.14)}',
        '.dsh-ac-btn.primary{background:#4d6bfe;color:#fff}',
        '.dsh-ac-btn.primary:hover{background:#3c58e0}',
        '.dsh-ac-btn.danger{background:#e5484d;color:#fff}',
        '.dsh-ac-btn.danger:hover{background:#cf3b40}',
        '.dsh-ac-spinner-row{display:flex;align-items:center;gap:10px;opacity:.9}',
        '.dsh-ac-spinner{width:16px;height:16px;border:2px solid rgba(127,127,127,.35);border-top-color:currentColor;border-radius:50%;animation:dsh-ac-spin .8s linear infinite;flex:none}',
        '.dsh-ac-progress{display:flex;flex-direction:column;gap:10px}',
        '.dsh-ac-versions{font-size:13px;opacity:.75;letter-spacing:.2px}',
        '.dsh-ac-track{height:8px;border-radius:999px;background:rgba(127,127,127,.22);overflow:hidden}',
        '.dsh-ac-fill{height:100%;width:0%;border-radius:999px;background:linear-gradient(90deg,#4d6bfe,#6ea8ff);transition:width .4s ease;position:relative;overflow:hidden}',
        '.dsh-ac-fill::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.45),transparent);transform:translateX(-100%);animation:dsh-ac-shimmer 1.6s ease-in-out infinite}',
        '.dsh-ac-progress-row{display:flex;justify-content:space-between;gap:12px;font-size:13px}',
        '.dsh-ac-phase{opacity:.9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dsh-ac-percent{font-variant-numeric:tabular-nums;font-weight:600;flex:none}',
        '.dsh-ac-activity{font-size:12px;opacity:.55;min-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
        '.dsh-ac-elapsed{font-size:12px;opacity:.55;font-variant-numeric:tabular-nums}',
        '.dsh-ac-exit{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(8,10,14,.62);backdrop-filter:blur(4px);animation:dsh-ac-fade .18s ease-out}',
        '.dsh-ac-exit-card{width:min(420px,calc(100vw - 40px));box-sizing:border-box;border-radius:16px;padding:28px 26px 22px;text-align:center;background:#ffffff;color:#1b1f24;box-shadow:0 18px 70px rgba(0,0,0,.35);font:14px/1.65 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}',
        'body[data-ds-dark-theme] .dsh-ac-exit-card{background:#20242c;color:#e9ebef;box-shadow:0 18px 70px rgba(0,0,0,.55)}',
        '.dsh-ac-exit-mark{width:44px;height:44px;margin:0 auto 14px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:rgba(63,174,99,.16);color:#3fae63;font-size:22px;font-weight:700}',
        '.dsh-ac-exit-mark.busy{background:rgba(77,107,254,.16);color:#4d6bfe}',
        '.dsh-ac-exit-title{font-size:16px;font-weight:600;margin-bottom:8px;word-break:break-word}',
        '.dsh-ac-exit-message{opacity:.82;white-space:pre-wrap;word-break:break-word;margin-bottom:14px}',
        '.dsh-ac-exit-hint{font-size:12px;opacity:.55;min-height:18px}',
        '@keyframes dsh-ac-fade{from{opacity:0}to{opacity:1}}',
        '@keyframes dsh-ac-pop{from{opacity:0;transform:translateY(6px) scale(.98)}to{opacity:1;transform:none}}',
        '@keyframes dsh-ac-spin{to{transform:rotate(360deg)}}',
        '@keyframes dsh-ac-shimmer{0%{transform:translateX(-100%)}60%,100%{transform:translateX(180%)}}',
        '.dsh-ac-progress-min{position:fixed;right:24px;bottom:24px;z-index:2147483000;display:inline-flex;align-items:center;gap:10px;padding:10px 13px;border:1px solid rgba(127,127,127,.34);border-radius:12px;background:#ffffff;color:#1b1f24;box-shadow:0 10px 34px rgba(0,0,0,.28);font:13px/1.4 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;cursor:pointer}',
        'body[data-ds-dark-theme] .dsh-ac-progress-min{background:#20242c;color:#e9ebef;box-shadow:0 10px 34px rgba(0,0,0,.52)}',
        '.dsh-ac-progress-min:hover{border-color:rgba(77,107,254,.7)}',
        '.dsh-ac-progress-min-dot{width:8px;height:8px;border-radius:50%;background:#4d6bfe;box-shadow:0 0 0 4px rgba(77,107,254,.14);flex:none}',
        '.dsh-ac-progress-min-text{font-variant-numeric:tabular-nums;white-space:nowrap}',
        '.dsh-ac-update-toast{position:fixed;right:24px;bottom:76px;z-index:2147482900;display:inline-flex;align-items:center;gap:10px;max-width:min(360px,calc(100vw - 48px));box-sizing:border-box;padding:10px 12px;border:1px solid rgba(127,127,127,.34);border-radius:12px;background:#ffffff;color:#1b1f24;box-shadow:0 10px 34px rgba(0,0,0,.28);font:13px/1.4 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}',
        'body[data-ds-dark-theme] .dsh-ac-update-toast{background:#20242c;color:#e9ebef;box-shadow:0 10px 34px rgba(0,0,0,.52)}',
        '.dsh-ac-update-toast button{appearance:none;border:1px solid rgba(127,127,127,.42);border-radius:7px;padding:4px 10px;background:transparent;color:inherit;font:inherit;cursor:pointer;flex:none}',
        '.dsh-ac-update-toast button:hover{background:rgba(127,127,127,.14)}',
        '.dsh-ac-update-toast .dsh-ac-update-toast-close{border:0;padding:0 2px;font-size:17px;line-height:1;opacity:.7}',
        '@media (prefers-reduced-motion: reduce){.dsh-ac-backdrop,.dsh-ac-dialog,.dsh-ac-exit,.dsh-ac-fill::after,.dsh-ac-spinner{animation:none}}',
      ].join('\n')
      document.head.appendChild(style)
    }

    // ── modal plumbing ──────────────────────────────────────────────────────
    function onModalKey(event) {
      if (event.key !== 'Escape') return
      if (!modalDismissible || typeof modalOnClose !== 'function') return
      event.preventDefault()
      modalOnClose()
    }

    function removeModal() {
      const existing = document.getElementById(MODAL_ID)
      if (existing !== null) existing.remove()
      const mini = document.getElementById(MINI_ID)
      if (mini !== null) mini.remove()
      document.removeEventListener('keydown', onModalKey)
      activeModal = null
      modalDismissible = false
      modalOnClose = null
    }

    function closeModal() {
      removeModal()
    }

    function buildButton(spec) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `dsh-ac-btn ${spec.variant ?? 'secondary'}`
      button.textContent = spec.label
      button.addEventListener('click', () => {
        if (typeof spec.onClick === 'function') spec.onClick()
      })
      return button
    }

    function openModal(options) {
      removeModal()
      const backdrop = document.createElement('div')
      backdrop.id = MODAL_ID
      backdrop.className = 'dsh-ac-backdrop'
      const dialog = document.createElement('div')
      dialog.className = 'dsh-ac-dialog'
      dialog.setAttribute('role', 'dialog')
      dialog.setAttribute('aria-modal', 'true')
      const title = document.createElement('div')
      title.className = 'dsh-ac-title'
      title.textContent = options.title
      dialog.appendChild(title)
      if (typeof options.message === 'string' && options.message !== '') {
        const message = document.createElement('div')
        message.className = 'dsh-ac-message'
        message.textContent = options.message
        dialog.appendChild(message)
      }
      if (options.content) dialog.appendChild(options.content)
      const buttons = Array.isArray(options.buttons) ? options.buttons : []
      if (buttons.length > 0) {
        const footer = document.createElement('div')
        footer.className = 'dsh-ac-footer'
        for (const spec of buttons) footer.appendChild(buildButton(spec))
        dialog.appendChild(footer)
      }
      backdrop.appendChild(dialog)
      document.body.appendChild(backdrop)
      modalDismissible = options.dismissible === true
      modalOnClose = typeof options.onClose === 'function' ? options.onClose : null
      if (modalDismissible) {
        backdrop.addEventListener('click', (event) => {
          if (event.target !== backdrop) return
          if (typeof modalOnClose === 'function') modalOnClose()
        })
      }
      document.addEventListener('keydown', onModalKey)
      const primary = dialog.querySelector('.dsh-ac-btn.primary') ?? dialog.querySelector('.dsh-ac-btn')
      if (primary !== null) window.setTimeout(() => primary.focus(), 30)
      activeModal = backdrop
      return { backdrop, dialog }
    }

    function openSpinner(title, message) {
      const row = document.createElement('div')
      row.className = 'dsh-ac-spinner-row'
      const spinner = document.createElement('div')
      spinner.className = 'dsh-ac-spinner'
      const text = document.createElement('div')
      text.textContent = message
      row.appendChild(spinner)
      row.appendChild(text)
      return openModal({ title, content: row, dismissible: false })
    }

    function openInfo(title, message) {
      return openModal({
        title,
        message,
        dismissible: true,
        onClose: closeModal,
        buttons: [{ label: '关闭', variant: 'primary', onClick: closeModal }],
      })
    }

    function openError(message) {
      return openModal({
        title: '操作失败',
        message,
        dismissible: true,
        onClose: closeModal,
        buttons: [{ label: '关闭', variant: 'primary', onClick: closeModal }],
      })
    }

    function openProgress(from, to) {
      const wrap = document.createElement('div')
      wrap.className = 'dsh-ac-progress'
      const versions = document.createElement('div')
      versions.className = 'dsh-ac-versions'
      versions.textContent = `${from}  →  ${to}`
      wrap.appendChild(versions)
      const track = document.createElement('div')
      track.className = 'dsh-ac-track'
      const fill = document.createElement('div')
      fill.className = 'dsh-ac-fill'
      track.appendChild(fill)
      wrap.appendChild(track)
      const row = document.createElement('div')
      row.className = 'dsh-ac-progress-row'
      const phase = document.createElement('span')
      phase.className = 'dsh-ac-phase'
      const percent = document.createElement('span')
      percent.className = 'dsh-ac-percent'
      row.appendChild(phase)
      row.appendChild(percent)
      wrap.appendChild(row)
      const activity = document.createElement('div')
      activity.className = 'dsh-ac-activity'
      wrap.appendChild(activity)
      const elapsed = document.createElement('div')
      elapsed.className = 'dsh-ac-elapsed'
      wrap.appendChild(elapsed)

      let modal = null
      let miniText = null
      function minimize() {
        if (modal === null) return
        modal.backdrop.style.display = 'none'
        const mini = document.getElementById(MINI_ID)
        if (mini !== null) mini.style.display = 'inline-flex'
      }
      function restore() {
        if (modal === null) return
        modal.backdrop.style.display = ''
        const mini = document.getElementById(MINI_ID)
        if (mini !== null) mini.style.display = 'none'
      }

      modal = openModal({
        title: '正在更新 DeepSeek Harness',
        content: wrap,
        dismissible: false,
        buttons: [{ label: '最小化', variant: 'secondary', onClick: minimize }],
      })

      // A compact floating progress pill keeps the page usable while the
      // update continues. Click it to bring the full dialog back.
      const mini = document.createElement('button')
      mini.type = 'button'
      mini.id = MINI_ID
      mini.className = 'dsh-ac-progress-min'
      mini.setAttribute('aria-label', '展开更新进度')
      mini.title = '展开更新进度'
      const dot = document.createElement('span')
      dot.className = 'dsh-ac-progress-min-dot'
      miniText = document.createElement('span')
      miniText.className = 'dsh-ac-progress-min-text'
      miniText.textContent = '更新中 0%'
      mini.appendChild(dot)
      mini.appendChild(miniText)
      mini.addEventListener('click', restore)
      mini.style.display = 'none'
      document.body.appendChild(mini)

      return {
        update(state) {
          const value = Math.max(0, Math.min(100, Math.round(state.percent ?? 0)))
          if (fill.isConnected) fill.style.width = `${value}%`
          if (percent.isConnected) percent.textContent = `${value}%`
          if (phase.isConnected) phase.textContent = state.message || '正在更新…'
          if (activity.isConnected) activity.textContent = state.activity ? state.activity : ''
          if (elapsed.isConnected) elapsed.textContent = state.elapsedMs > 0 ? `已用时 ${formatDuration(state.elapsedMs)}` : ''
          if (miniText !== null && miniText.isConnected) miniText.textContent = `更新中 ${value}%`
        },
        minimize,
        restore,
      }
    }

    // ── exit screen ─────────────────────────────────────────────────────────
    function removeExitScreen() {
      const existing = document.getElementById(EXIT_ID)
      if (existing !== null) existing.remove()
    }

    function showExitScreen(options) {
      removeModal()
      removeExitScreen()
      const screen = document.createElement('div')
      screen.id = EXIT_ID
      screen.className = 'dsh-ac-exit'
      const card = document.createElement('div')
      card.className = 'dsh-ac-exit-card'
      const mark = document.createElement('div')
      mark.className = options.spinner === true ? 'dsh-ac-exit-mark busy' : 'dsh-ac-exit-mark'
      const title = document.createElement('div')
      title.className = 'dsh-ac-exit-title'
      title.textContent = options.title
      const message = document.createElement('div')
      message.className = 'dsh-ac-exit-message'
      message.textContent = options.message
      const hint = document.createElement('div')
      hint.id = CLOSE_HINT_ID
      hint.className = 'dsh-ac-exit-hint'
      hint.textContent = options.spinner === true ? '' : '正在关闭窗口…'
      card.appendChild(mark)
      card.appendChild(title)
      card.appendChild(message)
      card.appendChild(hint)
      screen.appendChild(card)
      document.body.appendChild(screen)
      if (options.spinner === true) {
        const spinner = document.createElement('div')
        spinner.className = 'dsh-ac-spinner'
        mark.appendChild(spinner)
      } else {
        mark.textContent = '✓'
      }
      return { screen, title, message, hint, mark }
    }

    function tryCloseWindow() {
      window.setTimeout(() => {
        try {
          window.close()
        } catch {
          // a normal browser tab cannot be closed by script
        }
      }, 700)
      window.setTimeout(() => {
        const hint = document.getElementById(CLOSE_HINT_ID)
        if (hint !== null) hint.textContent = '窗口未能自动关闭，请手动关闭这个窗口。'
      }, 2200)
    }

    function stopPolling() {
      if (pollTimer !== 0) {
        window.clearTimeout(pollTimer)
        pollTimer = 0
      }
    }

    function dismissUpdateToast() {
      if (updateToast !== null && updateToast.parentNode !== null) updateToast.parentNode.removeChild(updateToast)
      updateToast = null
    }

    function showUpdateToast(status) {
      if (typeof document === 'undefined' || status === null || typeof status !== 'object') return
      const version = String(status.candidate ?? '')
      if (version === '') return
      notifiedUpdateVersion = version
      try {
        if (window.localStorage.getItem(`dsh-ac-update-notified:${version}`) === '1') return
        window.localStorage.setItem(`dsh-ac-update-notified:${version}`, '1')
      } catch {
        // private mode: still show once per page
      }
      dismissUpdateToast()
      const toast = document.createElement('div')
      toast.className = 'dsh-ac-update-toast'
      toast.setAttribute('role', 'status')
      const text = document.createElement('span')
      text.textContent = `发现新版本 ${version}`
      const action = document.createElement('button')
      action.type = 'button'
      action.textContent = '查看'
      action.addEventListener('click', () => {
        dismissUpdateToast()
        openConfirmUpdate(status, null)
      })
      const close = document.createElement('button')
      close.type = 'button'
      close.className = 'dsh-ac-update-toast-close'
      close.setAttribute('aria-label', '关闭')
      close.textContent = '×'
      close.addEventListener('click', dismissUpdateToast)
      toast.appendChild(text)
      toast.appendChild(action)
      toast.appendChild(close)
      document.body.appendChild(toast)
      updateToast = toast
    }

    function pluginsViewVisible() {
      const text = document.body.innerText || ''
      return text.includes('安装、启用和配置插件') || text.includes('Install, enable and configure')
    }

    function navigateToView(view) {
      if (view === 'plugins') {
        const clicked = clickPluginsNav()
        if (clicked) {
          // A freshly created session can still finish routing after the first
          // click; re-apply the navigation if the Plugins page did not stick.
          window.setTimeout(() => { if (!pluginsViewVisible()) clickPluginsNav() }, 700)
          window.setTimeout(() => { if (!pluginsViewVisible()) clickPluginsNav() }, 1500)
        }
        return clicked
      }
      if (view === 'settings') {
        if (openSettingsNavigation()) return true
        if (clickPluginsNav()) {
          window.setTimeout(clickBundleCard, 600)
          return true
        }
      }
      return false
    }

    function acknowledgeView(id) {
      if (typeof fetch !== 'function') return
      void fetch(apiUrl(VIEW_HANDLED_ENDPOINT), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      }).catch(() => {})
    }

    // Tray-initiated quit/update requests set `quitRequested` on the host; the
    // page notices it here and closes the window after the service stops.
    function stopStatePolling() {
      if (statePollTimer !== 0) {
        window.clearTimeout(statePollTimer)
        statePollTimer = 0
      }
    }

    function startStatePolling() {
      if (typeof window.setTimeout !== 'function') return
      const tick = async () => {
        try {
          const response = await fetch(apiUrl(STATE_ENDPOINT), {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          })
          const data = await readJson(response)
          if (response.ok && data !== null) {
            const pending = data.pendingView
            if (pending !== null && typeof pending === 'object' && typeof pending.id === 'string' && pending.id !== handledViewId) {
              if (navigateToView(pending.view)) {
                handledViewId = pending.id
                acknowledgeView(pending.id)
              }
            }
            const update = data.update
            const deferred = typeof data.updateDeferUntil === 'number' && data.updateDeferUntil > Date.now()
            if (update !== null && typeof update === 'object' && update.updateAvailable === true && !deferred) {
              showUpdateToast(update)
            }
          }
          if (response.ok && data !== null && data.quitRequested === true) {
            if (document.getElementById(EXIT_ID) === null) {
              showExitScreen({
                title: 'DeepSeek Harness 已停止',
                message: '本地服务已结束，正在关闭窗口…',
                spinner: false,
              })
            }
            tryCloseWindow()
            return
          }
        } catch {
          // the server may be stopping; keep the window open with the hint
        }
        statePollTimer = window.setTimeout(tick, 2500)
      }
      statePollTimer = window.setTimeout(tick, 2500)
    }

    // ── dynamic overlay placement ───────────────────────────────────────────
    // The main interface has a CSS-grid header; the right-side controls (e.g.
    // the sidebar toggle) move with the layout. Anchor the overlay right next
    // to the leftmost right-side header control instead of a fixed offset, so
    // no blank gap appears and the controls follow layout changes.
    function positionOverlayControls() {
      const overlay = document.querySelector('.dsh-ac-overlay')
      if (overlay === null) return
      let right = 12
      let top = 8
      const header = document.querySelector('header')
      if (header !== null) {
        const headerRect = header.getBoundingClientRect()
        const controls = Array.from(header.querySelectorAll('button'))
          .map((button) => button.getBoundingClientRect())
          .filter((rect) => rect.width > 0 && rect.height > 0)
          .filter((rect) => rect.right > headerRect.right - 320)
          .filter((rect) => rect.top < headerRect.bottom + 4 && rect.bottom > headerRect.top - 4)
        if (controls.length > 0) {
          const left = Math.min(...controls.map((rect) => rect.left))
          const controlTop = Math.min(...controls.map((rect) => rect.top))
          right = Math.max(12, Math.round(window.innerWidth - left + 8))
          top = Math.max(6, Math.round(controlTop))
        }
      }
      overlay.style.right = `${right}px`
      overlay.style.top = `${top}px`
    }

    function installOverlayPositioning() {
      if (typeof window.MutationObserver !== 'function' || typeof window.ResizeObserver !== 'function') {
        return () => {}
      }
      let frame = 0
      const schedule = () => {
        if (frame !== 0) return
        frame = window.requestAnimationFrame(() => {
          frame = 0
          positionOverlayControls()
        })
      }
      positionOverlayControls()
      window.addEventListener('resize', schedule)
      const mutation = new window.MutationObserver(schedule)
      // Only structural changes and control-label changes matter; not our own
      // inline style writes (which would otherwise feed back into the observer).
      mutation.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['aria-label'],
      })
      const resize = new window.ResizeObserver(schedule)
      for (const header of document.querySelectorAll('header')) resize.observe(header)
      return () => {
        window.removeEventListener('resize', schedule)
        mutation.disconnect()
        resize.disconnect()
        if (frame !== 0) window.cancelAnimationFrame(frame)
      }
    }

    // A tray menu entry opens the Web GUI with this hash; the SPA has no
    // deep-link route, so click the sidebar "Plugins" entry once it exists.
    const CONTROL_HASH = '#dsh-app-controls/plugins'
    const SETTINGS_HASH = '#dsh-app-controls/settings'

    function clickPluginsNav() {
      const labels = ['插件', 'Plugins']
      const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], [role="tab"], span, div'))
        .filter((element) => labels.includes((element.textContent || '').trim()))
        // Keep the innermost label: the outer wrappers carry the same text but
        // only the inner element has the click handler wired by the SPA.
        .filter((element) => !Array.from(element.children).some((child) => labels.includes((child.textContent || '').trim())))
        .filter((element) => {
          const rect = element.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0 && rect.left < 420 && rect.top < window.innerHeight
        })
      for (const element of candidates) {
        element.click()
        return true
      }
      return false
    }

    function clearControlHash() {
      try {
        window.history.replaceState(null, '', window.location.pathname + window.location.search)
      } catch {
        // keep the hash if the host does not allow history updates
      }
    }

    function clickBundleCard() {
      const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], span, div'))
        .filter((element) => {
          const text = (element.textContent || '').trim()
          return text === 'DeepSeek Harness 应用控制'
            || text === 'DeepSeek Harness App Controls'
            || text === 'dsh-app-controls'
            || text.includes('应用控制')
            || text.includes('App Controls')
        })
        .filter((element) => !Array.from(element.children).some((child) => {
          const text = (child.textContent || '').trim()
          return text.includes('应用控制') || text.includes('App Controls')
        }))
        .filter((element) => {
          const rect = element.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0
        })
      for (const element of candidates) {
        element.click()
        return true
      }
      return false
    }

    function openSettingsNavigation() {
      if (!clientContext || typeof clientContext.get !== 'function') return false
      try {
        const navigation = clientContext.get('pluginNavigation')
        if (navigation && typeof navigation.openBundle === 'function') {
          clearControlHash()
          navigation.openBundle('dsh-app-controls')
          return true
        }
      } catch {
        // fall through to the Plugins-page click path
      }
      return false
    }

    function openControlHash() {
      if (typeof window.setTimeout !== 'function' || typeof window.location !== 'object') return
      const hash = window.location.hash
      if (hash === SETTINGS_HASH) {
        clearControlHash()
        let attempts = 0
        const openPlugins = () => {
          if (clickPluginsNav()) {
            let cardAttempts = 0
            const openCard = () => {
              if (clickBundleCard()) return
              cardAttempts += 1
              if (cardAttempts < 24) window.setTimeout(openCard, 250)
            }
            window.setTimeout(openCard, 600)
            return
          }
          attempts += 1
          if (attempts < 24) window.setTimeout(openPlugins, 250)
        }
        window.setTimeout(openPlugins, 500)
        return
      }
      if (hash !== CONTROL_HASH) return
      let attempts = 0
      const tick = () => {
        if (clickPluginsNav()) {
          clearControlHash()
          return
        }
        attempts += 1
        if (attempts < 24) window.setTimeout(tick, 250)
      }
      window.setTimeout(tick, 500)
    }

    // ── header controls ─────────────────────────────────────────────────────
    function icon(paths) {
      return h(
        'svg',
        { viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
        paths.map((d, index) => h('path', { key: index, d: d })),
      )
    }

    const UPDATE_ICON = icon([
      'M20.5 12a8.5 8.5 0 1 1-2.49-6.01',
      'M20.5 4.5v5h-5',
      'M12 8.5v7',
      'M8.5 12.5 12 16l3.5-3.5',
    ])
    const QUIT_ICON = icon([
      'M12 3.5v8',
      'M6.9 6.9a7.5 7.5 0 1 0 10.2 0',
    ])

    function IconButton(props) {
      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-app-controls-btn',
          'data-dsh-ac-feature': props.feature,
          title: props.title,
          'aria-label': props.title,
          onClick: props.onClick,
        },
        props.icon,
      )
    }

    function resetUpdateButton(button) {
      if (button && button.isConnected) {
        button.disabled = false
        button.title = '检查并更新 DeepSeek Harness'
      }
    }

    function activityWarning(activity) {
      if (activity === null || typeof activity !== 'object' || activity.available === false) {
        return '暂时无法确认是否有任务在运行，更新前请留意。'
      }
      if (activity.active !== true) {
        return '当前没有检测到正在运行的任务。'
      }
      const parts = []
      if (activity.turns > 0) parts.push(`${activity.turns} 个进行中的对话`)
      if (activity.jobs > 0) parts.push(`${activity.jobs} 个后台任务`)
      return `检测到 ${activity.count} 个正在运行的任务（${parts.join('、')}）。更新会重启本地服务，这些任务会被中断。`
    }

    function deferLabel(minutes) {
      return minutes === 60 ? '1 小时' : `${minutes} 分钟`
    }

    async function deferUpdate(button) {
      closeModal()
      resetUpdateButton(button)
      const minutes = clientSettings.update.deferMinutes
      try {
        const response = await fetch(apiUrl(DEFER_ENDPOINT), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ minutes }),
        })
        const body = await readJson(response)
        if (!response.ok || body === null || body.ok !== true) throw new Error(failureText(body, response.status))
        if (notifiedUpdateVersion !== '') {
          try {
            window.localStorage.removeItem(`dsh-ac-update-notified:${notifiedUpdateVersion}`)
          } catch {
            // private mode: no stored marker
          }
        }
        openInfo('已推迟更新', `已推迟 ${deferLabel(minutes)}。后台再次检测到新版本时会再提醒你，也可以随时手动更新。`)
      } catch (error) {
        openError(`推迟更新失败：${errorMessage(error)}`)
      }
    }

    function releaseNotesText(status) {
      const notes = status.releaseNotes
      if (notes === null || typeof notes !== 'object' || typeof notes.notes !== 'string') return ''
      const text = notes.notes.trim()
      if (text === '') return ''
      const title = typeof notes.title === 'string' && notes.title.trim() !== '' ? notes.title.trim() : status.candidate
      return `\n\n更新说明（${title}）：\n${text.slice(0, 1600)}`
    }

    function openConfirmUpdate(status, button) {
      const channelNote = status.channel === 'next' ? '（预发布版本）' : ''
      const finish = () => {
        closeModal()
        resetUpdateButton(button)
      }
      const risky = status.activity !== null && typeof status.activity === 'object' && status.activity.active === true
      openModal({
        title: '发现新版本',
        message:
          `当前版本：${status.current}\n` +
          `新版本：${status.candidate}${channelNote}\n\n` +
          `${activityWarning(status.activity)}\n\n` +
          '更新会在后台下载并安装，通常需要几分钟；完成后服务会自动退出并关闭窗口。' +
          releaseNotesText(status),
        dismissible: true,
        onClose: finish,
        buttons: [
          { label: '取消', variant: 'secondary', onClick: finish },
          { label: `推迟 ${deferLabel(clientSettings.update.deferMinutes)}`, variant: risky ? 'primary' : 'secondary', onClick: () => deferUpdate(button) },
          { label: '立即更新', variant: 'secondary', onClick: () => startUpdate(status, button) },
        ],
      })
    }

    async function startUpdate(status, button) {
      closeModal()
      if (button && button.isConnected) button.disabled = true
      const progress = openProgress(status.current, status.candidate)
      progress.update({ percent: 0, message: '正在准备更新…', elapsedMs: 0 })
      try {
        const response = await fetch(apiUrl(START_ENDPOINT), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
        const body = await readJson(response)
        if (!response.ok || body === null) throw new Error(failureText(body, response.status))
        if (body.ok !== true) throw new Error(body.message || '无法开始更新')
        startPolling(progress, status, button)
      } catch (error) {
        removeModal()
        resetUpdateButton(button)
        openError(`启动更新失败：${errorMessage(error)}`)
      }
    }

    function startPolling(progress, status, button) {
      let failures = 0
      async function poll() {
        try {
          const response = await fetch(apiUrl(PROGRESS_ENDPOINT), {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          })
          const data = await readJson(response)
          if (!response.ok || data === null) throw new Error('无法读取更新进度')
          failures = 0
          progress.update({
            percent: data.percent,
            message: data.message,
            activity: data.activity,
            elapsedMs: data.elapsedMs,
          })
          if (data.done === true) {
            stopPolling()
            if (data.error !== null && data.error !== undefined) {
              removeModal()
              resetUpdateButton(button)
              if (data.error === 'up-to-date') {
                openInfo('已是最新版本', data.message || 'DeepSeek Harness 已是最新版本。')
              } else {
                openError(data.message || '更新失败')
              }
              return
            }
            progress.update({
              percent: 100,
              message: data.message || '更新完成',
              activity: '',
              elapsedMs: data.elapsedMs,
            })
            window.setTimeout(() => {
              removeModal()
              showExitScreen({
                title: `更新完成：DeepSeek Harness ${data.to ?? status.candidate}`,
                message: '新版本已安装，本地服务即将退出。正在关闭窗口，之后用桌面快捷方式重新启动。',
                spinner: false,
              })
              tryCloseWindow()
            }, 900)
            return
          }
          pollTimer = window.setTimeout(poll, POLL_INTERVAL_MS)
        } catch {
          failures += 1
          if (failures >= 4) {
            stopPolling()
            removeModal()
            resetUpdateButton(button)
            openError('无法读取更新进度：服务可能已经退出。若更新可能已完成，请用桌面快捷方式重新启动 DeepSeek Harness。')
            return
          }
          pollTimer = window.setTimeout(poll, 1200)
        }
      }
      poll()
    }

    async function onUpdate(event) {
      const button = event.currentTarget
      if (button.disabled) return
      button.disabled = true
      button.title = '正在检查更新…'
      openSpinner('检查更新', '正在查询 npm registry…')
      try {
        const response = await fetch(apiUrl(STATUS_ENDPOINT), {
          method: 'GET',
          headers: { accept: 'application/json' },
          cache: 'no-store',
        })
        const status = await readJson(response)
        if (!response.ok || status === null) throw new Error(failureText(status, response.status))
        if (status.updateAvailable !== true) {
          closeModal()
          resetUpdateButton(button)
          openInfo('已是最新版本', `DeepSeek Harness ${status.current} 已是最新版本。`)
          return
        }
        openConfirmUpdate(status, button)
      } catch (error) {
        closeModal()
        resetUpdateButton(button)
        openError(`检查更新失败：${errorMessage(error)}`)
      }
    }

    function onQuit(event) {
      const button = event.currentTarget
      openModal({
        title: '退出 DeepSeek Harness？',
        message:
          '这会结束整个本地服务：所有会话、正在生成的回答和后台任务都会停止。\n' +
          '退出后可以用桌面快捷方式重新启动。',
        dismissible: true,
        onClose: closeModal,
        buttons: [
          { label: '取消', variant: 'secondary', onClick: closeModal },
          { label: '退出', variant: 'danger', onClick: () => performQuit(button) },
        ],
      })
    }

    async function performQuit(button) {
      closeModal()
      if (button) button.disabled = true
      showExitScreen({
        title: '正在退出 DeepSeek Harness',
        message: '正在结束后台服务，请稍候…',
        spinner: true,
      })
      try {
        const response = await fetch(apiUrl(QUIT_ENDPOINT), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
        const body = await readJson(response)
        if (!response.ok || body === null) throw new Error(failureText(body, response.status))
        showExitScreen({
          title: 'DeepSeek Harness 已退出',
          message: '本地服务已停止。正在关闭窗口，之后用桌面快捷方式重新启动。',
          spinner: false,
        })
        tryCloseWindow()
      } catch (error) {
        removeExitScreen()
        if (button && button.isConnected) button.disabled = false
        openError(`退出失败：${errorMessage(error)}`)
      }
    }

    function controlButtons() {
      return [
        h(IconButton, {
          key: 'update',
          feature: 'update',
          title: '检查并更新 DeepSeek Harness',
          icon: UPDATE_ICON,
          onClick: onUpdate,
        }),
        h(IconButton, {
          key: 'quit',
          feature: 'quit',
          title: '退出 DeepSeek Harness（结束本地服务）',
          icon: QUIT_ICON,
          onClick: onQuit,
        }),
      ]
    }

    // Inside a conversation: the right side of the conversation header.
    function AppControls() {
      return h(
        'div',
        { className: 'dsh-app-controls', 'data-dsh-ac-utilities': '' },
        controlButtons(),
      )
    }

    // Everywhere else (main interface, plugin pages): a fixed top-right
    // overlay. CSS hides it whenever the conversation header controls are
    // mounted, so the two entry points never show duplicates.
    function OverlayControls() {
      return h(
        'div',
        { className: 'dsh-ac-overlay' },
        h('div', { className: 'dsh-ac-overlay-group' }, controlButtons()),
      )
    }

    function apply(ctx) {
      clientContext = ctx
      injectStyles()
      bindSettingsLocale(ctx)
      applyClientSettings(clientSettings)
      void loadClientSettings()
      startStatePolling()
      openControlHash()
      const onHashChange = () => openControlHash()
      if (typeof window.addEventListener === 'function') window.addEventListener('hashchange', onHashChange)
      const stopPositioning = installOverlayPositioning()
      const disposeHeader = ctx.slots.inject(SLOT, () =>
        ctx.slots.register(
          {
            name: SLOT,
            id: 'dsh-app-controls',
            order: 100,
            registrant: 'dsh-app-controls',
          },
          AppControls,
        ),
      )
      const disposeOverlay = ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'dsh-app-controls-overlay',
            order: 100,
            registrant: 'dsh-app-controls',
          },
          OverlayControls,
        ),
      )
      const disposeSettings = ctx.slots.inject('plugins.bundle.config', () =>
        ctx.slots.register(
          {
            name: 'plugins.bundle.config',
            key: 'dsh-app-controls',
            locale: SETTINGS_NS,
          },
          SettingsPanel,
        ),
      )
      if (typeof ctx.effect === 'function') {
        ctx.effect(
          () => () => {
            for (const dispose of [disposeHeader, disposeOverlay, disposeSettings]) {
              try {
                if (typeof dispose === 'function') dispose()
              } catch {
                // the slot may already be gone during teardown
              }
            }
            stopPolling()
            stopStatePolling()
            if (typeof window.removeEventListener === 'function') window.removeEventListener('hashchange', onHashChange)
            removeModal()
            removeExitScreen()
            stopPositioning()
            clearClientSettingsClasses()
            const style = document.getElementById(STYLE_ID)
            if (style !== null) style.remove()
          },
          'dsh-app-controls: header and overlay controls',
        )
      }
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
