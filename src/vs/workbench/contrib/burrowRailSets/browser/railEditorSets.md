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

- **[R3] Startup baseline.** `currentKey` is seeded in the constructor from
  `getLastActivePaneCompositeId(Sidebar)` — the rail the window was left on —
  so the **first** rail click after a restore is a real switch and applies the
  incoming set.

  It has to be read, not waited for. This contribution registers at
  `AfterRestored`, by which point the restored composite is already open and its
  `onDidPaneCompositeOpen` has been and gone; the first event it can ever
  observe is the user's own click. Baselining on that event instead — the
  original rule — swallowed it: reload on Components then click Data and Data's
  set did not apply until you switched a second time, which looked exactly like
  the tool panel having been lost. Fixed in WO-60b; covered by `P2-13`.

  The persisted id answers even when the sidebar is hidden at restore, which is
  the case that decided this over the alternative (apply on the first differing
  event): with the rail closed entirely there is no live composite to compare
  against, but the editors on screen still belong to the rail we were left on.
  If that rail does not participate — Search, Source Control, or a part with no
  persisted id at all — `currentKey` stays unset and the next participating
  event baselines and swaps nothing, because there is no outgoing set to save
  and applying over unowned editors would close tabs nothing could restore.

- **[R4] Dirty editors.** `applyWorkingSet` never closes an editor with unsaved
  changes, so a dirty file survives every swap and carries over into the
  incoming rail's set until you save it. Documented in the setting description
  rather than worked around: silently closing unsaved work to keep a tab bar
  tidy is not a trade this feature gets to make.

- **[R5] Persistence.** Sets persist under `burrow.railEditorSets`
  (WORKSPACE/MACHINE) on `onWillSaveState`, folding the live editors into the
  current rail's set first; the working-set handles themselves are persisted by
  the editor part.

## Webview panels — closed in WO-60

`applyWorkingSet` restores what the workbench can serialize, and a webview panel
is serializable only if its extension registers a `WebviewPanelSerializer`.
None did, so the Data grid, Wire Diagram, Test Lab, HTTP workbench and the
isolation preview used to close when you left their rail and never come back —
the files beside them did. WO-60 registered one serializer per panel (ten
surfaces), and they now return with their rail carrying their state. See
`docs/architecture/17-panel-persistence.md`.

Nothing here needs to know about it: this contribution asks the workbench to
save and apply working sets, and the workbench decides what is serializable.
The dependency runs the other way — **do not add a surface to a rail without a
serializer**, or that panel silently drops out of every set the rail saves.

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
