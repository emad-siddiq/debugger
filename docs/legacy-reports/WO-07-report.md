# WO-07 report — IX slice 5: the Watch view + retire the stock Watch (task 05.6)

STATUS: DONE — verified (Watch webview live over CDP; core Watch-retire by typecheck,
stale `out/`); committing under standing authorization (`main`, no push). **Core patch 0007.**

## What

The Burrow **Watch view** (task 05.6): a flat list of expressions rendered with the
**same summary renderer** and the **same value pane** as the inspector; watches
persist per workspace; invalid-in-this-frame watches **gray out** instead of
erroring. Closes the loop on the inspector value pane's previously-stubbed **Watch**
button. Retires the stock Watch view (core patch 0007, mirroring 0006).

## Changed

**New (layer 4):**
- `src/watch.ts` — `WatchProvider` (`WebviewViewProvider`, view `burrowWatch`
  "Watch (Preview)"): add via an input (Enter) or via the inspector's Watch button;
  per-workspace persistence (`workspaceState` key `burrow.watch.expressions`);
  evaluates each expression against the active frame; ↑↓ select; remove (✕); value
  pane with copy-as-Go-literal; invalid rows grayed.
- `src/watchmap.ts` — pure `watchVariableFrom(expr, dapEvaluateBody)` (vscode-free):
  maps a DAP `evaluate` body to a `DapVariable` so `summarize()` applies unchanged;
  `undefined` body → `undefined` (invalid-in-frame). 5 unit tests
  (`test/watchmap.test.js`).
- `src/webview.ts` — shared `nonce()` + `valuePaneCss()` for both inspector webviews
  (DRY: the value pane now renders identically in Miller + Watch).

**Modified (layer 4):**
- `src/model.ts` — `evaluate(expression, frameId)`: DAP `evaluate` (`context:'watch'`)
  → `watchVariableFrom`; returns `undefined` on rejection (caller grays out).
- `src/miller.ts` — the value pane's **Watch** button now routes the selected value's
  re-evaluable `evaluateName` via a new `onWatch` callback (was a toast); adopted the
  shared `nonce()`/`valuePaneCss()` (removed its private `makeNonce` + inline CSS).
- `src/extension.ts` — instantiates `WatchProvider(models, context.workspaceState)`,
  registers its webview, refreshes it on stop/frame/terminate, and wires
  `miller.onWatch → watch.addExpression + focus the Watch view`.
- `extensions/burrow-go-inspect/package.json` — `burrowWatch` webview view;
  `npm test` runs the third suite.

**Core patch 0007 (layer 3, reversible) — retire the stock Watch view:**
- `src/vs/workbench/contrib/debug/browser/debug.contribution.ts` — the `WATCH_VIEW_ID`
  `when` tightened to also require
  `ContextKeyExpr.notEquals('config.burrow.inspector.hideStockWatch', true)` (one line,
  same mechanism as 0006).
- `extensions/burrow-core/package.json` — registers `burrow.inspector.hideStockWatch`
  (bool, **default true**).
- `patches/0007-retire-stock-watch-view.md` — ledger entry.

**Housekeeping:** `testdata/debuggee/.gitignore` — ignore dlv's `__debug_bin*` artifact.

## Verified (host `dlv` 1.25.2, Go 1.24.1; fresh-profile CDP boot on `testdata/debuggee`)

- **extensions** compile → **0 errors**; **core** `typecheck-client` → **0**; **unit**
  `npm test` → **35/35** (23 summary + 7 literal + 5 watchmap); **ledger** →
  `9 core, 7 entries — OK` (0007 covers the WATCH edit).
- **Watch webview live (read inside the webview via `cdp-attach.js`):**
  - Stopped at `add()`, added via the input: `a` → `0`; `a + b` → **`2`** (the
    expression is evaluated, not just a field read); `cfg` → **grayed "not available
    in this frame"** (it lives in `main.main`). Value pane on select: `a int = 0` +
    Copy as Go literal.
  - **Frame re-evaluation:** selected `main.main` → `a`/`a + b` flip to grayed
    invalid, `cfg` becomes valid with its struct summary. (The whole list
    re-evaluates against the focused frame.)
  - **Inspector Watch button:** in the Miller inspector drilled `Locals`, selected
    `total` (value pane `total int 0` + [Copy as Go literal, Watch, Break on write]),
    clicked **Watch** → the Watch view gained `total` → `0`; a "Watching total."
    toast fired (screenshot `scratchpad/wo7-watch.png`).

### Not runtime-re-verified this turn (same as WO-6)

The **stock-Watch hide** is core `out/` behavior and `out/` is stale (no watcher);
`npm run compile` is forbidden by the repo guidance (typecheck is the CLI gate — done).
So 0007's retirement is verified by typecheck + `when`-logic + ledger, not a boot. On
the stale-core boot the stock VARIABLES + WATCH panes still showed alongside the Burrow
inspector/Watch — expected, confirms the extensions load; the retirement lands once
core `out/` is rebuilt.

## Discoveries

- **Webview *views* are torn down when scrolled out of view** (no
  `retainContextWhenHidden` in the WebviewView API — that's a WebviewPanel option). Not
  a correctness problem here: the Miller drill stack + Watch expressions live host-side
  in the providers, so on re-resolve the webview posts `ready` and the host re-renders
  current state. But it means a CDP read can only reach the webview whose pane is
  currently visible — reveal the target pane before probing (the other's context won't
  exist).

## Decisions

- made — Watch is a **second webview view** (not folded into the inspector) matching
  the design's separate Frames/Inspector/Watch stack; value pane + summary renderer
  shared via `webview.ts`.
- made — retire the stock Watch view with the **same reversible core mechanism** as
  Variables (0006): a `burrow-core` setting default-hidden, so the pair of stock views
  is consistently replaced yet independently restorable.
- made — the Watch button routes DAP `evaluateName` (dlv's re-evaluable path
  expression), so a watch added from a drilled value re-evaluates correctly at any
  frame.

## Next

- **Value/watch parity to drop "(Preview)":** set-variable/edit on l-values, in-place
  watch-expression editing + drag reorder, the memory view; Break-on-write wiring
  (task 04 watchpoints). Each closes a stock-view gap the reversible settings backstop.
- **Task 06 visualizers** consume the value-pane mount (slice/map tables, byte viewer).
- Deeper fixtures for the perf DoD (8-level, 50k-slice) still pending.
