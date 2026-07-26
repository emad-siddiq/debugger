# 0014 — Per-rail editor sets

- **Layer:** 3 (one new workbench contribution + one import line)
- **Task:** — (docs/plans/02 §6 successor; user report 2026-07-27, WO-59)
- **Upstream files touched:** `src/vs/workbench/workbench.common.main.ts` (one import)
- **New Burrow-owned files:** `src/vs/workbench/contrib/burrowRailSets/browser/railEditorSets.{contribution.ts,md}`
- **Size:** 1 line in the upstream file
- **Last verified against:** upstream 1.128.0

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
so the next reader does not have to rediscover which of the two runs.

## Interaction with WO-23's tool-surface sweep

Both still run and they no longer overlap in practice: a rail switch clears the
editor area first, so the sweep 300ms later finds nothing of another tool's to
close. `burrow.workbench.tidyToolTabs` stays on — it is the fallback when a user
turns the editor sets off.

## Known edge — webview panels do not come back

`applyWorkingSet` restores editors the workbench can serialize. A webview panel
is serializable only if its extension registers a `WebviewPanelSerializer`, and
no Burrow tool does. So the Data grid, Wire Diagram, Test Lab, HTTP workbench and
the isolation preview **close on leaving their rail and do not return with it** —
their files do. This is not silent data loss (each is one click to reopen, and
the isolation trio tears down as a unit by its own rule), but it is a visible
asymmetry: file tabs restore, tool panels reopen. Tracked as WO-60.

## Rebase notes

- The contribution is Burrow-owned and rebases as a unit. Only the single import
  in `workbench.common.main.ts` carries conflict risk, and it is additive.
- If upstream adds first-class per-container editor sets, this retires whole.
