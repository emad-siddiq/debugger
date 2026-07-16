# 0004 — Run & Debug defaults to the right auxiliary bar

- **Layer:** 3 (core patch — debug view-container default location + reveal hooks)
- **Task:** 05 (right-hand debug panel redesign), RD slice / WO-1
- **Upstream files touched:** `src/vs/workbench/contrib/debug/browser/debug.contribution.ts`,
  `src/vs/workbench/contrib/debug/browser/debugService.ts`,
  `src/vs/workbench/contrib/debug/browser/debugSession.ts`
- **Size:** 5 insertions / 6 deletions (net −1) across 3 files
- **Last verified against:** upstream 1.128.0

## Why

The "Run and Debug" view container's default location is a **hardcoded
registration argument** (`registerViewContainer(…, ViewContainerLocation.Sidebar)`),
not a product/config input, and its two auto-reveal hooks call
`paneCompositeService.openPaneComposite(VIEWLET_ID, ViewContainerLocation.Sidebar)`
with the location **hardcoded to Sidebar**. There is no layer-1/config or layer-4
extension path to relocate a *built-in* container: the `viewsContainers`
contribution point only accepts `activitybar`/`panel`
(`api/browser/viewsExtensionPoint.ts`), and `views.customizations` is fragile
per-profile *storage* (silently overwritten by any user drag; writing it from
outside violates the storage-key ownership rule). So RD's "debug on the right"
requires a core patch — the smallest one that moves the default and keeps the
reveal hooks pointed at wherever the container actually is.

## What

1. **Default location** — `debug.contribution.ts`: the `registerViewContainer`
   for `VIEWLET_ID` now passes `ViewContainerLocation.AuxiliaryBar` instead of
   `…Sidebar`. This is the single source of the default; every consumer that
   resolves "where is the debug container" reads it back through
   `ViewDescriptorService.getViewContainerLocation` (customLocation ?? default).

2. **Auto-reveal hooks made location-aware** (so a session/break reveal opens the
   container where it now lives, not a Sidebar slot where it no longer is —
   `paneCompositePart` only reveals a composite registered in the *target* part):
   - `debugService.ts` (`openOnSessionStart` / `openOnFirstSessionStart` path):
     `this.paneCompositeService.openPaneComposite(VIEWLET_ID, …Sidebar)` →
     `this.viewsService.openViewContainer(VIEWLET_ID)`. `IViewsService` is already
     injected here (used for the REPL reveal); `openViewContainer` resolves the
     container's current location internally, then calls `openPaneComposite` — so
     it opens in the aux bar **and auto-reveals the hidden aux bar** for free
     (`paneCompositePart` calls `setPartHidden(false)` when a hidden part's
     composite is opened). The other `openPaneComposite(EXPLORER_VIEWLET_ID,
     …Sidebar)` call is left alone — the file explorer stays in the Sidebar.
   - `debugSession.ts` (`openOnDebugBreak` path — the default): same swap. This
     file did **not** inject `IViewsService`, and `IPaneCompositePartService` was
     used *only* for this one call, so the injection is **swapped in place**
     (same constructor position) rather than added — which keeps the positional
     `new DebugSession(…)` in `test/browser/callStack.test.ts` valid with no test
     edit (its `undefined!` at that slot now types as `IViewsService`, still
     unused on that path). The now-dead `IPaneCompositePartService` and
     `ViewContainerLocation` imports are removed.

3. **Toggle keybinding** (layer 4, **not** in this patch): `extensions/burrow-core`
   `contributes.keybindings` binds **⌥⌘D** (`cmd+alt+d` on mac, `ctrl+alt+d`
   elsewhere) → `workbench.action.toggleAuxiliaryBar`. ⌥⌘D is free upstream (only
   ⌥⇧D exists); ⇧⌘D stays the debug-container open command. This toggles the aux
   bar, which now defaults to Run & Debug. A debug-*specific* toggle would need a
   small custom command — deferred; the generic aux-bar toggle satisfies the DoD.

## Not done here

- **Aux-bar first-boot visibility** (`layout.ts` `AUXILIARYBAR_HIDDEN` default
  `true`) is left as upstream — the aux bar stays hidden until the first
  debug reveal (or ⌥⌘D), which is the desired behavior. Flip it only if RD later
  wants the empty aux bar visible before any session.
- The Frames/Inspector/Watch **content** redesign (Miller columns, etc.) is task
  05 core / later WOs; this patch only relocates the existing views.

## Rebase notes

- If upstream changes the debug container registration signature or the reveal
  call sites, re-apply the three swaps; the intent is "default = AuxiliaryBar" +
  "reveal via `viewsService.openViewContainer` (location-resolving), never a
  hardcoded `openPaneComposite(VIEWLET_ID, Sidebar)`".
- If upstream adds a *new* hardcoded-Sidebar reveal for the debug container,
  it must get the same treatment.
- The `debugSession.ts` constructor swap assumes `IPaneCompositePartService`
  remains unused elsewhere in that file; if upstream adds a use, add
  `IViewsService` as a separate injection instead of swapping.
