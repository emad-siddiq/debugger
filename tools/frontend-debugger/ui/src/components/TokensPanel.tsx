import { useStore } from '../store'
import { ipc } from '../ipc'
import type { TokenOffender } from '../protocol'

export function TokensPanel() {
  const result = useStore((s) => s.tokens)
  const setAuditPanel = useStore((s) => s.setAuditPanel)
  const setAuditHighlight = useStore((s) => s.setAuditHighlight)
  const toast = useStore((s) => s.toast)

  const offenders = result?.offenders || []

  const highlight = (o: TokenOffender) => {
    if (o.box) setAuditHighlight(o.box)
    else toast('info', 'no on-screen box for this element (off-viewport)')
  }

  const rerun = () => {
    setAuditHighlight(null)
    ipc.send('auditTokens', {})
  }

  const close = () => {
    setAuditPanel(null)
    setAuditHighlight(null)
  }

  return (
    <div className="audit-panel tokens-panel">
      <div className="audit-bar">
        <span className="audit-title">🎨 Design Tokens</span>
        <span className="audit-badge warn" title="offending declarations">
          {offenders.length}
        </span>
        <span className="spacer" />
        <button className="insp-btn" title="Re-run audit" onClick={rerun}>
          ⟳
        </button>
        <button className="insp-x" title="Close" onClick={close}>
          ✕
        </button>
      </div>

      <div className="audit-body">
        {!result ? (
          <div className="empty-tab small">Running audit…</div>
        ) : (
          <>
            <div className="audit-summary">
              <b>{result.tokens}</b> tokens defined · <b>{offenders.length}</b> offending declaration
              {offenders.length === 1 ? '' : 's'}
            </div>
            {offenders.length === 0 ? (
              <div className="empty-tab small">✓ No hardcoded colors bypassing tokens.</div>
            ) : (
              <div className="audit-group">
                {offenders.map((o, idx) => (
                  <button
                    key={idx}
                    className="audit-row token-row"
                    title="Highlight on the render"
                    onClick={() => highlight(o)}
                  >
                    <span className="token-prop">{o.property}</span>
                    <span className="token-swatch" style={{ background: o.usedValue }} />
                    <span className="token-val">{o.usedValue}</span>
                    {o.nearestToken && <span className="token-near">≈ {o.nearestToken}</span>}
                    <span className="audit-sel">{o.selector}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
