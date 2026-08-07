# 0016 — Floating-window support for Burrow surfaces

- **Layer:** 3 (core patch)
- **Task:** — (user request 2026-08-06, "pop out and dock the windows we added")
- **Upstream files touched:**
  `src/vs/workbench/browser/parts/editor/editorCommands.ts`,
  `src/vs/workbench/browser/parts/editor/editorActions.ts`,
  `src/vs/workbench/browser/parts/editor/editor.contribution.ts`,
  `src/vs/workbench/api/common/extHost.protocol.ts`,
  `src/vs/workbench/api/browser/mainThreadEditorTabs.ts`,
  `src/vs/workbench/api/common/extHostEditorTabs.ts`,
  `src/vscode-dts/vscode.d.ts`
- **Size:** ~55 lines
- **Last verified against:** upstream 1.128.0

## Budget note

This is the **16th** entry against a stated budget of *"< 15 patches total"*
(`README.md` § The rule). The overrun is deliberate and is recorded here rather
than hidden: the alternative — an extension-side implementation — does not
exist, because the only API that moves an editor between windows
(`IEditorGroup.moveEditors` across parts) is core-internal, and the ext host
cannot even *observe* which window an editor is in (see *Why* below). If the
count matters more than the feature, the retirement candidate is 0005 or 0012,
both one-liners that could move to `product.json` defaults.

## Why

Every Burrow tool surface is a webview editor, and a second monitor is the
natural home for several of them (the Wire Diagram beside the code it explains,
the DB grid beside the query, the Frontend Debugger beside the component). VS
Code already moves an editor *out* into an auxiliary window
(`workbench.action.moveEditorToNewWindow`). It has no per-editor way to move one
back: `workbench.action.restoreEditorsToMainWindow` is `mergeAllGroups` — every
editor in the focused auxiliary window at once — and it is preconditioned on
`IsAuxiliaryWindowFocusedContext`, so it cannot back a title-bar button that is
meant to dock exactly the editor whose title bar it sits in.

This cannot be an extension. `IEditorGroupsService.mainPart` and
`IEditorGroup.moveEditors` are workbench services with no ext-host projection,
and `WebviewPanel.viewColumn` / `TabGroup.viewColumn` both derive from
`editorGroupToColumn`, which flattens all parts main-first — so an auxiliary
group reports a column indistinguishable from an ordinary split. An extension
can neither perform the move nor tell whether it is needed.

## What

`MoveEditorToMainWindowAction` (`workbench.action.moveEditorToMainWindow`) —
the exact mirror of `MoveEditorToNewWindowAction`, built from the same parts
(`resolveCommandsContext` for the target editor, `prepareMoveCopyEditors` for the
move options, single-group-only for the same reason upstream states there). It
moves the resolved editor into `editorGroupsService.mainPart.activeGroup` and
focuses it; a no-op when that group is already the source.

The precondition is `ActiveEditorContext && IsAuxiliaryWindowContext` —
deliberately **not** `IsAuxiliaryWindowFocusedContext`. `IsAuxiliaryWindowContext`
is bound on the *part-scoped* context key service in
`AuxiliaryEditorPartImpl.handleContextKeys`, so it is true for that window's
title bar regardless of focus; the focused variant tracks focus and would grey
the Dock button out at exactly the moments it is wanted.

Nothing closes the emptied auxiliary window explicitly. It closes itself:
`AuxiliaryEditorPartImpl.removeGroup` → `doRemoveLastGroup` → `doClose`, with
`Event.once(editorPart.onWillClose)` wired to `auxiliaryWindow.window.close()` in
`AuxiliaryEditorPart.create`. This holds only while
`workbench.editor.closeEmptyGroups` is `true` (upstream default; not overridden
in `burrow-core`'s `configurationDefaults`).

### Why Dock's button is contributed here and Pop Out's is not

The symmetric design — both buttons contributed by `burrow-core` from its
`editor/title` menu — does not work, and the reason is worth writing down
because nothing announces it.

**Measured 2026-08-06 in a real auxiliary window**, driving the title bar by
synthesized mouse events (a full `pointerdown/mousedown/mouseup/click` sequence
verified as delivered to the button element):

| button in the floating window's title bar | result |
|---|---|
| `Lock Group` (stock workbench action) | runs — the label flips to `Unlock Group` |
| `Toggle Focus Mode` (extension command, **pre-existing**, unrelated to this work) | nothing |
| `burrow.window.dock` (extension command) | nothing |

So **extension-contributed `editor/title` items do not execute when clicked in
an auxiliary window**, while core actions in the same toolbar do. That is a
property of this workbench, not of this feature — the `burrow.focus.toggle`
button has presumably been inert in floating windows since floating windows
existed.

Hence the split, which looks asymmetric and is not arbitrary:

- **Pop Out** is only ever clicked in the main window, so it stays an extension
  contribution (`burrow.window.popOut`, `editor/title`, `!isAuxiliaryWindow`).
- **Dock** is only ever clicked in a floating window, so it is contributed by
  the core action itself via `menu: { id: MenuId.EditorTitle, … }`.

Core reading `burrow.window.detachable` — an array context key that
`burrow-core` publishes — is the seam that keeps the surface list out of core:
this patch names no Burrow viewType. If a future workbench fixes extension
commands in auxiliary windows, move the Dock menu entry back to `burrow-core`
and this action loses its `menu`, nothing else.

### Amendment 2026-08-06 — Dock's `when` is the window, and only the window

Dock's menu entry originally also required
`activeWebviewPanelId in burrow.window.detachable`, mirroring Pop Out. That was
wrong, and the user found it the first afternoon: **any tab can be dragged into
a new window by hand** — that path is stock workbench behaviour and asks no
extension's permission — so an ordinary `.go` file could float with no button to
bring it back, only `workbench.action.restoreEditorsToMainWindow`, which merges
the entire window at once. Reported as "no redock button".

So the `when` is now `IsAuxiliaryWindowContext` alone. The asymmetry with Pop Out
is intentional and is about cost, not about which editors are special: Pop Out
buys a permanent icon in the main window's title bar, so it stays scoped to the
surfaces that opted in; Dock only ever renders in a floating window, where it is
the way home for whatever is in there. Verified 2026-08-06 on a plain `main.go`
in a floating group of three: the button is present, and clicking it moved that
one editor to the main window and left the other two floating.

The action's body never read the context key, so nothing else changed — and
`burrow.window.detachable` still gates Pop Out, so the seam this patch describes
is intact.

The `when` clause still leans on `IsAuxiliaryWindowContext` being bound on the
*part-scoped* context key service, which is what makes one static pair of
entries behave like a toggle. If a rebase moves that binding off the part's
scoped service, both buttons appear in both windows at once.

### The Dock target cannot come from the global active editor alone

`resolveCommandsContext` with no arguments falls back to
`editorGroupsService.activeGroup` — the *global* active group. For Pop Out that
is right. For Dock it is routinely wrong: the main window can hold focus while
the click lands in the floating window, and the resolved group is then the main
one, empty or holding an editor the user never asked to move. Measured: Dock
did nothing at all, silently.

So the action prefers the resolved context (correct with an
`IEditorCommandsContext` argument, or when the floating window has focus) and
falls back, when that context is empty or names a main-part group, to the first
non-main part with an active editor — asking the question Dock is actually
asking, *"which editor is floating?"*. With several floating windows and no
focus among them it picks the first; with focus, the context answers exactly.

## Part two — `TabGroup.isAuxiliaryWindow`

The feature is not finished by moving a window; it has to survive the two
things that close Burrow surfaces on a rail switch. One is the per-rail editor
sets (fixed in 0014's second amendment). The other is `burrow-core`'s
transient-tab sweep, and it needed a fact the extension host did not have.

`window.tabGroups.all` includes auxiliary-window groups, so a popped-out surface
is an ordinary sweep candidate. Nothing on `Tab` or `TabGroup` said otherwise:
`viewColumn` comes from `editorGroupToColumn`, a grid index over *all* parts
flattened main-first, so a floating group's column is indistinguishable from a
split's — there is no value it could take that means "floating".

So `IEditorTabGroupDto` gains `isAuxiliaryWindow`, set in
`MainThreadEditorTabs._createTabsModel` from
`group.windowId !== mainWindow.vscodeWindowId` (`IEditorGroup.windowId` is
already public), read back through `ExtHostEditorTabGroup`'s api object, and
declared on `vscode.TabGroup`.

The DTO field is **optional on the wire** and the getter coerces with `=== true`.
That is not sloppiness: upstream's `extHostEditorTabs.test.ts` hand-builds ~20 of
these DTOs, and making the field required means editing all twenty upstream test
call sites — a much larger rebase surface for no behavioural gain. Absent means
"not floating", which is the safe direction: a false negative costs exactly the
pre-patch behaviour.

Consumers: `extensions/burrow-core/src/toolsLogic.ts` (`selectTabsToClose` skips
any tab whose group is auxiliary — covered by
`extensions/burrow-core/test/tools.test.js`) and
`extensions/burrow-frontend-debugger/src/isolation.ts`
(`closeStaleComponentTabs`, which sweeps `tabGroups.all` on its own account).

An earlier revision protected floating surfaces with a *second* mechanism: a set
of viewTypes `burrow-core` had itself popped out, passed to `selectTabsToClose`
as `protectedKeys`. It is gone. It only ever covered button-driven pop-outs (not
a tab dragged out by hand), it needed its own invalidation, and once Dock moved
into core it had no reliable moment to clear — a docked surface would have
stayed "protected" until its tab closed. One exact signal beats two approximate
ones.

## Views cannot float, and that is not fixable here

`AuxiliaryEditorPart`, `IAuxiliaryTitlebarPart` and `IAuxiliaryStatusbarPart`
exist. There is no auxiliary *views* part, no `moveViewToNewWindow`, and nothing
under `browser/parts/views/` that mentions auxiliary windows at all. Adding one
means a `ViewPaneContainer` host, `IViewDescriptorService` re-targeting,
drag-and-drop and persistence — a workbench feature in the thousands of lines,
an order of magnitude past this ledger's per-patch budget.

Burrow's answer is layer 4 and needs no core change: `detachableView.ts` (copied
per extension, like `toolSurface.ts`) re-hosts a `WebviewView`'s HTML and
message protocol in a `WebviewPanel`, which *can* float. The provider renders
into a structural `ViewHost` and cannot tell which kind it got. The rail slot
keeps a placeholder with a Dock button — deliberately, rather than hiding the
view, so the way back is where the user last saw the content.

**The two TreeViews cannot be reached by this or anything short of a rewrite.**
`burrowFlowRoutes` and `burrowComponents` are `TreeDataProvider`s; a tree renders
only in a view container. Re-implementing each as webview HTML costs 300–600
lines apiece and forfeits filter-on-type, keyboard navigation, native context
menus, inline `view/item/context` actions and `TreeView.message`. Both already
have an editor-tab companion that does float — the Wire Diagram for the API
rail, the Frontend Debugger for Components. The rule Burrow ships: **a tool's
work surface floats; its navigator stays on the rail.**

## Rebase notes

- The action is additive and sits between `CopyEditorToNewindowAction` and
  `BaseMoveCopyEditorGroupToNewWindowAction`. The conflict risk is the shared
  import lines in all three files, all additive.
- If upstream ever ships a per-editor restore (the obvious shape is an argument
  on `RestoreEditorsToMainWindowAction`), this retires whole — keep the
  `workbench.action.moveEditorToMainWindow` id alive as an alias for one release
  so `burrow-core`'s command does not need to know.
- If upstream adds its own `TabGroup.isAuxiliaryWindow` (it is an obvious gap),
  drop Burrow's four-file half and keep the consumers — they are written against
  the public API, not the DTO.
- `prepareMoveCopyEditors` and `resolveCommandsContext` are both recent upstream
  refactors of what used to be inline. If either changes shape, copy whatever
  `MoveEditorToNewWindowAction` does — this action's whole design rule is *stay
  a mirror of that one*.
