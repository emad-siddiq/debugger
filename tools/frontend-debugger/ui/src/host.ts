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

// Esc bridge (Burrow docs/plans/01 §4). The SPA owns the focused document, so
// Escape never reaches the IDE's keybindings; report it up and the extension
// exits Focus Mode — the same single-Escape exit an editor gives you. Standalone
// this listener is never installed, so browser use is unaffected.
if (embedded) {
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') post({ type: 'exitFocus' })
  })
}

/** Open the component-isolation workbench in Burrow: the component's real source
 *  on the left, a live isolated preview beside it. Returns false when standalone
 *  so the caller can fall back to opening the harness page in a new tab. */
export function isolateInBurrow(file: string, exportName: string | null, props: unknown): boolean {
  if (!embedded) return false
  post({ type: 'openIsolation', file, export: exportName || undefined, props })
  return true
}

// --- Host → SPA commands (__fedbgCmd envelopes) ----------------------------
// The reverse direction: the extension posts `{__fedbgCmd:1, type, …}` to the
// panel webview and the shim relays it into this iframe ("Show in App" from
// the Components tree / isolation preview). Handlers register here (App.tsx)
// — this module stays store-free to avoid an import cycle with store.ts.

type HostCmdHandler = (msg: Record<string, unknown> & { type: string }) => void
const cmdHandlers = new Set<HostCmdHandler>()

if (embedded) {
  window.addEventListener('message', (e: MessageEvent) => {
    const d = e.data
    if (!d || d.__fedbgCmd !== 1 || typeof d.type !== 'string') return
    cmdHandlers.forEach((h) => h(d))
  })
}

export function onHostCommand(h: HostCmdHandler): () => void {
  cmdHandlers.add(h)
  return () => {
    cmdHandlers.delete(h)
  }
}

/** Several routes render the component — ask the extension to QuickPick one.
 *  It answers by re-posting `showInApp` with the chosen `route`. */
export function askRouteChoice(
  file: string,
  name: string | null,
  choices: { path: string; label: string; name: string | null }[],
): void {
  if (embedded) post({ type: 'routeChoices', file, name, choices })
}
