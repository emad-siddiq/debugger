# 0006 — Retire the stock Variables view (Go inspector replaces it)

- **Layer:** 3 (core patch — one `when`-clause on the Variables view registration)
  + layer 4 (`burrow-core` registers the gating setting)
- **Task:** 05 (right-hand debug panel redesign), IX slice / WO-6 — "pick the
  inspector, retire the stock tree" (task 05.8, "presentation swap").
- **Upstream files touched:** `src/vs/workbench/contrib/debug/browser/debug.contribution.ts`
- **Size:** 1 line (core `when` clause) + a `contributes.configuration` block in
  `extensions/burrow-core/package.json`
- **Last verified against:** upstream 1.128.0

## Why

The IX inspector (`extensions/burrow-go-inspect`) replaces VS Code's Variables
tree with a Miller-column + value-pane webview ("Inspector (Preview)"). With both
present the debug bar shows two variable panes. The design (task 05, "Inspector —
the anti-tree": *"Replaces the Variables tree…"*) wants **one**.

The stock Variables view is registered in core with a hardcoded
`when: CONTEXT_DEBUG_UX.isEqualTo('default')` (`debug.contribution.ts`), and an
extension cannot remove or re-gate a **built-in** view (the `views` contribution
point only *adds* views; there is no layer-4 lever to hide a core view). So
retiring it is a core patch — the smallest one: tighten that single `when`.

Retirement is made **reversible** (the webview is still a *Preview* and does not
yet cover everything the stock tree does — set-variable, the memory view, the
value context menu; Watch / Break-on-write are mounted-but-deferred stubs). A
hard delete would regress those during the preview period, so the gate reads a
setting instead.

## What

1. **Core (this patch):** the `VARIABLES_VIEW_ID` registration `when` becomes
   `ContextKeyExpr.and(CONTEXT_DEBUG_UX.isEqualTo('default'),
   ContextKeyExpr.notEquals('config.burrow.inspector.hideStockVariables', true))`.
   When the setting is `true` (the default), the `notEquals` is false → the stock
   Variables view is **not** registered/shown; the Burrow inspector stands alone.
   Set the setting `false` and the stock tree returns alongside the inspector.
   `ContextKeyExpr` is already imported in the file; no other change.

2. **Layer 4 (`burrow-core`):** registers the setting via
   `contributes.configuration` — `burrow.inspector.hideStockVariables`, boolean,
   **default `true`**. Registration is required so the `config.…` context key the
   core `when` reads resolves to `true` by default (an unregistered key is
   `undefined`, which would leave the stock view showing). Chosen in `burrow-core`
   (not `burrow-go-inspect`) because the key gates a *core* view and must be
   present whenever the workbench evaluates debug-view `when` clauses, independent
   of the Go inspector extension's activation.

## Not done here

- **Watch view** stays as upstream (task 05.6 replaces it with the same summary
  renderer later); only *Variables* is retired here.
- The inspector remains labeled **"Inspector (Preview)"** until it reaches
  set-variable / memory / watchpoint parity (later IX WOs) — at which point the
  setting's default can stay `true` and the "(Preview)" tag drops.

## Rebase notes

- If upstream changes the Variables view registration, re-apply the single `when`
  tightening; the intent is "stock Variables view is gated OFF by
  `config.burrow.inspector.hideStockVariables` (default true), on top of the
  existing `CONTEXT_DEBUG_UX == default` condition."
- If the setting is ever renamed, update both this `when` and the `burrow-core`
  `contributes.configuration` property in the same change.
