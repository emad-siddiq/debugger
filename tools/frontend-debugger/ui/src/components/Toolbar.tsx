import { useStore } from '../store'
import { ipc, apiPost } from '../ipc'
import { DEVICE_GROUPS, ALL_DEVICES } from '../devicePresets'
import { APP_BASE, APP_ROUTE_GROUPS, APP_ROUTES, buildRouteGroups, routeUrl } from '../appRoutes'

// MOCK ↔ LIVE pill: flips the embedded target between devMock and the real
// backend under debug (the flip restarts the target Vite server-side, so the
// iframe reloads when it lands). LIVE with the backend down goes red.
function ModePill() {
  const targetMode = useStore((s) => s.targetMode)
  const flipping = useStore((s) => s.modeFlipping)
  const backendDown = useStore((s) => s.backendDown)

  const flip = async () => {
    const st = useStore.getState()
    if (flipping || !targetMode) return
    const next = targetMode === 'live' ? 'mock' : 'live'
    st.setModeFlipping(true)
    st.setReady(false)
    try {
      const r = await apiPost('/mode', { mode: next })
      st.setTargetMode(r.mode)
      st.toast(
        'ok',
        r.mode === 'live'
          ? 'LIVE — clicks hit the debugged backend (:8080)'
          : 'MOCK — devMock intercepts /api again',
      )
      const f = document.querySelector('iframe.target-frame') as HTMLIFrameElement | null
      if (f) f.src = f.src // the target Vite restarted — reload the iframe
    } catch (e) {
      st.toast('error', `mode flip failed: ${e instanceof Error ? e.message : e}`)
    } finally {
      useStore.getState().setModeFlipping(false)
    }
  }

  const label = flipping ? '…' : targetMode ? targetMode.toUpperCase() : '·'
  const cls =
    'mode-pill' +
    (targetMode === 'live' ? ' live' : '') +
    (targetMode === 'live' && backendDown ? ' down' : '')
  const title =
    targetMode === 'live'
      ? backendDown
        ? 'LIVE but the backend is down — F5 the Go backend in Burrow, or click to flip back to mock'
        : 'LIVE: /api/nodewatch proxies to the backend under debug. Click to flip to mock.'
      : 'MOCK: devMock intercepts /api in-page. Click to go LIVE against the debugged backend.'

  return (
    <button className={cls} onClick={flip} disabled={flipping || !targetMode} title={title}>
      {label}
      {targetMode === 'live' && backendDown && !flipping ? ' · backend down' : ''}
    </button>
  )
}

export function Toolbar() {
  const ready = useStore((s) => s.ready)
  const mode = useStore((s) => s.mode)
  const setMode = useStore((s) => s.setMode)
  const exitTheater = useStore((s) => s.exitTheater)
  const viewport = useStore((s) => s.viewport)
  const setViewport = useStore((s) => s.setViewport)
  const orientation = useStore((s) => s.orientation)
  const toggleOrientation = useStore((s) => s.toggleOrientation)
  const autoZoom = useStore((s) => s.autoZoom)
  const setAutoZoom = useStore((s) => s.setAutoZoom)
  const pinned = useStore((s) => s.toolbarPinned)
  const setPinned = useStore((s) => s.setToolbarPinned)
  const openPanel = useStore((s) => s.openPanel)
  const targetUrl = useStore((s) => s.targetUrl)
  const gallery = useStore((s) => s.gallery)
  const toggleGallery = useStore((s) => s.toggleGallery)
  const fullScreen = useStore((s) => s.fullScreen)
  const setFullScreen = useStore((s) => s.setFullScreen)
  const setAuditPanel = useStore((s) => s.setAuditPanel)
  // Route catalog + basename resolution order:
  //   1. `discovered` — read from the target's live react-router fibers (any app)
  //   2. `appRoutes`  — parsed from the target's routes.ts by the server (merkle)
  //   3. static hand-mirror in appRoutes.ts (last-resort fallback)
  const discovered = useStore((s) => s.discovered)
  const liveRoutes = useStore((s) => s.appRoutes)
  const routes = discovered?.routes || liveRoutes || APP_ROUTES
  const routeGroups = discovered ? buildRouteGroups(discovered.routes) : liveRoutes ? buildRouteGroups(liveRoutes) : APP_ROUTE_GROUPS
  const routeBase = discovered?.basename ?? APP_BASE

  // Open an audit panel and kick off the corresponding agent scan. The panel
  // shows "Running…" until the `a11y`/`tokens` event lands (handled in App).
  const runAudit = (which: 'a11y' | 'tokens') => {
    if (which === 'a11y') {
      useStore.getState().setA11y(null)
      setAuditPanel('a11y')
      ipc.send('auditA11y', {})
    } else {
      useStore.getState().setTokens(null)
      setAuditPanel('tokens')
      ipc.send('auditTokens', {})
    }
  }

  const onPickDevice = (label: string) => {
    const d = ALL_DEVICES.find((x) => x.label === label)
    if (d) setViewport({ label: d.label, w: d.w, h: d.h, dpr: d.dpr })
  }

  // Jump the embedded target to a merkle route. Value is the route path;
  // navigating the same page again still reloads (a re-scan). Reset the select
  // back to the placeholder so it reads as an action, not a persistent choice.
  const onGoTo = (path: string) => {
    if (!path) return
    const route = routes.find((r) => r.path === path)
    ipc.navigate(routeUrl(path, targetUrl, routeBase))
    useStore.getState().toast('info', `→ ${route ? route.label : path}`)
  }

  return (
    <div className="toolbar">
      <div className="brand">
        <span className="logo">◉</span> Frontend Debugger
        <span className={'dot ' + (ready ? 'on' : 'off')} title={ready ? 'agent connected' : 'waiting for target app'} />
      </div>

      <ModePill />

      <div className="sep" />

      <div className="segmented" role="group" aria-label="mode">
        <button
          className={'seg' + (mode === 'interact' ? ' active' : '')}
          onClick={() => setMode('interact')}
          title="Interact: use the app normally (navigate pages). P toggles Pick, Esc → Interact"
        >
          🖱 Interact
        </button>
        <button
          className={'seg' + (mode === 'pick' ? ' active' : '')}
          onClick={() => setMode('pick')}
          title="Pick: hover to highlight, click to select. Right-click → theater"
        >
          🎯 Pick
        </button>
        <button
          className={'seg' + (mode === 'theater' ? ' active' : '')}
          onClick={() => mode === 'theater' && exitTheater()}
          title="Theater + drill-down (right-click a component in Pick mode)"
          disabled={mode !== 'theater'}
        >
          🎬 Theater
        </button>
      </div>
      {mode === 'theater' && (
        <button className="btn warn" onClick={exitTheater}>
          ⤺ Exit
        </button>
      )}

      <button className="btn ghost" title="Browse the component tree from the root" onClick={() => openPanel('tree')}>
        🌳 Components
      </button>

      <div className="sep" />

      <button
        className={'btn ghost icon' + (fullScreen ? ' active' : '')}
        title="Full screen: the app fills the pane 1:1 like a browser tab (maximizes the editor group in Burrow). Esc exits"
        onClick={() => setFullScreen(!fullScreen)}
      >
        ⛶
      </button>
      <button
        className={'btn ghost' + (gallery ? ' active' : '')}
        title="Responsive Gallery: the current route at Mobile / Tablet / Desktop side by side"
        onClick={toggleGallery}
      >
        🖼 Gallery
      </button>
      <button
        className="btn ghost"
        title="Accessibility audit of the current page (contrast, alt, labels, tap targets)"
        onClick={() => runAudit('a11y')}
        disabled={!ready}
      >
        ♿ Audit
      </button>
      <button
        className="btn ghost"
        title="Design-token conformance: flag colors that bypass the token system"
        onClick={() => runAudit('tokens')}
        disabled={!ready}
      >
        🎨 Tokens
      </button>

      <div className="sep" />

      <label className="lbl">go to</label>
      <select
        className="select wide"
        value=""
        title="Jump the embedded app to a merkle route"
        onChange={(e) => {
          onGoTo(e.target.value)
          e.target.selectedIndex = 0
        }}
      >
        <option value="">▸ route…</option>
        {routeGroups.map((g) => (
          <optgroup key={g.group} label={g.group}>
            {g.routes.map((r) => (
              <option key={r.id} value={r.path}>
                {r.label} · {r.path}
              </option>
            ))}
          </optgroup>
        ))}
      </select>

      <div className="sep" />

      <label className="lbl">device</label>
      <select className="select wide" value={viewport.label} onChange={(e) => onPickDevice(e.target.value)}>
        {DEVICE_GROUPS.map((g) => (
          <optgroup key={g.group} label={g.group}>
            {g.devices.map((d) => (
              <option key={d.label} value={d.label}>
                {d.label}
                {d.w ? ` · ${d.w}×${d.h}` : ''}
              </option>
            ))}
          </optgroup>
        ))}
        {!ALL_DEVICES.some((d) => d.label === viewport.label) && (
          <option value={viewport.label}>{viewport.label}</option>
        )}
      </select>
      <input
        className="num"
        type="number"
        value={viewport.w ?? ''}
        placeholder="W"
        onChange={(e) => setViewport({ label: 'Responsive', w: e.target.value ? Number(e.target.value) : null, h: viewport.h })}
      />
      <span className="x">×</span>
      <input
        className="num"
        type="number"
        value={viewport.h ?? ''}
        placeholder="H"
        onChange={(e) => setViewport({ label: 'Responsive', w: viewport.w, h: e.target.value ? Number(e.target.value) : null })}
      />
      <button
        className="btn ghost icon"
        title="Rotate (swap width/height)"
        onClick={toggleOrientation}
        disabled={!viewport.w}
      >
        {orientation === 'portrait' ? '⟳' : '⟲'}
      </button>

      <label className="check" title="Zoom to the focused component in theater mode">
        <input type="checkbox" checked={autoZoom} onChange={(e) => setAutoZoom(e.target.checked)} />
        auto-zoom
      </label>

      <div className="sep" />

      <button className="btn ghost" title="Refresh component tree" onClick={() => ipc.send('getTree', { max: 6000 })}>
        ⟳
      </button>
      <button
        className="btn ghost"
        title="Reload the embedded app"
        onClick={() => {
          const f = document.querySelector('iframe.target-frame') as HTMLIFrameElement | null
          if (f) f.src = f.src
        }}
      >
        ↻
      </button>

      <div className="spacer" />
      <button
        className={'btn pin' + (pinned ? ' active' : '')}
        title={pinned ? 'Unpin toolbar' : 'Pin toolbar open'}
        onClick={() => setPinned(!pinned)}
      >
        {pinned ? '📌 pinned' : '📌 pin'}
      </button>
    </div>
  )
}
