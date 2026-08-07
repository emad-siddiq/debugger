import { useState } from 'react'
import { useStore } from '../store'
import { apiPost } from '../ipc'
import type { Detail, HookEntry } from '../protocol'

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

// A primitive prop is editable when we know the file that USES the component
// (the owner's stamped source) — the edit rewrites the literal at the
// `<Component …>` call site (POST /api/jsx/edit) and Vite Fast Refresh does
// the rest. Dynamic/ambiguous call sites come back as structured refusals.
function isEditable(selection: Detail, k: string, v: unknown): boolean {
  if (!selection.owner?.file) return false
  if (k === 'children') return typeof v === 'string' && !v.startsWith('«') && !v.startsWith('ƒ')
  const t = typeof v
  if (t === 'string') return !(v as string).startsWith('«') && !(v as string).startsWith('ƒ')
  return t === 'number' || t === 'boolean'
}

function PropEditor({ selection, k, v }: { selection: Detail; k: string; v: unknown }) {
  const toast = useStore((s) => s.toast)
  const openInSource = useStore((s) => s.openInSource)
  const [text, setText] = useState(String(v))
  const [busy, setBusy] = useState(false)

  const commit = async (next: string) => {
    if (next === String(v)) return
    setBusy(true)
    try {
      const body =
        k === 'children'
          ? { file: selection.owner!.file, component: selection.name, op: 'setText', text: next }
          : {
              file: selection.owner!.file,
              component: selection.name,
              op: 'setAttribute',
              name: k,
              value: next,
              kind: typeof v === 'string' ? 'string' : typeof v === 'number' ? 'number' : 'boolean',
            }
      const res = await apiPost('/jsx/edit', body)
      if (res.ok) toast('ok', `${k} saved → ${selection.owner!.file.split('/').pop()}`)
      else {
        toast('error', res.reason || 'edit refused')
        const line = res.candidates?.[0]?.line || selection.owner!.line
        openInSource(selection.owner!.file, line)
      }
    } catch (err: any) {
      toast('error', 'prop edit failed: ' + (err.message || err))
    } finally {
      setBusy(false)
    }
  }

  if (typeof v === 'boolean')
    return (
      <label className="jn leaf editable">
        <span className="jn-key">{k}</span>
        <span className="jn-colon">:</span>
        <input
          type="checkbox"
          className="prop-check"
          checked={text === 'true'}
          disabled={busy}
          onChange={(e) => {
            setText(String(e.target.checked))
            commit(String(e.target.checked))
          }}
        />
      </label>
    )

  return (
    <div className="jn leaf editable">
      <span className="jn-key">{k}</span>
      <span className="jn-colon">:</span>
      <input
        className={'prop-edit ' + typeof v}
        value={text}
        disabled={busy}
        spellCheck={false}
        title={`Saves to the <${selection.name}> call site in ${selection.owner!.file}`}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => commit(text)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit(text)
          if (e.key === 'Escape') setText(String(v))
        }}
      />
    </div>
  )
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
            {propKeys.map((k) =>
              isEditable(selection, k, props![k]) ? (
                <PropEditor key={k + String(props![k])} selection={selection} k={k} v={props![k]} />
              ) : (
                <JsonNode key={k} k={k} v={props![k]} />
              ),
            )}
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
