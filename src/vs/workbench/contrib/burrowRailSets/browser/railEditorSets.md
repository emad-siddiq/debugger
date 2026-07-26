# Per-rail editor sets

Each rail icon that owns a *section* owns a set of editor tabs. Switching rails
saves the editors you were looking at under the outgoing icon and applies the
incoming icon's set, so a section's tabs are not visible from any other section
and are still there when you come back. Setting:
`burrow.workbench.perRailEditorSets` (default on).

## Rules

- **[R1] Participants.** Explorer and every `workbench.view.extension.burrow-*`
  container (Run, API, Data, Components — future burrow rails join
  automatically). **Match on the id the workbench actually uses:** an
  extension's container is registered as
  `workbench.view.extension.<manifest id>`, never the bare manifest id.

  Search, Source Control, Run and Debug and Extensions do **not** participate.
  They are lenses over the files the Explorer set holds; hiding those files when
  you click into a search result would be absurd.

- **[R2] Swap.** On a participating `onDidPaneCompositeOpen` for a different
  rail: save the visible editors as the outgoing rail's working set (a rail with
  no editors stores an explicit `'empty'` sentinel), then
  `applyWorkingSet(incoming ?? 'empty', { preserveFocus: true })`, serialized
  through a `Sequencer` so two fast rail clicks cannot interleave a save with an
  apply.

- **[R3] Startup baseline.** The first composite event after a window opens is a
  *restore*, not a click — the editors on screen were put there by the
  workbench. It only re-baselines `currentKey` and swaps nothing.

- **[R4] Dirty editors.** `applyWorkingSet` never closes an editor with unsaved
  changes, so a dirty file survives every swap and carries over into the
  incoming rail's set until you save it. Documented in the setting description
  rather than worked around: silently closing unsaved work to keep a tab bar
  tidy is not a trade this feature gets to make.

- **[R5] Persistence.** Sets persist under `burrow.railEditorSets`
  (WORKSPACE/MACHINE) on `onWillSaveState`, folding the live editors into the
  current rail's set first; the working-set handles themselves are persisted by
  the editor part.

## Known edge — webview panels do not come back

`applyWorkingSet` restores what the workbench can serialize. A webview panel is
serializable only if its extension registers a `WebviewPanelSerializer`, and no
Burrow tool does. So the Data grid, Wire Diagram, Test Lab, HTTP workbench and
the isolation preview close when you leave their rail and do **not** return with
it — the files beside them do. Each is one click to reopen. Tracked as WO-60.

## Not to be confused with

- **WO-23's tool-surface sweep** (`extensions/burrow-core/src/tools.ts`): closes
  *other tools'* claimed webview panels shortly after you land on a rail. It
  predates this and only ever handled webviews — an ordinary file tab is claimed
  by no one, which is why sections still bled into each other. The two no longer
  overlap in practice: a rail switch clears the editor area first, so the sweep
  finds nothing of another tool's to close. It stays as the fallback when this
  setting is off.
- **`vs/sessions/contrib/layout/browser/compositeEditorSetsController.ts`**: the
  same idea written for the agent-sessions layout flavour. Burrow boots
  `workbench.desktop.main.ts`, which never imports the sessions entry point, so
  that one is not constructed in this product.
