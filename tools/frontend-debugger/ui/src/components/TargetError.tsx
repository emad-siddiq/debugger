import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { apiGet } from '../ipc'

interface Check {
  id: string
  ok: boolean
  detail: string
  remedy: string
}
interface Preflight {
  target: boolean
  targetError: string | null
  ok: boolean
  checks: Check[]
  remediation: string | null
}

// If the in-page agent never connects within a grace window AND preflight
// reports a real problem, show a centered card with the error + remediation.
// Dismissible, and it never appears when the target is actually fine (the agent
// connecting flips `ready` and unmounts the card).
const GRACE_MS = 6000

export function TargetError() {
  const ready = useStore((s) => s.ready)
  const [pre, setPre] = useState<Preflight | null>(null)
  const [dismissed, setDismissed] = useState(false)

  // Reset the dismissal if the agent drops again (e.g. after a reload).
  useEffect(() => {
    if (ready) setDismissed(false)
  }, [ready])

  useEffect(() => {
    if (ready) return
    let cancelled = false
    const t = window.setTimeout(() => {
      if (useStore.getState().ready) return
      apiGet<Preflight>('/preflight')
        .then((p) => {
          if (!cancelled) setPre(p)
        })
        .catch(() => {})
    }, GRACE_MS)
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [ready])

  if (ready || dismissed || !pre || pre.ok) return null

  const failed = pre.checks.filter((c) => !c.ok)
  const remedy = pre.remediation

  return (
    <div className="target-error-scrim">
      <div className="target-error-card" role="alertdialog" aria-label="target app failed to start">
        <div className="tec-head">
          <span className="tec-icon">⚠</span>
          <span className="tec-title">Target app didn’t start</span>
          <button className="tec-close" title="Dismiss" onClick={() => setDismissed(true)}>
            ✕
          </button>
        </div>
        {pre.targetError && <p className="tec-msg">{pre.targetError}</p>}
        {failed.length > 0 && (
          <ul className="tec-checks">
            {failed.map((c) => (
              <li key={c.id}>
                <span className="tec-x">✗</span> {c.id}
                <span className="tec-detail">{c.detail}</span>
              </li>
            ))}
          </ul>
        )}
        {remedy && (
          <div className="tec-remedy">
            <span className="tec-remedy-label">try</span>
            <code>{remedy}</code>
          </div>
        )}
        <p className="tec-hint">
          The debugger keeps trying to connect — this dismisses on its own once the target comes up.
        </p>
      </div>
    </div>
  )
}
