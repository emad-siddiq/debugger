# Task 14 — implementation plan

> Task 14: Retire the ide container — port launcher/digest/extension to Burrow-on-host

Build-ready plan from the parallel planning pass (ultracode run), grounded in the current tree.

## Layer breakdown

CONFIG (layer 1, burrow): no product.json change needed — `urlProtocol: "burrow"` already present (product.json:36, task 01 done). Only build-wiring: append `extensions/burrow-nodewatch/tsconfig.json` to the curated compile list in build/gulpfile.extensions.ts (the list patch 0001 governs). Editing build/ nominally needs a ledger touch, but it extends the existing 0001 mechanism, not a new patch — update 0001's ledger row/note rather than mint 0009.

CORE-PATCH-WITH-LEDGER (layer 3): NONE required by task 14. Everything the ported extension needs is public API — `registerDebugAdapterTrackerFactory` (Request Trace), `window.registerUriHandler` (burrow://open; API lives in src/vs/workbench/api/common/extHostUrls.ts, no extension registers one yet), TreeDataProvider, webview iframes, addBreakpoints/FunctionBreakpoint, DocumentSymbolProvider. This is deliberately the out-of-tree task: contrast tasks 05–09 which each needed a patch (see patches/0004–0009). So no new patches/NNNN entry.

NEW burrow-* EXTENSION (layer 4): extensions/burrow-nodewatch/ — port extension/src/* feature-for-feature (Routes tree, Drills tree, MOCK↔LIVE toggle, Request Trace, tool panels), following the burrow-frontend-debugger precedent (config/extension/panel/sidecar/status + gulp compile-extension). Adds three NEW capabilities the old extension lacked: (a) a burrow://open URI handler, (b) selection-follow polling of the launcher, (c) a host-side digest runner that POSTs markdown to the launcher's new ingest endpoint. Reads digest over HTTP (GET launcher /api/digest) — on the host there is no /config mount, so the old fs.readFile(/config/digest.json) path in routesTree.ts/config.ts must become a launcher fetch.

OUTER-REPO (the core of THIS task, /Users/emadinfstones/Projects/debugger): launcher/server.js (drop debugger-ide from TOOL_CONTAINERS, retarget the backend health probe to host.docker.internal:8080, add /api/digest/ingest, 410 the old POST /api/digest, drop the exec-based regen from /api/select), launcher/digest.js (keep parser+writer, delete exec plumbing), launcher/ui/{app.js,index.html} (Backend IDE card → burrow://open with install-fallback; re-label/redirect the digest refresh control), launcher/test/verify.mjs (reversed-flow assertions, parser fixtures stay green), docker-compose.yml (ide + nw_go/nw_code_server behind profiles:["legacy"], emitters → host.docker.internal + extra_hosts host-gateway), .claude/memory/{api,env,repo}.yaml, CLAUDE.md + README.md.

## Already exists

- `product.json:36` already has `urlProtocol: "burrow"` (task 01) — burrow:// deep links are registerable now; no config change needed for the scheme.
- burrow-frontend-debugger is a COMPLETE port precedent for a stack tool moving into the fork: extensions/burrow-frontend-debugger/src/{config,extension,panel,sidecar,status}.ts, publisher "burrow", engines ^1.128.0, main ./out/extension.js, `gulp compile-extension:<name>`. It also shows the exact way to neutralize the legacy /config-selection read on the host (sidecar.ts:89-90 points SELECTION_FILE at os.tmpdir()).
- The extension compile list already exists and is curated (build/gulpfile.extensions.ts:59-62 lists burrow-core, burrow-frontend-debugger, burrow-go-debug, burrow-go-inspect …) — adding burrow-nodewatch is one tsconfig row.
- The digest PARSER is already pure and fixture-gated (launcher/digest.js:135 parseDigest; launcher/test/verify.mjs section 1; fixture launcher/test/fixtures/digest-sample.txt). It survives the reversal unchanged — only the exec plumbing around it goes.
- launcher/digest.js:210 readDigestCache and the atomic tmp+rename write (204-205) are already the sole-writer primitives the ingest endpoint reuses.
- The launcher UI already dropped the frontend card and documents "opens from Burrow" (launcher/ui/app.js:9-10) — the same treatment now applies to the Backend IDE card.
- The whole extension env surface is centralized in one file (extension/src/config.ts) — the port only edits that one module for URL scheme changes.

## Open items

- Debug-type id for the Request Trace tracker: the old extension registers registerDebugAdapterTrackerFactory('go', …) (extension/src/tracker.ts). Burrow's delve engine (task 04, extensions/burrow-go-debug) may contribute a different debug type ('go' vs 'dlv' vs 'burrow-go'). Must read burrow-go-debug's contributed debug type and match it, or the trace captures nothing.
- Host↔container path mapping for burrow://open: selection.backendDir is a CONTAINER path (/projects/merkle/nodewatch); the burrow://open?folder= needs a HOST path. The launcher container only knows /projects. Needs a new env (e.g. HOST_PROJECTS_DIR) so the launcher can rewrite /projects/<rel> → <hostRoot>/<rel>. Confirm the compose mount source (${PROJECTS_DIR:-$HOME/Projects}) is threaded into the launcher.
- Digest read path on host: routesTree.ts/config.ts read /config/digest.json off disk; Burrow-on-host has no /config mount. Must switch the Routes tree to GET launcher /api/digest (HTTP) and drop the fs.watch(configDir). Confirm the launcher URL the host extension uses (localhost:6060, not compose DNS launcher:6060).
- Whether task 09's burrow-http should consume the ingested digest now: grep shows NO digest reference in any extensions/burrow-*/src — the doc treats digest→routes.generated.http as an existing task-09 consumer, but it is not wired. Decide whether task 14 also wires burrow-http/burrow-nodewatch to GET /api/digest, or leaves that to task 09.
- pgweb retirement timing: the doc says pgweb follows the same two-step retirement once task 10 (DB explorer) ships. Task 14 keeps pgweb for now — confirm it stays in SERVICES and the UI, and is not swept into the legacy profile prematurely.
- Selection-follow UX default: doc wants a non-modal 'Launcher selected <project> — switch workspace?' prompt with an auto-follow setting for the single-user flow. Confirm the setting id/namespace (burrow.nodewatch.autoFollowSelection) and default (auto-follow on).
- First-open .vscode seeding source: the entrypoint's seed job is gone; the extension must offer seeding from backend/vscode/* with DATABASE_URL flipped to localhost-first. Confirm those seed files still live at debugger/backend/vscode/ after the backend slim-down (doc §Compose+repo cleanup).
- Install-fallback target for the launcher's Open Backend IDE button when burrow:// is unhandled: the doc points at the task 13 download page — confirm that page's URL/route exists or stub it.

## First slice

Digest-reversal, launcher half only (pure outer-repo, no burrow build): add `POST /api/digest/ingest` to `launcher/server.js` and an `ingestDigest(rawMarkdown)` writer to `launcher/digest.js` (reusing the existing pure `parseDigest` + atomic-write + `readDigestCache`), make the old `POST /api/digest` return `410` pointing at the ingest flow, and rewrite `launcher/test/verify.mjs` sections 2–3 for the reversed flow while leaving the parser-fixture section (1) untouched and green. Verify with `node launcher/test/verify.mjs`. This is the smallest independently-testable change, keeps the launcher the only /config writer, and is the prerequisite the Burrow-side digest runner POSTs into — so it unblocks the extension port without depending on it.

## Files to touch

- `/Users/emadinfstones/Projects/debugger/launcher/server.js`
- `/Users/emadinfstones/Projects/debugger/launcher/digest.js`
- `/Users/emadinfstones/Projects/debugger/launcher/ui/app.js`
- `/Users/emadinfstones/Projects/debugger/launcher/ui/index.html`
- `/Users/emadinfstones/Projects/debugger/launcher/test/verify.mjs`
- `/Users/emadinfstones/Projects/debugger/docker-compose.yml`
- `/Users/emadinfstones/Projects/debugger/.claude/memory/api.yaml`
- `/Users/emadinfstones/Projects/debugger/.claude/memory/env.yaml`
- `/Users/emadinfstones/Projects/debugger/.claude/memory/repo.yaml`
- `/Users/emadinfstones/Projects/debugger/CLAUDE.md`
- `/Users/emadinfstones/Projects/debugger/README.md`
- `/Users/emadinfstones/Projects/debugger/burrow/extensions/burrow-nodewatch/package.json`
- `/Users/emadinfstones/Projects/debugger/burrow/extensions/burrow-nodewatch/tsconfig.json`
- `/Users/emadinfstones/Projects/debugger/burrow/extensions/burrow-nodewatch/src/extension.ts`
- `/Users/emadinfstones/Projects/debugger/burrow/extensions/burrow-nodewatch/src/config.ts`
- `/Users/emadinfstones/Projects/debugger/burrow/extensions/burrow-nodewatch/src/routesTree.ts`
- `/Users/emadinfstones/Projects/debugger/burrow/extensions/burrow-nodewatch/src/drillsTree.ts`
- `/Users/emadinfstones/Projects/debugger/burrow/extensions/burrow-nodewatch/src/panels.ts`
- `/Users/emadinfstones/Projects/debugger/burrow/extensions/burrow-nodewatch/src/status.ts`
- `/Users/emadinfstones/Projects/debugger/burrow/extensions/burrow-nodewatch/src/tracker.ts`
- `/Users/emadinfstones/Projects/debugger/burrow/extensions/burrow-nodewatch/src/tracePanel.ts`
- `/Users/emadinfstones/Projects/debugger/burrow/extensions/burrow-nodewatch/src/selectionFollow.ts`
- `/Users/emadinfstones/Projects/debugger/burrow/extensions/burrow-nodewatch/src/digestRunner.ts`
- `/Users/emadinfstones/Projects/debugger/burrow/build/gulpfile.extensions.ts`

## Core risk

The digest feed is being turned inside-out AND moved off the shared /config mount, and both must happen without ever letting a tool write /config. Today the flow is: launcher docker-execs the oracle inside the ide container → parses → writes /config/digest.json → the extension reads it off the shared mount (launcher/digest.js execInIde + routesTree.ts readDigest via fs). On host there is no ide container to exec into and no /config mount for the extension to read. The whole feed must round-trip through the launcher over HTTP: Burrow runs the oracle on the host (task 03 toolchain) → POST /api/digest/ingest (raw markdown) → the launcher parses and writes /config/digest.json (still the ONLY writer) → the extension GETs /api/digest. If any of these leaks — the extension writing digest.json directly, or reading a stale /config path that no longer exists on host, or the ingest endpoint accepting a pre-parsed JSON body (which would move parsing/authority out of the launcher) — the sole-writer invariant breaks. Second-order risk: the burrow://open host-path rewrite (container /projects → host path) and the tracker's debug-type match ('go' vs Burrow's dlv type) are the two wiring details that silently no-op the demo loop (workspace never opens / trace stays empty) even when everything compiles.

## Dependencies

See structured field.

## Full plan

# Task 14 — Retire the ide container (build-ready plan)

Outer repo: `/Users/emadinfstones/Projects/debugger`. Nested fork: `.../burrow`.
Ground truth verified by reading the files cited below; the doc
(`burrow/docs/architecture/14-stack-migration.md`) is the spec, but several of
its "existing consumers" are not yet wired — see §0.

## 0. Current state vs the doc (verified)

- `product.json:36` `urlProtocol:"burrow"` — **present** (task 01). No config change for the scheme.
- No `burrow-nodewatch` extension exists; 11 other `burrow-*` do. `burrow-frontend-debugger` is the port template.
- **No extension consumes the digest** — `grep -rn digest extensions/burrow-*/src` is empty; task 09's `burrow-http` (codelens/httpFile/render/send/workbench) does not read it. So the ingest feed is net-new plumbing, not a swap.
- No extension calls `window.registerUriHandler` (API in `src/vs/workbench/api/common/extHostUrls.ts`). `burrow://open` is unbuilt.
- Outer repo is still the **old world**: `launcher/server.js:30` `TOOL_CONTAINERS=['debugger-ide','debugger-simulator']`; `SERVICES` (33-38) probes backend at `http://ide:9000/healthz`; `POST /api/digest` (141) → `runOracleDigest` docker-execs into ide; `/api/select` (169) restarts ide. `launcher/digest.js` is entirely exec-into-ide. `docker-compose.yml:35-61` still has `ide` + `nw_go`/`nw_code_server`; emitters (123,135) target `http://ide:8080`.

## 1. FIRST SLICE — launcher digest ingest (pure outer-repo)

**`launcher/digest.js`**: keep `parseDigest` (135), `readDigestCache` (210), the atomic tmp+rename write (202-205). ADD:
```js
export function ingestDigest(rawMarkdown, selection) {
  const parsed = parseDigest(rawMarkdown)
  if (!parsed.routes.length) throw new Error('digest produced no routes — output shape changed?')
  const digest = { generatedAt: new Date().toISOString(), project: selection?.name || parsed.project,
    rev: parsed.rev, counts: parsed.counts, routes: parsed.routes, env: parsed.env,
    contract: parsed.contract, tables: parsed.tables, raw: rawMarkdown }
  fs.mkdirSync(path.dirname(DIGEST_FILE), { recursive: true })
  const tmp = DIGEST_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(digest, null, 2) + '\n', 'utf8'); fs.renameSync(tmp, DIGEST_FILE)
  return digest
}
```
DELETE `dockerJson`, `dockerExecCollect`, `execInIde`, `runOracleDigest`, `shq`, and the `IDE_CONTAINER`/`DOCKER_SOCK`/`http` imports that only served exec. (The launcher stays sole writer — the write still happens here.)

**`launcher/server.js`**: replace the `runOracleDigest`/`kickDigest` import + `POST /api/digest` block:
```js
import { ingestDigest, readDigestCache } from './digest.js'
// NEW — Burrow (host) posts raw oracle markdown; the launcher parses + writes (sole writer).
app.post('/api/digest/ingest', express.text({ type: '*/*', limit: '2mb' }), (req, res) => {
  const selection = readSelection()
  if (!selection) return res.status(409).json({ error: 'no project selected yet' })
  if (!req.body || typeof req.body !== 'string') return res.status(400).json({ error: 'expected raw digest markdown body' })
  try { const { raw, ...lean } = ingestDigest(req.body, selection); res.json({ digest: lean }) }
  catch (err) { res.status(502).json({ error: String(err.message || err) }) }
})
// OLD trigger is dead — nothing to exec on the host stack.
app.post('/api/digest', (_req, res) => res.status(410).json({ error: 'digest is now computed by Burrow on the host and POSTed to /api/digest/ingest' }))
```
`GET /api/digest` (135) is unchanged. In `/api/select` (154-178) drop the `setTimeout(kickDigest…)` tail and remove `'debugger-ide'` from `TOOL_CONTAINERS` (30) → `['debugger-simulator']`.

**`launcher/test/verify.mjs`**: keep section 1 (parser fixtures) verbatim. Rewrite section 2 to assert the reversed flow — `ingestDigest` exists, parses+atomically writes, and there is NO `IDE_CONTAINER`/`execInIde`/exec-frame code left (`!/IDE_CONTAINER/.test(digestSrc)`, `!/readUInt32BE/.test(digestSrc)`). Rewrite section 3: `POST /api/digest/ingest` registered, `POST /api/digest` returns 410, and keep the sole-writer guard `!/writeFileSync/.test(server)`. Verify: `node launcher/test/verify.mjs`.

## 2. Compose + repo cleanup (parallelizable with §1)

**`docker-compose.yml`**: add `profiles: ["legacy"]` to the `ide` service (35). Move `nw_go`/`nw_code_server` usage behind legacy (they only serve ide). Emitters (114-136): `API_URL: http://host.docker.internal:8080` and add `extra_hosts: ["host.docker.internal:host-gateway"]` (Linux). Launcher (17-30): thread the host projects dir so burrow://open can rewrite paths — add `HOST_PROJECTS_DIR: ${PROJECTS_DIR:-${HOME}/Projects}` to its `environment`. Keep `db` and `pgweb` untouched (pgweb retires with task 10, not here). Verify: `docker compose config -q` AND `docker compose --profile legacy config -q`.

## 3. Launcher health + UI

**`launcher/server.js` SERVICES (33-38)**: change the backend row to probe the host: `{ id:'backend', label:'Backend (host)', url:'http://host.docker.internal:8080/healthz', open:8080 }`; tolerate down as normal (the `probe` helper already resolves false quietly). Keep launcher/pgweb/simulator rows.

**`launcher/ui/app.js` (12-14)** Backend IDE card → an "Open Backend IDE" action that builds `burrow://open?folder=<HOST path>` from `selection.backendDir` rewritten via the launcher's `HOST_PROJECTS_DIR` (expose it through a small `GET /api/env` or fold the rewrite into `/api/selection`), with an `onerror`/timeout fallback to the task-13 download page when the scheme is unhandled. Re-label or remove the digest refresh control (128-146) — the launcher no longer runs the oracle; either hide it or repoint it at a "Burrow computes the digest" hint. Update the index.html titles (21-22) that name the ide container.

## 4. New extension — `burrow/extensions/burrow-nodewatch/`

Port `extension/src/*` following `burrow-frontend-debugger`'s shape. Files: `package.json` (publisher "burrow", engines ^1.128.0, main ./out/extension.js, `compile`: `gulp compile-extension:burrow-nodewatch`, command ids renamed `nodewatch.*` → `burrow.nodewatch.*`, viewsContainer/views kept), `tsconfig.json`, then port `extension.ts`, `config.ts`, `routesTree.ts`, `drillsTree.ts`, `panels.ts`, `status.ts`, `tracker.ts`, `tracePanel.ts`, plus two NEW modules `selectionFollow.ts` and `digestRunner.ts`.

Key deltas from the code as read:
- **config.ts** (extension/src/config.ts): service URLs move from compose DNS to host `localhost` (`launcherUrl` → `http://localhost:6060`; drop `NW_FRONTEND_URL`/`NW_SIMULATOR_URL` compose defaults → localhost). `publicUrl(port)` stays for webview origins. Remove the `/config` filesystem digest read.
- **routesTree.ts** (extension/src/routesTree.ts:80 `readDigest()` fs read; :55 `fs.watch(configDir)`): on host there is no `/config` mount — replace `readDigest()` with a cached `GET ${launcherUrl}/api/digest`, and replace the fs watcher with a poll/refresh command. `refreshDigest` (109) no longer POSTs `/api/digest` (now 410); instead it calls the new `digestRunner`.
- **digestRunner.ts** (NEW): runs the oracle on the host (`cd <selection.backendDir or test/> && go run ./cmd/oracle --digest nodewatch` — the same command string `digest.js:181` used, now host-side via `child_process`), then `POST`s stdout to `${launcherUrl}/api/digest/ingest` (raw text). Surfaces failures as warnings, never throws.
- **selectionFollow.ts** (NEW): polls `GET ${launcherUrl}/api/selection` (2s, ETag) per doc §Selection; on change, non-modal "Launcher selected `<project>` — switch workspace?" with a `burrow.nodewatch.autoFollowSelection` setting (default on). Never writes selection.
- **extension.ts** (extension/src/extension.ts): register a `window.registerUriHandler` for `burrow://open?folder=…` that opens the folder (`vscode.commands.executeCommand('vscode.openFolder', Uri.file(folder))`). Keep the tree/tracker/command registrations; rename ids.
- **tracker.ts** (extension/src/tracker.ts:80): `registerDebugAdapterTrackerFactory('go', …)` — confirm and match Burrow's delve debug type from `burrow-go-debug` (open item); the join logic (SlogIndex by request_id) is unchanged.
- **panels.ts** (extension/src/panels.ts): unchanged logic — full-origin iframe `http://${publicHost}:<port>`. In Electron there is no `/proxy/<port>` rewrite so the `asExternalUri` landmine is moot, but keep the full-origin rule and its comment.
- **Build wiring**: add `'extensions/burrow-nodewatch/tsconfig.json'` to the compile list in `build/gulpfile.extensions.ts` (next to :59-62). This edits `build/` — note it under existing patch **0001** (curate the extension compilation list); no new ledger entry.

## 5. Docs + memory (same change)

- `.claude/memory/api.yaml`: rewrite the `POST /api/digest` row (now 410) and add `POST /api/digest/ingest` (parse+write, launcher sole writer); update the `/api/health` note (backend row now "backend (host)").
- `.claude/memory/env.yaml`: drop the launcher `IDE_CONTAINER` row; add `HOST_PROJECTS_DIR`. Under `extension:` note the compose-DNS URLs are now host localhost and the frontend URL is fully removed (not just defunct).
- `.claude/memory/repo.yaml`: bump `meta.updated_at`; add a trap for the reversed digest direction + host path rewrite; update the gate note if verify.mjs assertions changed.
- `CLAUDE.md` / `README.md`: rewrite every mention of the ide container, :6100 code-server, and scope the `asExternalUri` invariant to its remaining webview-origin form (the code-server /proxy hazard is gone on host).

## 6. Rollback + acceptance

Old world stays reachable one release via `docker compose --profile legacy up`. The eventual removal PR deletes `backend/Dockerfile`, `scripts/entrypoint.sh`, and the code-server config in one commit (out of scope here — this task only gates them behind the profile). Acceptance = the doc's demo loop on a fresh machine with no ide container (select → Burrow follows → open → Routes-tree breakpoint → emitter traffic to host.docker.internal:8080 → trace join → drill → mode flip), then the legacy rollback rehearsal.

## Verify strategy

See structured field.
