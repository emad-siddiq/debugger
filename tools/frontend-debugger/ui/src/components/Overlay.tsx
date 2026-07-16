import { useStore } from '../store'
import { ipc } from '../ipc'
import type { Box } from '../protocol'

function boxStyle(b: Box): React.CSSProperties {
  return { left: b.x, top: b.y, width: b.width, height: b.height }
}

export function Overlay({ scale }: { scale: number }) {
  const mode = useStore((s) => s.mode)
  const hover = useStore((s) => s.hover)
  const selection = useStore((s) => s.selection)
  const revealNonce = useStore((s) => s.revealNonce)
  const drillChildren = useStore((s) => s.drillChildren)
  const auditHighlight = useStore((s) => s.auditHighlight)
  const inv = 1 / (scale || 1)

  // Audit-panel highlight: a distinct outline drawn in any mode, so clicking an
  // a11y issue / token offender pinpoints its element on the render.
  const auditBox = auditHighlight ? <div className="ov-box audit" style={boxStyle(auditHighlight)} /> : null

  // A one-shot pulse on every selection so you can see where it landed after the
  // app scrolls to it. Keyed by revealNonce → React remounts it, replaying the
  // animation; it fades to nothing, leaving the steady-state selection outline.
  const flashBox =
    selection?.box && (mode === 'interact' || mode === 'pick') ? (
      <div key={revealNonce} className="ov-box reveal-flash" style={boxStyle(selection.box)} />
    ) : null

  // Interact: never block the app; only show a faint outline of the current
  // selection so you keep your bearings while navigating.
  if (mode === 'interact') {
    return (
      <div className="overlay" style={{ pointerEvents: 'none' }}>
        {selection?.box && <div className="ov-box selected faint" style={boxStyle(selection.box)} />}
        {flashBox}
        {hover?.box && (
          <div className="ov-box hover" style={boxStyle(hover.box)}>
            <span className="ov-label" style={{ transform: `scale(${inv})` }}>
              {hover.name}
            </span>
          </div>
        )}
        {auditBox}
      </div>
    )
  }

  if (mode === 'pick') {
    return (
      <div className="overlay" style={{ pointerEvents: 'none' }}>
        {hover?.box && (
          <div className="ov-box hover" style={boxStyle(hover.box)}>
            <span className="ov-label" style={{ transform: `scale(${inv})` }}>
              {hover.nameChain && hover.nameChain.length > 1 && (
                <span className="ov-chain">{hover.nameChain.slice(0, -1).join(' › ')} › </span>
              )}
              {hover.name}
            </span>
          </div>
        )}
        {selection?.box && <div className="ov-box selected" style={boxStyle(selection.box)} />}
        {flashBox}
        {auditBox}
      </div>
    )
  }

  // Theater
  return (
    <div className="overlay theater" style={{ pointerEvents: 'auto' }}>
      <div
        className="ov-backdrop"
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      />
      {selection?.box && <div className="ov-spotlight" style={boxStyle(selection.box)} />}
      {selection?.box && (
        <div className="ov-box focused" style={boxStyle(selection.box)}>
          <span className="ov-label focused" style={{ transform: `scale(${inv})` }}>
            {selection.name}
          </span>
        </div>
      )}
      {drillChildren.map((c) =>
        c.box ? (
          <button
            key={c.id}
            className="ov-child"
            style={boxStyle(c.box)}
            onClick={(e) => {
              e.stopPropagation()
              ipc.send('select', { id: c.id })
            }}
            title={`Drill into ${c.name}`}
          >
            <span className="ov-label child" style={{ transform: `scale(${inv})` }}>
              {c.name}
            </span>
          </button>
        ) : null,
      )}
      {!drillChildren.length && selection && (
        <div className="ov-leaf-hint" style={{ transform: `scale(${inv})` }}>
          leaf — no child components (↑ for parent)
        </div>
      )}
    </div>
  )
}
