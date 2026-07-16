import { useStore } from '../store'

// Network tab: the fetches the in-page agent captured inside the target
// iframe, newest first. In LIVE mode each row carries the backend's
// X-Request-Id — the join key the ide extension's Request Trace panel uses to
// show the exact slog lines; here it's copyable for hand-grepping too.
export function NetworkPanel() {
  const netlog = useStore((s) => s.netlog)
  const targetMode = useStore((s) => s.targetMode)
  const clearNetlog = useStore((s) => s.clearNetlog)
  const toast = useStore((s) => s.toast)

  const copyId = (id: string) => {
    navigator.clipboard?.writeText(id).then(
      () => toast('ok', `request id copied: ${id}`),
      () => toast('error', 'clipboard unavailable'),
    )
  }

  return (
    <div className="network-panel">
      <div className="network-head">
        <span className="hint">
          {targetMode === 'live'
            ? 'live — ids join to backend slog lines (Request Trace in the ide)'
            : 'mock — devMock answers in-page; only fall-through requests appear here'}
        </span>
        <button className="btn ghost" onClick={clearNetlog} disabled={!netlog.length}>
          clear
        </button>
      </div>
      {netlog.length === 0 ? (
        <div className="network-empty">no requests captured yet — click around in the app</div>
      ) : (
        <ul className="network-list">
          {netlog.map((r, i) => (
            <li key={`${r.at}-${i}`} className="network-row">
              <span className="net-method">{r.method}</span>
              <span className={'net-status' + (r.status > 0 && r.status < 400 ? ' ok' : ' err')}>
                {r.status || '—'}
              </span>
              <span className="net-url" title={r.url}>
                {r.url}
              </span>
              <span className="net-meta">
                {r.ms != null ? `${r.ms}ms` : ''}
                {r.clickGap != null && r.clickGap < 3000 ? ` · +${r.clickGap}ms` : ''}
              </span>
              {r.requestId && (
                <button className="net-id" title="copy X-Request-Id" onClick={() => copyId(r.requestId!)}>
                  {r.requestId.slice(0, 8)}…
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
