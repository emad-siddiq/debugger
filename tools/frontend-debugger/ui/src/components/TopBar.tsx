import { useRef } from 'react'
import { useStore } from '../store'
import { Toolbar } from './Toolbar'

// The toolbar is hidden so the render owns the whole screen. Hold the mouse at
// the very top edge for a moment to reveal it; pin it to keep it open.
export function TopBar() {
  const visible = useStore((s) => s.toolbarVisible)
  const pinned = useStore((s) => s.toolbarPinned)
  const setVisible = useStore((s) => s.setToolbarVisible)
  const showTimer = useRef<number | undefined>(undefined)
  const hideTimer = useRef<number | undefined>(undefined)

  const show = () => {
    window.clearTimeout(hideTimer.current)
    setVisible(true)
  }
  const scheduleShow = (delay: number) => {
    window.clearTimeout(showTimer.current)
    showTimer.current = window.setTimeout(show, delay)
  }
  const cancelShow = () => window.clearTimeout(showTimer.current)
  const scheduleHide = () => {
    if (pinned) return
    hideTimer.current = window.setTimeout(() => setVisible(false), 450)
  }

  const open = visible || pinned

  return (
    <>
      <div
        className="top-hotzone"
        onMouseEnter={() => scheduleShow(280)}
        onMouseLeave={cancelShow}
      />
      <div className={'toolbar-host' + (open ? ' show' : '')} onMouseEnter={show} onMouseLeave={scheduleHide}>
        <Toolbar />
      </div>
      {!open && (
        <button
          className="top-grip"
          title="Show toolbar (or hover the top edge)"
          onMouseEnter={() => scheduleShow(160)}
          onMouseLeave={cancelShow}
          onClick={show}
        >
          ⋯
        </button>
      )}
    </>
  )
}
