# Backend Visual Debugging — Feature Plan

**Date:** 2026-07-24 · **Scope:** nodewatch-relocatable (merkle = reference target) · **Host:** Burrow (Code-OSS fork)

The ask: for backend code — breakpoints; an interactive API index that sketches each request's
flow all the way to the database (wire diagram) with click-through to code; great syntax
highlighting with cmd-click go-to-definition; Postman-like endpoint calling with autopopulated,
editable defaults; a much-simpler-pgAdmin for Postgres; and easy, configurable debugging via
checkboxes (skip auth, seed mode, …).

---

## Part 1 — Summary for product review

### Where each feature stands today

| Feature | Status | What exists / what's missing |
|---|---|---|
| Backend breakpoints | **Mostly exists** | `burrow-go-debug` runs dlv-dap natively; the old `extension/` has symbol-anchored route breakpoints (click a route → breakpoint lands on the handler symbol, no line numbers). The route-breakpoint UX must be **ported into Burrow** — it's stranded in the retiring code-server extension. |
| API index → DB wire diagram | **New — the big build** | The oracle digest gives route → handler → file (~203 routes for merkle) but **nothing below the handler**: no handler → store → SQL → table chain exists as machine data anywhere. We build a static Go call-chain analyzer + an interactive diagram webview. |
| Click any diagram node → code | **Pattern exists** | The frontend-debugger already bridges webview clicks to the native editor (`openSource {file,line,col}`). Reuse the same bridge. |
| Syntax highlighting + cmd-click Class.Method → definition | **Already done** | Burrow ships gopls (`burrow-go-base`): semantic tokens, hover, cmd-click go-to-definition, references. Small verification task only. |
| Postman-like runner, autopopulated + editable defaults | **Half exists** | `burrow-http` is a full file-backed HTTP client (.http files, `{{vars}}`, send, response view, Postman import). Missing: **auto-population from the digest** (all ~203 routes with example bodies derived from the contract types) and persistent editable defaults. Merkle even has a Postman collection to import (`infra/test/nodewatch.postman_collection.json`). |
| Simple pgAdmin | **Mostly exists** | `burrow-db`: schema/table tree from `information_schema`, read-only query grid, optional embedded real pgAdmin. Missing: one-click table peek, digest integration (jump from a diagram's table node into the explorer), saved per-table starter queries. |
| Checkbox debug config (skip auth, seed mode, …) | **New — thin build** | Merkle has the levers (`NODEWATCH_DEV_NO_AUTH`, `NODEWATCH_READ_ONLY`, `NODEWATCH_DEBUG_EMIT`; "seed" = running the Python emitters). Nothing surfaces them as UI. We build a Debug Control Panel that writes these into the dlv launch env and manages emitter processes, wired into the existing `burrow-fullstack` one-click orchestrator. |

### Shape of the solution

Everything lands in **Burrow** (the go-forward host), following the proven frontend-migration
pattern: analyzers/tools under `burrow/tools/` (own lifecycle, exempt from core gates),
UI as `burrow/extensions/burrow-*` webview extensions, zero new core patches. The launcher/compose
stack gets nothing new — this plan continues the dismantling direction
(`burrow/docs/architecture/14-stack-migration.md`).

The one genuinely hard piece is the **flow analyzer** (WO-1): statically tracing merkle's
handler closures through store interfaces down to inline pgx SQL and the tables it touches.
Merkle's code shape makes this tractable — handlers are closures over a pool or a
`Pgx*Store`, SQL is inline string literals/constants, and the digest already hands us every
entry point — but interface-to-concrete resolution and SQL-to-table extraction are heuristic
by nature. The plan treats "unknown below this point" as a first-class diagram state rather
than pretending at completeness.

Estimated sequencing: WO-1 → WO-2 (diagram) is the critical path; WO-3/4/5/6 are independent
of it and of each other; WO-7 is a half-day audit.

---

## Part 2 — Detailed work orders (for the agent)

### Foundation facts (read before any WO)

**Merkle backend shape** (the reference target — everything must stay nodewatch-relocatable):
- Go 1.25, chi v5. All routes in `backend/router.go` (599 lines, `registerXRoutes` funcs) +
  per-domain `*/routes.go`. Mount map hand-maintained in `test/oracle/config.go` (`RouteMounts`).
- Handlers are closures: `r.Get("/nodes", nodes.ListNodes(a.Pool))` → `func ListNodes(db readQuerier) http.HandlerFunc`.
  Two data-access styles: (a) handler runs inline pgx SQL on the captured pool; (b) handler
  captures a store interface (e.g. `validatorStore`) whose concrete impl is `Pgx*Store{Pool}`
  injected in `router.go`.
- pgx v5 / pgxpool only, no ORM. Schema = `backend/migrations/` (132 sequential .sql files).
  Postgres 16 via TimescaleDB image. DSN `postgres://nodewatch:nodewatch@localhost:5432/nodewatch`.
- Oracle digest: `cd test && go run ./cmd/oracle --digest nodewatch` — fenced-markdown sections
  `routes` (METHOD /path → Handler [file]), `env`, `contract` (json-tagged model structs),
  `tables` (table ← first migration). `launcher/digest.js:parseDigest` already parses this into
  `/config/digest.json` `{routes:[{method,path,handler,file}], env, contract, tables}`.
  **Note:** the launcher currently generates it via docker-exec into the *broken* ide container;
  Burrow-side generation runs it on the host instead (WO-6).
- Auth: Auth0 JWT middleware; `NODEWATCH_DEV_NO_AUTH=1` makes `JWT()` a pass-through and org
  context falls back to seeded `models.DefaultOrgID` (`00000000-…-0001`) — requests need no token.
- Seed data: no seed flag; "seed mode" = running `emitters/eth_emitter.py` / `sol_emitter.py`
  (HMAC-signed POSTs to `/api/v1/ingest`, `API_KEY=test-key-eth`).

**Burrow assets to reuse:** `burrow-go-debug` (dlv-dap factory, env/envFile merge, macOS
DevToolsSecurity guard), `burrow-go-base` (gopls), `burrow-http` (.http parser/sender/renderer,
`importPostman`), `burrow-db` (catalog/query/grid/pgadmin), `burrow-fullstack` (db-up → F5 dlv →
frontend-live orchestrator), `burrow-oracle` (package-walk webview), frontend-debugger bridge
(`openSource` envelope `{__fedbgHost:1,…}`), old `extension/src/routesTree.ts` (symbol-anchored
breakpoint logic: DocumentSymbolProvider retry → `findHandlerSymbol` → SourceBreakpoint at
`selectionRange.start`, FunctionBreakpoint fallback).

**Burrow repo rules:** nested independent git repo — its own branching/commit rules; tools under
`burrow/tools/` keep their own idiom + `.claude/` memory/oracle; extensions follow the ledger.
Debugger-repo memory (`.claude/memory/{api,env,repo}.yaml`) must be updated in the same change
for anything touching launcher/simulator/extension.

---

### WO-1 · `flowscan` — route→handler→store→SQL→table call-chain extractor

**Deliverable:** `burrow/tools/flowscan/` — a standalone Go CLI (own `go.mod`) that emits
`flows.json` for a nodewatch-shaped backend. Ships with the debugger, requires **no changes to
the target project** (the target's oracle stays untouched; relocatability preserved).

- **Input:** `--backend <dir>` + `--routes <digest.json|digest-md>` (entry points come from the
  existing digest so route/mount resolution isn't reimplemented).
- **Analysis:** `golang.org/x/tools/go/packages` (`NeedSyntax|NeedTypes|NeedTypesInfo`) over the
  backend module. For each digest route:
  1. Resolve the handler expression (`nodes.ListNodes`, `(*H).CreateNode`, wrapped `mw(h)` —
     strip known wrappers) to its `types.Object` + position.
  2. Walk the handler body (and, for closure-returning constructors, the returned func literal):
     collect middleware seen on the route's chain (from digest path → router.go `Use` groups),
     calls on captured store interfaces, and direct pool calls (`Query/QueryRow/Exec` on
     pgx pool/tx receivers).
  3. Interface→concrete: index all `Pgx*Store` types implementing each store interface
     (`types.Implements`); merkle has exactly-one impls, so single-impl resolution is exact —
     if multiple impls, emit all with `ambiguous:true`.
  4. SQL extraction: resolve the query argument to a string constant/composite (`nodeCols`-style
     const concatenation supported); parse table names with a small regexp-grade extractor
     (`FROM|JOIN|INSERT INTO|UPDATE|DELETE FROM <ident>`), cross-checked against the digest
     `tables` set. Statement kind = read/write.
  5. Depth cap ~4 hops; anything unresolved emits a `{kind:"unknown", reason}` leaf — **never
     silently dropped**.
- **Output `flows.json`:** per route: `{method, path, nodes:[{id, kind: middleware|handler|store|
  query|table, label, file, line, col}], edges:[[from,to]], sql:[{text, kind, tables}]}` plus a
  provenance header (`rev`, `generatedAt`, coverage counts: N fully-traced / M partial / K unknown).
- **Verify:** golden-file tests against 4–5 hand-checked merkle routes covering both styles
  (`GET /api/nodes` inline-pool; a `validatorStore` interface route; an ingest write path; one
  wrapped-middleware handler). Gate: `cd burrow/tools/flowscan && go test ./...`.

### WO-2 · `burrow-flow` — interactive API index + wire diagram

**Deliverable:** `burrow/extensions/burrow-flow/` — activity-bar view **API Flows**: a
routes-index tree (grouped by `/api/<domain>`, same grouping as the old Routes tree) and, per
route, a wire-diagram webview.

- **Diagram:** left→right rail — `HTTP method+path → [middleware chips] → handler → store
  method(s) → SQL statement(s) → table(s)`. Vanilla SVG/DOM renderer (repo is dependency-light;
  this is a DAG of <20 nodes, cytoscape is overkill — reserve it for a later "whole-API map"
  view). Table nodes show read/write badge; unknown leaves render as a dashed "?" node with the
  analyzer's reason on hover.
- **Click behavior:** every code-bearing node → native editor at `{file,line,col}` (reuse the
  frontend-debugger host-bridge pattern, envelope-style messages, never `asExternalUri`).
  SQL node → also "copy SQL" + "run in DB explorer" (prefilled into burrow-db's query panel,
  WO-4). Table node → burrow-db catalog focus on that table + schema source (`tables` section
  gives the creating migration file — link it too).
- **Breakpoint affordance:** each handler/store node gets a ● toggle that arms a symbol-anchored
  breakpoint (delegates to WO-6's service). A route-level "Debug this route" arms handler bp +
  starts the fullstack session if not running.
- **Data:** runs `flowscan` on demand (host `go run`/built binary) with cached `flows.json`
  under the tool's workspace state; stale-rev banner + refresh button (same pattern as digest).
- **Verify:** extension builds under burrow's gates; webview renders the golden merkle routes;
  clicks land on the right symbols (manual checklist + unit tests on the flows→diagram mapper).

### WO-3 · Route Runner — digest-fed Postman

**Deliverable:** autopopulated request catalog on top of `burrow-http` — no new HTTP engine.

- **Generator:** from `digest.json` routes + `contract` types, emit
  `<backendDir>/.vscode/api.generated.http` **per domain section**, each request with:
  resolved `{{baseUrl}}` (default `http://localhost:8080`), path params as `{{id}}`-style vars
  with a defaults block, and for POST/PUT/PATCH a JSON body skeleton derived from the matching
  contract struct (field:type → sensible zero/example values; `?` omitempty fields commented
  out). Port + upgrade the old `generateApiHttp` logic; keep the curated `api.http` untouched.
- **Editable defaults that persist:** generated file carries a
  `### user-overrides` region read back on regeneration, so edited values survive digest
  refresh (file-backed = diffable, matches burrow-http's model).
- **Auth-aware:** when the Debug Control Panel (WO-5) has skip-auth ON, no auth header; when
  OFF, a `{{bearer}}` var slot. Ingest routes get the HMAC signing preamble documented inline
  (point at `emitters/nw_signing.py` semantics) rather than fake-signed.
- **Entry points:** "Send" codelens already exists; add "Open in Route Runner" from the WO-2
  route tree/diagram (jumps to that request block). Offer one-time
  `burrow.http.importPostman` of merkle's existing collection as seed comparison.
- **Verify:** unit tests: route+contract fixtures → generated .http snapshot; override region
  survives regeneration; a live smoke against `make verify`-style fixture server if cheap.

### WO-4 · DB Explorer polish — "pgAdmin, but simple"

**Deliverable:** incremental `burrow-db` upgrades (no new extension):

- **Table peek:** click a table → immediate `SELECT * … ORDER BY 1 DESC LIMIT 100` grid + row
  count + column panel (name, type, nullable, default, PK/FK) from `information_schema` —
  the "how does my data look" one-click.
- **Starter queries:** per-table saved snippets (workspace state), seeded with peek/count/
  recent-N; a plain textarea query panel stays read-only-by-default with an explicit
  "allow writes" toggle (guarded, session-scoped).
- **Digest links:** accept "focus table X" + "prefill query" commands (consumed by WO-2);
  show the creating migration next to each digest-known table.
- **DSN:** default from `DATABASE_URL`, fall back to the merkle local DSN; TimescaleDB
  hypertables/partitions just render as tables (no special handling in v1).
- **Verify:** burrow-db's existing gate + snapshot tests on the peek/column queries.

### WO-5 · Debug Control Panel — checkbox-configurable debugging

**Deliverable:** a **Debug Config** webview/tree section (inside `burrow-fullstack`) rendering
toggles that feed the debug session:

- **Toggles (merkle mapping, declared per-project):** `skip auth` → `NODEWATCH_DEV_NO_AUTH=1`
  (+ signup `NODEWATCH_SIGNUP_MODE=open`) · `seed mode` → start/stop emitter child processes
  (`python3 emitters/eth_emitter.py` etc. with their `API_KEY`s, OutputChannel logs, killed on
  session end) · `read-only` → `NODEWATCH_READ_ONLY=1` · `debug emit` → `NODEWATCH_DEBUG_EMIT=1`.
- **Mechanics:** panel state persists in Burrow settings (`burrow.debugConfig.*`); on F5 the
  `GoDebugConfigurationProvider` env-merge (already in `burrow-go-debug`) layers panel env over
  envFile. Changing a toggle mid-session prompts "restart backend?" (~1s Go reboot precedent).
- **Toggle manifest is data, not code:** `debug-toggles.json` (label, env or process spec,
  description) — merkle's shipped as the default; other nodewatch-shaped projects override via
  a workspace file. Keeps it relocatable.
- **Fullstack integration:** `burrow-fullstack`'s rocket flow reads the panel before launching
  (db up → dlv with merged env → emitters if seed ON → frontend live).
- **Verify:** unit tests on env merge + manifest parsing; manual checklist: bp in
  `nodes.ListNodes`, skip-auth ON, Route Runner sends `GET /api/nodes` with no token → breaks.

### WO-6 · Port Routes tree + symbol-anchored breakpoints into Burrow

**Deliverable:** the stranded `extension/` capabilities land in Burrow (per
`14-stack-migration.md`), as either `burrow-nodewatch` or folded into `burrow-flow` —
**recommendation: fold into `burrow-flow`** (one routes surface, not two; WO-2's tree is the
Routes tree).

- Port `routesTree.ts` breakpoint logic verbatim in behavior: DocumentSymbolProvider (gopls,
  4× retry) → bare-name match handling `(*H).Method` vs `Func` → `SourceBreakpoint` at
  `selectionRange.start`; `FunctionBreakpoint` fallback. **No stored line numbers, ever**
  (repo invariant). Expose as a small service WO-2 consumes.
- **Digest generation moves host-side:** a `burrow.flow.refreshDigest` command runs the oracle
  on the host (`cd <projectRoot>/test && go run ./cmd/oracle --digest nodewatch`), parses with
  a port of `launcher/digest.js:parseDigest` (29/29 fixture tests come along), caches in
  workspace storage. Launcher digest endpoints remain for the legacy stack but are no longer
  the Burrow path. Project root from workspace-folder auto-detect → `MERKLE_*` env (migration
  doc pattern), not `/config/selection.json`.
- **Do not port:** frontend panel/mode toggle (defunct), pgweb iframe (burrow-db supersedes).
  Request Trace port (DAP slog tracker ⨝ netlog) is desirable but **out of scope here** — it's
  already specced in `14-stack-migration.md`; note it as the follow-on.
- **Verify:** ported parser fixtures green; breakpoint lands on `ListNodes` symbol in merkle;
  memory: this retires extension surface → update `.claude/memory/repo.yaml`
  (`meta.updated_at`, trap/pref rows) in the same change when `extension/` is actually touched.

### WO-7 · Editor polish audit — highlighting + navigation (half-day)

- Confirm gopls **semantic tokens** are on by default in Burrow for Go (`burrow-go-base`), the
  Xcode theme colors them well (types vs funcs vs params distinct), and cmd-click works across
  packages (`Class.Method` → method definition) including from `router.go` handler refs.
- Confirm cmd-click works **inside SQL-adjacent code** (const query strings jump nowhere — fine;
  the diagram covers that hop) and in `.http` files (`burrow-http` codelens unaffected).
- Fix only what the audit finds; file follow-ups otherwise. `burrow-go-nav` already covers
  qualified-symbol search (`pkg.Symbol`) — verify, don't rebuild.

---

### Sequencing & risk

```
WO-1 flowscan ──▶ WO-2 burrow-flow ──▶ WO-6 (fold-in port)
WO-3 route runner   (independent — needs only digest+contract)
WO-4 db polish      (independent)
WO-5 control panel  (independent; WO-3 auth-awareness reads it when present)
WO-7 audit          (anytime)
```

- **Top risk — static analysis fidelity (WO-1):** wrapped handlers, dynamic SQL, multi-impl
  interfaces. Mitigation: digest-supplied entry points, single-impl fast path, explicit
  `unknown` nodes, golden tests on real merkle routes. Accept partial traces; never fake them.
- **Relocatability:** flowscan + toggle manifest are the two places target-project assumptions
  concentrate — both are data/CLI-driven, no merkle paths hardcoded (invariant).
- **Invariants honored:** no new `/config` writers; no `asExternalUri`; symbol-anchored
  breakpoints only; pinned toolchain untouched; dependency-light UIs (vanilla SVG diagram).

### Verification (whole plan)

`make verify` stays green (launcher/simulator/extension gates untouched until WO-6 touches
`extension/`); each burrow tool/extension carries its own gate (`go test` for flowscan, build +
unit tests per extension); end-to-end acceptance: **open merkle in Burrow → API Flows shows
`GET /api/nodes` traced to the `nodes` table → click handler lands in `nodes.go` → ● arms the
symbol breakpoint → Control Panel: skip-auth ✓, seed ✓ → rocket → Route Runner sends the
request → breaks in the handler → step to the SQL → peek the `nodes` table in the DB explorer.**

---

## Implementation status — 2026-07-24

All seven work orders landed the same day the plan was approved:

- **WO-1 flowscan** — `burrow/tools/flowscan/` (Go, own module). Merkle result: 235 flows,
  209 traced / 26 partial / 0 unknown, 0 digest routes unmatched, ~3.5 s. Gate:
  `go vet ./... && go test ./...` (golden fixture app + SQL classifier units).
- **WO-2 + WO-6 burrow-flow** — `burrow/extensions/burrow-flow/`: Routes tree (domain-grouped),
  wire-diagram webview (pure renderer in `diagram.ts`), click→editor, query→burrow-db,
  table→burrow-db, ● symbol-anchored breakpoints (verbatim port of the old
  `routesTree.ts` logic — DocumentSymbolProvider retry → FunctionBreakpoint fallback),
  host-side digest+flowscan refresh (`project.ts`). Registered in
  `build/gulpfile.extensions.ts`. Old `extension/` left intact for the legacy stack.
- **WO-3 Route Runner** — `burrow-flow/src/httpgen.ts` + `burrow.flow.generateHttp`:
  contract-fed JSON body skeletons, `{{param}}` vars, user-overrides region that survives
  regeneration, JWT-aware auth headers driven by the Debug Config skip-auth toggle,
  API-key ingest routes annotated. Emits `<backendDir>/.vscode/api.generated.http`
  (sent via burrow-http's codelens).
- **WO-4 burrow-db** — table peek stays; added `burrow.db.tableInfo` (columns/types/PK grid),
  `burrow.db.starterQuery` (seeded peek/recent/count/columns + workspace-saved snippets),
  `burrow.db.toggleWrites` (session-scoped, modal confirm, status pill),
  `runQuery(prefill)` + `openTable(table)` single-arg form for cross-extension calls.
- **WO-5 Debug Config panel** — `burrow-fullstack`: webview checkboxes from a data manifest
  (built-in merkle mapping: skip auth / seed mode / read-only / debug emit; projects override
  via `.vscode/debug-toggles.json`), env patched into every `go` debug launch via a
  DebugConfigurationProvider (panel authoritative for its vars), seed emitters run as managed
  child processes only while a backend session is live, rocket/stop integrated.
  State in `burrow.debugConfig.toggles` (workspace setting).
- **WO-7 audit** — found + fixed: gopls semantic tokens were off (gopls default) despite the
  Xcode theme opting in; `burrow-go-base` now passes `initializationOptions: {'ui.semanticTokens': true}`.
  Cmd-click/hover/references confirmed default-on.

**Verification:** launcher 29/29 · extension 43/43 · flowscan, burrow-flow, burrow-db,
burrow-fullstack, burrow-go-base gates all green. Pre-existing failure (NOT from this work):
simulator `test/verify.mjs` expects `<merkle>/nodewatch/k8s` but the checkout moved to
`infra/k8s` — recorded as trap `simulator-gate-merkle-layout-drift` in `.claude/memory/repo.yaml`.
