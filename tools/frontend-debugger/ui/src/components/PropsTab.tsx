import { useState } from 'react'
import { useStore } from '../store'
import type { HookEntry } from '../protocol'

// Renders a single value: primitives inline, arrays/objects as a collapsible
// subtree. The agent has already bounded depth/size, so this is pure display.
function JsonNode({ k, v, depth = 0 }: { k: string; v: unknown; depth?: number }) {
  const [open, setOpen] = useState(depth < 1)
  const t = typeof v
  const isArr = Array.isArray(v)
  const isObj = v !== null && t === 'object'

  if (!isObj) {
    return (
      <div className="jn leaf">
        <span className="jn-key">{k}</span>
        <span className="jn-colon">:</span>
        <span className={'jn-val ' + (v === null ? 'null' : t)}>{renderPrimitive(v)}</span>
      </div>
    )
  }

  const entries = isArr ? (v as unknown[]).map((x, i) => [String(i), x] as const) : Object.entries(v as object)
  const summary = isArr ? `Array(${entries.length})` : `{${entries.length}}`
  return (
    <div className="jn branch">
      <div className="jn-row" onClick={() => setOpen((o) => !o)}>
        <span className={'jn-tw' + (open ? ' open' : '')}>▸</span>
        <span className="jn-key">{k}</span>
        <span className="jn-colon">:</span>
        <span className="jn-summary">{summary}</span>
      </div>
      {open && (
        <div className="jn-children">
          {entries.map(([ck, cv]) => (
            <JsonNode key={ck} k={ck} v={cv} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

function renderPrimitive(v: unknown): string {
  if (v === null) return 'null'
  if (typeof v === 'string') return v.startsWith('«') ? v : JSON.stringify(v)
  return String(v)
}

function hookLabel(h: HookEntry): string {
  return `#${h.index} ${h.kind}`
}

export function PropsTab() {
  const selection = useStore((s) => s.selection)
  if (!selection) return <div className="empty-tab">Select a component to inspect its props & hooks.</div>

  const props = selection.props
  const hooks = selection.hooks
  const propKeys = props ? Object.keys(props) : []
  const isHost = !props || (propKeys.length === 0 && (!hooks || hooks.length === 0))

  return (
    <div className="props-tab">
      <section className="props-sec">
        <h4 className="sec-h">Props</h4>
        {propKeys.length === 0 ? (
          <div className="empty-tab small">
            {isHost ? 'Host element — no component props.' : 'No props on this component.'}
          </div>
        ) : (
          <div className="json-tree">
            {propKeys.map((k) => (
              <JsonNode key={k} k={k} v={props![k]} />
            ))}
          </div>
        )}
      </section>

      <section className="props-sec">
        <h4 className="sec-h">
          Hooks{hooks && hooks.length ? <span className="sec-count">{hooks.length}</span> : null}
        </h4>
        {!hooks || hooks.length === 0 ? (
          <div className="empty-tab small">No hooks (not a function component, or none used).</div>
        ) : (
          <div className="json-tree">
            {hooks.map((h) => (
              <JsonNode key={h.index} k={hookLabel(h)} v={h.value} />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
