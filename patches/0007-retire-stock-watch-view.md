# 0007 — Retire the stock Watch view (Burrow Watch replaces it)

- **Layer:** 3 (core patch — one `when`-clause on the Watch view registration)
  + layer 4 (`burrow-core` registers the gating setting)
- **Task:** 05 (right-hand debug panel redesign), IX slice / WO-7 — the Watch view
  (task 05.6).
- **Upstream files touched:** `src/vs/workbench/contrib/debug/browser/debug.contribution.ts`
- **Size:** 1 line (core `when` clause) + one property in `extensions/burrow-core/package.json`
- **Last verified against:** upstream 1.128.0

## Why

The Burrow Watch view (`extensions/burrow-go-inspect`, `watch.ts`) replaces the
stock Watch view: a flat list of expressions rendered with the **same summary
renderer** and the **same value pane** as the inspector, invalid-in-frame watches
grayed out. With both present the debug bar shows two Watch panes. This is the
exact same situation as the Variables view in patch 0006 — an extension cannot
hide a built-in view, so retiring the stock Watch view is a one-line core patch.

## What

Identical mechanism to 0006, on the **Watch** view registration:
`when: CONTEXT_DEBUG_UX.isEqualTo('default')` becomes
`ContextKeyExpr.and(CONTEXT_DEBUG_UX.isEqualTo('default'),
ContextKeyExpr.notEquals('config.burrow.inspector.hideStockWatch', true))`.
The gating setting `burrow.inspector.hideStockWatch` (boolean, **default true**) is
registered in `burrow-core` `contributes.configuration` — required so the
`config.…` context key resolves true by default. Set the setting `false` to bring
the stock Watch view back.

Reversible for the same reason as 0006: the Burrow Watch view is still a *Preview*
(no drag-reorder, no set-value on a watched l-value, no watch-expression editing
in place yet), so the setting is the safety valve until parity lands.

## Not done here

- **Break-on-write / watchpoints** (the value pane's other button) stay task 04.
- Watch-expression **editing in place** and **drag reorder** are later polish; the
  Burrow view supports add / remove / evaluate / copy-as-literal in this slice.

## Rebase notes

- Mirror 0006's notes: if upstream changes the Watch view registration, re-apply
  the single `when` tightening (intent: stock Watch gated OFF by
  `config.burrow.inspector.hideStockWatch`, default true, on top of
  `CONTEXT_DEBUG_UX == default`). Rename in lockstep with the `burrow-core`
  property if the setting id ever changes.
