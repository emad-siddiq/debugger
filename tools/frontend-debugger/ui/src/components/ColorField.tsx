import { useMemo } from 'react'
import { useStore } from '../store'

// Color control: swatch (native picker), raw text, and a design-token dropdown
// fed by the agent's tokenList — so a hard-coded color is one click away from
// becoming `var(--token)`. var() values resolve through the token catalog.

let ctx: CanvasRenderingContext2D | null | undefined
function normColor(v: string): string | null {
  if (ctx === undefined) ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return null
  try {
    ctx.fillStyle = '#000'
    ctx.fillStyle = v
    const a = ctx.fillStyle // hex for opaque, rgba() otherwise
    ctx.fillStyle = '#fff'
    ctx.fillStyle = v
    return a === ctx.fillStyle ? a : null // invalid values keep the sentinel
  } catch {
    return null
  }
}

function toHex(v: string): string | null {
  const n = normColor(v)
  if (!n) return null
  if (n.startsWith('#')) return n
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(n)
  if (!m) return null
  const h = (x: string) => (+x).toString(16).padStart(2, '0')
  return '#' + h(m[1]) + h(m[2]) + h(m[3])
}

const isColorish = (v: string) => normColor(v) !== null

function rgbOf(v: string): [number, number, number] | null {
  const hex = toHex(v)
  if (!hex) return null
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
}

// WCAG contrast ratio between two resolvable colors (null when either can't
// be parsed) — powers the AA/AAA badge on the Typography color row.
export function contrastRatio(a: string, b: string): number | null {
  const ra = rgbOf(a)
  const rb = rgbOf(b)
  if (!ra || !rb) return null
  const lum = (rgb: [number, number, number]) => {
    const [r, g, bl] = rgb.map((c) => {
      const s = c / 255
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl
  }
  const l1 = lum(ra)
  const l2 = lum(rb)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

export function ColorField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const tokenList = useStore((s) => s.tokenList)
  const varMatch = /^var\((--[\w-]+)\)?/.exec(value.trim())
  const tokenName = varMatch ? varMatch[1] : null
  const resolved = tokenName ? tokenList.find((t) => t.name === tokenName)?.value || '' : value
  const hex = toHex(resolved) || '#000000'

  const colorTokens = useMemo(() => tokenList.filter((t) => isColorish(t.value)), [tokenList])

  return (
    <span className="colorfield">
      <span className="cf-swatch-wrap" title={resolved || value}>
        <span className="cf-swatch" style={{ background: resolved || value }} />
        <input
          className="cf-picker"
          type="color"
          value={hex}
          onChange={(e) => onChange(e.target.value)}
          title="Pick a color"
        />
      </span>
      <input
        className="cf-text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="color"
        spellCheck={false}
      />
      {colorTokens.length > 0 && (
        <select
          className="cf-token"
          value={tokenName || ''}
          title="Use a design token"
          onChange={(e) => e.target.value && onChange(`var(${e.target.value})`)}
        >
          <option value="">var()</option>
          {colorTokens.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name}
            </option>
          ))}
        </select>
      )}
    </span>
  )
}
