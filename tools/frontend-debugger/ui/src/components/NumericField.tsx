import { useEffect, useRef, useState } from 'react'

// Figma-style numeric control: type a value, arrow-key it (Shift=±10, Alt=±0.1),
// scrub by dragging the label, wheel over the input, switch units. Emits every
// change through onChange → the shared live-preview pipeline.

const NUM_RE = /^(-?\d*\.?\d+)([a-z%]*)$/i

export function parseNumeric(v: string): { n: number; unit: string } | null {
  const m = NUM_RE.exec((v || '').trim())
  return m ? { n: parseFloat(m[1]), unit: m[2] } : null
}

const stepFor = (e: { shiftKey: boolean; altKey: boolean }, base: number) =>
  e.shiftKey ? base * 10 : e.altKey ? base / 10 : base

const fmt = (n: number) => String(Math.round(n * 100) / 100)

export function NumericField({
  value,
  onChange,
  units = ['px', 'rem', 'em', '%', 'vh', 'vw'],
  keywords = [],
  step = 1,
  min,
  max,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  units?: string[]
  keywords?: string[]
  step?: number
  min?: number
  max?: number
  placeholder?: string
}) {
  // Local text while focused so typing "1" on the way to "12px" doesn't fight
  // the round-tripped selection value.
  const [text, setText] = useState(value)
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    if (!focused) setText(value)
  }, [value, focused])

  const parsed = parseNumeric(text)
  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n))

  const nudge = (delta: number) => {
    const p = parseNumeric(text) || { n: 0, unit: units[0] || 'px' }
    const next = fmt(clamp(p.n + delta)) + p.unit
    setText(next)
    onChange(next)
  }

  const commit = (v: string) => {
    setText(v)
    onChange(v.trim())
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      nudge((e.key === 'ArrowUp' ? 1 : -1) * stepFor(e, step))
    }
  }

  const onWheel = (e: React.WheelEvent) => {
    if (!focused) return
    e.preventDefault()
    nudge((e.deltaY < 0 ? 1 : -1) * stepFor(e, step))
  }

  const setUnit = (unit: string) => {
    if (keywords.includes(unit)) return commit(unit)
    const p = parseNumeric(text)
    if (!p) return commit('0' + unit)
    // px↔rem conversion keeps the rendered size; other switches keep the number.
    let n = p.n
    if (p.unit === 'px' && unit === 'rem') n = p.n / 16
    else if (p.unit === 'rem' && unit === 'px') n = p.n * 16
    commit(fmt(n) + unit)
  }

  const unitShown = parsed ? parsed.unit || 'px' : text.trim() || '—'

  return (
    <span className="numfield">
      <input
        className="nf-in"
        value={text}
        placeholder={placeholder}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false)
          commit(text)
        }}
        onChange={(e) => commit(e.target.value)}
        onKeyDown={onKeyDown}
        onWheel={onWheel}
      />
      {(units.length > 0 || keywords.length > 0) && (
        <select
          className="nf-unit"
          value={units.concat(keywords).includes(unitShown) ? unitShown : ''}
          onChange={(e) => e.target.value && setUnit(e.target.value)}
          title="Unit"
        >
          {!units.concat(keywords).includes(unitShown) && <option value="">{unitShown}</option>}
          {units.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
          {keywords.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      )}
    </span>
  )
}

// A label that scrubs its field's value horizontally, pointer-locked like
// Figma/Blender. Wire it next to a NumericField sharing the same value/onChange.
export function ScrubLabel({
  label,
  value,
  onChange,
  step = 1,
  min,
  max,
  title,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  step?: number
  min?: number
  max?: number
  title?: string
}) {
  const start = useRef<{ x: number; n: number; unit: string } | null>(null)

  const onPointerDown = (e: React.PointerEvent) => {
    const p = parseNumeric(value) || { n: 0, unit: 'px' }
    start.current = { x: e.clientX, n: p.n, unit: p.unit || 'px' }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    e.preventDefault()
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!start.current) return
    const dx = e.clientX - start.current.x
    const scaled = start.current.n + dx * stepFor(e, step) * 0.5
    const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, scaled))
    onChange(fmt(clamped) + start.current.unit)
  }
  const onPointerUp = (e: React.PointerEvent) => {
    start.current = null
    ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
  }

  return (
    <span
      className="scrub-label"
      title={title || 'Drag to scrub · Shift=×10 · Alt=×0.1'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {label}
    </span>
  )
}
