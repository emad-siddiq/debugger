import { useState } from 'react'
import { useStore, editKey, type StyleEdit } from '../store'
import { ipc } from '../ipc'
import type { Detail, MatchedRule } from '../protocol'
import { declKey, loserKeys, provKey, type Origin } from '../styleModel'
import { editRule, localizeProp, revertAllEdits, revertEdit, saveAllEdits } from '../styleEditing'
import { EditorPanel } from './EditorPanel'
import { ProvenanceChip } from './ProvenanceChip'

// Styles tab = design panel (EditorPanel) + the truth underneath it: the raw
// cascade bucketed by origin stratum (component / theme / global), then the
// inherited section. Every edit anywhere flows through styleEditing.ts.

const STRATA: { origin: Origin; label: string; hint: string }[] = [
  { origin: 'component', label: 'Component styles', hint: "this component's own stylesheet" },
  { origin: 'theme', label: 'Theme / tokens', hint: 'theme-*.css & tokens — changing these affects every themed component' },
  { origin: 'global', label: 'Global styles', hint: 'app-wide stylesheets — changing these affects the whole app' },
  { origin: 'unknown', label: 'Other matched rules', hint: 'rules whose source file could not be located' },
]

export function StylesTab() {
  const selection = useStore((s) => s.selection)
  const styleEdits = useStore((s) => s.styleEdits)
  const provenance = useStore((s) => s.provenance)
  const openInSource = useStore((s) => s.openInSource)
  const toast = useStore((s) => s.toast)
  const [busy, setBusy] = useState(false)
  const [showCascade, setShowCascade] = useState(true)

  if (!selection) return <div className="empty-tab">Select a component to see its styles.</div>

  const editList = Object.values(styleEdits)
  const dirty = editList.length > 0
  const losers = loserKeys(selection)

  const saveAll = async () => {
    setBusy(true)
    try {
      const { saved, files } = await saveAllEdits(selection)
      toast('ok', `saved ${saved} change(s) → ${files.map((f) => f.split('/').pop()).join(', ')}`)
      setTimeout(() => ipc.send('select', { id: selection.id }), 350)
    } catch (err: any) {
      toast('error', 'save failed: ' + (err.message || err))
    } finally {
      setBusy(false)
    }
  }

  const discardAll = () => {
    revertAllEdits()
    toast('info', 'discarded live edits')
  }

  const byOrigin = (origin: Origin) =>
    selection.css.filter((r) => {
      const p = provenance[provKey(r.selectorText, r.media)]
      return (p?.origin || 'unknown') === origin
    })

  return (
    <div className="styles">
      {dirty && (
        <div className="preview-banner">
          <span className="pb-text">
            <b>{editList.length}</b> live edit{editList.length > 1 ? 's' : ''} — previewing, not saved
          </span>
          <button className="btn primary" disabled={busy} onClick={saveAll}>
            💾 Save
          </button>
          <button className="btn" disabled={busy} onClick={discardAll}>
            ↩ Discard
          </button>
        </div>
      )}

      <EditorPanel />

      <div className="cascade">
        <button className="ed-sec-h cascade-h" onClick={() => setShowCascade((v) => !v)}>
          <span className={'ed-tw' + (showCascade ? ' open' : '')}>▸</span>
          Cascade
          <span className="sec-count">{selection.css.length}</span>
        </button>
        {showCascade && (
          <>
            {!selection.css.length && <div className="empty-tab small">No matched CSS rules for this element.</div>}
            {STRATA.map(({ origin, label, hint }) => {
              const rules = byOrigin(origin)
              if (!rules.length) return null
              return (
                <div className={'stratum ' + origin} key={origin}>
                  <h4 className="sec-h" title={hint}>
                    {label}
                  </h4>
                  {rules.map((r, i) => (
                    <Rule key={i} selection={selection} r={r} styleEdits={styleEdits} losers={losers} warn={origin === 'global' || origin === 'theme'} />
                  ))}
                </div>
              )
            })}
          </>
        )}
      </div>

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
                    <ProvenanceChip prov={provenance[provKey(r.selectorText, r.media)] || null} />
                  </div>
                  {r.declarations.map((d, di) => (
                    <div className="decl inh" key={di}>
                      <span className="prop">{d.prop}</span>
                      <span className="colon">:</span>
                      <span className="val ro">{d.value}</span>
                      <button
                        className="override"
                        title="Override in this component's own stylesheet"
                        onClick={() => {
                          const err = localizeProp(selection, d.prop, d.value)
                          if (err) toast('error', err)
                          else toast('info', `override ${d.prop} → component styles (save to persist)`)
                        }}
                      >
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

function Rule({
  selection,
  r,
  styleEdits,
  losers,
  warn,
}: {
  selection: Detail
  r: MatchedRule
  styleEdits: Record<string, StyleEdit>
  losers: Set<string>
  warn: boolean
}) {
  const provenance = useStore((s) => s.provenance)
  const toast = useStore((s) => s.toast)
  const prov = provenance[provKey(r.selectorText, r.media)] || null
  const file = prov && prov.found ? prov.file : null
  return (
    <div className={'rule' + (r.stateOnly ? ' state' : '')}>
      <div className="rule-head">
        <span className="selector" title={r.selectorText}>
          {r.selectorText}
        </span>
        <div className="rule-tags">
          {r.media && <span className={'tag media' + (r.mediaActive ? ' active' : '')}>{r.media}</span>}
          {r.stateOnly && <span className="tag state">state</span>}
          <ProvenanceChip prov={prov} />
        </div>
      </div>
      <div className="decls">
        {r.declarations.map((d, j) => {
          const k = editKey(file, r.selectorText, r.media, d.prop)
          const edited = k in styleEdits
          const val = edited ? styleEdits[k].value : d.value
          const lost = losers.has(declKey(r.selectorText, r.media, d.prop))
          return (
            <div className={'decl' + (lost ? ' overridden' : '')} key={j}>
              <span className="prop">{d.prop}</span>
              <span className="colon">:</span>
              <input
                className={'val' + (edited ? ' edited' : '')}
                value={val}
                title={lost ? 'Overridden by a more specific rule' : undefined}
                onChange={(e) => editRule(r, d.prop, e.target.value, d.value, true)}
              />
              {d.important && <span className="imp">!</span>}
              {edited && (
                <button className="revert" title="revert this edit" onClick={() => revertEditByKey(styleEdits[k])}>
                  ↩
                </button>
              )}
              {lost && warn && (
                <button
                  className="override"
                  title="Copy into the component's own stylesheet instead"
                  onClick={() => {
                    const err = localizeProp(selection, d.prop, val)
                    if (err) toast('error', err)
                  }}
                >
                  localize
                </button>
              )}
            </div>
          )
        })}
        <AddDecl onAdd={(prop, value) => editRule(r, prop, value, '', false)} />
      </div>
    </div>
  )
}

const revertEditByKey = (e: StyleEdit) => revertEdit(e)

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
