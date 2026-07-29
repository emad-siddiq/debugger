# 0014 — Per-rail editor sets

- **Layer:** 3 (one new workbench contribution + one import line)
- **Task:** — (docs/plans/02 §6 successor; user report 2026-07-27, WO-59)
- **Upstream files touched:** `src/vs/workbench/workbench.common.main.ts` (one import)
- **New Burrow-owned files:** `src/vs/workbench/contrib/burrowRailSets/browser/railEditorSets.{contribution.ts,md}`
- **Size:** 1 line in the upstream file
- **Last verified against:** upstream 1.128.0
- **Amended:** WO-60b, 2026-07-29 — see *Amendment* below

## Why

Each rail icon is a section — Explorer, Run, API, Data, Components — and each
opens its own editors. Left alone they accumulate: switching Data → Components
leaves the query grid behind, and the component's `.tsx`/`.css` follow you into
Data. The user's words: *"if I switch from components to database, I want the
components related tabs to not be visible … only tabs that are an integral part
of that section, not carry overs."*

`docs/plans/02 §6` (WO-23) answered half of this from the extension side: tools
*claim* their transient surfaces and `burrow-core` closes the inactive tools'
claims on a switch. That handles webview panels and nothing else — an ordinary
file tab is claimed by no one, so every source file a section opened carried
over, which is most of what the user was looking at.

## What

`RailEditorSetsContribution` gives each participating rail its own **editor
working set**: switching saves the visible editors under the outgoing icon and
applies the incoming icon's set, so returning restores what you left. Rules and
persistence are in `railEditorSets.md`; the setting is
`burrow.workbench.perRailEditorSets` (default on).

The upstream file gains exactly one import line, next to the Explorer
contributions it sits closest to in purpose.

## Two reasons it did nothing before this (2026-07-27)

There was already an implementation of this idea in the tree —
`vs/sessions/contrib/layout/browser/compositeEditorSetsController.ts`, with
tests and a design note — and it had never run. Two independent faults, either
of which alone is enough to make a feature look like it does not exist:

1. **It is registered from `sessions.layout.contribution.ts`**, which only
   `sessions.desktop.main.ts` imports. Burrow boots the standard
   `workbench.desktop.main.ts`, so the class was never constructed. Nothing logs
   when a contribution is simply not imported.
2. **`participates()` matched `compositeId.startsWith('burrow-')`.** Extension
   containers are registered as `workbench.view.extension.<id>`
   (`viewsExtensionPoint.ts`), which is the id the composite event carries — so
   no Burrow rail would have participated even if it had been constructed.

This entry covers the standalone rewrite for the standard workbench. The
sessions-flavour twin is left in place, inert, and named in `railEditorSets.md`
so the next reader does not have to rediscover which of the two runs. It is
three files, all Burrow-owned and all dead code in this product:

- `src/vs/sessions/contrib/layout/browser/compositeEditorSetsController.ts`
- `src/vs/sessions/contrib/layout/browser/compositeEditorSetsController.md`
- `src/vs/sessions/contrib/layout/test/browser/compositeEditorSetsController.test.ts`
- plus its registration in `src/vs/sessions/contrib/layout/browser/sessions.layout.contribution.ts`

They are listed here because they are core-source files and the ledger is the
only place that says so. WO-60b's rebuilt gate caught the test file as
unmentioned, which is the gate working: the paths above are now the record.

## Interaction with WO-23's tool-surface sweep

Both still run and they no longer overlap in practice: a rail switch clears the
editor area first, so the sweep 300ms later finds nothing of another tool's to
close. `burrow.workbench.tidyToolTabs` stays on — it is the fallback when a user
turns the editor sets off.

## Amendment — WO-60b, 2026-07-29: the first rail click after a restore was swallowed

**Authorised deviation from the run protocol's line budget.** The patch *count*
is unchanged — this is an edit to 0014, not a new entry — but the line count in
`railEditorSets.contribution.ts` moves by **+19/−8** (7 of them code, the rest
comment). WO-60b authorised it explicitly, and the reason is that without it
WO-60's ten serializers are invisible on the one click that matters: the panel
comes back into the rail's set correctly and then is not shown, which reads to
the user as the panel having been lost.

**The fault.** `RailEditorSetsContribution` registers at
`WorkbenchPhase.AfterRestored`, by which time the restored sidebar composite is
already open — so `onDidPaneCompositeOpen` never fires for it. The first event
the contribution could ever observe was therefore the user's first click, and
`_pendingRebaseline` consumed it without saving the outgoing set or applying the
incoming one. Measured in the packaged app, both directions: reload on
Components then click Data left the Components editors in place; reload on Data
then click Explorer left the Data editors in place.

**The fix.** `_pendingRebaseline` is deleted. The constructor seeds
`_currentKey` from
`paneCompositePartService.getLastActivePaneCompositeId(ViewContainerLocation.Sidebar)`.

Chosen over the alternative (apply on the first event whose key differs from the
restored one) because it is the one that survives **a rail being closed entirely
at restore time**: `getLastActivePaneCompositeId` reads the pane composite
part's persisted id — `compositePart.ts` seeds `lastActiveCompositeId` from
storage in its own constructor — so it answers with the rail the window was left
on even when the sidebar is hidden and there is no live composite to compare
anything against. The alternative has nothing to work with in that case and
degrades back to swallowing the click.

Where the seed does not participate (Search, Source Control, or a part with no
persisted id), `_currentKey` stays `undefined` and the existing
`!this._currentKey` branch baselines without swapping — deliberately: there is
no outgoing set to save, and applying a set over editors that belong to no rail
would close tabs that are in no set and cannot be brought back.

**Regression cover:** `docs/plans/scripts/pass2/P2-13.mjs`, which drives both
directions in a real window and names the rail in the failure message.

## Known edge — webview panels do not come back (closed by WO-60)

`applyWorkingSet` restores editors the workbench can serialize. A webview panel
is serializable only if its extension registers a `WebviewPanelSerializer`, and
no Burrow tool does. So the Data grid, Wire Diagram, Test Lab, HTTP workbench and
the isolation preview **close on leaving their rail and do not return with it** —
their files do. This is not silent data loss (each is one click to reopen, and
the isolation trio tears down as a unit by its own rule), but it is a visible
asymmetry: file tabs restore, tool panels reopen.

**Closed by WO-60** (2026-07-29, layer 4 only, no core change): ten surfaces
register a serializer and come back with their rail, their window and their
state. Nothing in this patch changed for it. The dependency runs one way — a new
tool surface without a serializer silently drops out of every set its rail
saves. See `docs/architecture/17-panel-persistence.md`.

## Rebase notes

- The contribution is Burrow-owned and rebases as a unit. Only the single import
  in `workbench.common.main.ts` carries conflict risk, and it is additive.
- If upstream adds first-class per-container editor sets, this retires whole.
