# 0008 — Frames view: retire stock Call Stack + a focus-frame command

- **Layer:** 3 (two core patches) + layer 4 (`burrow-core` setting, `burrow-go-inspect` view)
- **Task:** 05 (right-hand debug panel redesign), IX slice / WO-11 — the Frames view
  (task 05.2).
- **Upstream files touched:**
  - `src/vs/workbench/contrib/debug/browser/debug.contribution.ts` — one `when` clause
  - `src/vs/workbench/contrib/debug/browser/debugCommands.ts` — one new command
- **Size:** 1 line (Call Stack `when` clause) + ~28 lines (the `burrow.debug.focusFrame`
  command) + one property in `extensions/burrow-core/package.json`
- **Last verified against:** upstream 1.128.0

## Why

The Burrow Frames view (`extensions/burrow-go-inspect`, `frames.ts`) replaces the
stock Call Stack: compact one-line frames, runtime/stdlib frames folded into an
expandable `runtime ⋯ (n)` row, and a goroutine header + switcher backed by dlv's
DAP `threads` list. It needs **two** things core has to grant:

1. **Retire the stock view** — same situation as Variables (0006) and Watch (0007):
   an extension cannot hide a built-in view, so gating the Call Stack registration
   is a one-line core patch.
2. **A way to act on a click.** The extension API exposes `debug.activeStackItem`
   as **read-only** and `IDebugService.focusStackFrame` is core-only. A webview
   Frames view can *read* the stack (DAP `threads`/`stackTrace`) but has no
   supported way to focus a frame or switch goroutines. `burrow.debug.focusFrame`
   is that one capability, added to `debugCommands.ts`.

## What

### debug.contribution.ts — gate the Call Stack view

`when: CONTEXT_DEBUG_UX.isEqualTo('default')` becomes
`ContextKeyExpr.and(CONTEXT_DEBUG_UX.isEqualTo('default'),
ContextKeyExpr.notEquals('config.burrow.inspector.hideStockCallStack', true))`.
The gating setting `burrow.inspector.hideStockCallStack` (boolean, **default true**)
is registered in `burrow-core` `contributes.configuration`. Set it `false` to bring
the stock Call Stack back. Identical mechanism to 0006/0007.

### debugCommands.ts — `burrow.debug.focusFrame`

A `CommandsRegistry.registerCommand` taking `{ sessionId, threadId, frameId? }`:
resolves the session and thread from the debug model, fetches the call stack on
demand (a thread the user never expanded has an empty one), and calls
`debugService.focusStackFrame(frame, thread, session, { explicit: true })`. Omit
`frameId` to focus a goroutine at its top frame — that is the goroutine switcher's
path. Every service and type it uses (`IDebugService`, `ServicesAccessor`,
`CommandsRegistry`) was already imported in the file.

## Not done here

- The full **goroutine table** (state histogram, labels, stack-per-goroutine
  panel) is task 06's visualizer. This view surfaces what DAP volunteers — the
  goroutine's innermost user function and a wait *hint* derived from it. dlv has
  the real scheduler state and wait reason but does **not** send them over DAP
  (`onThreadsRequest` builds only the name string), so the header shows a hint,
  not a claim.
- **Breakpoints popover** off the scheme bar (task 05.1) is its own work order;
  the Breakpoints pane is untouched here.

## Rebase notes

- Mirror 0006/0007: if upstream changes the Call Stack view registration, re-apply
  the single `when` tightening (intent: stock Call Stack gated OFF by
  `config.burrow.inspector.hideStockCallStack`, default true, on top of
  `CONTEXT_DEBUG_UX == default`).
- `burrow.debug.focusFrame` is additive (a new command id), so a rebase only needs
  the `IDebugService` API shape to hold: `getModel().getSessions()`,
  `session.getAllThreads()`, `getModel().fetchCallstack(thread)`,
  `focusStackFrame(frame, thread, session, opts)`. If any of those move, re-point
  the handler; the command id and its args contract stay stable for the extension.
