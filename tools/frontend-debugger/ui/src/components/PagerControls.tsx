import { useStore } from '../store'

// Bottom-center indicator + arrows for the pager. Drag/swipe lives at the screen
// edges (EdgeNav); two-finger trackpad swipe and ←/→ also work.
export function PagerControls() {
  const page = useStore((s) => s.page)
  const setPage = useStore((s) => s.setPage)
  return (
    <div className="pager-controls">
      <button className="pgbtn" disabled={page <= 0} onClick={() => setPage(page - 1)} title="Preview (←)">
        ‹
      </button>
      <div className="pager-ind">
        <span className={'pgdot' + (page === 0 ? ' on' : '')} />
        <span className="pglabel">{page === 0 ? 'Preview' : 'Styles'}</span>
        <span className={'pgdot' + (page === 1 ? ' on' : '')} />
      </div>
      <button className="pgbtn" disabled={page >= 1} onClick={() => setPage(page + 1)} title="Styles (→)">
        ›
      </button>
    </div>
  )
}
