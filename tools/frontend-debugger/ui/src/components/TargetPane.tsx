import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { ipc } from '../ipc'
import { Overlay } from './Overlay'

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
type ResizeDir = 'e' | 's' | 'se'

export function TargetPane() {
  const targetUrl = useStore((s) => s.targetUrl)
  const viewport = useStore((s) => s.viewport)
  const orientation = useStore((s) => s.orientation)
  const setViewport = useStore((s) => s.setViewport)
  const toggleOrientation = useStore((s) => s.toggleOrientation)
  const pane = useStore((s) => s.pane)
  const setPane = useStore((s) => s.setPane)
  const ready = useStore((s) => s.ready)
  const mode = useStore((s) => s.mode)
  const autoZoom = useStore((s) => s.autoZoom)
  const selection = useStore((s) => s.selection)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ dir: ResizeDir; x: number; y: number; w: number; h: number; scale: number } | null>(null)
  const [resizing, setResizing] = useState(false)

  // Effective logical viewport (orientation swaps w/h; null = fill the stage).
  let bw = viewport.w
  let bh = viewport.h
  if (bw && bh && orientation === 'landscape') {
    bw = viewport.h
    bh = viewport.w
  }
  const fixed = bw != null
  const vw = bw ?? Math.max(320, Math.floor(pane.w))
  const vh = bh ?? Math.max(240, Math.floor(pane.h))

  useEffect(() => {
    if (!stageRef.current) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect
      setPane(r.width, r.height)
    })
    ro.observe(stageRef.current)
    return () => ro.disconnect()
  }, [setPane])

  const handshake = () => {
    ipc.setFrame(iframeRef.current?.contentWindow || null)
    ipc.send('hello', {})
  }
  const onLoad = () => {
    useStore.getState().setReady(false)
    handshake()
  }
  useEffect(() => {
    if (ready) return
    const t = setInterval(handshake, 700)
    return () => clearInterval(t)
  }, [ready])

  const { transform, scale, tx, ty } = useMemo(() => {
    const fit = Math.min(pane.w / vw, pane.h / vh, 1) || 1
    let s = fit
    let x = (pane.w - vw * fit) / 2
    let y = (pane.h - vh * fit) / 2
    if (mode === 'theater' && autoZoom && selection?.box && selection.box.width > 0) {
      const b = selection.box
      const pad = 28
      const z = clamp(Math.min(pane.w / (b.width + pad * 2), pane.h / (b.height + pad * 2)), 0.1, 4)
      s = z
      x = pane.w / 2 - (b.x + b.width / 2) * z
      y = pane.h / 2 - (b.y + b.height / 2) * z
    }
    return { transform: `translate(${x}px, ${y}px) scale(${s})`, scale: s, tx: x, ty: y }
  }, [pane.w, pane.h, vw, vh, mode, autoZoom, selection])

  // Re-box drill children while in theater (layout shifts not caught by scroll).
  useEffect(() => {
    if (mode !== 'theater') return
    const t = setInterval(() => {
      const st = useStore.getState()
      const ids = st.drillChildren.map((c) => c.id)
      const all = st.selection ? [st.selection.id, ...ids] : ids
      if (all.length) ipc.send('rebox', { ids: all })
    }, 800)
    return () => clearInterval(t)
  }, [mode])

  // --- resize handles ---
  const startResize = (dir: ResizeDir) => (e: React.MouseEvent) => {
    e.preventDefault()
    dragRef.current = { dir, x: e.clientX, y: e.clientY, w: vw, h: vh, scale }
    setResizing(true)
  }
  const onDragMove = (e: React.MouseEvent) => {
    const d = dragRef.current
    if (!d) return
    const dx = (e.clientX - d.x) / d.scale
    const dy = (e.clientY - d.y) / d.scale
    let w = d.w
    let h = d.h
    if (d.dir === 'e' || d.dir === 'se') w = Math.max(200, Math.round(d.w + dx))
    if (d.dir === 's' || d.dir === 'se') h = Math.max(200, Math.round(d.h + dy))
    // store in portrait orientation terms
    if (orientation === 'landscape') setViewport({ label: 'Responsive', w: h, h: w })
    else setViewport({ label: 'Responsive', w, h })
  }
  const endDrag = () => {
    dragRef.current = null
    setResizing(false)
  }

  const fullScreen = useStore((s) => s.fullScreen)
  const rectW = vw * scale
  const rectH = vh * scale
  // Full-screen is a pure browser view — no device label, no handles.
  const showChrome = mode !== 'theater' && !fullScreen

  return (
    <div className={'target-pane'}>
      <div className={'stage mode-' + mode} ref={stageRef}>
        <div
          className="viewport-wrap"
          style={{ width: vw, height: vh, transform, transformOrigin: 'top left' }}
        >
          <iframe
            ref={iframeRef}
            className="target-frame"
            src={targetUrl || undefined}
            onLoad={onLoad}
            style={{ width: vw, height: vh, pointerEvents: mode === 'theater' || resizing ? 'none' : 'auto' }}
          />
          <Overlay scale={scale} />
        </div>

        {/* Chrome layer (device label + resize handles), in unscaled stage space */}
        {showChrome && (
          <div className="chrome-layer" style={{ left: tx, top: ty, width: rectW, height: rectH }}>
            <div className="device-label">
              <span className="dl-name">{viewport.label}</span>
              <span className="dl-dim">
                {vw} × {vh}
              </span>
              <span className="dl-zoom">{Math.round(scale * 100)}%</span>
              {viewport.dpr ? <span className="dl-dpr">@{viewport.dpr}x</span> : null}
              {fixed && (
                <button className="dl-rotate" title="Rotate" onClick={toggleOrientation}>
                  {orientation === 'portrait' ? '⟳' : '⟲'}
                </button>
              )}
            </div>
            {fixed && (
              <>
                <div className="rh rh-e" onMouseDown={startResize('e')} />
                <div className="rh rh-s" onMouseDown={startResize('s')} />
                <div className="rh rh-se" onMouseDown={startResize('se')} />
              </>
            )}
          </div>
        )}

        {resizing && (
          <div className="drag-capture" onMouseMove={onDragMove} onMouseUp={endDrag} onMouseLeave={endDrag} />
        )}

        {!ready && (
          <div className="stage-loading">
            <div className="spinner" /> connecting to target app…
          </div>
        )}
      </div>
    </div>
  )
}
