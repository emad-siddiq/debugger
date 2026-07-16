import { useStore } from '../store'
import { ipc } from '../ipc'

export function Breadcrumb() {
  const selection = useStore((s) => s.selection)
  if (!selection) return null
  const path = selection.path || []
  return (
    <div className="breadcrumb">
      {path.map((p, i) => (
        <span key={p.id + ':' + i}>
          {i > 0 && <span className="crumb-sep">›</span>}
          <button
            className={'crumb' + (p.id === selection.id ? ' active' : '')}
            onClick={() => ipc.send('select', { id: p.id })}
            title="Select this ancestor"
          >
            {p.name}
          </button>
        </span>
      ))}
    </div>
  )
}
