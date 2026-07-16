# 15 — Frontend debugger: editor panel + sidecar

> Part of the [Go IDE overhaul](00-overview.md). Depends on: 01. Effort: ~1 wk (landed 2026-07-16).

## Goal

The standalone visual React component debugger (formerly `debugger/frontend/`,
a docker-compose service) becomes a first-class Burrow feature: the tool lives
at **`tools/frontend-debugger/`** in this repo, runs as a **Node sidecar**
spawned by the **`burrow-frontend-debugger`** built-in extension, renders in an
**editor-area WebviewPanel**, and — because the source code now lives in the
same window — bridges component/CSS reveals into the real editor and offers a
**browser-like full-screen mode** instead of relying on its embedded Monaco.

WO-00 decided the architecture (decision A, *embed + bridge*, over a CDP
rewrite): the tool's fiber-aware inspection, JSX `data-inspect-*` stamping, and
CSSOM style resolution are things CDP cannot see, and the SPA was already
iframe-hosted. The one-time move mechanics are recorded in
`debugger/docs/frontend-migration/` (the debugger checkout, outside this repo).

## What moves where

| Before (compose stack) | After (Burrow) |
|---|---|
| `debugger/frontend/` service `frontend` (:6080/:5180) | `tools/frontend-debugger/` sidecar, ports auto-picked on collision |
| Dockerfile, `docker/entrypoint.sh`, selection.json | deleted; settings `burrow.frontendDebugger.*` + workspace auto-detect → `MERKLE_*` env |
| `NW_BACKEND_TARGET=http://ide:8080` (compose DNS) | default `http://localhost:8080` — the Go backend under F5 |
| Launcher `POST /api/mode` forward | status-bar `FE:` pill → sidecar `POST /api/mode`; durable default = the `mode` setting |
| Reveal → embedded Monaco Source tab | Reveal → `showTextDocument` Beside at file:line:col (Monaco tab hidden when embedded, kept standalone) |
| code-server ext iframe panel (`nodewatch.openFrontendDebugger`) | `burrow.frontendDebugger.open` WebviewPanel |

## Design

### Sidecar lifecycle (`extensions/burrow-frontend-debugger/src/sidecar.ts`)

- One per window, owned by the extension, **survives panel close** (status bar
  + mode toggle stay live). Killed by `…stop` / `deactivate()`.
- Spawn: `process.execPath server/index.js` with `ELECTRON_RUN_AS_NODE=1`,
  `NODE_ENV=production` (serves the built `ui/dist`; no UI HMR in the webview).
  Env contract: `MERKLE_FRONTEND_DIR`, `MERKLE_REPO_ROOT`, `UI_PORT`,
  `TARGET_PORT`(+`_PUBLIC`), `TARGET_BASE`, `FRONTEND_MODE`,
  `NW_BACKEND_TARGET`; `SELECTION_FILE` is pointed at an inert tmp path so the
  tool's legacy launcher read stays dormant.
- **Attach before spawn**: if `GET 127.0.0.1:<uiPort>/healthz` already answers,
  reuse it — that is also the tool-dev loop (`npm run dev` in a terminal, then
  open the panel).
- Ports: probe the configured 6080/5180; taken → OS-assigned ephemeral.
- Health: poll `/healthz` every 500 ms, 60 s cap. `/healthz` is `ok:true` even
  when the *target* Vite failed — the SPA preflight overlay explains that case.
- **No auto-`npm install`** (zero non-user-initiated network): a preflight
  error names the bootstrap (`cd tools/frontend-debugger && npm install && npm
  run build`). `ui/dist` and `node_modules` are untracked.
- Crash → warning with a Restart action; no auto-restart loop. Logs → the
  "Frontend Debugger" output channel.

### Webview + host protocol (`src/panel.ts` ↔ `tools/frontend-debugger/ui/src/host.ts`)

- Singleton WebviewPanel, `enableScripts`, `retainContextWhenHidden`; CSP
  `default-src 'none'; frame-src <origin>; script-src 'nonce-…'`; the iframe
  loads `http://127.0.0.1:<uiPort>/?embed=burrow` **by full loopback origin —
  never `asExternalUri`** (a code-server-era rewrite that targets the wrong
  host).
- The SPA posts `{__fedbgHost: 1, type, …}` to `window.parent`; the nonce'd
  shim relays to the extension after an `e.origin` check. Two types:
  - **`openSource`** `{file, line, col?}` — file is frontendDir-relative
    (JSX coords from `data-inspect-file/line/col`; CSS lines from the existing
    SPA-side `GET /api/css/locate`). The extension re-validates the path
    against `targetDir` (no absolutes, no escapes — mirrors the sidecar's
    `safe()`), then `showTextDocument` Beside with the selection at line:col.
  - **`setFullScreen`** `{on}` — enter: `maximizeEditorHideSidebar` +
    `closePanel`; exit: unmaximize only when >1 editor group (the toggle is
    not precondition-guarded through `executeCommand`). Side bars stay hidden
    on exit — the workbench has no visibility query. Panel dispose restores.
- This channel is separate from the agent↔UI `__fedbg` protocol; the tool's
  oracle enforces only agent commands/events, which are unchanged.

### Full-screen browser view (tool-side, `ui/src/store.ts setFullScreen`)

⛶ in the toolbar (Esc exits): snapshots viewport + inspector state, switches to
the **Fit** viewport (pane-tracking 1:1, scale 1), hides the device-label
chrome and the floating Inspector, and — embedded — asks Burrow to maximize the
group. Combined with the SPA's existing auto-hide toolbar the target reads as a
browser tab. Exit restores the snapshot. Embedded also hides the Monaco Source
tab from the Inspector strip (reveals go to the editor); standalone keeps it.

### Layering

Layer 4 throughout: the extension is `extensions/burrow-frontend-debugger`
(zero npm deps, plain gulp/tsc), the tool is `tools/` (outside hygiene/eslint/
ledger CORE). The **only core-source touch** is its `compilations` line in
`build/gulpfile.extensions.ts`, covered by patch 0001's standing rule. The tool
keeps its own npm/vite lifecycle and its memory oracle
(`tools/frontend-debugger/.claude/` — `npm run oracle` must stay `0 FAIL`).

## Tasks

1. ✅ Import the tool (`debugger/frontend` → `tools/frontend-debugger`), drop
   docker bits, re-point the merkle fallback + backend default, oracle green.
2. ✅ Host bridge + full-screen in the SPA (`host.ts`, store routing, Fit
   viewport view, embedded Source-tab hiding, `data-inspect-col` in the agent's
   source payloads) + memory yamls.
3. ✅ `burrow-frontend-debugger` extension (config/sidecar/panel/status) +
   compilations line + patch-0001 amendment.
4. ☐ Task 13 packaging: ship the tool (with built `ui/dist` + pruned deps)
   inside the .app and re-point `toolPath`.

## Acceptance criteria

- `npm run compile` 0 errors; only core-source diff = `build/gulpfile.extensions.ts`.
- `tools/frontend-debugger`: `npm run build && npm run oracle` → `0 FAIL`.
- Open `~/Projects/merkle` → "Burrow: Open Frontend Debugger" → panel renders
  the SPA; sidecar healthz OK; logs in the output channel.
- Reveal round-trips: component source chip → merkle `.tsx` opens Beside at the
  stamped line:col; StylesTab rule → `src/index.css` at the postcss line.
  Embedded Inspector shows no Monaco Source tab.
- ⛶ full-screen: editor group maximizes, target fills the pane 1:1, Esc
  restores both; window resize tracks live.
- Mode pill flips mock↔live; live with no backend degrades to the preflight
  remediation card, never a crash.
- Lifecycle: panel close keeps the sidecar; reopen attaches; Stop kills the
  child; occupied 6080 → auto-picked port still works.

## Out of scope

- Packaging the tool into the .app (task 13) — dev-mode runs it from the repo tree.
- Auxiliary-bar docking (extensions can only declare activitybar/panel; the
  editor-tab shape fits the full-size SPA anyway).
- Multi-window sidecar sharing; auto-npm-install; restoring side-bar visibility
  on full-screen exit (no workbench API).
- The retired compose `frontend` service and the old code-server extension's
  frontend panel (404s until the stack dismantling finishes — task 14).
