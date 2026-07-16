import { useState } from 'react'
import { useStore, editKey, type StyleEdit } from '../store'
import { ipc, apiGet, apiPost } from '../ipc'
import type { MatchedRule } from '../protocol'

export function StylesTab() {
  const selection = useStore((s) => s.selection)
  const styleEdits = useStore((s) => s.styleEdits)
  const setStyleEdit = useStore((s) => s.setStyleEdit)
  const removeStyleEdit = useStore((s) => s.removeStyleEdit)
  const clearStyleEdits = useStore((s) => s.clearStyleEdits)
  const openInSource = useStore((s) => s.openInSource)
  const toast = useStore((s) => s.toast)
  const [busy, setBusy] = useState(false)

  if (!selection) return <div className="empty-tab">Select a component to see its styles.</div>

  const editList = Object.entries(styleEdits)
  const dirty = editList.length > 0

  // Live preview only — never writes to disk.
  const onEdit = (r: MatchedRule, prop: string, value: string, original: string, existed: boolean) => {
    const k = editKey(r.selectorText, r.media, prop)
    if (value === original) removeStyleEdit(k)
    else setStyleEdit(k, { selectorText: r.selectorText, media: r.media, prop, value, original, existed })
    ipc.send('previewRule', { selectorText: r.selectorText, media: r.media, prop, value })
  }

  const saveAll = async () => {
    setBusy(true)
    try {
      for (const [, e] of editList) {
        await apiPost('/css/edit', {
          file: 'src/index.css',
          selector: e.selectorText,
          media: e.media,
          prop: e.prop,
          value: e.value,
        })
      }
      toast('ok', `saved ${editList.length} change(s) → index.css`)
      clearStyleEdits()
      setTimeout(() => ipc.send('select', { id: selection.id }), 350)
    } catch (err: any) {
      toast('error', 'save failed: ' + (err.message || err))
    } finally {
      setBusy(false)
    }
  }

  const discardAll = () => {
    // Revert each live preview back to its original CSSOM value.
    for (const [, e] of editList) {
      ipc.send('previewRule', {
        selectorText: e.selectorText,
        media: e.media,
        prop: e.prop,
        value: e.existed ? e.original : '',
      })
    }
    clearStyleEdits()
    toast('info', 'discarded live edits')
  }

  const discardOne = (e: StyleEdit) => {
    ipc.send('previewRule', {
      selectorText: e.selectorText,
      media: e.media,
      prop: e.prop,
      value: e.existed ? e.original : '',
    })
    removeStyleEdit(editKey(e.selectorText, e.media, e.prop))
  }

  // Override an inherited property onto THIS element's most specific own rule
  // (live preview; persists on Save). No own rule → can't override into a file.
  const overrideProp = (prop: string, value: string) => {
    const own = selection.css[0]
    if (!own) {
      toast('error', 'no own rule to override into')
      return
    }
    const existing = own.declarations.find((d) => d.prop === prop)
    onEdit(own, prop, value, existing ? existing.value : '', !!existing)
    toast('info', `override ${prop} → ${own.selectorText}`)
  }

  const locate = async (r: MatchedRule) => {
    try {
      const res = await apiGet(
        `/css/locate?file=src/index.css&selector=${encodeURIComponent(r.selectorText)}&media=${encodeURIComponent(r.media || '')}`,
      )
      if (res.found && res.line) openInSource(res.file, res.line)
      else toast('error', 'rule not found under src/ stylesheets')
    } catch (err: any) {
      toast('error', 'locate failed: ' + (err.message || err))
    }
  }

  return (
    <div className="styles">
      {dirty && (
        <div className="preview-banner">
          <span className="pb-text">
            <b>{editList.length}</b> live edit{editList.length > 1 ? 's' : ''} — previewing, not saved
          </span>
          <button className="btn primary" disabled={busy} onClick={saveAll}>
            💾 Save to index.css
          </button>
          <button className="btn" disabled={busy} onClick={discardAll}>
            ↩ Discard
          </button>
        </div>
      )}

      <ComputedBoxView />

      {!selection.css.length && <div className="empty-tab small">No matched CSS rules for this element.</div>}

      {selection.css.map((r, i) => (
        <div className={'rule' + (r.stateOnly ? ' state' : '')} key={i}>
          <div className="rule-head">
            <span className="selector" title={r.selectorText}>
              {r.selectorText}
            </span>
            <div className="rule-tags">
              {r.media && (
                <span className={'tag media' + (r.mediaActive ? ' active' : '')}>{r.media}</span>
              )}
              {r.stateOnly && <span className="tag state">state</span>}
              <button className="mini" title="Open in index.css" onClick={() => locate(r)}>
                ↗
              </button>
            </div>
          </div>
          <div className="decls">
            {r.declarations.map((d, j) => {
              const k = editKey(r.selectorText, r.media, d.prop)
              const edited = k in styleEdits
              const val = edited ? styleEdits[k].value : d.value
              return (
                <div className="decl" key={j}>
                  <span className="prop">{d.prop}</span>
                  <span className="colon">:</span>
                  <input
                    className={'val' + (edited ? ' edited' : '')}
                    value={val}
                    onChange={(e) => onEdit(r, d.prop, e.target.value, d.value, true)}
                  />
                  {d.important && <span className="imp">!</span>}
                  {edited && (
                    <button className="revert" title="revert this edit" onClick={() => discardOne(styleEdits[k])}>
                      ↩
                    </button>
                  )}
                </div>
              )
            })}
            <AddDecl onAdd={(prop, value) => onEdit(r, prop, value, '', false)} />
          </div>
        </div>
      ))}

      {selection.inherited && selection.inherited.length > 0 && (
        <div className="inherited">
          <h4 className="sec-h">Inherited</h4>
          {selection.inherited.map((g, gi) => (
            <div className="inh-group" key={gi}>
              <div className="inh-head">
                <span className="inh-from">
                  from <b>{g.name}</b> <span className="inh-tag">{'<' + g.tag + '>'}</span>
                </span>
                {g.source && (
                  <button
                    className="mini"
                    title={'Open ' + g.source.file}
                    onClick={() => openInSource(g.source!.file, g.source!.line)}
                  >
                    {g.source.file.split('/').pop()}:{g.source.line} ↗
                  </button>
                )}
              </div>
              {g.rules.map((r, ri) => (
                <div className="inh-rule" key={ri}>
                  <div className="inh-sel">
                    <span className="selector">{r.selectorText}</span>
                    {r.media && <span className={'tag media' + (r.mediaActive ? ' active' : '')}>{r.media}</span>}
                  </div>
                  {r.declarations.map((d, di) => (
                    <div className="decl inh" key={di}>
                      <span className="prop">{d.prop}</span>
                      <span className="colon">:</span>
                      <span className="val ro">{d.value}</span>
                      <button className="override" title="Override on this element" onClick={() => overrideProp(d.prop, d.value)}>
                        override
                      </button>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function AddDecl({ onAdd }: { onAdd: (prop: string, value: string) => void }) {
  const [prop, setProp] = useState('')
  const [value, setValue] = useState('')
  const commit = () => {
    if (prop && value) {
      onAdd(prop.trim(), value.trim())
      setProp('')
      setValue('')
    }
  }
  return (
    <div className="decl add">
      <input className="prop-in" placeholder="add property" value={prop} onChange={(e) => setProp(e.target.value)} />
      <span className="colon">:</span>
      <input
        className="val"
        placeholder="value ⏎"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
    </div>
  )
}

function ComputedBoxView() {
  const selection = useStore((s) => s.selection)
  const box = selection?.computed
  if (!box) return null
  return (
    <div className="boxmodel">
      <div className="bm margin">
        <span className="bm-tag">margin</span>
        <span className="bm-v t">{box.margin[0]}</span>
        <span className="bm-v r">{box.margin[1]}</span>
        <span className="bm-v b">{box.margin[2]}</span>
        <span className="bm-v l">{box.margin[3]}</span>
        <div className="bm border">
          <span className="bm-tag">border</span>
          <div className="bm padding">
            <span className="bm-tag">padding</span>
            <span className="bm-v t">{box.padding[0]}</span>
            <span className="bm-v r">{box.padding[1]}</span>
            <span className="bm-v b">{box.padding[2]}</span>
            <span className="bm-v l">{box.padding[3]}</span>
            <div className="bm content">
              {box.width} × {box.height}
            </div>
          </div>
        </div>
      </div>
      <div className="bm-meta">
        <span>{box.display}</span>
        <span>{box.position}</span>
        <span className="swatch" style={{ background: box.background }} title={box.background} />
        <span className="swatch" style={{ background: box.color }} title={`color ${box.color}`} />
        <span className="fz">{box.fontSize}</span>
      </div>
    </div>
  )
}
