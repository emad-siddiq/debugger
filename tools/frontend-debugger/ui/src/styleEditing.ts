import { useStore, editKey, type StyleEdit } from './store'
import { ipc, apiGet, apiPost } from './ipc'
import type { Detail, MatchedRule } from './protocol'
import { effectiveDecls, pickOwnRule, provKey, suggestSelector } from './styleModel'

// ---------------------------------------------------------------------------
// One pipeline for every style control (panel fields, cascade inputs, spacing
// box, overrides): change → CSSOM live preview + pending edit in the store;
// explicit Save persists each edit into the file its provenance names.
// Preview never writes to disk (invariant: preview-not-save).
// ---------------------------------------------------------------------------

// Record + preview an edit against a KNOWN matched rule.
export function editRule(rule: MatchedRule, prop: string, value: string, original: string, existed: boolean) {
  const s = useStore.getState()
  const prov = s.provenance[provKey(rule.selectorText, rule.media)]
  const file = prov && prov.found ? prov.file : null
  const k = editKey(file, rule.selectorText, rule.media, prop)
  if (value === original) s.removeStyleEdit(k)
  else s.setStyleEdit(k, { selectorText: rule.selectorText, media: rule.media, prop, value, original, existed, file })
  ipc.send('previewRule', { selectorText: rule.selectorText, media: rule.media, prop, value })
}

// Edit a property "on the component": route to the rule that currently wins the
// cascade for it, else the component's own rule, else a fresh component-scoped
// rule (scaffolded on save via /css/ensure). Returns an error string when
// there's nothing to anchor a rule to.
export function editProp(detail: Detail, prop: string, value: string): string | null {
  const eff = effectiveDecls(detail).get(prop)
  if (eff) {
    editRule(eff.rule, prop, value, eff.value, true)
    return null
  }
  const own = pickOwnRule(detail, useStore.getState().provenance)
  if (own) {
    editRule(own, prop, value, '', false)
    return null
  }
  const selector = suggestSelector(detail)
  if (!selector) return 'no CSS rule matches this element and it has no class to anchor a new rule to'
  const s = useStore.getState()
  const k = editKey(null, selector, null, prop)
  if (value === '') s.removeStyleEdit(k)
  else s.setStyleEdit(k, { selectorText: selector, media: null, prop, value, original: '', existed: false, file: null, ensure: true })
  // The rule doesn't exist in the CSSOM yet — previewRule falls back to the
  // selected element's inline style, which Save-then-reselect clears.
  ipc.send('previewRule', { selectorText: selector, media: null, prop, value })
  return null
}

// "Override in component": copy a value (inherited from an ancestor, or set by
// a global/theme rule) into the component's OWN stratum — its most specific
// component-origin rule, else a fresh component-scoped rule on save.
export function localizeProp(detail: Detail, prop: string, value: string): string | null {
  const s = useStore.getState()
  const componentRules = detail.css.filter(
    (r) => !r.stateOnly && r.mediaActive && s.provenance[provKey(r.selectorText, r.media)]?.origin === 'component',
  )
  if (componentRules.length) {
    const rule = componentRules[componentRules.length - 1]
    const existing = rule.declarations.find((d) => d.prop === prop)
    editRule(rule, prop, value, existing ? existing.value : '', !!existing)
    return null
  }
  const selector = suggestSelector(detail)
  if (!selector) return 'no component rule to override into and no class to anchor a new one'
  const k = editKey(null, selector, null, prop)
  s.setStyleEdit(k, { selectorText: selector, media: null, prop, value, original: '', existed: false, file: null, ensure: true })
  ipc.send('previewRule', { selectorText: selector, media: null, prop, value })
  return null
}

export function revertEdit(e: StyleEdit) {
  ipc.send('previewRule', {
    selectorText: e.selectorText,
    media: e.media,
    prop: e.prop,
    value: e.existed ? e.original : '',
  })
  useStore.getState().removeStyleEdit(editKey(e.file, e.selectorText, e.media, e.prop))
}

export function revertAllEdits() {
  const s = useStore.getState()
  for (const e of Object.values(s.styleEdits)) {
    ipc.send('previewRule', {
      selectorText: e.selectorText,
      media: e.media,
      prop: e.prop,
      value: e.existed ? e.original : '',
    })
  }
  s.clearStyleEdits()
}

// Persist every pending edit. Unresolved files go through /css/locate, then
// /css/ensure (scaffolding <Component>.css + its import) as a last resort.
export async function saveAllEdits(detail: Detail | null): Promise<{ saved: number; files: string[] }> {
  const s = useStore.getState()
  const edits = Object.values(s.styleEdits)
  const files = new Set<string>()
  for (const e of edits) {
    let file = e.file
    if (!file) {
      const located = await apiGet(
        `/css/locate?selector=${encodeURIComponent(e.selectorText)}&media=${encodeURIComponent(e.media || '')}`,
      )
      if (located.found) file = located.file
      else if (detail?.source) {
        const ensured = await apiPost('/css/ensure', {
          componentFile: detail.source.file,
          selector: e.selectorText,
          media: e.media,
        })
        file = ensured.file
      } else {
        throw new Error(`no stylesheet defines ${e.selectorText} and the component has no source to scaffold beside`)
      }
    }
    await apiPost('/css/edit', { file, selector: e.selectorText, media: e.media, prop: e.prop, value: e.value })
    files.add(file!)
  }
  useStore.getState().clearStyleEdits()
  return { saved: edits.length, files: [...files] }
}
