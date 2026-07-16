import { useStore } from '../store'
import { ipc } from '../ipc'
import type { A11yIssue } from '../protocol'

const RULE_LABEL: Record<string, string> = {
  contrast: 'Contrast',
  'img-alt': 'Image alt',
  'control-name': 'Control name',
  'form-label': 'Form label',
  'tap-target': 'Tap target',
}

export function A11yPanel() {
  const result = useStore((s) => s.a11y)
  const setAuditPanel = useStore((s) => s.setAuditPanel)
  const setAuditHighlight = useStore((s) => s.setAuditHighlight)
  const toast = useStore((s) => s.toast)

  const issues = result?.issues || []
  const errors = issues.filter((i) => i.severity === 'error')
  const warns = issues.filter((i) => i.severity === 'warn')

  const highlight = (i: A11yIssue) => {
    if (i.box) setAuditHighlight(i.box)
    else toast('info', 'no on-screen box for this issue (off-viewport)')
  }

  const rerun = () => {
    setAuditHighlight(null)
    ipc.send('auditA11y', {})
  }

  const close = () => {
    setAuditPanel(null)
    setAuditHighlight(null)
  }

  return (
    <div className="audit-panel a11y-panel">
      <div className="audit-bar">
        <span className="audit-title">♿ Accessibility</span>
        <span className="audit-badge err" title="errors">
          {errors.length}
        </span>
        <span className="audit-badge warn" title="warnings">
          {warns.length}
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
        ) : issues.length === 0 ? (
          <div className="empty-tab small">✓ No accessibility issues found (heuristic).</div>
        ) : (
          <>
            <Group label="Errors" items={errors} onPick={highlight} />
            <Group label="Warnings" items={warns} onPick={highlight} />
          </>
        )}
      </div>
    </div>
  )
}

function Group({ label, items, onPick }: { label: string; items: A11yIssue[]; onPick: (i: A11yIssue) => void }) {
  if (!items.length) return null
  return (
    <div className="audit-group">
      <div className="audit-group-h">
        {label} <span className="sec-count">{items.length}</span>
      </div>
      {items.map((i, idx) => (
        <button
          key={idx}
          className={'audit-row sev-' + i.severity}
          title="Highlight on the render"
          onClick={() => onPick(i)}
        >
          <span className="audit-rule">{RULE_LABEL[i.rule] || i.rule}</span>
          <span className="audit-msg">{i.message}</span>
          <span className="audit-sel">{i.selector}</span>
        </button>
      ))}
    </div>
  )
}
