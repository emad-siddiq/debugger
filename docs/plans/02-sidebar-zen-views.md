# 02 — The left rail: seven items, seven finished views

> Workstream 2 of the [master plan](00-master-plan.md). Lands in `burrow/extensions/burrow-*`.
> Target: **every left-rail item opens one calm, organized view** that answers exactly one
> question, with one primary action and a designed empty state.

---

## Part 1 — Technical summary (for product review)

The rail currently has ten-plus icons and the views behind them were each built by a different
task, at a different time, to a different shape: some are four stacked trees (Docker), some are a
single tree with hidden power (Database), one is a tree that silently boots a dev server
(Components). Nothing is *wrong*; nothing is *finished*. That mismatch is what reads as
"overwhelming".

Two moves fix it.

**Move 1 — a written view contract.** Six rules (below) that every view must satisfy, each of
them checkable in a screenshot. This is deliberately boring: one purpose, one primary action, at
most two expanded sections, one designed empty state, one density, no decoration.

**Move 2 — consolidate ten icons to seven**, grouped by *what you are doing*, not by which task
built them:

| # | Rail item | Answers | Absorbs |
|---|---|---|---|
| 1 | **Files** | "where is the code?" | Explorer + Oracle notes |
| 2 | **Find** | "where is *this*?" | Search (the one search bar, file `01`) |
| 3 | **Source** | "what have I changed?" | Source Control |
| 4 | **Run** | "does it work?" | Full Stack launcher + Tests + debug config |
| 5 | **API** | "what does the backend expose, and what did it answer?" | API Flows (routes) + HTTP workbench |
| 6 | **Data** | "what is in the database, and what is running?" | Database + Docker |
| 7 | **Components** | "what does the UI look like, alone and in the app?" | Frontend debugger |

The right dock keeps its two tenants: the **debug inspector** during a session, and the
**Agent** (file `03`). Nothing is deleted — Docker and Tests become named sections inside their
new home, one click from where they were.

Cost: ~1 day per view for the six that need real work (Files and Source are nearly compliant
already), and they parallelize almost perfectly — one agent per view (see `06`).

---

## Part 2 — Details for the implementing agents

### 1. The Burrow view contract (normative)

Every view container in the rail must satisfy all six. A WO is not done until its view passes
this checklist in a screenshot.

1. **One question.** The view has a single sentence purpose, written in its `package.json`
   description, and nothing in it that fails to serve that sentence.
2. **One primary action** in the view header (`view/title`, `group: navigation@1`), plus at most
   two secondary icons; everything else goes into the `…` overflow (`group: 1_x`). Views with
   more than three header icons today must shed them.
3. **Two visible sections, maximum.** Additional sections are contributed collapsed
   (`"visibility": "collapsed"` in the `views` contribution) and carry a count badge in their
   title (`Images (14)`), so collapsed never means hidden.
4. **A designed empty state** via `viewsWelcome`: one sentence of plain English + exactly one
   button. No stack traces, no "no data", no spinner-forever. Failure states say what to do
   (`Docker isn't running — Start Docker Desktop`).
5. **One density.** Single-line rows, no wrapping, secondary text right-aligned and muted, icons
   only where they carry information (status), never as decoration. Take colours from the theme
   tokens (`task-12-plan.md`), never hard-code hex.
6. **One full-surface escape hatch.** If the view has a bigger surface (a grid, a preview, a
   diagram), its header carries the `⛶` Focus button from file `01` — same icon, same command,
   `Esc` exits.

Anti-patterns to remove on sight: nested trees deeper than two levels by default; progress
spinners that outlive a click; a header that shows both a title *and* a redundant toolbar label;
two ways to do the same thing in one view; anything that auto-starts a process without saying so.

### 2. Rail order, icons, and how consolidation is implemented

Order is fixed (top to bottom): **Files, Find, Source, Run, API, Data, Components**. Implement by
editing `viewsContainers.activitybar` ids/titles/icons in the owning extensions and by
re-homing views with the `views` contribution — no core patch:

| New container | Owner extension | Views inside (order, default state) |
|---|---|---|
| Files | upstream explorer | Explorer (expanded) · Oracle Notes (collapsed, from `burrow-oracle`) |
| Find | upstream search | Search (expanded) |
| Source | upstream scm | Source Control (expanded) |
| **Run** (`burrow-run`, new id on `burrow-fullstack`) | `burrow-fullstack` | Full Stack (expanded) · Tests (collapsed, host the `burrow-go-test` testing view or a thin proxy) · Debug Config (collapsed) |
| **API** (`burrow-api`, rename of `burrow-flow`) | `burrow-flow` | Routes (expanded) · Requests — `.http` files + history (collapsed, from `burrow-http`) |
| **Data** (`burrow-data`, rename of `burrow-db`) | `burrow-db` | Database (expanded) · Containers (collapsed, from `burrow-docker`) · Images/Volumes/Networks (single collapsed "Docker Resources" section, or `…` overflow) |
| Components | `burrow-frontend-debugger` | Components (expanded) |

If moving upstream's Testing view container into `burrow-run` needs core surgery, do **not** patch:
instead contribute a thin `burrowTests` tree in `burrow-go-test` that mirrors package/test status
and opens the stock test UI on click, and hide the stock Testing container from the rail via the
existing view-container context menu default. Record the deviation in the WO report.

### 3. Per-view specifications

Each spec below is one WO. Format: *question → sections → primary action → empty state → Focus →
what to delete*.

#### 3.1 Files
- **Question:** where is the code?
- **Sections:** Explorer (expanded). **Oracle Notes** (collapsed) — today `burrowOracleWalk` sits
  in the explorer as a peer tree; demote it to a collapsed section titled `Oracle Notes (n)`.
- **Primary action:** New File. Secondary: Collapse All, Refresh → overflow.
- **Empty state:** "No folder open — Open merkle" button running `workbench.action.files.openFolder`
  pre-seeded to `~/Projects/merkle`.
- **Delete:** breadcrumb duplication in the view header; any "Outline"/"Timeline" sections not
  used for Go/TSX work (move to overflow).

#### 3.2 Find
- Covered by file `01 §3`. This WO only enforces contract rules 4–5 (empty state copy, density)
  and adds the `⛶` (search results are a legitimate full surface).

#### 3.3 Source
- **Question:** what have I changed?
- **Sections:** Changes (expanded). Graph/Stashes → collapsed or overflow.
- **Primary action:** Commit. **Guard rail:** the outer CLAUDE.md forbids branch creation/switching
  by agents; the *human* UI keeps full git. No behaviour change, just contract compliance.

#### 3.4 Run — "does it work?"
- **Question:** start, debug, and test the whole stack from one place.
- **Sections:**
  - **Full Stack** (expanded): three status rows — `Postgres`, `Go backend (dlv)`, `Frontend
    (Vite)` — each with a state dot (stopped/starting/running/stopped-at-breakpoint), the port,
    and one inline action. Below them one row: **Debug Full Stack** (`burrow.fullstack.debug`).
  - **Tests** (collapsed): Go packages with pass/fail counts; click runs; `…` has Race, Coverage,
    Bench, Fuzz (from `burrow-go-test`). **Lab feel (user ask, 2026-07-24):** the tree is the
    index, but the *result surface* is a full editor tab — the **Test Lab** — opened by the ⛶ on
    the section or by running anything: left = suites with state dots and duration bars, right =
    the selected run's output with failures first, a diff-rendered `want/got` for
    `assert.deepStrictEqual`-style failures, and a sticky header with Run · Re-run failed ·
    Race · Coverage toggles. Coverage paints gutters in the source editor, not a percentage
    table. Same visual language as the isolation canvas (the "lab" family: quiet dark stage,
    one accent, big result area) — see `04 §6` for the shared lab shell.
  - **Debug Config** (collapsed): the existing `burrowDebugConfig` toggles (Auth0 on/off, mock/live,
    race) — presented as toggles, not a tree of settings.
- **Primary action:** ▶ Debug Full Stack. Secondary: Stop. Everything else in `…`.
- **Empty state:** "Nothing running — Debug Full Stack" (single button).
- **Focus:** n/a (no full surface) — but the *status* must stay legible when the sidebar is 260px.
- **This is where the compound from file `04` (Postgres → Go → Chrome) surfaces.**

#### 3.5 API — "what does the backend expose, and what did it answer?"
- **Question:** every route merkle serves, and the request/response history.
- **Sections:**
  - **Routes** (expanded): flowscan-fed tree from `burrow-flow`, grouped by resource (`/api/nodes`,
    `/api/alerts`, …), each row `METHOD path` + handler symbol, with a breakpoint dot when armed
    (`burrow.flow.armBreakpoint`). Two levels maximum.
  - **Requests** (collapsed): `.http` files in the workspace (`infra/test/nodewatch.http` first) +
    the last N responses, click to reopen in the workbench.
- **Primary action:** Send (`burrow.http.send`) when a `.http` editor is active, else
  "New Request". Secondary: Import Postman (`burrow.http.importPostman`) → overflow.
- **Empty state:** "No routes indexed — Scan backend" (`burrow.flow.refresh`), and for Requests:
  "No .http files — Import Postman collection".
- **Focus:** the response webview gets `⛶`.
- **Ties into `05`:** the endpoint-coverage pass drives this view.

#### 3.6 Data — "what is in the database, and what is running?"
- **Question:** the single Postgres instance merkle uses, plus the containers behind it.
- **Sections:**
  - **Database** (expanded): connection row (`nodewatch@localhost:5432`, discovered from
    `launch.json`/compose — never hardcoded), then schemas → tables, two levels. Row count and a
    tiny "last written" hint per table where cheap.
  - **Docker** (collapsed): Containers with state dots; Images/Volumes/Networks folded into one
    collapsed "Resources" child or the `…` menu. Docker keeps all its actions (start/stop/logs/
    exec/inspect) on the row context menu, not in the header.
- **Primary action:** New Query (`burrow.db.starterQuery`). Secondary: Refresh; `…` holds
  pgAdmin (`burrow.db.openPgAdmin`), Toggle Writes (`burrow.db.toggleWrites`), Table Info.
- **pgAdmin surface (user ask, 2026-07-24):** today pgAdmin opens as a raw iframe with its own
  busy chrome — it fails every rule in this contract. Improve it in three steps, cheapest first:
  1. **Frame it like a Burrow tool:** the webview strips to content — pass pgAdmin's
     `PGADMIN_CONFIG_*` options to hide its browser tree chrome where possible, auto-login
     (`PGADMIN_CONFIG_SERVER_MODE=False`), pre-register the one server via `servers.json` so it
     opens *on* `nodewatch`, never on a welcome page. Loading state = one sentence + spinner,
     not a white flash; failure state names the container to start.
  2. **Native-first routing:** table browse/peek stays in the native grid (it's faster and
     theme-true); pgAdmin is reached *from* rows — right-click table → "Open in pgAdmin" — for
     the jobs the grid can't do (ERDs, explain plans, grants). The `…` keeps the plain "Open
     pgAdmin" for everything else.
  3. **One Focus story:** ⛶ + Esc like every surface (`01 §5`).
- **Writes safety:** the writes toggle must be visible *as state* (a lock glyph on the connection
  row), not buried — it is the one destructive affordance in the IDE.
- **Empty state:** "No connection — Discover from workspace" then "Start Postgres" if compose is
  down (`docker compose -f merkle/infra/docker-compose.yml up -d nodewatch-db`).
- **Focus:** the results grid gets `⛶` and becomes a genuine pandas-style full-screen table.

#### 3.7 Components — "what does the UI look like, alone and in the app?"
- **Question:** browse merkle's React components, open one in isolation, or find it in the running
  app.
- **Sections:** Components (expanded) — a **two-level** tree: folder group → component; each row
  shows the component name and a muted hint (`primitives/badge`). Sample-count/props badges go in
  the tooltip, not the row.
- **Primary action:** Isolate (`burrow.frontendDebugger.isolate`). Secondary: Show in App
  (`showInApp`). `…`: Refresh, Toggle Mock/Live, Restart Sidecar, Show Logs, Open in Browser.
- **Honest auto-start:** `autoStartOnComponentsView` currently boots the sidecar when the view
  opens. Keep the behaviour (it is the round-trip plan's promise) but make it visible: a single
  muted status row at the top of the view — `dev server: starting… / :6099 live / stopped` — that
  doubles as the stop button. Contract rule 6 forbids silent background work.
- **Empty state:** "No components found — set the frontend folder" → opens the
  `burrow.frontendDebugger.targetDir` setting.
- **Focus:** isolation editor and app preview both get `⛶` (file `01 §5`).
- **Also here:** the responsive-breakpoints panel returns as a *tab of the isolation surface*,
  not a rail item (file `04 §4`).

### 4. The right dock (secondary side bar)

Two tenants, mutually exclusive by default:
- **Debug** (patch `0004`): Frames · Inspector · Watch · Visualizer — auto-reveals on session
  start, and must still auto-reveal after this WS.
- **Agent** (file `03`): `⌘⌥D` toggles the dock; when a debug session is running the dock shows
  Debug, and the Agent moves to a second dock tab rather than fighting for the same space.

Contract rules 1–5 apply to the debug views too: the Miller inspector already reads well; the
Watch/Frames headers should shed any icon that is not Add/Refresh.

### 5. Zen separators & layout defaults (one WO, config-only)

The "jumbled" feel is partly seams: every pane today announces itself with a hard border and a
grabby sash. Calm them with `burrow-core` `configurationDefaults` + theme-token tweaks (the
theme JSON from `task-12-plan.md` owns the colours):

```jsonc
"workbench.tree.indent": 12,
"workbench.tree.renderIndentGuides": "onHover",   // guides on demand, not always-on grid paper
"workbench.sash.size": 8,                          // easy to grab…
"workbench.sash.hoverDelay": 300,
"editor.renderLineHighlight": "gutter",           // active-line calm
"editor.guides.indentation": false,                // Go/TSX don't need the picket fence
"editor.stickyScroll.enabled": true,
"workbench.editor.tabSizing": "shrink",
"workbench.editor.tabActionCloseVisibility": false, // close button on hover only
"workbench.editor.limit.enabled": true,            // tab hygiene backstop (see 04 §5)
"workbench.editor.limit.value": 8,
"workbench.editor.limit.perEditorGroup": true,
"scm.diffDecorations": "gutter",
"breadcrumbs.enabled": true,
"window.density.editorTabHeight": "compact"
```

…and in the theme: `sideBar.border`/`panel.border`/`editorGroup.border` become the surface colour
(seams vanish; the sash still hit-tests), `tree.indentGuidesStroke` drops to ~25% alpha,
`sideBarSectionHeader.border` transparent. Rule: **separation by spacing and surface, not by
lines.** Any view that still draws its own `<hr>`/border in a webview loses it in the same WO.

### 6. Tool-surface isolation — tabs don't outlive their tool (user ask, 2026-07-25)

**Problem.** Each rail tool opens editor-area surfaces (Data: query grids + pgAdmin; API: `.http`
editors + response panes; Components: source/CSS/preview trio; Run: Test Lab; docs viewer…).
Switching Data → Components leaves the Data tabs behind; an hour of browsing = twenty stale tabs.
WO-15 fixes this *within* the Components flow; this section fixes it **across tools**.

**Policy (normative):**
1. **A tool's transient surfaces close when you switch to another tool.** "Transient" = anything
   the tool itself opened that the user hasn't claimed. A tab is *claimed* — and therefore
   survives — if it is **dirty**, **pinned**, or a real workspace file the user opened themselves
   (explorer, quick-open). `.http` files under the workspace are user files → survive; a query
   grid, a response pane, pgAdmin, a Test Lab run, an isolation preview → transient.
2. **Explicit registry, not heuristics.** `burrow-core` exports a tiny API from `activate()`:
   `tools.claim(toolId: string, tab: { uri?|viewType? })` + `tools.activated(toolId)`. Each
   tool extension registers the surfaces it opens; nothing unregistered is ever touched. (Same
   cross-extension `exports` pattern the agent context engine uses, `03 §3`.)
3. **Switch detection.** Every Burrow view already gets `onDidChangeVisibility`
   (TreeView/WebviewView, stable API). On a view becoming visible, its extension calls
   `tools.activated(myToolId)`; burrow-core closes the *previous* tool's registered transient
   tabs via `vscode.window.tabGroups` (match `TabInputText` by uri, `TabInputWebview` by
   viewType; skip `tab.isDirty || tab.isPinned`). Debounce ~300 ms so rapid rail-surfing doesn't
   thrash.
4. **Singleton surfaces.** Each tool keeps **at most one** instance of each surface kind alive
   (the FD preview already does this — generalize): re-running a query re-points the existing
   grid tab; a second Send re-uses the response pane. Preview-tab (`preview: true`, italic,
   self-replacing) for anything text-based.
5. **Cheap resurrection.** Closing must never lose work: grids re-query from the Data view in
   one click, responses live in the API view's Requests history, Test Lab reopens from Run,
   isolation reopens from the gallery. If a surface can't be rebuilt in ≤1 click, it isn't
   transient — don't register it.
6. **Escape hatch.** `burrow.workbench.tidyToolTabs` (default `true`); per-tab opt-out is just
   pinning it. The `workbench.editor.limit` (8/group, §5) stays as the backstop for what slips
   through.

**Out of scope (rejected):** per-tool editor *groups* or saved layouts — multiplies layout states
and violates "one layout, opinionated" (design principle 1). Closing beats hiding.

**Acceptance:** Data (open 2 grids + pgAdmin) → Components (isolate 2 components) → API (open
`nodewatch.http`, Send) → back to Data: at every stop the tab bar holds only the active tool's
surfaces (≤3) plus user-claimed tabs; a dirty CSS edit and a pinned grid survive the whole trip.
Screenshot at each stop.

### 7. Cross-cutting deletions (do these once, in one WO)

- Remove every `view/title` icon that duplicates a command-palette action (audit all
  `extensions/burrow-*/package.json` `menus` blocks).
- Remove decorative emoji/unicode from view titles and tree labels; use codicons.
- Normalize titles to sentence case, one word where possible: `Explorer`, `Search`, `Source`,
  `Run`, `API`, `Data`, `Components`.
- Ensure every `viewsWelcome` string exists (grep for views without one — today most Burrow views
  have none).

### 8. Acceptance for the workstream

A single screenshot sweep: rail shows seven icons in the stated order; each view opened in turn
shows ≤ 2 expanded sections, ≤ 3 header icons, and a legible empty state when its backing service
is down (test by stopping Docker, Postgres, and the FD sidecar). Plus: `npm run gulp
compile-extensions` clean, and for the Components WO `cd burrow/tools/frontend-debugger && npm run
oracle` → `0 FAIL`.
</content>
