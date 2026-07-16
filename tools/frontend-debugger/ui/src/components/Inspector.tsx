import { lazy, Suspense, useState } from 'react'
import { useStore, type Tab } from '../store'
import { ipc } from '../ipc'
import { embedded } from '../host'
import { Breadcrumb } from './Breadcrumb'
import { TreeTab } from './TreeTab'
import { StylesTab } from './StylesTab'
import { PropsTab } from './PropsTab'
import { BreakpointsTab } from './BreakpointsTab'
import { NetworkPanel } from './NetworkPanel'
import type { RelativeDir } from '../protocol'

// Lazy so Monaco (bundled by SourceTab) is a separate chunk fetched only when the
// Source tab is first opened — keeps the initial debugger load light.
const SourceTab = lazy(() => import('./SourceTab').then((m) => ({ default: m.SourceTab })))

const ALL_TABS: { id: Tab; label: string }[] = [
  { id: 'tree', label: 'Tree' },
  { id: 'styles', label: 'Styles' },
  { id: 'props', label: 'Props' },
  { id: 'breakpoints', label: 'Breakpoints' },
  { id: 'source', label: 'Source' },
  { id: 'network', label: 'Network' },
]
// Embedded in Burrow, source reveals open in the real editor — the Monaco tab
// is redundant chrome, so it's dropped from the strip (standalone keeps it).
const TABS = embedded ? ALL_TABS.filter((t) => t.id !== 'source') : ALL_TABS

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

export function Inspector({ full = false }: { full?: boolean }) {
  const selection = useStore((s) => s.selection)
  const activeTab = useStore((s) => s.activeTab)
  const setActiveTab = useStore((s) => s.setActiveTab)
  const panel = useStore((s) => s.panel)
  const setPanel = useStore((s) => s.setPanel)
  const closePanel = useStore((s) => s.closePanel)
  const setPager = useStore((s) => s.setPager)
  const [dragging, setDragging] = useState<null | 'move' | 'resize'>(null)

  const rel = (dir: RelativeDir) => selection && ipc.send('selectRelative', { id: selection.id, dir })

  const start = (kind: 'move' | 'resize') => (e: React.MouseEvent) => {
    if (full) return
    e.preventDefault()
    const p = useStore.getState().panel
    const op = { sx: e.clientX, sy: e.clientY, px: p.x, py: p.y, pw: p.w, ph: p.h }
    setDragging(kind)
    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - op.sx
      const dy = ev.clientY - op.sy
      if (kind === 'move')
        setPanel({ x: clamp(op.px + dx, 0, window.innerWidth - 140), y: clamp(op.py + dy, 0, window.innerHeight - 44) })
      else setPanel({ w: clamp(op.pw + dx, 320, window.innerWidth - 24), h: clamp(op.ph + dy, 240, window.innerHeight - 24) })
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.userSelect = ''
      setDragging(null)
    }
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const style = full ? undefined : { left: panel.x, top: panel.y, width: panel.w, height: panel.h }

  return (
    <div className={'inspector ' + (full ? 'fullscreen' : 'floating')} style={style}>
      {/* While dragging, a full-viewport shield keeps the target iframe from
          swallowing mousemove events — without it the drag stalls the instant the
          cursor crosses the embedded app. Mirrors TargetPane's .drag-capture. */}
      {dragging && <div className="insp-drag-shield" style={{ cursor: dragging === 'resize' ? 'nwse-resize' : 'move' }} />}
      <div className="insp-bar" onMouseDown={full ? undefined : start('move')}>
        {!full && <span className="insp-grip">⠿</span>}
        <span className="insp-bar-title">{selection ? selection.name : 'Components'}</span>
        <span className="spacer" />
        {full ? (
          <button
            className="insp-btn"
            title="Dock back to a floating panel"
            onClick={() => setPager(false)}
          >
            ⤡ dock
          </button>
        ) : (
          <>
            <button
              className="insp-btn"
              title="Full screen — swipe between preview and styles"
              onClick={() => setPager(true)}
              onMouseDown={(e) => e.stopPropagation()}
            >
              ⤢
            </button>
            <button
              className="insp-x"
              title="Close (re-opens on next selection)"
              onClick={closePanel}
              onMouseDown={(e) => e.stopPropagation()}
            >
              ✕
            </button>
          </>
        )}
      </div>

      <div className="insp-head">
        {selection ? (
          <>
            <div className="insp-title">
              <span className="comp-name">{selection.name}</span>
              {selection.tag && <span className="comp-tag">{'<' + selection.tag + '>'}</span>}
              {selection.source && (
                <span
                  className="comp-src link"
                  title={selection.source.file}
                  onClick={() =>
                    useStore.getState().openInSource(selection.source!.file, selection.source!.line, selection.source!.col)
                  }
                >
                  {selection.source.file.split('/').pop()}:{selection.source.line}
                </span>
              )}
            </div>
            <div className="nav-row">
              <div className="nav-group" role="group" aria-label="navigate">
                <button className="navbtn" title="Parent (↑)" onClick={() => rel('parent')}>
                  ↑
                </button>
                <button
                  className="navbtn"
                  title={`First child (↓)${selection.childCount ? ` · ${selection.childCount}` : ''}`}
                  onClick={() => rel('child')}
                  disabled={!selection.childCount}
                >
                  ↓{selection.childCount ? <sup>{selection.childCount}</sup> : null}
                </button>
                <button className="navbtn" title="Previous sibling (←)" onClick={() => rel('prev')}>
                  ‹
                </button>
                <button className="navbtn" title="Next sibling (→)" onClick={() => rel('next')}>
                  ›
                </button>
              </div>
              <button className="navbtn wide" title="Theater + drill" onClick={() => ipc.send('theater', { id: selection.id })}>
                🎬
              </button>
              <button className="navbtn wide" title="Scroll the app to this component" onClick={() => ipc.send('scrollTo', { id: selection.id })}>
                ⤓ reveal
              </button>
            </div>
            <Breadcrumb />
          </>
        ) : (
          <div className="muted small">No selection — browse the Tree below, or switch to Pick.</div>
        )}
      </div>

      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={'tab' + (activeTab === t.id ? ' active' : '')} onClick={() => setActiveTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="tab-body">
        {activeTab === 'tree' && <TreeTab />}
        {activeTab === 'styles' && <StylesTab />}
        {activeTab === 'props' && <PropsTab />}
        {activeTab === 'breakpoints' && <BreakpointsTab />}
        {activeTab === 'source' && (
          <Suspense fallback={<div className="empty-tab">Loading editor…</div>}>
            <SourceTab />
          </Suspense>
        )}
        {activeTab === 'network' && <NetworkPanel />}
      </div>

      {!full && <div className="insp-resize" onMouseDown={start('resize')} title="Resize" />}
    </div>
  )
}
