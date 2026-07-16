import { useStore } from '../store'

export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={'toast ' + t.kind} onClick={() => dismiss(t.id)}>
          <span className="toast-dot" />
          <span className="toast-text">{t.text}</span>
        </div>
      ))}
    </div>
  )
}
