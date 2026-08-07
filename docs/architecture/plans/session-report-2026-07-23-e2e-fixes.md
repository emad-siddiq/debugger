# Session report — e2e IDE fixes (2026-07-22/23)

> Follow-up to `frontend-isolation-integration-recon.md`. This session fixed the
> isolation-preview crash and then swept every Burrow surface against
> `~/Projects/merkle` + its `infra/` stack. **Read "Why it may still look broken"
> first** — every fix is committed and was live-verified, but in fresh
> from-source instances, not the window you were using.

## ⚠️ Why it may still look broken for you

1. **Your running Burrow is the PACKAGED app and predates all fixes.** PID 12272
   is `.build/electron/Burrow — Go IDE.app`, launched **Jul 22 21:06** — before
   the first commit below (~22:5x). A packaged app bundles its own copies of
   `extensions/burrow-*`; relaunching it does NOT pick up source changes.
   **Fix: either `make dist` again (repackage), or run from sources
   (`make dev` / `scripts/code.sh` from a clean terminal).** The in-process FD
   sidecar on :6080/:5180 dies with that window, so a relaunch also refreshes
   `tools/frontend-debugger` (interpreted from source — those fixes apply on
   sidecar respawn regardless of packaging).
2. **Go debugging (dlv) cannot work on this Mac yet** — macOS Developer Mode is
   disabled, so Delve's debugserver hangs forever on task-port authorization.
   One-time fix: `sudo DevToolsSecurity -enable` (needs your password; nothing
   in-repo can do it). Until then burrow-go-debug fails fast with this exact
   message instead of hanging (commit `395ccb61`).

## Commits — burrow repo (`~/Projects/debugger/burrow`, branch `main`)

| Commit | What / why |
|---|---|
| `ce801004` | **fix(fedbg): isolation preview 404.** Gallery-click opened `/watch/app/__isolate` and merkle's own 404 route answered. The extension trusted its `targetBase` *setting* (stale default `/watch/app/`) while the sidecar serves merkle from `/` (post de-nesting). Now the sidecar is the source of truth: attach derives port+base from `GET /api/config`'s `targetUrl` (`sidecar.ts detectTarget`), spawn records its cfg; `extension.ts` passes `sidecar.targetBase` to `openIsolation`. Stale `/watch/app/` defaults → `/` in extension setting/config.ts and `server/config.js`; server's standalone `frontendDir` default now probes `<repo>/frontend` then `nodewatch/frontend`. FD memory env.yaml rows updated; oracle 0 FAIL. |
| `62f7de96` | **fix(gotest): Go test explorer was dead.** (a) Composite test-item ids embedded literal NUL bytes; vscode reserves `\0` in TestIds and threw on the first package — discovery failed in every Go workspace. Now explicit `ID_SEP = ''`. (b) `go test` ran from the workspace folder, but merkle's module is `backend/` → "cannot find main module" on every run. New `findModuleRoot()` walks up to the nearest `go.mod`. Verified: full backend package tree lists; `backend/internal/ttlcache` runs 4/4 PASS from the tree. |
| `395ccb61` | **fix(godebug): fail fast on disabled Developer Mode; surface dlv output.** Root-caused the infinite "backend (dlv)…" hang with a raw DAP probe (initialize ok, `launch` never answers, even hello-world). `resolveDebugConfiguration` now checks `/usr/sbin/DevToolsSecurity -status` (absolute path — /usr/sbin missing from exthost PATH) and cancels cleanly (`undefined` → `startDebugging` resolves false) with the actionable error. `dlv dap`'s post-banner stdout (the debuggee's output in server mode) now streams to a "Go Debug (dlv)" output channel. `BURROW_SKIP_DEVMODE_CHECK=1` bypasses after enabling. |
| `e42be155` | **feat(db): zero-config Postgres.** DB explorer had no connection source in a merkle window and the `pg` driver was never installed. New `workspaceDsn.ts`: third DSN precedence (setting → env → workspace) parsing `.vscode/launch.json` (JSONC-tolerant) for `DATABASE_URL` in env blocks then envFiles (`${workspaceFolder}` resolved); 6 unit tests. `pg@^8.22` now a real dependency. Verified: connects zero-config to infra's timescaledb, lists `public` (68 tables), `nodes` grid → 21 real rows / 8ms. |
| `7f4ea19d` | **feat(http): Postman → .http importer.** merkle documents its API as `infra/test/nodewatch.postman_collection.json` (56 requests) but the HTTP workbench only reads `.http`. New pure `postman.ts` converter (folders → `###` sections, `{{var}}` pass-through, env values → `@var` lines, disabled headers dropped) + `burrow.http.importPostman` command (auto-finds collection, pairs sibling environment, writes `<name>.http`). Round-trip tested through the real parser. Verified: import → 56 Send codelenses; workbench Send `GET {{baseUrl}}/healthz` → real backend JSON. |
| `2f3dc5cd` | **feat(fedbg): W6 surface defaults (recon §8).** `openMaximized` (default on): main panel maximizes editor area on open. `designLayout` (default on): isolation hides sidebar/aux-bar/panel after the 0.42/0.58 split — chrome-free source \| canvas, both columns visible. Cmd+B / Cmd+J restore. |

(Pre-session, also relevant: `cc6ecdfc` gallery, `9a4c6521` samples, `456e9809`
harness Router fix — the two recon defects were already fixed on disk when this
session started; the live failures were the ones above.)

## Commits — merkle repo (`~/Projects/merkle`)

| Commit | What / why |
|---|---|
| `eee86e9` | **fix(isolate): respect live mode.** `frontend/src/burrow.isolate.tsx` installed devMock unconditionally → isolated components always saw fixtures even in FD live mode. Now gated on main.tsx's DEV_MOCK logic (`VITE_DEV_MOCK==='1'`, or skip-auth without explicit `'0'`). Verified both ways (live isolation renders real Postgres incidents; mock still uses fixtures). Typecheck + css-architecture 38/38. |
| `98a9159` | **fix(escalation): `/api/incidents` 500 in Mode B.** Under `NODEWATCH_DEV_NO_AUTH` there is no caller identity; default `scope=mine` compared uuid columns against `""` (SQLSTATE 22P02) — guaranteed 500 (reproduced with curl). Empty userID now falls back to `scope=org`. go build + escalation tests pass; verified 200 after `./merkle --restart-api`. |

Untracked in merkle (intentional, commit if wanted): `infra/test/nodewatch.http`
(generated by the importer; re-import refreshes it).

## What was live-verified (fresh from-source instances, launch skill + playwright)

- **Components gallery → isolate**: App and IncidentsInbox render in the preview
  (styles, fixtures, no Router crash); design layout fills the window.
- **Live mode** (own sidecar :6180/:5280, `FRONTEND_MODE=live`): Vite proxy →
  real backend :8080; isolated IncidentsInbox renders **real incidents from
  Postgres**. Only expected no-auth 401s remain (`org/list`, `superadmin/me`,
  `favorites`).
- **Go Tests view**: full backend tree; ttlcache 4/4 PASS.
- **Database Explorer**: zero-config connect, schema tree, 21-row grid.
- **HTTP Workbench**: collection import + live send/response.
- **Docker view**: compose projects listed (`infra` 1/1 up) — worked as-is.
- **⚡ Debug Full Stack**: db leg healthy; backend leg now fails fast with the
  DevToolsSecurity error (was: infinite hang); frontend leg unreached until dev
  mode is enabled → **re-verify all three tiers after `sudo DevToolsSecurity
  -enable`**.

## Pick-up checklist (new conversation)

1. Quit the running packaged Burrow; `make dist` (or run from sources) and
   relaunch — otherwise you are testing pre-fix code.
2. Run `sudo DevToolsSecurity -enable`, then ⚡ Debug Full Stack → expect db +
   dlv-paused backend + FD live, and set a breakpoint in `router.go`.
3. Optionally commit merkle's generated `infra/test/nodewatch.http`.
4. Remaining large Burrow items: task 03 scheme bar, 04–06 depth (breakpoint
   matrix, right-hand inspector, visualizers), 12–14 (design/packaging/cutover).
5. Session transcript with full per-iteration reports:
   `~/Projects/debugger/.claude/docs/convos/2026/07/22/isolation-preview-404-targetbase-fix.md`.
