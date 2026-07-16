import { useStore } from '../store'

// Parse a width number out of a media query so we can jump the viewport to it.
function widthOf(media: string): number | null {
  const m = media.match(/(max|min)-width:\s*(\d+)px/)
  if (!m) return null
  const px = Number(m[2])
  // For max-width, sit 1px under so the rule is active; for min-width, sit on it.
  return m[1] === 'max' ? Math.max(320, px) : px
}

export function BreakpointsTab() {
  const selection = useStore((s) => s.selection)
  const setViewport = useStore((s) => s.setViewport)
  const viewport = useStore((s) => s.viewport)

  if (!selection) return <div className="empty-tab">Select a component to see the breakpoints that affect it.</div>

  // Media queries that actually carry rules matching the selected element.
  const matchedMedia = new Map<string, boolean>()
  for (const r of selection.css) {
    if (r.media) matchedMedia.set(r.media, r.mediaActive)
  }
  // All media queries present in the stylesheet (context).
  const allMedia = selection.allMedia || {}
  const allKeys = Object.keys(allMedia).sort((a, b) => {
    const wa = widthOf(a) ?? 99999
    const wb = widthOf(b) ?? 99999
    return wb - wa
  })

  return (
    <div className="breakpoints">
      <div className="bp-section">
        <h4>Affecting this component</h4>
        {matchedMedia.size === 0 && <div className="empty-tab small">No responsive rules match this element.</div>}
        {[...matchedMedia.entries()].map(([media, active]) => (
          <BpRow
            key={media}
            media={media}
            active={active}
            highlight
            onApply={() => {
              const w = widthOf(media)
              if (w) setViewport({ label: 'BP', w, h: viewport.h ?? 900 })
            }}
          />
        ))}
      </div>

      <div className="bp-section">
        <h4>All breakpoints in stylesheet</h4>
        {allKeys.map((media) => (
          <BpRow
            key={media}
            media={media}
            active={allMedia[media]}
            highlight={matchedMedia.has(media)}
            onApply={() => {
              const w = widthOf(media)
              if (w) setViewport({ label: 'BP', w, h: viewport.h ?? 900 })
            }}
          />
        ))}
      </div>
    </div>
  )
}

function BpRow({
  media,
  active,
  highlight,
  onApply,
}: {
  media: string
  active: boolean
  highlight?: boolean
  onApply: () => void
}) {
  const w = widthOf(media)
  return (
    <div className={'bp-row' + (highlight ? ' hl' : '')}>
      <span className={'bp-dot' + (active ? ' active' : '')} title={active ? 'currently matching' : 'inactive'} />
      <span className="bp-media">{media}</span>
      {w && (
        <button className="mini" onClick={onApply} title={`Set viewport width to ${w}px`}>
          → {w}px
        </button>
      )}
    </div>
  )
}
