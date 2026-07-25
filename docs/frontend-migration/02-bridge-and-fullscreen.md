# 02 — Host bridge + browser-like full-screen (tool side)

> Part of the [frontend migration](00-overview.md). All paths relative to
> `burrow/tools/frontend-debugger/`.

## Host protocol

The SPA is iframed by the Burrow webview with `?embed=burrow`. `window.parent` is the webview
shim page, which relays envelopes to the extension via `acquireVsCodeApi().postMessage`.

Envelope: `{ __fedbgHost: 1, type: string, ...payload }`. Two types:

| type | payload | extension action |
| --- | --- | --- |
| `openSource` | `file` (frontendDir-relative), `line` (1-based), `col?` (1-based) | `showTextDocument` Beside at the position |
| `setFullScreen` | `on: boolean` | maximize/restore the editor group |

`targetOrigin` is `'*'` — the `vscode-webview://` page origin is unknowable from inside the
iframe; payloads carry only target-relative paths + coords / a boolean, so leakage risk is nil.
This channel is distinct from the agent↔UI `__fedbg` protocol (agent.js is untouched).

## New `ui/src/host.ts`

```ts
const params = new URLSearchParams(window.location.search)
export const embedded = params.get('embed') === 'burrow'

function post(msg: Record<string, unknown>) {
  window.parent.postMessage({ __fedbgHost: 1, ...msg }, '*')
}
/** Reveal a target-relative file in the Burrow editor. Returns false when standalone. */
export function openInBurrow(file: string, line: number, col?: number): boolean {
  if (!embedded) return false
  post({ type: 'openSource', file, line, col: col ?? 1 })
  return true
}
/** Ask Burrow to maximize/restore the editor group around the panel. */
export function hostFullScreen(on: boolean): void {
  if (embedded) post({ type: 'setFullScreen', on })
}
```

## `ui/src/store.ts`

- `openInSource(file, line, col?)` — new optional `col`; routes: `if (openInBurrow(file, line,
  col)) return` (Burrow reveals; no tab switch) else the existing Monaco behavior
  (`activeTab: 'source'`, bump `openSource.nonce`).
- New state `fullScreen: boolean` (default `false`) + `setFullScreen(on)`:
  - calls `hostFullScreen(on)`;
  - entering: remembers current `panelOpen` and sets `panelOpen: false`;
  - leaving: restores the remembered `panelOpen`.

## Full-screen layout (browser view of the target)

- **`components/TargetPane.tsx`** — when `fullScreen`:
  - viewport tracks the pane 1:1: treat `vw = pane.w`, `vh = pane.h`, transform `scale(1)`
    with zero centering offset (bypass the fit math at the top of the `useMemo`);
  - hide the device frame chrome and the resize handles;
  - the existing pane resize observer (`setPane`) keeps reporting size, so the target iframe
    tracks live panel/window resizes.
- **`components/Toolbar.tsx`** — add a full-screen toggle button; while `fullScreen`, collapse
  the toolbar to a slim auto-hide strip (CSS hover/focus reveal) so the target reads as a
  browser tab.
- **`App.tsx`** — Esc exits full-screen: wire `setFullScreen(false)` into the existing global
  keydown handler (~:245, beside the theater-exit case). Inspector is already suppressed via
  `panelOpen`.
- **Embedded Source tab** — hide the Monaco `source` tab from the Inspector tab strip when
  `embedded` (source opens in the IDE). `SourceTab.tsx` keeps working for standalone runs and
  gains an "Open in Burrow" button in its src-bar when `embedded && file`.
- **`components/Inspector.tsx:115`** — pass the selection's stamped column as the third
  `openInSource` arg (field per `ui/src/protocol.ts` `Detail['source']`; the agent stamps
  `data-inspect-col`).
- **`StylesTab.tsx`** — unchanged: both reveal paths (:93, :177) route through `openInSource`,
  and CSS locate stays SPA-side via existing `GET /api/css/locate`.

## Oracle memory (same change)

Enforced name-sets are unchanged — routes 12 / commands 17 / events 16 / env 16 /
components 19; full-screen adds no agent command/event. Updates:

- `.claude/memory/components.yaml` — core-file row for `ui/src/host.ts` (existence-checked).
- `.claude/memory/protocol.yaml` — documented, non-enforced `host:` section (the oracle reads
  only `commands:`/`events:`): envelope `__fedbgHost:1`, `openSource`, `setFullScreen`.
- `.claude/memory/env.yaml` — reword `NW_BACKEND_TARGET` (default now `http://localhost:8080`)
  and `SELECTION_FILE` (legacy launcher path; inert under Burrow).
- `.claude/memory/repo.yaml` — `meta.updated_at`; header/apps rows (no longer Dockerized;
  spawned by burrow-frontend-debugger); decision row (moved into burrow/tools, host bridge,
  full-screen) and trap rows (`?embed=burrow` flag; ports auto-picked on collision; `ui/dist`
  must be built before the panel opens; full-screen hides Inspector + embedded Source tab).
- `.claude/memory/MEMORY.md` — snapshot paragraph.

Gate: `npm run build && npm run oracle` → 0 FAIL.
