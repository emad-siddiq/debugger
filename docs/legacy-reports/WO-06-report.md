# WO-06 report — IX slice 4: pick the inspector + retire the stock Variables view

STATUS: DONE — committed `28ac6ae5` (`main`, no push). **First IX core patch (0006).**
Verified: extensions compile 0 + `typecheck-client` 0 + unit 30/30 + ledger OK; the
Miller webview is unchanged from WO-5's live proof.

## The pick (recorded)

**Webview wins.** Only a webview (or a future core workbench view) can render the
Miller **columns + value pane** the design mandates — a `TreeView` structurally
cannot show side-by-side columns or a value pane, so the WO-4 native tree was always
a stepping stone. WO-6 makes the WO-5 Miller webview the **sole Burrow inspector** and
retires the WO-4 tree. A core-view escalation (layer 3) stays the fallback only if
keyboard/perf parity later fails; the webview's protocol + model reuse port directly
if so. Recorded here + in patch `0006`.

## Changed

**Layer 4 — consolidate to one Burrow inspector (retire the WO-4 tree):**
- `extensions/burrow-go-inspect/src/extension.ts` — deleted `InspectorNavProvider`
  (the WO-4 drill tree) and all four `burrow.inspect.*` tree commands + the tree
  view; `activate()` now wires only the Miller webview (shared model map, same
  stop/frame/terminate reset triggers). File shrank ~200 → ~80 lines.
- `extensions/burrow-go-inspect/package.json` — dropped the `burrowInspectorPreview`
  tree view, the four commands, and their `view/title` + `commandPalette` menus. The
  Miller webview `burrowInspectorMiller` is promoted to the sole view, **renamed
  "Inspector (Preview)"**. (The webview self-navigates: ↑↓ select, → / Enter drill,
  ← up, clickable breadcrumb — no contributed commands needed.)

**Layer 3 — retire the stock Variables view (core patch 0006, reversible):**
- `src/vs/workbench/contrib/debug/browser/debug.contribution.ts` — the
  `VARIABLES_VIEW_ID` registration `when` tightened from
  `CONTEXT_DEBUG_UX.isEqualTo('default')` to
  `ContextKeyExpr.and(CONTEXT_DEBUG_UX.isEqualTo('default'),
  ContextKeyExpr.notEquals('config.burrow.inspector.hideStockVariables', true))`.
  One line; `ContextKeyExpr` already imported.
- `extensions/burrow-core/package.json` — registers the gating setting via
  `contributes.configuration`: `burrow.inspector.hideStockVariables`, boolean,
  **default `true`** (so the `config.…` context key resolves true → stock view
  hidden by default; set `false` to bring it back).
- `patches/0006-retire-stock-variables-view.md` — the ledger entry (layer 3 + the
  layer-4 setting; why an extension can't hide a built-in view; rebase notes).

**Reversible on purpose:** the inspector is still a *Preview* and does not yet cover
set-variable, the memory view, or the value context menu (Watch / Break-on-write are
mounted-but-deferred stubs). Default-hidden realizes the "replaces the Variables
tree" design; the setting is the safety valve until parity lands, at which point the
default stays true and "(Preview)" drops.

## Verified (host `dlv` 1.25.2, Go 1.24.1)

- **extensions** `compile-extension:burrow-go-inspect` + `:burrow-core` → **0 errors**.
- **core** `npm run typecheck-client` (`tsgo --project ./src/tsconfig.json`) → **0
  errors** (the `when` clause type-checks against already-imported, correctly-typed
  symbols).
- **unit** `npm test` → **30/30** (unchanged: 23 summary + 7 literal).
- **ledger** → `9 core files changed, 6 ledger entries — OK` (0006 now covers the
  `debug.contribution.ts` change; the gate saw and accepted the new core edit).
- **inspector (live):** the Miller webview's behavior is **unchanged from WO-5's live
  CDP proof** (two columns + preview + value pane + breadcrumb-jump + copy-as-literal;
  screenshot `scratchpad/wo5-miller.png`). WO-6 only removed the *other* (WO-4) view
  and renamed this one — both mechanical and compile-checked.

### Not runtime-re-verified this turn (honest scope)

The **stock-Variables hide** is a core `out/` behavior, and the compiled
`out/vs/.../debug.contribution.js` is stale (Jul 16) with no watcher running.
Producing a runnable `out/` needs a full core build (`npm run compile` is forbidden
by the repo's agent guidance, which prescribes `typecheck-client` as the CLI gate for
`src/` changes — done). So the retirement is verified by **typecheck + `when`-clause
logic + ledger**, not a fresh boot. A booting proof (stock Variables gone by default;
`hideStockVariables:false` brings it back) is available on request via a one-time core
build — flagged rather than skipped silently.

## Decisions

- made — **pick = webview**; retire the WO-4 native tree (layer 4); retire the stock
  Variables view via a **reversible** core patch (default-hidden, setting-gated)
  rather than a hard delete, because the inspector is still a Preview missing
  set-variable/memory/value-menu.
- made — the gating setting lives in **`burrow-core`** (gates a core view, must be
  registered independent of the Go-inspector extension's activation), default `true`.
- needed — authorize the **WO-6 commit** (suggested
  `feat(inspect): retire stock Variables view; Miller webview is the inspector (IX, patch 0006)`,
  `main`, no push)? And optionally: **run the one-time core build** for a live retirement screenshot?

## Next

- **Value-pane parity → drop "(Preview)":** set-variable/edit, memory view, real Watch
  (task 05.6) + Break-on-write (task 04 watchpoints). Each closes a stock-tree gap the
  reversible setting currently backstops.
- **Task 06 visualizers** consume the value-pane mount next (slice/​map tables, byte
  viewer, …) — the seam is in place.
- Deeper fixtures for the perf DoD (8-level, 50k-slice paging) still pending.
