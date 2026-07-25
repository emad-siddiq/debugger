# Frontend debugger → Burrow migration (task 15 / FD track) — overview

> Doc set: [01-move-tool](01-move-tool.md) · [02-bridge-and-fullscreen](02-bridge-and-fullscreen.md) ·
> [03-extension](03-extension.md) · [04-build-docs-ledger](04-build-docs-ledger.md) ·
> [05-debugger-cleanup](05-debugger-cleanup.md)

## Context

WO-00 decided the frontend debugger's future: **architecture A, "Embed + bridge"** — the
existing visual React debugger is hosted inside Burrow rather than rewritten against CDP.
The tool is a single Node process (deps: express, @babel/core, postcss) that serves its own
React SPA + `/api` on one port (`UI_PORT`, default 6080) and boots the *target* app's own Vite
in-process (`TARGET_PORT`, default 5180) with `agent/agent.js` injected and
`data-inspect-file/line/col` stamped on JSX by `server/inspectorPlugin.js`.

This migration goes further than embedding:

1. **`debugger/frontend/` moves into the burrow repo wholesale** — the same absorption pattern
   as the deleted `backend/`. Burrow is the surviving repo; the docker stack retires the
   `frontend` service.
2. The tool docks as an **editor-area WebviewPanel** in Burrow (media-preview pattern).
3. **Full reveal-in-editor bridge**: clicking a component or CSS rule in the tool opens the
   real file at line:col in Burrow's native editor (`showTextDocument`), replacing the
   embedded-Monaco-only reveal.
4. **Browser-like full-screen mode**: the target app fills the panel 1:1 (no device frame, no
   inspector chrome, slim auto-hide toolbar) with the editor group maximized — usable like a
   browser tab, because source viewing is now the IDE's job.

No launcher, no selection.json, no docker: the target project comes from the opened workspace
folder (or a setting), and "live" mode proxies to `http://localhost:8080` — the Go backend the
user is F5-debugging in the same Burrow window.

## What moves where

| Before | After |
| --- | --- |
| `debugger/frontend/` (compose service `frontend`) | `burrow/tools/frontend-debugger/` (spawned sidecar) |
| `frontend/Dockerfile`, `frontend/docker/` | deleted |
| Launcher `/config/selection.json` → target resolution | Burrow settings + workspace-folder auto-detect → `MERKLE_*` env |
| `NW_BACKEND_TARGET=http://ide:8080` (compose DNS) | default `http://localhost:8080` (Go backend under F5) |
| Launcher `POST /api/mode` forward → frontend | Burrow status-bar toggle → sidecar `POST /api/mode`; durable default = Burrow setting |
| Reveal → embedded Monaco `SourceTab` | Reveal → Burrow editor via `__fedbgHost` bridge (Monaco stays for standalone runs) |
| code-server ext `nodewatch.openFrontendDebugger` iframe (:6080) | `extensions/burrow-frontend-debugger` WebviewPanel, loopback origin, auto-picked ports |

## Binding decisions

- Tool lands at `burrow/tools/frontend-debugger/`, NOT under `extensions/`: burrow's hygiene
  gate lints all of `extensions/**` (tabs/copyright headers; the tool is 2-space header-less
  ESM), while `tools/` is exempt from hygiene, eslint, and the patch-ledger CORE check. The
  tool keeps its own npm/vite/oracle lifecycle.
- **Zero new core patches.** Only core-source touch: one line in
  `build/gulpfile.extensions.ts` (compilations array), covered by patch 0001's ledger entry.
- Bridge = two host message types over the webview shim: `openSource {file, line, col}` and
  `setFullScreen {on}`; envelope `{__fedbgHost: 1, type, ...}`. CSS reveals keep resolving
  SPA-side via existing `GET /api/css/locate`.
- The tool's oracle gate stays green: agent.js commands/events, express routes, and env
  name-sets are unchanged (counts 12 routes / 17 commands / 16 events / 16 env / 19 components).
- Sidecar: spawned by the extension (`process.execPath` + `ELECTRON_RUN_AS_NODE=1`,
  `NODE_ENV=production` serving built `ui/dist`), survives panel close, attaches to a dev-run
  instance if `/healthz` already answers, auto-picks free ports, logs to an OutputChannel,
  no auto-`npm install` (zero non-user-initiated network invariant).
- Burrow work on `main` (no branch creation/switching), no AI co-author trailers, commits only
  on explicit request — and staged selectively (uncommitted RD/WO-1 work coexists in the tree).

## Out of scope

- Packaging the tool into the .app (task 13). Dev-mode runs it from the repo tree.
- Aux-bar docking (RD / patch-0004 territory).
- The old `extension/` (code-server) frontend panel — left as-is; it 404s once the compose
  frontend service is gone.
- Multi-window sidecar sharing; auto-npm-install.

## Verification checklist

1. `cd burrow && npm run compile` → 0 errors; `node build/burrow/check-ledger.js` → OK; the
   only FD core-source diff is `build/gulpfile.extensions.ts`.
2. Tool gates from the new home: `npm run build && npm run oracle` → 0 FAIL.
3. Boot via burrow's launch skill with `~/Projects/merkle` open → "Burrow: Open Frontend
   Debugger" → sidecar healthz OK, panel renders the SPA.
4. Bridge round-trip: component → source chip → merkle `.tsx` opens Beside at stamped
   line:col; StylesTab rule → `src/index.css` at the postcss line. Embedded Inspector shows no
   Monaco Source tab.
5. Full-screen round-trip: toolbar toggle → editor group maximizes, target fills the panel 1:1;
   Esc restores layout and un-maximizes. Window resize tracks while full-screen.
6. Mode toggle with no backend: LIVE flip completes, preflight remediation card, degrades
   (502s) not crashes; MOCK recovers.
7. Lifecycle: panel close → sidecar survives; reopen → attach; Stop → child gone; port
   collision → auto-picked port.
8. Tool Playwright e2e (standalone): `UI_URL=http://localhost:6080 npm run verify`.
   Known issue (pre-existing, target drift): merkle's router no longer maps the boot base
   `/watch/app/` (its basename moved; live routes are `/validators`, `/fleet`, …), so the
   e2e's "Overview"-click checks fail on the boot 404 page → 5/6. The agent/tree/CSS checks
   all pass; fix belongs in the e2e / TARGET_BASE default, not the migration.
9. Debugger repo: `docker compose config -q`; `node launcher/test/verify.mjs`.
