# CompositeEditorSetsController

Per-activity-icon editor working sets: each participating left-menu icon owns
its own set of editor tabs. Switching icons saves the visible editors under the
outgoing icon and applies the incoming icon's saved set — separate
"workspaces" per icon. Setting: `sessions.layout.perActivityEditorSets`
(default on).

## Rules

- **[C1] Participants.** Explorer, every `burrow-*` view container (Run, API,
  Data, Components, Docker — future `burrow-*` icons join automatically) and
  the sessions Files container (AuxiliaryBar). **Match on the id the workbench
  actually uses:** an extension's container is registered as
  `workbench.view.extension.<manifest id>`, so matching the bare manifest id
  excludes every one of them — that mistake made this feature inert for its
  first two days. Search, Source Control, Run and Debug and Extensions are
  deliberately excluded: they are lenses over the files the Explorer set holds,
  and hiding those files when you click a search result would be absurd.
  Composites the layout controllers open programmatically (Changes, sessions
  list, …) never swap the editor area. One `currentKey` spans both locations:
  the last participating icon opened in either bar.

- **[C2] Swap.** On an allowlisted `onDidPaneCompositeOpen` for a different
  icon: save the visible editors as the outgoing icon's working set (an icon
  with no editors stores an explicit `'empty'` sentinel), then
  `applyWorkingSet(incoming ?? 'empty', { preserveFocus: true })` under a
  `Sequencer` and `suppressEditorPartAutoVisibility()` — an icon switch never
  toggles the editor part's visibility, only the tabs inside it.

- **[C3] Session scoping.** Keys are `sessionResource::compositeId`
  (`global::…` without a session). Session working sets
  (BaseLayoutController [B2]) are the OUTER scope: on a session switch this
  controller records which icon owned the outgoing session's editors
  (`lastCompositeBySession`), goes quiescent while the base controller
  restores the incoming session's editors, and the next composite event only
  **re-baselines** `currentKey` to the incoming session's remembered icon —
  restore-driven composite opens (e.g. the aux bar re-opening Files) never
  swap, and the restored editors are never saved under the wrong icon.

- **[C4] Multi-visible suppression.** While more than one session is visible
  the editor area is shared (base [B5]); all swaps are suppressed and the
  controller re-baselines when collapsing back to one session.

- **[C5] Dirty editors.** `applyWorkingSet` closes with
  `excludeConfirming: true`, so editors with unsaved changes survive every
  swap — they carry over into the incoming icon's set until saved (documented
  in the setting description).

- **[C6] Persistence & cleanup.** Sets + per-session anchors persist under
  `sessions.compositeEditorSets` (WORKSPACE/MACHINE) on `onWillSaveState`,
  folding the live editors into the current icon's set first; the working-set
  handles themselves are persisted by the editor part. Removed/archived
  sessions delete their icon sets.
