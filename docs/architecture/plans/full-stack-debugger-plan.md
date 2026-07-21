# Burrow Full Stack Debugger — implementation plan

> Final, agent-executable. Synthesizes 8 grounded pillar findings into one build-ready, dependency-ordered plan. Every citation is `path:line` as grounded by the pillar research. The governing constraint: **reach a demoable Full Stack Debugger — Go backend under dlv + React frontend via the FD tool + a SINGLE Postgres instance, tied by one request id — with ZERO new core patches**, keeping every pillar in Layer 4.

---

## 1. Vision & target architecture

The user vision, verbatim intent: *debug merkle frontend components in ISOLATION + the Go BACKEND + the DB TOGETHER; a first-class DOCKER activity-bar item to control containers; pgAdmin integrated; an Xcode-style dark/light theme (original assets, SF Mono by name); IntelliJ-style click-to-definition; reached as fast and lean as possible.*

### Single source-of-truth Postgres (read this first — it makes the seams real)

The whole "one request id links three tiers" payoff only works if the **dlv-debugged backend, pgAdmin, and any native explorer all read/write the SAME Postgres instance and volume**.

**RECONCILED (2026-07-21) — merkle now has exactly ONE Postgres.** The user collapsed the two former services into one: `nodewatch/docker/docker-compose.yml` was **deleted** (git `D`; its Dockerfiles moved under `infra/docker/`), and the surviving service **`nodewatch-db`** in `infra/docker-compose.yml` now **publishes `5432:5432`** itself (`infra/docker-compose.yml:7-8`), volume **`nodewatch_pgdata`** (`infra/docker-compose.yml:14`). So:

- **The single instance is `infra` → `nodewatch-db` (volume `nodewatch_pgdata`), reachable at `localhost:5432` on the host.** The container-internal name stays `nodewatch-db:5432` (matches the backend's own default, `db.go:14`, `config.go:189`, and the compose `DATABASE_URL` at `infra/docker-compose.yml:30`).
- **NO Burrow compose override is needed.** The former plan step (`burrow/infra/docker-compose.burrow.yml` publishing to loopback) is **dropped** — the user already exposed the host port directly. The host-side dlv backend connects at `localhost:5432`; pgAdmin (container-to-container) reaches `nodewatch-db:5432`.
- **All three consumers** (backend `DATABASE_URL`, pgAdmin `servers.json`, deferred native explorer connection string) point at this one instance. Credentials and DB name are **read from `infra/docker-compose.yml:9-12`, never guessed or hardcoded** (`nodewatch`/`nodewatch`/`nodewatch`).
- **The M6 orchestrator brings up this same instance** (`docker compose -f <infra compose> up -d --wait nodewatch-db`) — one `-f`, no override.

Every VERIFY below that touches the DB asserts the row written under dlv is the row pgAdmin shows — the single-instance guarantee is the thing being tested.

### The Full Stack Debugger, as one screen

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│  Burrow (Code-OSS fork) — Xcode-inspired theme, SF Mono, original icons              │
│                                                                                       │
│  ACTIVITY BAR          EDITOR / PANEL AREA                     RIGHT DOCK             │
│  ┌───────┐   ┌──────────────────────────────┐   ┌─────────────────────────────────┐ │
│  │ Files │   │  router.go  ← dlv breakpoint  │   │  FD isolation preview (webview) │ │
│  │ SCM   │   │  ● stopped, live locals       │   │  one <Component/> alone, live   │ │
│  │ Run   │   │  ▲ Cmd+B / F12 → gopls def    │   │  props editable, HMR, Watch     │ │
│  │ ─────  │   └──────────────────────────────┘   │  ticks on every React commit    │ │
│  │ 🐳 Docker (burrow-docker viewlet)          │   └─────────────────────────────────┘ │
│  │   Compose ▸ infra ▸ nodewatch-db (running) │                                       │
│  │   Images / Volumes / Networks              │   ┌─────────────────────────────────┐ │
│  │   right-click: start/stop/logs/exec/inspect│   │  pgAdmin (webview iframe :6110)  │ │
│  │ ─────  │                                   │   │  connected to nodewatch-db      │ │
│  │ 🗄 Database (pgAdmin surface)               │   │  SELECT … FROM nodewatch        │ │
│  └───────┘                                        └─────────────────────────────────┘ │
│                                                                                       │
│  STATUS BAR:  [⚡ Debug Full Stack]  ← one click fans out ↓  (canonical L4 entrypoint) │
└──────────────┬────────────────────────────────────────────────────────────────────┘
               │
   burrow-fullstack orchestrator (Layer 4, no new debug type)
               │
   ┌───────────┼────────────────────────────────┐
   ▼           ▼                                 ▼
 DB tier    Backend tier                      Frontend tier
 compose    vscode.debug.startDebugging       executeCommand
 up -d      ({type:'go'})  →  dlv dap :8080    ('burrow.frontendDebugger.open', mode=live)
 --wait     breakpoints on handlers            embedded Vite → /api/nodewatch → :8080
 (single    env AUTH0_DOMAIN='' no-auth        FD /api/netlog captures X-Request-Id
  instance)   │                                 │
   │           │                                 │
   └── postgres nodewatch-db:5432 ◄── pgxpool ──┘  ⨝  Request Trace joins
       (infra, volume nodewatch_pgdata,             netlog ⨝ dlv slog on X-Request-Id
        loopback-published by Burrow override)      (requires backend slogs the id — verify M0)
```

**The three seams that make it "full stack," not three tools in a trench coat:**
1. **Frontend → backend**: FD live mode proxies `/api/nodewatch` → `http://localhost:8080` (the dlv-debugged Go backend) — `targetServer.js:97-108`, `api.js:75-84`.
2. **Backend → DB**: the Go backend under dlv connects `pgxpool` → the single `nodewatch-db:5432` (loopback-published) — `db.go:14`, `config.go:189`.
3. **The joining thread**: FD captures each fetch's `X-Request-Id` (`api.js:116-137`) and joins it against the backend's dlv-tracker slog — one request id visibly links a React click → a Go breakpoint frame → the DB rows it touched. **This payoff depends on the merkle backend actually propagating and slog-emitting `X-Request-Id`** — verified as an M0 baseline check (see F-Trace); if it doesn't, that backend change is a prerequisite sequenced before M5.

### Design/navigation layer (independent of the run control)
- **Xcode-inspired theme**: two color themes + one original-SVG icon theme in `extensions/burrow-theme-xcode`, made default via `burrow-core` `configurationDefaults`. SF Mono by name with Menlo/Monaco fallback. Palette is **original (Xcode-inspired), not a transcription of Apple's set**; product name is **"Burrow Dark (Xcode-inspired)" / "Burrow Light (Xcode-inspired)"**.
- **Go-to-def**: F12 / Cmd+click / Peek / references-view are **stock core built-ins already compiled in** — Go works today via gopls; only a new `burrow-ts-base` LSP client and a Cmd+B keybinding are missing.

---

## 2. Current state per pillar vs the gap

| Pillar | What EXISTS (cite) | The GAP |
|---|---|---|
| **Backend Go/dlv + orchestration** | `burrow-go-debug` registers debug type `go` as pure L4, spawns `dlv dap` on ephemeral port, bridges to intact workbench debug UI; launch/attach modes work; kill-safe teardown — `extension.ts:29-152`. Compounds/preLaunchTask/tasks runner all **intact** in core (only JS DAP stripped, `STRIP.md:121-123`). | `envFile` not honored by the provider (`extension.ts:57-82`) → merkle's envFile-only configs boot empty and `config.Validate()` fatals. Stock `Full stack: backend + Chrome` compound is **dead** (chrome stripped). No first-class "Full Stack" surface, and no Burrow-owned dynamic backend config resolved through the shared project-path resolver. |
| **Frontend isolation** | Isolation workbench ships (commit `8981e5bd`): real source in col One + live isolated preview beside (`isolation.ts:54-82`), served by target's own Vite `__isolate` middleware (`inspectorPlugin.js:227-284`), edit→HMR loop, live-editable props, rich fiber inspection (`agent.js:952-974`, `collectHooks:916-939`). Live mode proxies to dlv backend (`api.js:75-84`). | No JS breakpoints (js-debug stripped, `02-strip-to-go-only.md:49-50`) — accepted stance. Fiber inspection is a **one-shot snapshot**, doesn't tick on re-render. State not editable (only isolation props). Request Trace plumbed but no single visual seam yet, and backend `X-Request-Id` slog emission unverified. |
| **Docker viewlet** | Nothing yet — but the exact new-activity-bar-container pattern exists in `burrow-db/package.json:66-81` + `src/extension.ts:74`; execFile CLI boundary in `burrow-go-docs/runner.ts:13,53`; terminal exec in `burrow-oracle/extension.ts:257`. Built-in `docker` ext is grammar-only → no collision. | `burrow-docker` must be created from scratch. No `$(docker)` codicon (need original SVG). Daemon-down welcome needs an extension-set context key. Compose discovery must include stopped stacks. |
| **pgAdmin / DB** | FD panel proves the localhost-iframe-in-webview pattern (`panel.ts:69-79`, CSP `:75`); `sidecar.ts:14-21,191-203` proves compose-lifecycle + readiness polling. `burrow-db` has a native first slice (DSN parse, `PgQueryClient`, info_schema tree, grid — `query.ts`, `explorer.ts`, `panel.ts`), but `pg` is absent (`query.ts:122-129` throws). | Single-instance publishing not yet in place (`infra/docker-compose.yml:3-16` has no host port). pgAdmin route needs compose asset + X-Frame-Options/ServerMode config. **Only ONE DB surface ships on the critical path** (pgAdmin — the literal "pgAdmin integrated"); native explorer is deferred. |
| **Xcode theme** | Themes ship via built-in Themes-category extensions; `theme-defaults` is the exact shape (`package.json:14-79`); defaults live in core `workbenchThemeService.ts:42-47`; `burrow-core` already owns `configurationDefaults`. | No color themes, no icon theme, no SF Mono default. `burrow-core` doesn't pin `colorTheme/iconTheme/editor.fontFamily` yet. Palette must be original, not transcribed. |
| **Go-to-def** | Go **works today** via gopls (`burrow-go-base/extension.ts:62-79`, commit `2241f5a0`). All IntelliJ gestures are unmodified core built-ins (`goToCommands.ts:276,292,362,628`; `goToDefinitionAtPosition.ts`). `vscode-languageclient ^8.0.2` already resolved. | `typescript-language-features` **absent** → no DefinitionProvider for `.ts/.tsx`; F12/Cmd+click dead in the frontend. No Cmd+B keybinding. |

---

## 3. The lean critical path (M0…M8)

Ordered so each milestone is **independently demoable** and every step through M6 is **pure Layer 4 (zero new core patches)**. Design/nav pillars interleave because they unblock nothing and can land whenever.

| M | Milestone (demoable outcome) | Pillars | Layer | Ledger? |
|---|---|---|---|---|
| **M0** | **Smoke the done pieces + verify the seam prerequisite.** gopls hover/def + `go` dlv launch on merkle backend; FD tool renders merkle frontend with HMR + isolation; the backend propagates + slogs `X-Request-Id`. **VERIFIED 2026-07-21: seam gate GREEN** — `middleware.RequestID` mounted (`app.go:392`), honors + echoes the header (`middleware/request_id.go:31-35`), slogged as `request_id` (`middleware/logging.go:37-38`). No merkle change needed for M5. | backend, frontend | — | no |
| **M1** | **Backend debuggable against the single docker DB, configs unmodified.** Close the `envFile` gap (~10 lines in `burrow-go-debug` provider) so merkle's `envFile`-based configs boot. (Loopback-publish step **dropped** — the single `nodewatch-db` already exposes `5432:5432`, see §1.) Demo: run merkle's "Backend: debug (Auth0 OFF)" → breakpoint in a handler → `curl /healthz` → stop with live locals. | backend | L4 | no |
| **M2** | **DB demoable — pgAdmin integrated. DONE (container side live-verified).** `burrow.db.openPgAdmin` provisions + boots a managed pgAdmin container and opens it in a webview, auto-connected to the single db. Native `pg` explorer stays a deferred follow-up. | pgAdmin/db | L4 | no |
| **M3** | **Docker activity-bar viewlet. DONE (CLI layer live-smoked).** New `burrow-docker` extension: Containers grouped by compose project, Images/Volumes/Networks; start/stop/restart/remove, exec-to-terminal, follow-logs, inspect; daemon-down welcome via context key; visibility-gated poll. Drives the `docker` CLI (no dockerode). gulpfile row + patch-0001 ledger note. | docker | L4 | **tracked** |
| **M4** | **Frontend intellisense + IntelliJ nav complete.** New `burrow-ts-base` LSP client lights up F12/Cmd+click/Peek/Find-References in `.tsx`; `burrow-core` adds Cmd+B + `editor.multiCursorModifier:'alt'`. Go already worked. | go-to-def | L4 | **tracked†** |
| **M5** | **Live Watch + the three-together seam.** Fiber inspection ticks on every React commit (`onCommitFiberRoot`); Request Trace surfaces netlog ⨝ dlv slog on `X-Request-Id`. Demo: click component → live state ticks; a frontend fetch clicks through to the Go handler frame and the DB rows it wrote (same instance). | frontend, backend, three-tier | L4 | no |
| **M6** | **One-click orchestrator.** New thin **standalone** `burrow-fullstack` extension: status-bar `⚡ Debug Full Stack` fans out db-up-and-wait (single instance) → `startDebugging({type:'go'})` → FD open in live mode → combined status tree. **This ships the whole vision with no core patch.** | orchestration | L4 | **tracked†** |
| **M7** | **Xcode-inspired look.** `burrow-theme-xcode` (2 original color themes + original icon theme); `burrow-core` flips defaults + SF Mono. Optional onboarding-picker rows. | theme | L4 (+opt L1) | no |
| **M8** | **Engine hardening + optional title-bar home.** Task-04 dlv gauntlet (pinned dlv matched to the image Go toolchain, breakpoint matrix, panic decode). Optionally surface Full Stack in the **task-03 scheme bar** once its host lands. Package into the .app. | backend, orchestration | L4 (+ opt L3) | opt |

**† `tracked` — gulpfile ledger discipline (replaces the old "rides 0001, no entry" hand-wave).** M3/M4/M6 each add a brand-new `build/gulpfile.extensions.ts` compilation row (`burrow-docker`, `burrow-ts-base`, `burrow-fullstack`). Do **not** assume these silently ride patch 0001 just because `check-ledger.js:18-20` is coarse. At land time, **confirm against patch 0001's stated intent** whether "add a new curated extension compilation row" is in-scope:
- **If in-scope** → extend patch **0001's ledger note/description to enumerate each new row** in the same change that adds the row. One tracked update per new extension.
- **If out-of-scope** → allocate a real `patches/NNNN` entry (next-free-at-land-time) with `check-ledger.js` passing.

Either way each gulpfile touch is a tracked, reviewed change — never an untracked accumulation under a stale umbrella.

### The ONE likely core patch — and why the Full Stack run control does NOT need it

The only genuinely-new core patch in this neighborhood is the **task-03 scheme-bar toolbar host — patch `0010`-or-next-free in `src/vs/workbench/browser/parts/titlebar/titlebarPart.ts`** (`task-03-plan.md:13`, a generic <40-line host mount, ledger row + `check-ledger.js` required).

**The Full Stack run control ships WITHOUT it.** The orchestrator is a Layer-4 command driven from a **status-bar item + command palette + Run menu** (M6), because:
- Compounds/preLaunchTask/tasks-runner are all intact core — no patch needed to sequence backend+db.
- The FD frontend leg is an **extension command, not a debug-adapter type**, so a stock `compounds` array structurally cannot include it — a sequencing command is the clean single entrypoint.
- The scheme-bar host is therefore **optional polish**: once the host lands for task-03, the *identical* `burrow.fullstack.debug` command becomes one extra scheme-model row in `burrow-go-core` (a few lines, **no new patch**).

**End-state for the two Full-Stack surfaces (dedupe, explicit):** the **status-bar `⚡ Debug Full Stack` item is the canonical L4 entrypoint and is retained**. If/when the scheme-bar host lands, the scheme-bar row is an **alternate surface invoking the same one `burrow.fullstack.debug` command** — one command, two surfaces, no second implementation. This is intentional, not accidental duplication.

**Contested-0010 warning** (reconcile before any core patch lands): task-03 (scheme bar), task-13 (entitlements trim), task-15.4 (FD bundle) each independently name their next patch `0010`, but disk already holds `0001-0009`. **Rule: allocate next-free-at-land-time (0010/0011/0012 by land order); fix the stale `patches/README.md` table (0001-0005 → 0001-0009) in the same change.**

---

## 4. Per-pillar detailed, agent-executable steps

Each step lists new/changed files, exact contribution points, concrete config, the **VERIFY** gate, its **layer**, and whether a **ledger** entry is needed. Standing gates: `gulp compile-extension:<name>`, `npm run typecheck-client` (only if a core patch is touched), `cd burrow/tools/frontend-debugger && npm run oracle` (must be `0 FAIL` for any FD change), `node build/burrow/check-ledger.js`, live CDP/Playwright via the `launch` skill.

---

### 4.1 Backend + orchestration `[L4]`

**B1 — Close the envFile gap** *(backend M1)* `[L4, no ledger]`
- **Change**: `burrow-go-debug/src/extension.ts` `GoDebugConfigurationProvider.resolveDebugConfiguration` (`:57-82`). When `config.envFile` is set, read+parse the dotenv file(s) and merge **under** `config.env` — **inline `env` wins on conflict** (matches launch.json's documented precedence). Keep it vscode-free/synchronous.
- **Why it matters**: merkle's `Backend: debug (Auth0 ON)` has *only* `envFile`; without the merge it boots empty and `config.Validate()` fatals. **Risk guard**: a naive merge letting envFile win would re-enable the Auth0 boot-refuse path on the `Auth0 OFF` config (which layers `env` over `envFile`) — inline env MUST win.
- **VERIFY**: `gulp compile-extension:burrow-go-debug` + typecheck; run merkle's envFile-only config against a filled `auth0.env`, confirm `config.Validate()` passes.

**B2 — Single-instance DB publish + Burrow dynamic backend config** *(backend M1)* `[L4, no ledger]`
- **No merkle commit.** The old draft committed a `launch.json`/`tasks.json` into merkle; that violated the "never hardcode `../merkle`" invariant and duplicated B3. Instead:
  - **New (Burrow-owned)**: `burrow/infra/docker-compose.burrow.yml` — an override that adds `ports: ["127.0.0.1:5432:5432"]` to the `nodewatch-db` service (`infra/docker-compose.yml:3-16`). This is the single-instance loopback publish; it touches no merkle file.
  - **New (Burrow-owned)**: a `DebugConfigurationProvider` `provideDebugConfigurations` (dynamic) in `burrow-go-debug` (or contributed by `burrow-fullstack`) that **resolves the selected project's backend path via the same project-path resolver the FD tool uses** — never a hardcoded `../merkle`. It returns the inline `go` config: `type:go, request:launch, mode:debug`, `program+cwd = <resolvedProject>/nodewatch/backend`, env `DATABASE_URL=postgres://<user>:<pass>@localhost:5432/<db>?sslmode=disable` (**user/pass/db read from `infra/docker-compose.yml:3-16`, not literal-guessed**), `PORT=8080`, `NODEWATCH_DEV_NO_AUTH=1`, `AUTH0_DOMAIN=""`, `AUTH0_AUDIENCE=""`, `CORS_ORIGINS=""`, `NODEWATCH_SIGNUP_MODE=open`.
  - **This is the ONE definition** of the backend config. B3's orchestrator reuses this exact object — there is no second copy.
- **DB bring-up** is a task/step owned by the orchestrator (B3), not a merkle `tasks.json`: `docker compose -f <resolvedProject>/infra/docker-compose.yml -f burrow/infra/docker-compose.burrow.yml up -d --wait nodewatch-db` (the `--wait` gates on infra's existing healthcheck; fallback: `pg_isready` poll loop if compose is too old).
- **VERIFY** (via `launch` skill): cold start (db down) → run the dynamic config → backend connects only after the single `nodewatch-db` is healthy, no connection-refused; breakpoint in an ingest handler stops with live variables; **write a row under the breakpoint and confirm it is visible via pgAdmin (M2) — same instance/volume**.

**B3 — Orchestrator command (standalone extension)** *(orchestration M6)* `[L4, tracked gulpfile row]`
- **New standalone extension** `extensions/burrow-fullstack/`: `src/extension.ts`, `package.json`, `tsconfig.json`. **Standalone (not folded into burrow-core)** → it needs its own **`build/gulpfile.extensions.ts` compilation row** (`'extensions/burrow-fullstack/tsconfig.json'`, alphabetical ~`:60`) — covered by the **tracked** ledger reconciliation in §3.
- **Contribution points**:
  - `contributes.commands`: `burrow.fullstack.debug`, `burrow.fullstack.stop`.
  - `contributes.menus`: `commandPalette` (title `Burrow: Debug Full Stack`) + Run menu item + a `StatusBarItem` "⚡ Debug Full Stack" (matches FD's status-bar idiom) — **the canonical entrypoint, retained even if a scheme-bar row is later added**.
  - `tasks` / `vscode.tasks.registerTaskProvider` for the single-instance db-up + `pg_isready` poll (works even when merkle has no tasks.json).
- **Sequence** (public API only): (1) run db-up task against the single instance (`infra` + `burrow.burrow.yml` override), await `pg_isready` healthy; (2) `vscode.debug.startDebugging(folder, <B2 inline go config>)` and await `onDidStartDebugSession` — **call by TYPE `'go'`, never re-register the type**, so task-04's engine swap is transparent; (3) set `burrow.frontendDebugger.mode=live` + `backendTarget=http://localhost:8080`, `executeCommand('burrow.frontendDebugger.open')`; (4) show combined status tree. `stop` = stopAll sessions + `burrow.frontendDebugger.stop` + optional `docker compose … stop nodewatch-db`.
- **Do NOT** use a launch.json `compounds` including the FD leg (would need a core patch to teach the compound runner a non-debug member).
- **VERIFY**: `gulp compile-extension:burrow-fullstack`; `node build/burrow/check-ledger.js` OK; one status-bar click brings up the single db → dlv backend stopped-ready → FD live panel showing real data; `burrow.fullstack.stop` leaves no orphan dlv/vite/container.

**B4 — Task-04 engine hardening** *(backend M8)* `[L4 for the engine; author the missing task-04 plan first]`
- **Pin dlv to a real, released version whose `go.mod` matches the ide image's `GO_VERSION` under `GOTOOLCHAIN=local`** — the exact rule that broke the build with gopls v0.22.0 requiring go 1.26. Do **not** assert an unverifiable number: at authoring time, select the newest Delve tag that builds against the image's pinned Go, pin *that*, and record the pin next to the gopls pin. Drop the host fallback under `useSystem` before the fixture gauntlet (host dlv unpinned today, `extension.ts:40-51`).
- Verify breakpoint matrix (conditional/hitCondition/logpoints/function-by-symbol/watchpoints) headlessly via DAP scripting on a `testdata/debuggee` fixture; add panic-value decode + panicked-goroutine selection; `substitutePath` UI for remote/container attach; route build failures to Problems; demux program vs debugger output.
- **VERIFY**: fixture gauntlet green in CI + all seven NodeWatch launch configs debug unmodified (`04-delve-debugging-engine.md:91`); the pinned dlv builds against the image Go toolchain (no `@latest`, no toolchain mismatch).

---

### 4.2 Frontend isolation `[L4 — FD changes land `.claude/memory/*.yaml` in the same change, `oracle 0 FAIL`]`

> **Product stance to confirm with PM**: no JS breakpoints (js-debug is stripped). The debugging model is inspect + HMR + live-backend + Request Trace, not stepping. Fallback for a true single-statement pause is the developer's own browser at the loopback Vite URL — never a bundled adapter.

**F-Trace — Backend `X-Request-Id` prerequisite check** *(M0 baseline, gates M5)*
- **VERIFY (no code if it passes)**: confirm the merkle Go backend **propagates and slog-emits `X-Request-Id`** end-to-end (middleware reads/sets it; handlers log it). Inspect the request middleware + slog setup. If it does NOT, **the M5 Request Trace join has nothing to match on** → a merkle backend change (add id propagation + structured log field) becomes a prerequisite and must be sequenced **before** M5 (with its own cross-repo commit/branch rule, per §5). Record the outcome in the M0 checklist.

**F1 — Live Watch** *(frontend M1 — biggest win)*
- **Change**: `tools/frontend-debugger/agent/agent.js` — re-emit the tracked fiber's `describeFiber` payload on `onCommitFiberRoot` (`agent.js:134-136`), **throttled (rAF/coalesce), only for the currently-tracked id**, as a new event `send({type:'inspectUpdate'})`. UI in `ui/src` subscribes and live-updates props/hooks/state.
- **Guard (agent invariant)**: never throw/degrade into the embedded app; installs before React and before devMock; plain ES2018.
- **VERIFY**: add the new event to `protocol.yaml` **in the same change** (machine-enforced) → `npm run oracle` `0 FAIL`; `npm run build && npm run verify` (Playwright asserts a state change reflects without re-select).

**F2 — Editable state** *(frontend M2/M5)*
- **Change**: new agent command `case 'setHook'` calling `hook.queue.dispatch` on the live fiber for a `useState/useReducer` slot (`agent.js:913`) — **guard behind shape checks + try/catch; degrade to read-only if shape unrecognized** (React-internals fragility). Inline-edit affordance in the Watch/Hooks UI; keep isolation props editable.
- **VERIFY**: command added to `protocol.yaml` → `oracle` green; Playwright asserts an edited hook value re-renders the target.

**F3 — Isolation "feels like debugging"** *(frontend M5)*
- **Change**: `server/inspectorPlugin.js` (`:110-213`) — render-count badge + effect-fire log + a scoped eval/logpoint input over the existing `__burrowIsoCmd` postMessage channel; surface in the preview toolbar (`isolation.ts` `buildPreviewHtml`, `:149-214`).
- **VERIFY**: `gulp compile-extension:burrow-frontend-debugger` typechecks; `oracle` green; badge ticks on prop edits.

**F4 — Docs honesty pass** *(frontend M5, doc-only, no ledger)*
- Update `docs/architecture/15-frontend-debugger.md`: state the no-JS-breakpoints stance; note merkle's `Frontend: debug in Chrome` + `Full stack: backend + Chrome` compound are non-functional in Burrow, point users to the FD tool.

---

### 4.3 Docker viewlet `[L4 — one new gulpfile row is a tracked change (§3)]`

**D0 — Scaffold** *(docker M0)*
- **New**: `extensions/burrow-docker/{src,resources,test}`; copy `tsconfig.json` + esbuild shape from `burrow-db`; `package.json` (publisher `burrow`, engines `^1.128.0`, `main ./out/extension.js`, `activationEvents ['onView:burrowDockerContainers']`). Original monochrome 24×24 `resources/docker.svg` (whale) — **no `$(docker)` codicon exists**; fallback `$(server-environment)`.
- **One line** in `build/gulpfile.extensions.ts` compilations[] (~`:60`, alphabetical): `'extensions/burrow-docker/tsconfig.json'`. **This is a tracked ledger change** — extend patch 0001's note to enumerate it (or allocate a `patches/NNNN`), per §3.
- **VERIFY**: `gulp compile-extension:burrow-docker` builds; `node build/burrow/check-ledger.js` stays OK **and** the 0001 note (or new patch) now names this row.

**D1 — CLI boundary** `src/docker.ts` — `execFile('docker', argv)` (no shell) behind injectable `type ExecFileFn` (copy `burrow-go-docs/runner.ts:13,25,53`). Functions: `listContainers/Images/Volumes/Networks()`, `inspect(id)`, `composeLs()`, `composePs(project)`, lifecycle `start/stop/restart/remove(id)`, plus `daemonOk()` (wraps `docker version`), each parsing `--format '{{json .}}'`. Unit-test against a fake `ExecFileFn` (`node test/docker.test.js`). **Reject dockerode** (no compose support, adds dep + raw-socket handling).

**D2 — Containers view** `src/containers.ts` TreeDataProvider (clone `burrow-db/src/explorer.ts`): node union `group|project|container|message`; root = Compose group (`compose ls`) + Other group; project expands to service containers (`ps --filter label=com.docker.compose.project=<name>`); `contextValue` = `container.running`/`container.stopped`; `iconPath` ThemeIcon `vm-running`/`vm`. **Register via `window.createTreeView` (not `registerTreeDataProvider`)** to get `.visible`/`onDidChangeVisibility` for poll-gating.
- **Contribution points**: `viewsContainers.activitybar` `[{id:'burrow-docker',title:'Docker',icon:'resources/docker.svg'}]` (precedent `burrow-db/package.json:66-73`); `views['burrow-docker']` = Containers/Images/Volumes/Networks.

**D3 — Lifecycle + inspect + logs** — `contributes.commands` `burrow.docker.{refresh,start,stop,restart,remove,logs,inspect}` each `$(...)`; `menus.view/title` (refresh, group `navigation`); `menus.view/item/context` gated `when: viewItem =~ /container.(running|stopped)/` (start only on stopped; stop/restart/exec/logs only on running). logs → `createTerminal` running `docker logs -f <id>`; inspect → `docker inspect` JSON in untitled read-only editor.

**D4 — exec-into** — `burrow.docker.exec` → `window.createTerminal({name:'docker: '+name, shellPath:'docker', shellArgs:['exec','-it',id,'sh']}); t.show()` (precedent `burrow-oracle/extension.ts:257`) — docker exec becomes the terminal's own process. **Fallback to bash** if `sh` absent.

**D5 — Images/Volumes/Networks + daemon-down (with context key)** — three small providers under the same container. **Daemon-down welcome needs an extension-set context key**: on `execFile` failure of `daemonOk()`/`ps` (poll or on-demand), call `vscode.commands.executeCommand('setContext','burrow.docker.daemonReachable', false)`; **clear it (`true`) when the daemon returns**. `contributes.viewsWelcome` for the Containers view gates its `when` on `!burrow.docker.daemonReachable` (precedent `git/package.json:4274` — but note viewsWelcome renders only on an empty tree gated by `when`, so the key is mandatory).

**D6 — Refresh loop** — first slice: `contributes.configuration` `burrow.docker.pollSeconds` (default ~5s) + `burrow.docker.composeFile`; **visibility-gated `setInterval`** firing `onDidChangeTreeData` only while a view is `.visible`; title `$(refresh)`. Upgrade: `spawn('docker',['events','--format','{{json .}}'])` debounced repaint, **tracked in `context.subscriptions`, killed on deactivate**.

**Risk guards**: `docker compose ls` omits fully-stopped stacks → also group by `com.docker.compose.project` label on `ps -a` and read `burrow.docker.composeFile` (default merkle `infra/docker-compose.yml`). Long-lived `logs -f`/`events` MUST be disposed on deactivate.
- **VERIFY** each: `launch` skill → open the Docker icon, see `nodewatch-db` under Compose; stop a container → tree repaints; exec into `nodewatch-db`, run `psql`; **stop the daemon → context key flips false → welcome renders; restart → key flips true → tree returns**.

---

### 4.4 pgAdmin / DB `[L4, no ledger]`

> **Ship exactly ONE DB surface on the critical path: Option A (pgAdmin webview).** It *is* "pgAdmin integrated," is the least Burrow code, and directly matches the verbatim vision. It reads the **single** `nodewatch-db` instance. The native `pg` explorer (Option B) is an explicit **deferred follow-up**, not built or verified for the demo — do not land both on the critical path.

> **DELIVERED (2026-07-21) — leaner than drafted.** Because the single db now publishes `5432` on the host, pgAdmin connects over **`host.docker.internal:5432`** and needs **no attachment to merkle's compose network** (the network-name-detection fragility is gone). Files shipped in `extensions/burrow-db`: `tools/db-admin/docker-compose.yml` (`dpage/pgadmin4:8`, desktop mode, `X_FRAME_OPTIONS=''`, port `127.0.0.1:6110`, `extra_hosts host.docker.internal:host-gateway`), a git-ignored `servers.json`+`pgpass` **generated** from the resolved DSN by pure `src/pgadminConfig.ts` (8 unit tests — host-rewrite, PassFile-not-inline), the `src/pgadmin.ts` controller (resolve connection → provision → `docker compose up` → poll `/misc/ping` → webview), and `burrow.db.openPgAdmin`/`stopPgAdmin` + the explorer title button. **Live-verified headless:** container boots (17s), `/misc/ping` 200, **X-Frame-Options absent → iframe-embeddable**, "Added 1 Server(s)" from `servers.json`, and pgAdmin reaches `host.docker.internal:5432`. Only the in-Burrow webview render is unverified (proven FD-panel pattern). The bullets below are the original draft, kept for context.

**Option A — pgAdmin in a webview** *(db M2 — the ONE surface)*
- **New**: `burrow/extensions/burrow-db/tools/db-admin/docker-compose.yml` — service `pgadmin` (`dpage/pgadmin4:8`), env `PGADMIN_CONFIG_SERVER_MODE="False"`, `PGADMIN_CONFIG_MASTER_PASSWORD_REQUIRED="False"`, `PGADMIN_CONFIG_X_FRAME_OPTIONS="''"`, `PGADMIN_CONFIG_WTF_CSRF_ENABLED="False"`, `PGADMIN_DEFAULT_EMAIL=burrow@local`, `PGADMIN_DEFAULT_PASSWORD=burrow`; `ports ["127.0.0.1:6110:80"]`; mounts `./servers.json:/pgadmin4/servers.json:ro` + `./pgpass:/pgadmin4/pgpass:ro`; attaches to **infra's compose network as `external`** so it reaches the single `nodewatch-db` container-to-container (**resolve the real network name at command time via `docker network ls`, or expose `burrow.db.pgadmin.network` — never hardcode; likely `infra_default`**).
- **New**: `servers.json` (Name `NodeWatch (merkle)`, Host `nodewatch-db`, Port 5432, user + PassFile `/pgpass` — **user/db read from `infra/docker-compose.yml:3-16`**) + `pgpass` line `nodewatch-db:5432:<db>:<user>:<pass>` (**chmod 600, never in a published artifact**). pgAdmin reaches the single db over the compose network, so **no merkle change needed**.
- **New**: `extensions/burrow-db/src/pgadmin.ts` — clone `burrow-frontend-debugger/src/panel.ts:36-91`: `createWebviewPanel('burrow.db.pgadmin', …, {retainContextWhenHidden:true})`, CSP `default-src 'none'; frame-src http://127.0.0.1:6110; style-src 'unsafe-inline'`, iframe `http://127.0.0.1:6110/browser/`. Compose lifecycle helper: `cp.spawn('docker compose … up -d pgadmin')` + poll `GET /misc/ping` for pong (mirror `sidecar.ts:14-21,191-203`) with a **readiness spinner** (~450MB image, 10-30s boot).
- **Contribution points**: `contributes.commands` `burrow.db.openPgAdmin` (+ optional `stopPgAdmin`); `menus.view/title` "Open pgAdmin" button when `view == burrowDbExplorer` (`package.json:81-92`); `activationEvents onCommand:burrow.db.openPgAdmin`.
- **Risk guards**: verify **embedded** load (not just a browser tab) before building further — if a pgAdmin version tightens `frame-ancestors` beyond env's reach, fall back to `vscode.env.openExternal`. Docker-absent → name the exact `docker compose up` command in the error (no auto-install, `sidecar.ts:173`).
- **VERIFY**: `docker compose … config -q` passes; `gulp compile-extension:burrow-db`; run command → pgAdmin tree loads embedded, NodeWatch server auto-connected to the **single** `nodewatch-db`; a row written by the dlv backend (B2) appears here; kill Docker → clear directive error, not a dead iframe.

**Option B — native `pg` explorer `[DEFERRED follow-up, NOT on the critical path]`**
- When taken up later: add `"dependencies": { "pg": "^8.13" }` to `burrow-db/package.json` (**pure-JS path — never `pg-native`**, keeps notarization clean); `npm install` so `query.ts:122 require('pg')` resolves; point its connection string at the **same** loopback-published `nodewatch-db` (`localhost:5432`, from `burrow/infra/docker-compose.burrow.yml`). It then coexists behind the same `Database` viewlet (native tree = read-only-by-default; pgAdmin button = full admin surface). Not built or verified for the demo.

---

### 4.5 Xcode-inspired theme `[L4 new extension + burrow-core flip; optional L1 onboarding; NO ledger — burrow-* and product.json excluded, check-ledger.js:19-24]`

**T1 — Scaffold** `extensions/burrow-theme-xcode/package.json`: name `burrow-theme-xcode`, publisher `burrow`, categories `['Themes']`, engines `*`.
- `contributes.themes[]` = `[{id:'Burrow Dark (Xcode-inspired)',label:'Burrow Dark (Xcode-inspired)',uiTheme:'vs-dark',path:'./themes/burrow-dark.json'},{id:'Burrow Light (Xcode-inspired)',label:'Burrow Light (Xcode-inspired)',uiTheme:'vs',path:'./themes/burrow-light.json'}]`. (No `Xcode` trademark in the product-visible name.)
- `contributes.iconThemes[]` = `[{id:'burrow-icons',label:'Burrow Icons',path:'./fileicons/burrow-icon-theme.json'}]`.

**T2 — Color themes** `themes/burrow-{dark,light}.json` (`$schema vscode://schemas/color-theme`). **INLINE base colors** (avoid brittle cross-extension `include`). Fill chrome `colors{}` + `tokenColors[]` scopes.
- **IP guardrail — ORIGINAL palette, VALUES only.** Author an **original Xcode-*inspired* palette** (functional dark/light editor colors in the same visual family) — do **not** transcribe Apple's exact Default Dark/Light hex set as a copied group. Color values individually aren't copyrightable; the point is to ship *our* functional palette, tuned by eye, not a duplicated file. Target the same roles below, choosing our own nearby values:
  - **Dark**: near-black editor bg, soft off-white fg, subtle line highlight, translucent accent selection, white cursor; muted comment; magenta/pink keyword; warm coral string; olive/gold number; violet language-constant; teal/mint function; cyan type-or-class; coral tag/attr; amber preprocessor; deep chrome bg with a blue accent + focus border. Include `storage.type.*.go` in the type scope.
  - **Light**: white editor bg, near-black fg, pale-blue line highlight, light-blue selection, black cursor; slate comment; magenta keyword; red string; deep-blue number; violet language-constant; purple function; navy type; brown preprocessor; light chrome bg, blue accent.
  - (minimap disabled by burrow-core — skip minimap keys.)

**T3 — Icon theme** `fileicons/burrow-icon-theme.json` in the **minimal-SVG format** (mirror `theme-defaults/fileicons/vs_minimal-icon-theme.json`, **not** the seti woff). `iconDefinitions{}` of ~15-20 **original hand-authored** 16px SVGs (rounded-square tile + language monogram in accent hues — an original style inspired by, not traced from, Xcode artwork) under `fileicons/images/`; `fileExtensions{go,ts,tsx,js,jsx,json,sql,md,yaml,yml,css,html,png,svg,mod,sum,sh,txt}`, `fileNames{go.mod,go.sum,Dockerfile,Makefile,package.json,.env}`, `languageIds{go,typescript,typescriptreact,json,sql}`, plus a `light:` override block.

**T4 — Flip the default** in `burrow-core/package.json contributes.configurationDefaults`: `workbench.colorTheme:'Burrow Dark (Xcode-inspired)'`, `preferredDarkColorTheme:'Burrow Dark (Xcode-inspired)'`, `preferredLightColorTheme:'Burrow Light (Xcode-inspired)'`, `iconTheme:'burrow-icons'`, `editor.fontFamily:'"SF Mono", Menlo, Monaco, "Cascadia Code", monospace'`. L4 override wins over core `ThemeSettingDefaults` (`workbenchThemeService.ts:42-47`) with no src/ patch.

**T5 — (optional, L1, no ledger)** add `{id:'burrow-dark',label:'Burrow Dark (Xcode-inspired)',themeId:'Burrow Dark (Xcode-inspired)',type:'dark'}` + light to `product.json onboardingThemes[]`. **Skip** the core `INITIAL_COLORS` splash patch — only cost is a ~1-frame flash.
- **VERIFY**: `gulp compile-extension:burrow-theme-xcode` + `:burrow-core` clean; launch on a **fresh `--user-data-dir`** → boots Burrow Dark + Burrow icons + SF Mono; toggle OS appearance → preferredLight swaps; `make ledger-check` → 0 findings; eyeball `.go/.tsx/.sql/.json` icons at 16px. **SF Mono is referenced by NAME only, never bundled; the `Menlo → Monaco → monospace` fallback must render cleanly on a machine without SF Mono exposed.**

---

### 4.6 Go-to-def (Go done / TS gap) `[L4]`

**N1 — Go: verify only** `[no ledger]` — open a merkle backend `.go`, confirm gopls up (`burrow.go.restartLanguageServer`), F12 + Cmd+click jump, Alt+F12 peeks. `gulp compile-extension:burrow-go-base` clean. **No code.**

**N2 — Keybindings in `burrow-core`** `[no ledger]` — `contributes.keybindings[]`: `{command:'editor.action.revealDefinition', key:'cmd+b', mac:'cmd+b', win:'ctrl+b', when:'editorTextFocus && editorHasDefinitionProvider'}` (covers Go **and** TS — language-agnostic); optional `cmd+alt+b → editor.action.goToImplementation`. `contributes.configurationDefaults`: `editor.multiCursorModifier:'alt'` so Cmd+click = definition, not multicursor.
- **Note/risk**: Cmd+B overrides upstream `toggleSidebar` — intentional IntelliJ parity; keep sidebar toggle on the existing `cmd+alt+d` (`burrow-core/package.json:39-40`) and document it.
- **VERIFY**: `gulp compile-extension:burrow-core`, reload, Cmd+B jumps in a `.go` file.

**N3 — New `burrow-ts-base` LSP client** `[L4 — one new gulpfile row is a tracked change (§3)]` — copy `burrow-go-base` structure: `package.json` (engines `^1.128.0`, `activationEvents onLanguage:typescript/typescriptreact/javascript/javascriptreact`, deps `vscode-languageclient ^8.0.2` [already resolved] + `typescript-language-server` + `typescript`), `src/extension.ts`, `src/tslsp.ts`. **Add the tsconfig row to `build/gulpfile.extensions.ts`** (`'extensions/burrow-ts-base/tsconfig.json'`) — **tracked**: extend patch 0001's note to name it (or allocate `patches/NNNN`), per §3.
- **Client** (`extension.ts`): mirror `burrow-go-base/extension.ts:62-79` — `ServerOptions` spawning `typescript-language-server --stdio` (this server **does** want `--stdio`, unlike gopls — set transport accordingly), `documentSelector` for the four TS/JS languages, `initializationOptions` pointing tsserver at the selected project's `typescript`.
- **Resolver** `tslsp.ts` (mirror `gopls.ts:47-73`): `BURROW_TS_LSP_PATH → <project>/node_modules/.bin/typescript-language-server → PATH`; single actionable message + `burrow.ts.restartLanguageServer` if missing.
- **Invariant**: re-point at the **selected project's** node_modules via the same project-path resolution the FD tool uses — **never hardcode `../merkle`**.
- **Prefer this over re-vendoring Microsoft's `typescript-language-features`** (heavy, rebase-hostile). For go-to-def/hover/references the community server is complete.
- **VERIFY**: `gulp compile-extension:burrow-ts-base` 0 errors; `check-ledger.js` OK and the 0001 note (or new patch) names the row; `typecheck-client` unaffected; open `merkle/nodewatch/frontend/src/App.tsx` → F12/Cmd+click resolves, Shift+F12 lists references via `references-view`; Cmd+B jumps.

**N4 — Core-patch check (explicit)** — grep confirms F12 (`goToCommands.ts:276/292`), Alt+F12 peek (`:362`), Cmd+click (`goToDefinitionAtPosition.ts`), Shift+F12 (`references-view`) are stock/untouched → **no `patches/NNNN` entry** for the gestures (the only tracked item here is the gulpfile row in N3).

---

## 5. IP / leanness guardrails

**IP boundaries (explicit, enforced in review):**
- **SF Mono — by NAME, never bundled.** `editor.fontFamily` lists `"SF Mono"` as a string so macOS resolves the installed system font; **never ship `SFMono-*.otf`**; always provide the `Menlo → Monaco → monospace` fallback and verify it renders on a machine without SF Mono exposed.
- **Icons — ORIGINAL only.** Every SVG glyph is hand-authored in an Xcode-*inspired* style (rounded-square tile + language monogram in accent hues). **Do not extract/trace/redistribute Apple's Xcode artwork; do not reuse the seti woff.**
- **Colors — ORIGINAL VALUES only.** Ship our own functional Xcode-*inspired* Dark/Light palette (values tuned by eye, not a transcription of Apple's exact set). Color values aren't copyrightable, but we deliberately do not copy the theme *file* or the exact set as a group.
- **Naming — avoid the trademark.** Product-visible theme names are **"Burrow Dark (Xcode-inspired)" / "Burrow Light (Xcode-inspired)"**, not "Xcode" (Apple trademark). "Xcode-inspired" is descriptive/nominative.

**Leanness forks (chose the leaner side each time):**
- **Docker: `docker` CLI via `execFile`, NOT dockerode** — dockerode has no compose support (compose is CLI-only, mandatory for the compose tree), adds a dep + raw-socket handling. **Do not vendor MS `vscode-docker`** — thousands of lines + marketplace dep; the built-in `docker` ext already provides Dockerfile/compose grammar. Target: ~5 small src files + one package.json + one **tracked** gulpfile line.
- **TS: focused `typescript-language-server` client, NOT re-vendored `typescript-language-features`** — LSP-uniform with the gopls path, cheap to re-pin; one **tracked** gulpfile line.
- **DB: ONE surface on the critical path — pgAdmin webview** (~40 lines compose + ~150 lines webview), the literal "pgAdmin integrated," reading the single `nodewatch-db`. Native `pg` explorer is **deferred** (pure-JS `pg` only, **never `pg-native`**), not built for the demo.
- **Single Postgres, single volume** across backend, pgAdmin, orchestrator — a Burrow-owned compose override (`burrow/infra/docker-compose.burrow.yml`) publishes `infra`'s `nodewatch-db` to loopback; no merkle edit, no second instance, no split-brain data.
- **Orchestration: one thin standalone command gluing shipped pieces** — no vendored MS extensions, no js-debug revival, no new debug type. Call backend debug by TYPE `'go'` so task-04's engine swap is transparent. One inline backend config (B2), reused by the orchestrator — no duplicate definition, no merkle-committed launch.json/tasks.json.
- **dlv pin matched to the image Go toolchain** — pin a real released Delve whose `go.mod` matches `GO_VERSION` under `GOTOOLCHAIN=local`, mirroring the gopls pinning rule; never `@latest`, never an unverified version number.
- **Ledger discipline, not hand-waving** — every new `build/gulpfile.extensions.ts` row (`burrow-docker`, `burrow-ts-base`, `burrow-fullstack`) is a tracked change: confirm scope against patch 0001's intent, then either enumerate it in 0001's note (same change) or allocate a `patches/NNNN`. No silent accumulation.
- **Zero core patches for the demoable M0-M6.** The only new core patch (task-03 scheme-bar host, next-free number ≥0010) is optional title-bar polish for an **alternate surface of the same `burrow.fullstack.debug` command**; the status-bar item stays the canonical entrypoint. Reconcile the contested-0010 collision (03/13/15.4) by land-order allocation and fix the stale `patches/README.md` in the same change.

**Cross-repo rule (only if unavoidable):** the deliverables live in `burrow/` and the debugger repo. If the **F-Trace** prerequisite forces a merkle-side backend change (X-Request-Id propagation/slog), that is the sole sanctioned merkle edit: it lands on merkle's current branch (never a new/switched branch), stages only the touched handler/middleware paths, author = user only (no `Co-Authored-By`), and is called out explicitly in the M0/M5 record. No other merkle files are committed by this plan.

---

## 6. Reorganized TODO checklist (ordered milestones)

**M0 — Baseline smoke + seam prerequisite (no code unless F-Trace fails)**
- [ ] Confirm gopls hover/def + `go` dlv launch on merkle backend (honoring no-auth env, `PORT=8080`).
- [ ] Confirm FD tool renders merkle frontend with HMR + isolation workbench.
- [ ] **F-Trace**: confirm the merkle backend propagates + slogs `X-Request-Id` (gate for M5). If not, sequence a merkle backend change before M5 under the cross-repo rule.

**M1 — Backend debuggable, single DB, configs unmodified `[L4]`**
- [ ] Merge `envFile` into `env` (inline `env` wins on conflict) in the `burrow-go-debug` provider — in `resolveDebugConfigurationWithSubstitutedVariables` so `${workspaceFolder}` in the envFile path is already resolved (`extension.ts:57-82`). Tiny inline dotenv parser (dep-light, no `dotenv` package).
- [ ] ~~Add a Burrow compose override~~ **DROPPED** — the single `nodewatch-db` already publishes `5432:5432` (§1); host-side dlv reaches `localhost:5432` directly.
- [ ] (Optional, defer unless demo needs it) `provideDebugConfigurations` offering a no-auth backend config resolved via the workspace folder (no `../merkle` hardcode) — M6 can instead invoke merkle's existing named config `"Backend: debug (Auth0 OFF)"`.
- [ ] VERIFY: `gulp compile-extension:burrow-go-debug` clean; run merkle's Auth0-OFF config → breakpoint stops with live locals; a row written here is later visible in pgAdmin (M2).

**M2 — DB demoable — pgAdmin integrated (ONE surface) `[L4]`**
- [ ] `db-admin/docker-compose.yml` (attached to infra network, external) + `servers.json` + `pgpass` (chmod 600) + `pgadmin.ts` webview + `burrow.db.openPgAdmin` command/button; creds read from `infra/docker-compose.yml:3-16`.
- [ ] VERIFY embedded load; NodeWatch server auto-connected to the single `nodewatch-db`; backend-written row appears.
- [ ] (deferred, off critical path) native `pg` explorer against the same loopback instance.

**M3 — Docker viewlet `[L4, tracked gulpfile row]`**
- [ ] Scaffold `burrow-docker` + **tracked** gulpfile row (extend 0001 note or new patch) + `resources/docker.svg`.
- [ ] `docker.ts` CLI boundary (execFile + fake-tested, incl. `daemonOk()`); Containers view (createTreeView, Compose grouping); lifecycle/logs/inspect/exec commands; Images/Volumes/Networks; **daemon-down context key + viewsWelcome gated on it**; visibility-gated poll (→ events stream upgrade).
- [ ] VERIFY: `nodewatch-db` under Compose; stop/start repaints; exec runs `psql`; daemon stop→key false→welcome; daemon start→key true→tree.

**M4 — Frontend intellisense + IntelliJ nav `[L4, tracked gulpfile row]`**
- [ ] Cmd+B keybinding + `editor.multiCursorModifier:'alt'` in `burrow-core`.
- [ ] New `burrow-ts-base` LSP client (project-relative resolver, no hardcoded merkle path) + **tracked** gulpfile row.
- [ ] VERIFY: F12/Cmd+click/Peek/Find-References in `App.tsx`.

**M5 — Live debugging loop + three-together seam `[L4]`**
- [ ] Live Watch: re-emit `describeFiber` on `onCommitFiberRoot` (throttled) + `inspectUpdate` event (+ `protocol.yaml` row, `oracle 0 FAIL`).
- [ ] Editable state: `setHook` agent command (shape-guarded) (+ `protocol.yaml`).
- [ ] Isolation render-count/effect-fire log + scoped eval.
- [ ] Request Trace surface: netlog ⨝ dlv slog on `X-Request-Id`, click-through to the Go handler frame + the DB rows it wrote (same instance). (Prerequisite: M0 F-Trace green.)
- [ ] Docs honesty pass (`15-frontend-debugger.md`).

**M6 — One-click orchestrator `[L4, tracked gulpfile row] — ships the whole vision, no core patch`**
- [ ] New **standalone** `burrow-fullstack` (+ **tracked** gulpfile row): `burrow.fullstack.debug` + `stop`, status-bar item (canonical entrypoint), Run menu, TaskProvider for single-instance db-up + `pg_isready`.
- [ ] Sequence: db-up-and-wait (single instance) → `startDebugging({type:'go'})` (reuse B2 config) → FD open live → status tree.
- [ ] VERIFY: one click brings up all three tiers on ONE Postgres + a live X-Request-Id join; stop leaves no orphans.

**M7 — Xcode-inspired look `[L4 + opt L1]`**
- [ ] `burrow-theme-xcode` (2 original color themes inlined + original icon theme), named "Burrow Dark/Light (Xcode-inspired)".
- [ ] Flip `burrow-core` defaults + SF Mono fontFamily (by name, fallback verified).
- [ ] (opt) `product.json onboardingThemes[]` rows.
- [ ] VERIFY on fresh `--user-data-dir`: boots Burrow Dark/icons/SF Mono; OS-appearance swap; ledger-check 0 findings.

**M8 — Hardening + optional title-bar home `[L4 + opt L3]`**
- [ ] Author task-04 plan; pin a **real** `dlv` version whose `go.mod` matches the image `GO_VERSION`/`GOTOOLCHAIN=local`; breakpoint-matrix gauntlet; panic decode; substitutePath; Problems routing; output demux. VERIFY seven NodeWatch configs unmodified.
- [ ] (opt) Once the task-03 scheme-bar host (next-free patch, reconcile contested-0010, fix stale README) lands, add a "Full Stack" scheme-model row in `burrow-go-core` invoking the **same** `burrow.fullstack.debug` (no new patch); **keep the status-bar item as canonical** — the scheme-bar row is an alternate surface, not a replacement.
- [ ] Package `tools/frontend-debugger` + (deferred) `pg` driver + `burrow-fullstack` into the darwin build (FD-bundle patch = next free number, not a second 0010).

**Cross-cutting discipline (every milestone):** stay on the current branch — never create/switch branches; stage explicit paths; author = user only, no `Co-Authored-By`; any core-source change ships its ledger entry in the same commit; every new gulpfile row is a tracked ledger change (enumerated in 0001's note or a `patches/NNNN`); FD changes land their `.claude/memory/*.yaml` rows (`oracle 0 FAIL`); update `.claude/memory/{api,env,repo}.yaml` for launcher/simulator/extension changes in the same change; the only sanctioned merkle edit is the F-Trace prerequisite under the cross-repo rule.