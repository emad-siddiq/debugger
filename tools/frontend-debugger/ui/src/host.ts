// Burrow host bridge. When the SPA runs inside a Burrow webview it is iframed
// with ?embed=burrow; window.parent is the webview shim page, which relays
// __fedbgHost envelopes to the burrow-frontend-debugger extension over
// acquireVsCodeApi(). Standalone (no ?embed=burrow) every call is a no-op, so
// callers can invoke unconditionally. This channel is separate from the
// agent↔UI __fedbg protocol — agent.js knows nothing about it.

const params = new URLSearchParams(window.location.search)

export const embedded = params.get('embed') === 'burrow'

function post(msg: Record<string, unknown>) {
  // targetOrigin '*': the vscode-webview:// page origin is unknowable from
  // here; payloads carry only target-relative paths + coords / a boolean.
  window.parent.postMessage({ __fedbgHost: 1, ...msg }, '*')
}

/** Reveal a target-relative file at line:col in the Burrow editor. Returns
 *  false when standalone so the caller can fall back to the Monaco tab. */
export function openInBurrow(file: string, line: number, col?: number | null): boolean {
  if (!embedded) return false
  post({ type: 'openSource', file, line, col: col || 1 })
  return true
}

/** Ask Burrow to maximize/restore the editor group around the panel. */
export function hostFullScreen(on: boolean): void {
  if (embedded) post({ type: 'setFullScreen', on })
}

/** Open the component-isolation workbench in Burrow: the component's real source
 *  on the left, a live isolated preview beside it. Returns false when standalone
 *  so the caller can fall back to opening the harness page in a new tab. */
export function isolateInBurrow(file: string, exportName: string | null, props: unknown): boolean {
  if (!embedded) return false
  post({ type: 'openIsolation', file, export: exportName || undefined, props })
  return true
}
