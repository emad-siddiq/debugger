import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'

// Fixed NodeWatch responsive breakpoints for side-by-side comparison. These are
// the same edges the device picker exposes under "NodeWatch"; the gallery pins
// them so you can eyeball all three at once.
const FRAMES = [
  { name: 'Mobile', w: 375, h: 812 },
  { name: 'Tablet', w: 768, h: 1024 },
  { name: 'Desktop', w: 1280, h: 800 },
] as const

// A single labeled, scaled iframe column. The iframe renders at its logical
// WxH and is scaled down to fit the available column width (never scaled up).
function GalleryFrame({ name, w, h, url }: { name: string; w: number; h: number; url: string }) {
  const colRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)

  useEffect(() => {
    const el = colRef.current
    if (!el) return
    const fit = () => {
      const avail = el.clientWidth - 16 // column padding
      setScale(Math.min(avail / w, 1) || 1)
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [w])

  return (
    <div className="gallery-col" ref={colRef}>
      <div className="gallery-head">
        <span className="gh-name">{name}</span>
        <span className="gh-dim">
          {w} × {h}
        </span>
        <span className="gh-zoom">{Math.round(scale * 100)}%</span>
      </div>
      <div className="gallery-frame-wrap" style={{ width: w * scale, height: h * scale }}>
        <iframe
          className="gallery-frame"
          title={`${name} ${w}×${h}`}
          src={url || undefined}
          style={{ width: w, height: h, transform: `scale(${scale})`, transformOrigin: 'top left' }}
        />
      </div>
    </div>
  )
}

// Read-only, side-by-side render of the CURRENT route at three viewports. The
// gallery iframes load currentUrl — the target's LIVE route (tracked from the
// agent's ready/navigated events), not the stale boot URL — because navigation
// happens inside the primary iframe (location.assign) and never updates its src.
// They do NOT drive selection — they're for eyeballing responsive behavior only.
export function Gallery() {
  const currentUrl = useStore((s) => s.currentUrl || s.targetUrl)
  const toggleGallery = useStore((s) => s.toggleGallery)

  return (
    <div className="gallery">
      <div className="gallery-bar">
        <span className="gallery-title">🖼 Responsive Gallery</span>
        <span className="gallery-sub">current route · read-only</span>
        <span className="spacer" />
        <button className="btn ghost" title="Exit gallery (Esc)" onClick={toggleGallery}>
          ✕ close
        </button>
      </div>
      <div className="gallery-strip">
        {FRAMES.map((f) => (
          <GalleryFrame key={f.name} name={f.name} w={f.w} h={f.h} url={currentUrl} />
        ))}
      </div>
    </div>
  )
}
