# 04 — Frontend lab: every component renders, prod-parity, tab hygiene, real breakpoints

> Workstream 4 of the [master plan](00-master-plan.md). Lands in `burrow/` (extension +
> `tools/frontend-debugger`) and, where component code needs adapting, in `~/Projects/merkle`
> (its own repo/rules). Target: **any merkle component opens in the isolation ("framer") editor
> and renders something meaningful by default**, the edit→see loop is as close to prod as we can
> get, the workbench keeps the file explorer and stops leaking tabs, and **frontend breakpoints
> come back** — both runtime (TSX in Chrome) and responsive (media queries).

---

## Part 1 — Technical summary (for product review)

Four problems, four fixes:

1. **"Several components don't render at all."** The isolation harness mounts one component with
   stub providers and whatever props the schema parser could guess — which for anything that
   *requires* data (a `DataTable` without `rows`, a chart without series, a page without route
   params) renders nothing or throws. Fix on **both sides**, per the user's mandate: the harness
   learns to synthesize **decent defaults from the prop types** (a table gets three plausible
   rows; an enum gets its first value; a callback gets a stub; a `ReactNode` gets short text),
   and merkle components adopt a tiny, dev-only convention — a colocated `<Component>.samples.*`
   file (already supported!) or an exported `SAMPLE_PROPS` — for anything the synthesizer can't
   guess. A **render triage sweep** over all of merkle's components produces the exact fix list.

2. **Prod parity.** Isolation should look like production, not like a lab bench: real
   `index.css` tokens (already), real fonts, real providers (already via `burrow.isolate.tsx`),
   fixture data through the same fetch path as the app (already via devMock), plus a new
   **App/Prod toggle** that renders the component against the production-built CSS
   (`vite build` output) to catch dev-only styling drift.

3. **Workbench ergonomics.** Isolation's "design layout" currently hides the sidebar — the file
   explorer comes back (design layout keeps the rail and Files view; hiding chrome is Focus
   Mode's job, `01`). Switching components currently *adds* editor tabs forever; the isolation
   flow becomes **tab-tidy**: it reuses its three tabs (source, CSS, preview) and closes the
   previous component's pair on switch. Plus sane global tab defaults (8 per group, shrink,
   preview-tab reuse).

4. **Breakpoints.** `js-debug` (the Chrome/Node debugger) was stripped from the fork, so
   merkle's own `Frontend: debug in Chrome` launch config can't run in Burrow. We vendor it back
   (pinned, offline, `STRIP.md` reversal — same pattern as the python/rust grammars), wire the
   **Full Stack** compound (Postgres → dlv Go → Chrome on Vite), and restore the
   **responsive-breakpoints panel** (media-query view) that existed in the old tool UI but was
   never ported to the native isolation surface.

Cost: triage sweep ~1 day; harness defaults ~2 days; parity toggle ~1 day; tab/explorer work
~1 day; js-debug restore + compound ~2 days; responsive panel ~1 day.

---

## Part 2 — Details for the implementing agents

### 1. Render triage sweep (do this first — it scopes everything else)

A script (`tools/frontend-debugger/test/renderSweep.mjs`, playwright over the running sidecar)
that iterates **every** component the gallery discovers, opens `__isolate` for each, and
records: rendered DOM height, console errors, thrown invariants, and a screenshot. Output:
`docs/render-sweep.md` — a table of `component | status (ok/blank/throws) | error | suspected
cause`. Causes will cluster into:

| Cluster | Fix side | Fix |
|---|---|---|
| Required data prop missing (`rows`, `data`, `series`, `items`) | harness | type-driven synthesis (§2) |
| Needs router params (`useParams`) | harness | `initialEntries` from a new `sampleRoute` hint (§2.4) |
| Needs query/fetch data on mount | merkle | devMock fixture for that endpoint (the mock is already installed in isolation) |
| Needs a provider not in `burrow.isolate.tsx` (e.g. a store/context added since) | merkle | add it to `Providers` there — that file exists precisely for this |
| CSS-only render (zero-height until sized) | harness | default stage min-height + a checker background so "invisible" is visibly empty |
| Genuinely page-scale (needs full app) | tooling | mark `appOnly` in the gallery — row shows "open in app" instead of a broken isolate |

The sweep is kept as a permanent gate: `npm run sweep` must end with `0 blank, 0 throws`
(appOnly exclusions listed). Re-run it in `05` Pass 2.

### 2. Decent defaults — type-driven prop synthesis (harness side)

Where: the extension already parses a props schema (`propsSkeleton.ts`, "schema + defaults
pre-filled" landed in `15c2cb67`). Extend the *skeleton filler*, not the parser:

- `string` → name-aware: `title|label|name` → "Example {Prop}"; `id` → `"node-1"`; `href|url` →
  `"#"`; else `"text"`.
- `number` → name-aware: `count|total` → 3; `percent|ratio` → 0.42; `width|height` → 320; else 1.
- `boolean` → `false` (except `open|visible|enabled` → `true` so the component shows itself).
- union of literals → **first literal** (already the convention in the samples UI).
- `Array<T>` → **three** synthesized `T`s (recursive), so *a table has rows*, a list has items,
  a chart has points. Depth-cap 3, node-cap ~50.
- object type → recurse over required fields only.
- `ReactNode`/`children` → the component's own name as text (short, real-looking).
- functions → no-op stubs (`ƒ` markers — mechanism exists).
- `Date`/ISO-looking strings → a fixed date (no `Date.now()` — deterministic renders).
- domain enums that resolve through merkle's `lib/statusColor.ts` types (`Severity`,
  `BadgeTone`…) → first member, which the parser already sees as a union.

Precedence (highest wins): saved sample ▸ colocated `<Component>.samples.*` ▸ exported
`SAMPLE_PROPS` ▸ type-driven synthesis ▸ today's empty skeleton. The props panel labels each
value's provenance (`sample`/`synth`) with the existing ProvenanceChip pattern so synthesized
data is never mistaken for real.

**2.4 Route hint:** support `sampleRoute` in the samples file (e.g.
`{ route: '/watch/app/nodes/node-1' }`) → harness passes it as the MemoryRouter
`initialEntries`. Fix-side for `useParams` components.

**merkle side (its own repo, own commit rules):** add samples/fixtures only where synthesis
can't do the job (the sweep says where). House the convention in
`frontend/README.md` + one exemplar (`DataTable.samples.ts` with three rows shaped like prod
node data). No prod-bundle impact: samples files are only ever imported by the harness.

### 3. Prod parity

- **Fonts + tokens**: harness already imports `src/index.css`; assert in the sweep that computed
  `font-family` and `--*` token counts match the running app (catch drift, don't hope).
- **App/Prod CSS toggle** (new, small): a third background/state chip in the iso top bar —
  `dev · prod-css`. `prod-css` loads the latest `frontend/dist/assets/*.css` build artifact
  over the stage instead of dev-injected styles; if `dist/` is stale (>24 h) show a muted
  "built 3 d ago — rebuild" hint that runs `npm run build` via the sidecar. This is the honest
  "as close to prod as possible" without losing HMR: dev for iterating, one click to check prod.
- **Live mode already exists** (`VITE_DEV_MOCK=0` → real backend through the Vite proxy); the
  mode chip stays, and `05` exercises both.

### 4. Responsive breakpoints panel — bring it back

The old tool UI had `BreakpointsTab.tsx` (media queries affecting the selected element; click →
jump viewport to that width). It never made it into the native isolation surface. Port it as an
**Isolation panel tab** next to Props:

- Data source: the agent already computes matched CSS incl. `media` + `mediaActive` per
  selection (the envelope the old tab consumed) — reuse, don't reinvent.
- UI: two groups ("affecting this component", "all breakpoints in stylesheet"), active dot,
  `→ 768px` button sets the stage viewport. Clicking a media query with the source panel open
  reveals the rule in the CSS editor.
- Keep the width-parsing helper (`widthOf`) as-is from the old component.

### 5. Workbench ergonomics: explorer back, tabs tidy

**5.1 File explorer stays visible.** `isolation.ts:126` (`designLayout`) currently closes the
sidebar for a "clean canvas". Change the default behaviour: design layout arranges the three
columns but **leaves the sidebar alone**; hiding chrome is exclusively Focus Mode (`01`).
Setting `burrow.frontendDebugger.designLayout` keeps working for people who want the old
behaviour, default flips to the new one. Same audit for `panel.ts`'s
`maximizeEditorHideSidebar` path — `openMaximized` keeps maximizing the *group*, not hiding the
sidebar.

**5.2 Isolation is tab-tidy (user ask).** Today every `isolate` opens the component's source
(`preview:false`, pinned) and CSS in fresh tabs; twenty components later, twenty tab pairs. New
behaviour in `isolation.ts`:

- Track the current trio (source doc, css doc, preview panel) — the preview is already a
  singleton; make the *editors* follow the same pattern.
- On switching to another component: open the new source/CSS as **preview tabs**
  (`preview: true` — italics, self-replacing), and close the previous component's source/CSS
  tabs **iff we opened them and they are not dirty** (`tabGroups.close`; a dirty tab survives
  with a toast "kept — unsaved changes").
- Pin-on-edit: first keystroke in a previewed source tab pins it (upstream behaviour, free).
- Setting: `burrow.frontendDebugger.tidyTabs` (default `true`).

**5.3 Global tab management defaults** (in `burrow-core`, shared with `02 §5`): 8 tabs per
group, `tabSizing: shrink`, `enablePreview: true`, `revealIfOpen: true`, compact tab height,
close-button on hover. Verify `⌘W`/`⌘K W`/middle-click all behave.

### 6. The shared "lab" shell (design note for 02's Test Lab + this file's isolation)

One visual family for all bench-like surfaces (isolation canvas, Test Lab, HTTP response, DB
grid in Focus): quiet dark stage from theme tokens, a single 32-px top bar (name · state chips ·
actions · ⛶), content on a subtly inset stage with 20-px gutters, no borders (spacing + surface
per `02 §5`). Extract the iso top-bar CSS into a shared stylesheet under
`tools/frontend-debugger/server/` or duplicate the ~40 lines per surface — whichever keeps the
tools decoupled; note the choice in the WO report.

### 7. Runtime frontend breakpoints — restore js-debug

**Why:** merkle's `infra/test/vscode/launch.json` `Frontend: debug in Chrome (:5173)` is
`type: "chrome"` → provided by `ms-vscode.js-debug`, which the strip removed
(`STRIP.md:137-139`, `product.json` `builtInExtensions: []`). Tutorial 03 and the full-stack
one-click both depend on it.

**How (deterministic, offline — D6):**
1. Vendor a pinned js-debug build compatible with upstream 1.128.0 into
   `extensions/js-debug/` — prefer extracting the exact version from an official VS Code
   1.128.0 build's `resources/app/extensions/` (byte-identical provenance, like the grammar
   restore) over a marketplace download. Record version + licence in `THIRD_PARTY_NOTICES.md`.
2. Wire it as a normal built-in dir (the build packages whatever extension folders exist —
   proven by the grammar restore). Check whether `js-debug-companion` is needed for the
   `chrome` launch flow on the desktop app; vendor it too only if launch fails without it.
3. `STRIP.md`: flip the three js-debug rows to keep via `tools/inventory.js` `DECISIONS`,
   regenerate (never hand-edit), reason: "frontend breakpoints for merkle".
4. Keep the Node-side auto-attach (`debug-auto-launch`) **out** — we only need browser debug.
5. Sanity: `debug-auto-launch`-adjacent leaf strips (patch `0003`) must not have removed
   contributions js-debug needs; if the boot log complains, resolve per ledger discipline.

**Acceptance:** open merkle in Burrow → Run & Debug shows the chrome configs → F5 on
`Frontend: debug in Chrome` opens Chrome, a breakpoint in `frontend/src/api/client.ts:88`
binds (real line, verified in tutorial 03) and hits on reload, with correct TSX source mapping.

### 8. Full Stack compound — one click, three tiers

Extend `burrow-fullstack` (`burrow.fullstack.debug`) to the full fan-out the plan doc already
specifies (`docs/architecture/plans/full-stack-debugger-plan.md`):

1. `docker compose -f ~/Projects/merkle/infra/docker-compose.yml up -d --wait nodewatch-db`
   (+ the `nw-db-fwd` socat forward if `localhost:5432` isn't published — reuse `./merkle`'s
   trick, or document that `./merkle --start` owns the db).
2. `vscode.debug.startDebugging` with merkle's `Backend: debug (Auth0 OFF)` config (env verbatim
   from `infra/test/vscode/launch.json` — the invariant contract).
3. Vite via the FD sidecar in **live** mode (`VITE_DEV_MOCK=0`).
4. js-debug `chrome` launch against `http://localhost:5173/watch/app/`.
5. Status rows in the Run view (`02 §3.4`) reflect each tier; Stop tears down in reverse.

**Acceptance:** one click → a click in the app stops at a `client.ts` breakpoint *and* stepping
continues into a Go breakpoint in the handler for the same request; the Request Trace joins the
two on `X-Request-Id`.

### 9. What this workstream must not break

- FD oracle: any change under `tools/frontend-debugger/` lands with its `.claude/memory/*.yaml`
  rows; `npm run oracle` → `0 FAIL`; `npm run verify` (playwright e2e) green.
- The packaged-.app layout (`task-15-4-plan.md`): new files under `server/` must be included in
  the staging copy list; nothing may import devDependencies at runtime.
- `agent/agent.js` stays plain ES2018 and never throws into the embedded app.
- merkle's CSS-architecture test (only two entries import CSS) — the samples convention imports
  no CSS.

### 10. Evidence

Sweep report before/after (`N blank → 0 blank`), screenshots: DataTable rendering three
synthesized rows; a `useParams` page in isolation via `sampleRoute`; prod-css toggle diff;
tab bar before/after a five-component browse (≤3 tool tabs); explorer visible during isolation;
Chrome breakpoint hit; full-stack double-breakpoint stop.
</content>
