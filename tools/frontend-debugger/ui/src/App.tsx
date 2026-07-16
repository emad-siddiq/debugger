import { useEffect, useRef, useState } from 'react'
import { useStore } from './store'
import { ipc, apiGet, apiPost } from './ipc'
import { TopBar } from './components/TopBar'
import { TargetPane } from './components/TargetPane'
import { Inspector } from './components/Inspector'
import { PagerControls } from './components/PagerControls'
import { EdgeNav } from './components/EdgeNav'
import { Toasts } from './components/Toasts'
import { TargetError } from './components/TargetError'
import { Gallery } from './components/Gallery'
import { A11yPanel } from './components/A11yPanel'
import { TokensPanel } from './components/TokensPanel'
import type { Detail, RelativeDir, RoutesInfo } from './protocol'
import { APP_ROUTES } from './appRoutes'

export function App() {
  const panelOpen = useStore((s) => s.panelOpen)
  const pager = useStore((s) => s.pager)
  const page = useStore((s) => s.page)
  const setPage = useStore((s) => s.setPage)
  const gallery = useStore((s) => s.gallery)
  const auditPanel = useStore((s) => s.auditPanel)
  const [drag, setDrag] = useState(0)

  useEffect(() => {
    apiGet('/config')
      .then((c) => useStore.getState().setTargetUrl(c.targetUrl))
      .catch(() => useStore.getState().setTargetUrl('http://localhost:5180/watch/app/'))
    apiGet('/mode')
      .then((m) => useStore.getState().setTargetMode(m.mode))
      .catch(() => useStore.getState().setTargetMode(null))
    // Live route catalog from the selected target's routes.ts. The parse only
    // covers NAV_DESTINATIONS (Primary) — keep the curated Secondary rows from
    // the static fallback. On any failure the picker keeps APP_ROUTES as-is.
    apiGet('/routes')
      .then((r) => {
        if (r.source === 'live' && r.routes?.length)
          useStore
            .getState()
            .setAppRoutes([...r.routes, ...APP_ROUTES.filter((x) => x.group === 'Secondary')])
      })
      .catch(() => {})
  }, [])

  // In LIVE mode, poll preflight so a dead backend shows on the mode pill
  // (red "backend down") instead of every click 502ing mysteriously.
  const targetMode = useStore((s) => s.targetMode)
  useEffect(() => {
    if (targetMode !== 'live') {
      useStore.getState().setBackendDown(false)
      return
    }
    let stop = false
    const check = () =>
      apiGet('/preflight')
        .then((p) => {
          if (stop) return
          const backend = (p.checks || []).find((c: { id: string; ok: boolean }) => c.id === 'backend')
          useStore.getState().setBackendDown(backend ? !backend.ok : false)
        })
        .catch(() => {})
    check()
    const t = window.setInterval(check, 6000)
    return () => {
      stop = true
      window.clearInterval(t)
    }
  }, [targetMode])

  const mode = useStore((s) => s.mode)
  useEffect(() => {
    ipc.send('setMode', { mode: mode === 'pick' ? 'pick' : 'interact' })
  }, [mode])

  // Tell the agent whether to capture two-finger swipes over the preview.
  useEffect(() => {
    ipc.send('setPager', { on: pager })
  }, [pager])

  // Central message handler from the in-page agent.
  useEffect(() => {
    const s = useStore.getState
    const off = ipc.on((msg) => {
      switch (msg.type) {
        case 'ready':
          s().setReady(true)
          if (msg.url) s().setCurrentUrl(msg.url)
          ipc.send('setMode', { mode: s().mode === 'pick' ? 'pick' : 'interact' })
          ipc.send('setPager', { on: s().pager })
          ipc.send('getTree', { max: 6000 })
          ipc.send('getRoutes', {})
          break
        case 'tree':
          s().setTree(msg.nodes || [])
          break
        case 'hover':
          if (s().mode !== 'theater') s().setHover(msg.box ? msg : null)
          break
        case 'selected': {
          const d = msg.detail as Detail
          s().setSelection(d)
          if (s().mode === 'theater') ipc.send('getChildren', { id: d.id })
          else {
            // Every selection — tree click, breadcrumb, keyboard nav, source
            // link — reveals the component in the app: scroll it into view
            // (the agent re-boxes it as it scrolls) and flash its outline, so
            // you see where it landed, as if you'd picked it in interact mode.
            ipc.send('scrollTo', { id: d.id })
            s().reveal()
          }
          break
        }
        case 'theater': {
          const d = msg.detail as Detail
          s().enterTheater()
          s().setSelection(d)
          ipc.send('getChildren', { id: d.id })
          break
        }
        case 'children':
          s().setDrillChildren(msg.items || [])
          break
        case 'boxes': {
          const cur = s()
          if (cur.drillChildren.length)
            cur.setDrillChildren(cur.drillChildren.map((c) => ({ ...c, box: msg.boxes[c.id] ?? c.box })))
          const sel = cur.selection
          if (sel && msg.boxes[sel.id]) cur.setSelection({ ...sel, box: msg.boxes[sel.id] })
          break
        }
        case 'swipe':
          if (s().pager) s().setPage(s().page + (msg.dir || 0))
          break
        case 'routes': {
          // Route catalog discovered from the target's live react-router fibers.
          // source:'none' (non-react-router app / detection failed) clears it so
          // the picker falls back to /api/routes then the static appRoutes.ts.
          const info = msg.detail as RoutesInfo
          s().setDiscovered(info && info.source === 'live' ? info : null)
          break
        }
        case 'navigated':
          s().toast('info', 'app navigated — refreshing tree')
          if (msg.url) s().setCurrentUrl(msg.url)
          s().setDrillChildren([])
          s().setAuditHighlight(null)
          // Prior audit results are stale after a route change; drop them.
          s().setA11y(null)
          s().setTokens(null)
          setTimeout(() => ipc.send('getTree', { max: 6000 }), 120)
          setTimeout(() => ipc.send('getRoutes', {}), 120)
          break
        case 'netreq': {
          // A fetch inside the target completed. Keep it for the Network tab
          // and forward it to the server ring buffer — the ide extension polls
          // GET /api/netlog to join ids against the backend's slog lines.
          const entry = {
            method: msg.method || 'GET',
            url: msg.url || '',
            status: msg.status || 0,
            ms: msg.ms ?? null,
            requestId: msg.requestId || null,
            clickGap: msg.clickGap ?? null,
            at: Date.now(),
          }
          s().pushNetRequest(entry)
          apiPost('/netlog', entry).catch(() => {})
          break
        }
        case 'a11y':
          s().setA11y(msg.result || { issues: [] })
          break
        case 'tokens':
          s().setTokens(msg.result || { tokens: 0, offenders: [] })
          break
        case 'error':
          s().toast('error', `${msg.cmd || ''}: ${msg.error}`)
          break
      }
    })
    return off
  }, [])

  // Parent-side two-finger swipe (fires when over the styles window / controls;
  // the preview iframe is handled by the agent).
  useEffect(() => {
    if (!pager) return
    let acc = 0
    let t: number | undefined
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
      acc += e.deltaX
      window.clearTimeout(t)
      t = window.setTimeout(() => (acc = 0), 180)
      if (Math.abs(acc) > 80) {
        const dir = acc > 0 ? 1 : -1
        acc = 0
        e.preventDefault()
        setPage(useStore.getState().page + dir)
      }
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => window.removeEventListener('wheel', onWheel)
  }, [pager, setPage])

  // Keyboard navigation of the recursive tree (+ pager paging with the panel open).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable || t.closest('.monaco-editor')))
        return
      const st = useStore.getState()
      const rel = (dir: RelativeDir) => {
        if (st.selection) {
          e.preventDefault()
          ipc.send('selectRelative', { id: st.selection.id, dir })
        }
      }
      switch (e.key) {
        case 'ArrowUp':
          rel('parent')
          break
        case 'ArrowDown':
          rel('child')
          break
        case 'ArrowLeft':
          if (st.pager) {
            e.preventDefault()
            st.setPage(st.page - 1)
          } else rel('prev')
          break
        case 'ArrowRight':
          if (st.pager) {
            e.preventDefault()
            st.setPage(st.page + 1)
          } else rel('next')
          break
        case 'Escape':
          if (st.auditPanel) {
            st.setAuditPanel(null)
            st.setAuditHighlight(null)
          } else if (st.gallery) st.toggleGallery()
          else if (st.pager) st.setPager(false)
          else if (st.fullScreen) st.setFullScreen(false)
          else if (st.mode === 'theater') st.exitTheater()
          else st.setMode('interact')
          break
        case 'p':
        case 'P':
          st.setMode(st.mode === 'pick' ? 'interact' : 'pick')
          break
        case 't':
        case 'T':
          st.openPanel('tree')
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const transform = `translateX(calc(${-page * 100}vw + ${drag}px))`

  return (
    <div className="app">
      {gallery ? (
        // Gallery replaces the normal single-viewport render + inspector.
        <Gallery />
      ) : (
        <>
          <div className={'surface' + (drag ? ' dragging' : '')} style={{ transform }}>
            <section className="screen preview">
              <TargetPane />
            </section>
            <section className="screen styles">{pager && <Inspector full />}</section>
          </div>
          {!pager && panelOpen && <Inspector />}
          {pager && <EdgeNav setDrag={setDrag} />}
          {pager && <PagerControls />}
        </>
      )}

      <TopBar />
      {auditPanel === 'a11y' && <A11yPanel />}
      {auditPanel === 'tokens' && <TokensPanel />}
      <TargetError />
      <Toasts />
    </div>
  )
}
