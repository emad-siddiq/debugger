import { useMemo, useState } from 'react'
import { useStore } from '../store'
import type { Detail } from '../protocol'
import { effectiveDecls, targetFor, provKey, type ProvMap, type RuleProv } from '../styleModel'
import { editProp } from '../styleEditing'
import { ProvenanceChip } from './ProvenanceChip'
import { NumericField, ScrubLabel, parseNumeric } from './NumericField'
import { ColorField, contrastRatio } from './ColorField'

// ---------------------------------------------------------------------------
// The Figma-style design panel: sectioned controls over the selection's
// effective styles. Every row shows WHERE its value comes from (provenance
// chip → click to open the defining line) and edits flow through the shared
// preview→pending→save pipeline in styleEditing.ts.
// ---------------------------------------------------------------------------

interface Ctx {
  detail: Detail
  prov: ProvMap
  effective: ReturnType<typeof effectiveDecls>
  valueOf: (prop: string) => string
  provOf: (prop: string) => RuleProv | null
  change: (prop: string, value: string) => void
}

function useEditorCtx(): Ctx | null {
  const detail = useStore((s) => s.selection)
  const prov = useStore((s) => s.provenance)
  const styleEdits = useStore((s) => s.styleEdits)
  const toast = useStore((s) => s.toast)
  const effective = useMemo(() => (detail ? effectiveDecls(detail) : new Map()), [detail])
  if (!detail) return null
  const targetOf = (prop: string) => targetFor(detail, prov, effective, prop)
  const pendingFor = (prop: string) => {
    const t = targetOf(prop)
    return Object.values(styleEdits).find(
      (e) =>
        e.prop === prop &&
        (t.rule ? e.selectorText === t.rule.selectorText && e.media === t.rule.media : e.ensure),
    )
  }
  return {
    detail,
    prov,
    effective,
    valueOf: (prop) => pendingFor(prop)?.value ?? targetOf(prop).value,
    provOf: (prop) => {
      const t = targetOf(prop)
      return t.rule ? prov[provKey(t.rule.selectorText, t.rule.media)] || null : null
    },
    change: (prop, value) => {
      const err = editProp(detail, prop, value)
      if (err) toast('error', err)
    },
  }
}

function Section({ title, children, defaultOpen = true }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={'ed-sec' + (open ? ' open' : '')}>
      <button className="ed-sec-h" onClick={() => setOpen((o) => !o)}>
        <span className={'ed-tw' + (open ? ' open' : '')}>▸</span>
        {title}
      </button>
      {open && <div className="ed-sec-body">{children}</div>}
    </div>
  )
}

function Row({
  ctx,
  prop,
  label,
  children,
  scrub,
  step,
  min,
}: {
  ctx: Ctx
  prop: string
  label: string
  children: React.ReactNode
  scrub?: boolean
  step?: number
  min?: number
}) {
  return (
    <div className="ed-row">
      {scrub ? (
        <ScrubLabel label={label} value={ctx.valueOf(prop)} onChange={(v) => ctx.change(prop, v)} step={step} min={min} />
      ) : (
        <span className="ed-label">{label}</span>
      )}
      <span className="ed-control">{children}</span>
      <ProvenanceChip prov={ctx.provOf(prop)} />
    </div>
  )
}

function Num(ctx: Ctx, prop: string, label: string, opts: { step?: number; min?: number; max?: number; units?: string[]; keywords?: string[] } = {}) {
  return (
    <Row ctx={ctx} prop={prop} label={label} scrub step={opts.step} min={opts.min}>
      <NumericField
        value={ctx.valueOf(prop)}
        onChange={(v) => ctx.change(prop, v)}
        step={opts.step}
        min={opts.min}
        max={opts.max}
        units={opts.units}
        keywords={opts.keywords}
      />
    </Row>
  )
}

function Sel(ctx: Ctx, prop: string, label: string, options: string[]) {
  const cur = ctx.valueOf(prop)
  return (
    <Row ctx={ctx} prop={prop} label={label}>
      <select className="ed-select" value={options.includes(cur) ? cur : ''} onChange={(e) => ctx.change(prop, e.target.value)}>
        {!options.includes(cur) && <option value="">{cur || '—'}</option>}
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </Row>
  )
}

function Txt(ctx: Ctx, prop: string, label: string) {
  return (
    <Row ctx={ctx} prop={prop} label={label}>
      <input
        className="ed-text"
        value={ctx.valueOf(prop)}
        onChange={(e) => ctx.change(prop, e.target.value)}
        spellCheck={false}
      />
    </Row>
  )
}

function Segmented(ctx: Ctx, prop: string, label: string, options: { v: string; icon: string; title: string }[]) {
  const cur = ctx.valueOf(prop)
  return (
    <Row ctx={ctx} prop={prop} label={label}>
      <span className="ed-seg" role="group" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.v}
            className={'seg-btn' + (cur === o.v ? ' active' : '')}
            title={`${o.title} (${o.v})`}
            onClick={() => ctx.change(prop, o.v)}
          >
            {o.icon}
          </button>
        ))}
      </span>
    </Row>
  )
}

// Mini numeric input for the spacing box sides: type, arrow keys, wheel.
function MiniNum({ value, onChange, title }: { value: string; onChange: (v: string) => void; title: string }) {
  const shown = parseNumeric(value) ? String(parseNumeric(value)!.n) : value
  const nudge = (dir: number, e: { shiftKey: boolean; altKey: boolean }) => {
    const p = parseNumeric(value) || { n: 0, unit: 'px' }
    const step = e.shiftKey ? 10 : e.altKey ? 0.1 : 1
    onChange(Math.round((p.n + dir * step) * 100) / 100 + (p.unit || 'px'))
  }
  return (
    <input
      className="bm-in"
      value={shown}
      title={title}
      onChange={(e) => {
        const raw = e.target.value.trim()
        onChange(/^-?\d*\.?\d+$/.test(raw) ? raw + (parseNumeric(value)?.unit || 'px') : raw)
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault()
          nudge(e.key === 'ArrowUp' ? 1 : -1, e)
        }
      }}
      onWheel={(e) => {
        if (document.activeElement === e.currentTarget) {
          e.preventDefault()
          nudge(e.deltaY < 0 ? 1 : -1, e)
        }
      }}
    />
  )
}

// Interactive margin/padding box — the editable version of ComputedBoxView.
function SpacingBox({ ctx }: { ctx: Ctx }) {
  const c = ctx.detail.computed
  if (!c) return null
  const side = (kind: 'margin' | 'padding', which: 'top' | 'right' | 'bottom' | 'left') => {
    const prop = `${kind}-${which}`
    return <MiniNum value={ctx.valueOf(prop)} onChange={(v) => ctx.change(prop, v)} title={prop} />
  }
  return (
    <div className="ed-spacing">
      <div className="sp margin">
        <span className="sp-tag">margin</span>
        <span className="sp-v t">{side('margin', 'top')}</span>
        <span className="sp-v r">{side('margin', 'right')}</span>
        <span className="sp-v b">{side('margin', 'bottom')}</span>
        <span className="sp-v l">{side('margin', 'left')}</span>
        <div className="sp padding">
          <span className="sp-tag">padding</span>
          <span className="sp-v t">{side('padding', 'top')}</span>
          <span className="sp-v r">{side('padding', 'right')}</span>
          <span className="sp-v b">{side('padding', 'bottom')}</span>
          <span className="sp-v l">{side('padding', 'left')}</span>
          <div className="sp content" title="content box">
            {c.width} × {c.height}
          </div>
        </div>
      </div>
      <div className="ed-row sp-meta">
        <span className="ed-label">provenance</span>
        <span className="ed-control muted small">margin / padding</span>
        <span className="sp-chips">
          <ProvenanceChip prov={ctx.provOf('margin-top')} />
          <ProvenanceChip prov={ctx.provOf('padding-top')} />
        </span>
      </div>
    </div>
  )
}

function CornersSection({ ctx }: { ctx: Ctx }) {
  const [split, setSplit] = useState(false)
  return (
    <Section title="Corners" defaultOpen={false}>
      {!split ? (
        Num(ctx, 'border-radius', 'radius', { min: 0 })
      ) : (
        <>
          {Num(ctx, 'border-top-left-radius', '⌜', { min: 0 })}
          {Num(ctx, 'border-top-right-radius', '⌝', { min: 0 })}
          {Num(ctx, 'border-bottom-right-radius', '⌟', { min: 0 })}
          {Num(ctx, 'border-bottom-left-radius', '⌞', { min: 0 })}
        </>
      )}
      <button className="mini ed-split" onClick={() => setSplit((s) => !s)} title="Link / unlink corners">
        {split ? '⊡ link corners' : '⊞ per-corner'}
      </button>
    </Section>
  )
}

export function EditorPanel() {
  const ctx = useEditorCtx()
  if (!ctx) return null
  const display = ctx.valueOf('display')
  const position = ctx.valueOf('position')
  const isFlex = display.includes('flex')
  const isGrid = display.includes('grid')

  const color = ctx.valueOf('color')
  const bg = ctx.detail.computed?.background || ''
  const ratio = contrastRatio(color, bg)

  return (
    <div className="editor-panel">
      <Section title="Layout">
        {Sel(ctx, 'display', 'display', ['block', 'flex', 'grid', 'inline', 'inline-block', 'inline-flex', 'none'])}
        {Sel(ctx, 'position', 'position', ['static', 'relative', 'absolute', 'fixed', 'sticky'])}
        {position !== 'static' && position !== '' && (
          <>
            {Num(ctx, 'top', 'top', { keywords: ['auto'] })}
            {Num(ctx, 'right', 'right', { keywords: ['auto'] })}
            {Num(ctx, 'bottom', 'bottom', { keywords: ['auto'] })}
            {Num(ctx, 'left', 'left', { keywords: ['auto'] })}
            {Num(ctx, 'z-index', 'z-index', { units: [], keywords: ['auto'] })}
          </>
        )}
        {Sel(ctx, 'overflow-x', 'overflow', ['visible', 'hidden', 'auto', 'scroll'])}
      </Section>

      {(isFlex || isGrid) && (
        <Section title="Auto layout">
          {isFlex && (
            <>
              {Segmented(ctx, 'flex-direction', 'direction', [
                { v: 'row', icon: '→', title: 'row' },
                { v: 'column', icon: '↓', title: 'column' },
                { v: 'row-reverse', icon: '←', title: 'row-reverse' },
                { v: 'column-reverse', icon: '↑', title: 'column-reverse' },
              ])}
              {Sel(ctx, 'justify-content', 'justify', [
                'flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly',
              ])}
              {Sel(ctx, 'align-items', 'align', ['stretch', 'flex-start', 'center', 'flex-end', 'baseline'])}
              {Num(ctx, 'gap', 'gap', { min: 0 })}
              {Sel(ctx, 'flex-wrap', 'wrap', ['nowrap', 'wrap', 'wrap-reverse'])}
            </>
          )}
          {isGrid && (
            <>
              {Txt(ctx, 'grid-template-columns', 'columns')}
              {Txt(ctx, 'grid-template-rows', 'rows')}
              {Num(ctx, 'gap', 'gap', { min: 0 })}
            </>
          )}
        </Section>
      )}

      <Section title="As flex child" defaultOpen={false}>
        {Sel(ctx, 'align-self', 'align self', ['auto', 'stretch', 'flex-start', 'center', 'flex-end', 'baseline'])}
        {Num(ctx, 'flex-grow', 'grow', { units: [], min: 0 })}
        {Num(ctx, 'flex-shrink', 'shrink', { units: [], min: 0 })}
        {Num(ctx, 'flex-basis', 'basis', { keywords: ['auto'] })}
      </Section>

      <Section title="Spacing">
        <SpacingBox ctx={ctx} />
      </Section>

      <Section title="Size">
        {Num(ctx, 'width', 'W', { keywords: ['auto'] })}
        {Num(ctx, 'height', 'H', { keywords: ['auto'] })}
        {Num(ctx, 'min-width', 'min W', { keywords: ['auto'] })}
        {Num(ctx, 'min-height', 'min H', { keywords: ['auto'] })}
        {Num(ctx, 'max-width', 'max W', { keywords: ['none'] })}
        {Num(ctx, 'max-height', 'max H', { keywords: ['none'] })}
      </Section>

      <Section title="Fill">
        <Row ctx={ctx} prop="background-color" label="color">
          <ColorField value={ctx.valueOf('background-color')} onChange={(v) => ctx.change('background-color', v)} />
        </Row>
        {Txt(ctx, 'background-image', 'image')}
      </Section>

      <Section title="Stroke" defaultOpen={false}>
        {Num(ctx, 'border-width', 'width', { min: 0 })}
        {Sel(ctx, 'border-style', 'style', ['none', 'solid', 'dashed', 'dotted', 'double'])}
        <Row ctx={ctx} prop="border-color" label="color">
          <ColorField value={ctx.valueOf('border-color') || ctx.valueOf('border-top-color')} onChange={(v) => ctx.change('border-color', v)} />
        </Row>
        {Txt(ctx, 'outline', 'outline')}
      </Section>

      <CornersSection ctx={ctx} />

      <Section title="Effects" defaultOpen={false}>
        {Num(ctx, 'opacity', 'opacity', { units: [], step: 0.05, min: 0, max: 1 })}
        {Txt(ctx, 'box-shadow', 'shadow')}
        {Txt(ctx, 'filter', 'filter')}
        {Txt(ctx, 'backdrop-filter', 'backdrop')}
        {Txt(ctx, 'transform', 'transform')}
      </Section>

      <Section title="Typography">
        {Txt(ctx, 'font-family', 'family')}
        {Num(ctx, 'font-size', 'size', { min: 1 })}
        {Sel(ctx, 'font-weight', 'weight', ['100', '200', '300', '400', '500', '600', '700', '800', '900', 'normal', 'bold'])}
        {Num(ctx, 'line-height', 'line h', { keywords: ['normal'] })}
        {Num(ctx, 'letter-spacing', 'tracking', { step: 0.1, keywords: ['normal'] })}
        <Row ctx={ctx} prop="color" label="color">
          <ColorField value={color} onChange={(v) => ctx.change('color', v)} />
          {ratio !== null && (
            <span
              className={'contrast-badge ' + (ratio >= 7 ? 'aaa' : ratio >= 4.5 ? 'aa' : 'fail')}
              title={`Contrast vs background ${bg}: ${ratio.toFixed(2)}:1`}
            >
              {ratio.toFixed(1)} {ratio >= 7 ? 'AAA' : ratio >= 4.5 ? 'AA' : '✗'}
            </span>
          )}
        </Row>
        {Segmented(ctx, 'text-align', 'align', [
          { v: 'left', icon: '⇤', title: 'left' },
          { v: 'center', icon: '↔', title: 'center' },
          { v: 'right', icon: '⇥', title: 'right' },
          { v: 'justify', icon: '☰', title: 'justify' },
        ])}
        {Sel(ctx, 'text-transform', 'transform', ['none', 'uppercase', 'lowercase', 'capitalize'])}
        {Sel(ctx, 'text-decoration-line', 'decoration', ['none', 'underline', 'line-through', 'overline'])}
      </Section>
    </div>
  )
}
