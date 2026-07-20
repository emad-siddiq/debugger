# 0009 — Retire the Breakpoints pane (management moves to a popover)

- **Layer:** 3 (one `when`-clause on the Breakpoints view registration)
  + layer 4 (`burrow-core` setting, `burrow-go-inspect` command/menu/keybinding)
- **Task:** 05 (right-hand debug panel redesign), IX slice / WO-13 — task 05.1
  ("Breakpoints management moves to a popover … it's configuration, not hot
  state, and doesn't deserve permanent space").
- **Upstream files touched:** `src/vs/workbench/contrib/debug/browser/debug.contribution.ts`
- **Size:** 1 line (the Breakpoints `when` clause) + one property in
  `extensions/burrow-core/package.json` + the command/menu/keybinding in
  `extensions/burrow-go-inspect/package.json`
- **Last verified against:** upstream 1.128.0

## Why

The design retires the permanent Breakpoints pane: breakpoints are configuration,
not hot state, so they move to a transient popover. The replacement lives in
`extensions/burrow-go-inspect/breakpoints.ts` — a QuickPick (the native popover)
listing every breakpoint with per-item enable/disable and remove buttons, a
"remove all" title button, and reveal-on-accept. Entry points: the
**Burrow: Breakpoints…** command, `⇧⌘B`, and a 🐞 button on the debug toolbar
(`menus` → `debug/toolbar`, `when: debugType == go`).

Hiding the built-in view is, as with Variables (0006) / Watch (0007) / Call Stack
(0008), a one-line core patch — an extension cannot retire a built-in view.

## What

The Breakpoints view's `when` is
`ContextKeyExpr.or(CONTEXT_BREAKPOINTS_EXIST, CONTEXT_DEBUG_UX.isEqualTo('default'),
CONTEXT_HAS_DEBUGGED)`. It becomes that same OR **AND-gated** by
`ContextKeyExpr.notEquals('config.burrow.inspector.hideStockBreakpoints', true)`.
The gating setting `burrow.inspector.hideStockBreakpoints` (boolean, **default
true**) is registered in `burrow-core`. Set it `false` to bring the permanent pane
back.

## Design deviation (recorded honestly)

Task 05.1 hangs the popover off "the scheme bar's 🐞 menu". The extension API has
**no** supported menu-contribution point for the pre-launch Run/Debug scheme bar,
so the button lives on the debug toolbar (visible while a session runs) and the
keyboard/palette command covers the pre-launch case. The interaction — a transient,
keyboard-driven popover with no permanent real estate — matches the design intent;
only the button's placement differs. A literal scheme-bar button would need a new
core menu id, which is a larger core patch than this task warrants.

## Not done here

- Adding/editing a breakpoint's **condition / hit-count / log message** from inside
  the popover. The popover toggles, removes, and reveals; setting conditions still
  uses the editor gutter's inline breakpoint UI (unchanged). Conditional-breakpoint
  editing in the popover is later polish.

## Rebase notes

- Mirror 0006/0007/0008: if upstream changes the Breakpoints view registration,
  re-apply the single `when` tightening — preserve the original OR and AND-gate it
  by `config.burrow.inspector.hideStockBreakpoints` (default true). Rename in
  lockstep with the `burrow-core` property if the id changes.
