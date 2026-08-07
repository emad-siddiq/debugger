import type { Detail, MatchedRule } from './protocol'

// ---------------------------------------------------------------------------
// Pure cascade/provenance derivation for the editor panel. No React, no IO —
// the panel and StylesTab both lean on this, and it's directly testable.
//
// The agent reports matched rules in document order (matchedRulesFor walks
// document.styleSheets front to back), and CSSOM expands shorthands, so
// declarations arrive as longhands. Cascade resolution here is the pragmatic
// plain-CSS subset: !important beats normal, then selector specificity, then
// source order. Good for the target stack (plain .css files, no layers).
// ---------------------------------------------------------------------------

export type Origin = 'component' | 'theme' | 'global' | 'unknown'

export interface RuleProv {
  found: boolean
  file: string | null
  line: number | null
  origin: Origin
}

export type ProvMap = Record<string, RuleProv>

export const provKey = (selector: string, media: string | null) => `${selector}|${media || ''}`

export const declKey = (selector: string, media: string | null, prop: string) =>
  `${selector}|${media || ''}|${prop}`

// Specificity of one selector part (ids, classes/attrs/pseudo-classes,
// elements) packed into a single comparable number.
export function specificity(sel: string): number {
  const s = sel
    .replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, (m) => (m.startsWith('::') ? '~el~' : '~cls~'))
    .replace(/\[[^\]]*\]/g, '~cls~')
  const ids = (s.match(/#[\w-]+/g) || []).length
  const classes = (s.match(/\.[\w-]+|~cls~/g) || []).length
  const els = (s.match(/(^|[\s>+~(])[a-z][\w-]*|~el~/g) || []).length
  return ids * 1_000_000 + classes * 1_000 + els
}

export interface EffectiveDecl {
  prop: string
  value: string
  important: boolean
  rule: MatchedRule
}

const applies = (r: MatchedRule) => !r.stateOnly && r.mediaActive

// Winner per property across the matched rules.
export function effectiveDecls(detail: Detail): Map<string, EffectiveDecl> {
  const out = new Map<string, EffectiveDecl>()
  const rank = new Map<string, number>()
  detail.css.forEach((rule, index) => {
    if (!applies(rule)) return
    const spec = specificity(rule.selectorPart || rule.selectorText)
    for (const d of rule.declarations) {
      const score = (d.important ? 1_000_000_000 : 0) + spec + index / 1_000
      const prev = rank.get(d.prop)
      if (prev === undefined || score >= prev) {
        rank.set(d.prop, score)
        out.set(d.prop, { prop: d.prop, value: d.value, important: d.important, rule })
      }
    }
  })
  return out
}

// Declarations that LOST the cascade (rendered struck-through), keyed by
// declKey(selector, media, prop).
export function loserKeys(detail: Detail): Set<string> {
  const effective = effectiveDecls(detail)
  const losers = new Set<string>()
  for (const rule of detail.css) {
    if (!applies(rule)) continue
    for (const d of rule.declarations) {
      const win = effective.get(d.prop)
      if (win && win.rule !== rule) losers.add(declKey(rule.selectorText, rule.media, d.prop))
    }
  }
  return losers
}

// The value + defining rule behind one editor control.
export interface PropTarget {
  prop: string
  value: string
  rule: MatchedRule | null // null = nothing authored → computed fallback
  prov: RuleProv | null
}

export function targetFor(
  detail: Detail,
  prov: ProvMap,
  effective: Map<string, EffectiveDecl>,
  prop: string,
): PropTarget {
  const eff = effective.get(prop)
  if (eff) {
    return {
      prop,
      value: eff.value,
      rule: eff.rule,
      prov: prov[provKey(eff.rule.selectorText, eff.rule.media)] || null,
    }
  }
  return { prop, value: computedValue(detail, prop) || '', rule: null, prov: null }
}

// Computed fallback: the named ComputedBox fields plus the agent's extra map.
export function computedValue(detail: Detail, prop: string): string | null {
  const c = detail.computed
  if (!c) return null
  const named: Record<string, string | undefined> = {
    width: c.width,
    height: c.height,
    display: c.display,
    position: c.position,
    color: c.color,
    'background-color': c.background,
    'font-size': c.fontSize,
    'font-family': c.fontFamily,
    'margin-top': c.margin[0],
    'margin-right': c.margin[1],
    'margin-bottom': c.margin[2],
    'margin-left': c.margin[3],
    'padding-top': c.padding[0],
    'padding-right': c.padding[1],
    'padding-bottom': c.padding[2],
    'padding-left': c.padding[3],
    'border-top-width': c.border[0],
    'border-right-width': c.border[1],
    'border-bottom-width': c.border[2],
    'border-left-width': c.border[3],
  }
  if (named[prop] !== undefined) return named[prop]!
  return (c.extra && c.extra[prop]) ?? null
}

// The rule new component-scoped edits should land in: the most specific own
// rule whose provenance says "component", else the first applicable own rule.
export function pickOwnRule(detail: Detail, prov: ProvMap): MatchedRule | null {
  const usable = detail.css.filter(applies)
  const component = usable.filter((r) => prov[provKey(r.selectorText, r.media)]?.origin === 'component')
  const pool = component.length ? component : usable
  if (!pool.length) return null
  return pool.reduce((best, r) =>
    specificity(r.selectorPart || r.selectorText) >= specificity(best.selectorPart || best.selectorText) ? r : best,
  )
}

// Selector for a fresh component-scoped rule when nothing matches at all:
// the element's first class, or null when there's no class to anchor to.
export function suggestSelector(detail: Detail): string | null {
  const cls = (detail.className || '').trim().split(/\s+/).filter(Boolean)[0]
  return cls ? '.' + cls : null
}
