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
    const PROGRESS_ENDPOINT = 'api/dsh-app-controls/update-progress'
    const QUIT_ENDPOINT = 'api/dsh-app-controls/quit'
    const STYLE_ID = 'dsh-app-controls-style'
    const MODAL_ID = 'dsh-app-controls-modal'
    const EXIT_ID = 'dsh-app-controls-exit'
    const CLOSE_HINT_ID = 'dsh-app-controls-close-hint'
    const POLL_INTERVAL_MS = 800

    let activeModal = null
    let modalDismissible = false
    let modalOnClose = null
    let pollTimer = 0

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
      openModal({ title: '正在更新 DeepSeek Harness', content: wrap, dismissible: false })
      return {
        update(state) {
          const value = Math.max(0, Math.min(100, Math.round(state.percent ?? 0)))
          fill.style.width = `${value}%`
          percent.textContent = `${value}%`
          phase.textContent = state.message || '正在更新…'
          activity.textContent = state.activity ? state.activity : ''
          elapsed.textContent = state.elapsedMs > 0 ? `已用时 ${formatDuration(state.elapsedMs)}` : ''
        },
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

    function openConfirmUpdate(status, button) {
      const channelNote = status.channel === 'next' ? '（预发布版本）' : ''
      const finish = () => {
        closeModal()
        resetUpdateButton(button)
      }
      openModal({
        title: '发现新版本',
        message:
          `当前版本：${status.current}\n` +
          `新版本：${status.candidate}${channelNote}\n\n` +
          '更新会在后台下载并安装，通常需要几分钟；期间不能结束服务，完成后会自动退出并关闭窗口。',
        dismissible: true,
        onClose: finish,
        buttons: [
          { label: '取消', variant: 'secondary', onClick: finish },
          { label: '立即更新', variant: 'primary', onClick: () => startUpdate(status, button) },
        ],
      })
    }

    async function startUpdate(status, button) {
      closeModal()
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
          title: '检查并更新 DeepSeek Harness',
          icon: UPDATE_ICON,
          onClick: onUpdate,
        }),
        h(IconButton, {
          key: 'quit',
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
      injectStyles()
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
      if (typeof ctx.effect === 'function') {
        ctx.effect(
          () => () => {
            for (const dispose of [disposeHeader, disposeOverlay]) {
              try {
                if (typeof dispose === 'function') dispose()
              } catch {
                // the slot may already be gone during teardown
              }
            }
            stopPolling()
            removeModal()
            removeExitScreen()
            stopPositioning()
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
