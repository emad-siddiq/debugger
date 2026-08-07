# Component ↔ App round-trip — plan (for review)

**Ask** (2026-07-24): seamlessly switch between editing a frontend component in
component view (isolation) and seeing it rendered live in the app — the app runs
in dev automatically (e.g. when the Components icon in the left menu is clicked),
the picker selects a component in the app, and from a component you can jump to
where it is rendered in the actual app, or see it in isolation and interact with
it there.

---

## Part 1 — Technical summary (product review)

### Most of the loop already exists

| Capability | Status |
| --- | --- |
| Components icon in the activity bar + native tree of the target's components | ✅ `burrowComponents` view (`gallery.ts`) |
| Click a component → isolation workbench: real source \| colocated CSS \| live preview, typed props panel, samples, viewport presets, Fast Refresh on save | ✅ `isolation.ts` + `server/isolateHarness.js` |
| Full-app debugger panel: embedded app, Interact / Pick / Theater modes, hover+click picking, Inspector | ✅ `panel.ts` + SPA + agent |
| App → isolation: Inspector ⛶ isolates the picked component **with its live captured props** | ✅ `openIsolation` host envelope |
| Pick → source: every selection reveals `file:line` in the Burrow editor; ⌥-click reveal from a real browser | ✅ `openSource` / reveal bridge |
| Sidecar (dev server) auto-starts on demand | ✅ but only when an isolate/open command runs |
| Route catalog discovered from live react-router fibers (`getRoutes` → paths, active route, page boundary) | ✅ agent `detectRoutes()` |

### The three gaps

1. **The app isn't warm when you arrive through Components.** Clicking the icon
   starts nothing; the first isolate click eats the sidecar boot (~seconds).
2. **There is no component → app direction.** Nothing answers "where is this
   component rendered in the real app?" — no navigation to that route, no
   auto-selection of the live instance. (App → component exists; the reverse
   doesn't.)
3. **No round-trip continuity.** Isolation and the app panel don't know about
   each other: no "Show in App" from isolation or the tree, no way to flip
   between the two surfaces for the *same* component, no restored app state on
   return.

### Proposal — four work orders

- **WO-1 · Warm start (S).** Revealing the Components view warm-starts the
  sidecar in the background (setting-gated); an "Open App" button appears on the
  view title. First isolate/panel click becomes instant.
- **WO-2 · Usage discovery (M).** New sidecar route `GET /api/usages?file=` —
  static reverse-import walk from a component file up to the page components,
  plus JSX usage sites (`file:line`). The agent's route catalog additionally
  reports each route's **page-component name** so usages can be matched to
  routes.
- **WO-3 · "Show in App" (M/L).** From the Components tree, an editor tab, or
  the isolation preview: resolve which route(s) render the component (QuickPick
  if several), open/reveal the app panel, navigate the embedded app there, and
  have the agent **locate + select + flash** the live instance. Falls back to
  the usage list when the component isn't currently mounted (auth/conditional).
- **WO-4 · Round-trip polish (S/M).** Symmetric buttons on both surfaces
  (Inspector ⛶ already goes app→isolation; isolation gets "Show in App"), a
  toggle command that flips surfaces for the current component, and app
  selection restored when you come back.

### Decisions needed before implementation

1. **Auto-start on Components reveal** — recommend **on by default** (background
   warm start only; it never opens/steals a panel; `autoStartOnComponentsView`
   setting to opt out).
2. **Several routes render the component** — recommend **QuickPick, remembering
   the last choice per component** (alternatives: always first match; always ask).
3. **Where the usage walk lives** — recommend **server route** (it owns the
   target fs + alias resolution; the extension's `typeResolver` is 1-hop only
   and per-window). Alternative: extension-side, no new HTTP route.
4. **WO-4 now or later** — recommend **later** (ship WO-1..3 first; WO-4 is
   polish on a working loop and its shape may change after real use).
5. **"Show in App" on every component editor tab?** — recommend **no for now**;
   surfaces stay: tree context menu + isolation preview title (the editor-title
   row already carries the ⛶ Isolate button; two component buttons there is
   clutter).

Estimated total: ~3–5 focused sessions. No new dependencies, no new processes —
everything rides the existing sidecar, agent, and extension.

---

## Part 2 — Implementation detail (for the agent)

### Verified seams this plan builds on

- Components tree: `extensions/burrow-frontend-debugger/src/gallery.ts`
  (`ComponentsProvider`, fs-only); click fires
  `burrow.frontendDebugger.isolate` with the file Uri (`gallery.ts:99`).
- Sidecar lifecycle: `src/sidecar.ts` `start(cfg)` (attach-or-spawn, rev
  handshake), `extension.ts:37` `open()`.
- Panel↔SPA bridge today is **SPA→extension only**: `__fedbgHost` envelopes
  relayed by the nonce'd shim (`panel.ts:85-93`) → `handleHostMessage`
  (`openSource` / `setFullScreen` / `openIsolation`). There is **no
  extension→SPA channel yet** — WO-3 adds one.
- Agent protocol (oracle-enforced in `.claude/memory/protocol.yaml`): commands
  incl. `navigate`, `getRoutes`, `select`, `scrollTo`; events incl. `routes`,
  `navigated`, `selected`. Route entries are
  `{id, path, label, group, dynamic}` (`agent.js:415-420` `pushRoute`) — **no
  component name today**.
- Selection identity is the stable fiber **PATH id**; every `selected` (non-
  theater) centrally reveals (scrollTo + flash) via `App.tsx` — WO-3's locate
  only needs to end in a normal `select`.
- DOM→source mapping: `data-inspect-file/line/name` stamped by
  `server/inspectorPlugin.js`; `sourceOfElement` in the agent already resolves
  an element to its authored file — the same stamps let `locate` go the other
  way (file → mounted fibers).
- Isolation workbench: `src/isolation.ts` (`openIsolation`, knows the module's
  target-relative path); harness envelopes `__burrowIso`/`__burrowIsoCmd`
  (non-oracle).

### WO-1 — Warm start from the Components icon

**Files:** `extensions/burrow-frontend-debugger/src/extension.ts`,
`package.json`.

1. Keep the `createTreeView` return (already pushed to subscriptions) in a
   local; add `treeView.onDidChangeVisibility(e => { if (e.visible && autoStart) void warmStart(); })`.
   `warmStart()` = `sidecar.start(resolveConfig(context))` + `status.show(port)`
   inside try/catch (log to `sidecar.out`, **no** modal error — this is a
   background nicety). Debounce: only attempt once per window until a failure
   is cleared by an explicit command.
2. `package.json`: new setting `burrow.frontendDebugger.autoStartOnComponentsView`
   (boolean, default `true`, description says "warm-starts the dev sidecar when
   the Components view is revealed"); `view/title` menu entry for the existing
   `burrow.frontendDebugger.open` command on `view == burrowComponents`
   (`"icon": "$(play)"`, `group: navigation@1`); update the `viewsWelcome` text
   to mention the app can be opened from here.
3. **Verify:** open the Components icon in a fresh window → sidecar output shows
   boot; component click isolates with no boot wait; toggle the setting off →
   no auto boot. Extension compiles via `npm run gulp compile-extensions`
   (burrow rules).

*No sidecar-repo changes → no memory rows. Burrow is a separate git repo —
commit there per its rules.*

### WO-2 — Usage discovery (component → route candidates)

**Files:** `server/api.js` (new route), `agent/agent.js` (enrich route
entries), memory: `routes.yaml` +1, `repo.yaml` counts/date. Oracle must be
`0 FAIL`.

1. `GET /api/usages?file=<src-relative>` in `server/api.js`:
   - Validate with the existing `safe()` allowlist.
   - Walk `<frontendDir>/src` once (skip `node_modules`, tests — mirror the
     gallery's skip set), parse **imports only with regex** (idiom: the repo is
     parser-free; `propsSkeleton.ts` sets precedent) resolving relative, `@/`
     and `@shared/` specifiers; build a reverse-import map
     `file → importers[]`. Memoize with an mtime-keyed cache.
   - JSX usage sites: for each importer, `<(ExportName)\b` scan → `{file, line}`.
   - BFS importer chains from the query file (depth cap ~8) and return
     `{ usages: [{file, line, name}], reachable: [{file, exportName}] }` where
     `reachable` is every ancestor file + its exported PascalCase component
     name(s) — the client intersects these names with the route catalog.
2. `agent.js` `pushRoute` (`agent.js:415`): add `name` — the route element's
   component displayName (`routeObj.element?.type` for JSX routes,
   `r.element.type` for data-router objects; `getComponentName`-style
   resolution, lazy/memo unwrap where cheap, `null` when unknowable). Same
   `routes` **event** → no protocol.yaml row change; verify the oracle agrees.
3. **Verify:** with merkle running, `curl '/api/usages?file=src/components/HudBar.tsx'`
   returns usages + a `reachable` set whose names intersect
   `getRoutes().routes[].name`; oracle `0 FAIL`.

### WO-3 — "Show in App"

**Files:** `agent/agent.js` (+`locate` cmd, +`located` event),
`ui/src/host.ts` + `ui/src/store.ts` + `ui/src/ipc.ts`/`App.tsx` (host→SPA
command + orchestration), `panel.ts` (extension→iframe forwarding),
`extension.ts` + `package.json` (command + menus), memory: `protocol.yaml`
+1 command +1 event, `repo.yaml` counts.

1. **Agent `locate`** `{file, name}`: walk mounted fibers from the route
   anchor; match a component fiber when (a) any of its host descendants'
   `data-inspect-file` equals `file` and the stamp's `data-inspect-name`
   (or fiber type name) equals `name`, or (b) fiber name matches and `file`
   is unknown. Reply `send({type:'located', ids:[pathId...], file, name})`.
   Wrapped in try/catch like every handler; never throws into the page.
2. **Extension→SPA channel:** `panel.ts` gets
   `postToApp(msg)` — `current?.webview.postMessage({__fedbgCmd:1, ...msg})`;
   the shim (`buildHtml`) adds a listener for messages **from the extension**
   (`e.origin` check fails for extension messages — distinguish by
   `d.__fedbgCmd === 1` and forward via
   `document.querySelector('iframe').contentWindow.postMessage(d, '${origin}')`).
   `host.ts` listens for `__fedbgCmd` envelopes (embedded only) and dispatches
   to the store. Document the new envelope in `protocol.yaml`'s host comment
   block (non-oracle, same as `openSource`).
3. **UI orchestration** (`store.showInApp({file, name, route?})`):
   - if `route` given and ≠ active → `navigate`, wait for `navigated` + next
     `tree`, then `locate`;
   - else `locate` immediately;
   - on `located`: `select(ids[0])` — the central reveal does scroll+flash;
     >1 instance → toast "n instances — showing first";
   - `ids` empty → toast "not rendered on this page" (extension already showed
     usages).
4. **Extension command** `burrow.frontendDebugger.showInApp(uriOrArgs)`:
   ensure sidecar + panel (`open()` path, reveal not re-maximize), fetch
   `/api/usages`, intersect `reachable` names with the cached/fresh route
   catalog (`getRoutes` result travels up — simplest: extension asks the SPA
   via a `__fedbgCmd:'getRoutes'` round trip, or the SPA resolves routes itself
   and the extension only sends `{file,name}`; **prefer the latter — the SPA
   owns route logic**, extension only QuickPicks when the SPA reports multiple
   candidates via a host envelope `routeChoices`). Remember last pick in
   `workspaceState` keyed by file.
   - Menus: `view/item/context` on `viewItem == burrowComponent`
     ("Show in App", `$(eye)`, inline); isolation preview `editor/title`
     (`activeWebviewPanelId == burrow.frontendIsolation`).
5. **Verify:** Playwright (`npm run verify` suite gains a case): isolate a
   component rendered on a non-default route → Show in App → assert the app
   URL changed to the candidate route and a `selected` event carries
   `source.file == component file`. Oracle `0 FAIL`. Manual: tree right-click →
   Show in App on `HudBar`.

### WO-4 — Round-trip polish (after WO-1..3 land)

1. Isolation preview title button wired (from WO-3 menus) passes the module rel
   path it already knows (`isolation.ts` state) — no active-editor guessing.
2. `burrow.frontendDebugger.toggleSurface`: workspaceState `currentComponent`
   `{file, name}` updated by both isolate and showInApp; the command flips
   between the isolation panel and the app panel for it (reveal, not rebuild).
   Optional default keybinding (decide: e.g. `cmd+shift+.`).
3. Return-state: before showInApp navigates away, snapshot `{route, selectedId}`
   in the store; "Back" affordance (toast action or TopBar chip) restores via
   `navigate` + `select`.
4. Memory: `repo.yaml` decision row `roundtrip-surfaces` documenting the loop;
   components.yaml only if new UI components appear.

### Risks & mitigations

- **Name-based route matching is heuristic** (lazy(), HOC wrappers hide names).
  Mitigation: `locate` runs regardless after navigation — the match only picks
  *which* route to try; final fallback is the usage list → `openSource` reveal,
  which always works.
- **Component not mounted even on its route** (auth gate, feature flag,
  conditional). `located` returns empty → honest toast + usages. Never spin.
- **Regex import-walk misses exotic re-exports** (`export * from`). Accept for
  slice 1; the fallback path (usages list) still shows the truth. Note it in
  the route's JSDoc.
- **New extension→iframe channel**: keep the envelope allowlist tiny
  (`showInApp` only), keep the shim's origin check for *incoming* iframe
  messages untouched, and never forward extension messages back out.
- **Oracle drift**: WO-2/WO-3 each land their memory rows in the same commit
  (routes.yaml, protocol.yaml, repo.yaml counts + `updated_at`).

### Out of scope (explicitly)

- Selection *live-sync* between simultaneously-visible isolation and app
  surfaces (two-way binding) — revisit after WO-4 usage.
- Multi-instance cycling UI ("next instance") — toast count only for now.
- Non-react-router targets: `showInApp` degrades to locate-on-current-page +
  usages list (route resolution needs a router).
