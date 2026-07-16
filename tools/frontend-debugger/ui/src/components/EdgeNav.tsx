import { useRef, useState } from 'react'
import { useStore } from '../store'

// Edge navigation for the pager: hold the mouse at a screen edge to reveal a
// click-arrow to the other window, and/or drag from the edge to swipe across.
// Only the edge that has a window to go to is active (so it never blocks the app
// on the other side).
export function EdgeNav({ setDrag }: { setDrag: (n: number) => void }) {
  const page = useStore((s) => s.page)
  const setPage = useStore((s) => s.setPage)
  const [show, setShow] = useState<'left' | 'right' | null>(null)
  const showTimer = useRef<number | undefined>(undefined)
  const draggingRef = useRef(false)

  const canPrev = page > 0
  const canNext = page < 1

  const enter = (side: 'left' | 'right') => () => {
    window.clearTimeout(showTimer.current)
    showTimer.current = window.setTimeout(() => setShow(side), 150)
  }
  const leave = () => {
    window.clearTimeout(showTimer.current)
    if (!draggingRef.current) setShow(null)
  }

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault()
    draggingRef.current = true
    const sx = e.clientX
    const move = (ev: MouseEvent) => setDrag(ev.clientX - sx)
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      draggingRef.current = false
      const dx = ev.clientX - sx
      const cur = useStore.getState().page
      if (dx > 60) setPage(cur - 1)
      else if (dx < -60) setPage(cur + 1)
      setDrag(0)
      setShow(null)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <>
      <div
        className={'edge-zone left' + (show === 'left' ? ' show' : '')}
        style={{ pointerEvents: canPrev ? 'auto' : 'none' }}
        onMouseEnter={canPrev ? enter('left') : undefined}
        onMouseLeave={leave}
        onMouseDown={canPrev ? startDrag : undefined}
      >
        {show === 'left' && canPrev && (
          <button
            className="edge-arrow"
            title="Preview window (←)"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => setPage(page - 1)}
          >
            ‹
          </button>
        )}
      </div>
      <div
        className={'edge-zone right' + (show === 'right' ? ' show' : '')}
        style={{ pointerEvents: canNext ? 'auto' : 'none' }}
        onMouseEnter={canNext ? enter('right') : undefined}
        onMouseLeave={leave}
        onMouseDown={canNext ? startDrag : undefined}
      >
        {show === 'right' && canNext && (
          <button
            className="edge-arrow"
            title="Styles window (→)"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => setPage(page + 1)}
          >
            ›
          </button>
        )}
      </div>
    </>
  )
}
