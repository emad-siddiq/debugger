# 0017 — Extension-published control chips for the local chat input

- **Layer:** 3 (core patch) + layer 4 (`burrow-chat` owns every Claude semantic)
- **Task:** chat — complete Claude Code controls in the chat panel
- **Upstream files touched:**
  - `src/vs/workbench/contrib/chat/browser/widget/input/burrowControlsChips.ts` — new file
  - `src/vs/workbench/contrib/chat/browser/widget/input/chatInputPart.ts` — one import,
    one `actionViewItemProvider` branch (~6 lines)
- **Size:** ~250 lines (new file) + 7 lines in `chatInputPart.ts`
- **Last verified against:** upstream 1.128.0

## Why

`burrow-chat` runs the real Claude Code CLI behind the chat panel, and the CLI has a
control surface — effort, thinking budget, permission mode, agent — that the user
expects to reach the way the Claude Code extension exposes it: chips under the chat
input whose labels show the current value.

An extension cannot draw one. The evidence, all in this tree:

- **`contributes.menus` titles are static.** The only chat-input menu an extension may
  contribute to at all is `chat/input/status` → `MenuId.ChatInputStatus`
  (`services/actions/common/menusExtensionPoint.ts`); every other chat-input menu
  (`MenuId.ChatInput`, `ChatInputSecondary`, `ChatExecute`, `ChatModePicker`) is
  internal. A menu item's `title` comes from the manifest, so a chip that reads
  "Effort: high" and then "Effort: max" is not expressible.
- **Option groups don't apply here.** `ChatSessionProviderOptionGroup`
  (`vscode.proposed.chatSessionsProvider.d.ts`) is the supported way to get real
  dropdown chips, but `chatInputPart.getAllOptionsGroups` resolves them through
  `chatSessionsService.getOptionGroupsForSessionType(...)` — they exist only for chat
  *session types* an extension owns. The Burrow chat participant is the default
  participant on the **local** session type, which core owns.

So this patch adds the missing host — and deliberately adds it **generic**. Core learns
nothing about Claude: it renders whatever groups an extension publishes and hands a
click straight back. `burrow-chat` keeps the entire vocabulary (which controls exist,
what they mean, how they map onto argv and env), which is also what keeps this patch
small enough to re-apply after a rebase.

## What

### burrowControlsChips.ts (new)

- **`IBurrowChatControlsService`** — an observable cache of the published payload
  (`{ default: Group[], sessions: { [sessionResource]: Group[] } }`) plus
  `groupsFor(sessionResource)`. Registered `InstantiationType.Delayed`. Publishing also
  sets the context keys `burrowChatControlsSlot0…3`, one per rendered chip.
- **Three commands** — the whole bridge:
  - `burrow.chat.controls.publish(payload)` — extension → core, on every state change.
    Core caches it so a chip label renders synchronously, with no ext-host round trip.
  - `burrow.chat.controls.pick(groupId, itemId, sessionResource)` — core → extension,
    on click. Core stores nothing; the extension mutates and republishes.
  - `burrow.chat.controls.activeSession()` — extension → core, the focused chat tab's
    session resource, so the extension's own quick-pick hub edits the right tab.
- **Four slot `Action2`s** on `MenuId.ChatInputSecondary`, group `navigation`, order
  `0.71`–`0.74` — between the workspace pickers (`0.6`) and the built-in Approvals
  picker (`1`), the same band the agent-host chips use. `when` is
  `chatSessionType == local` **and** the slot's context key, so the chips appear only
  in the local panel and only once something has been published. Their titles never
  render; the view item draws the label.
- **`BurrowControlChipActionViewItem`** — a `ChatInputPickerActionViewItem` (the same
  base as the model and mode pickers), so the dropdown, anchoring and compact-mode
  behaviour are upstream's. `renderLabel` draws the published label plus a per-group
  codicon; an `autorun` over the service's observable re-renders on every publish.

Only four slots exist because each chip needs a statically registered action. Raising
the count means adding actions, not just publishing more groups.

### chatInputPart.ts

One import, and one `else if` in the secondary toolbar's `actionViewItemProvider`
alongside the existing agent-host branch: when the action id is a Burrow control slot,
create the view item with the slot index and `() => this.getCurrentSessionResource()`.

## Rebase notes

- The `actionViewItemProvider` chain in `chatInputPart.ts` is upstream's churn hotspot.
  The branch is order-independent — it keys on the action id — so on a conflict, re-add
  it anywhere in that `else if` chain.
- If upstream renames `ChatInputPickerActionViewItem` or changes its constructor
  signature, follow whatever `modePickerActionItem.ts` does; this view item is a copy of
  that shape.
- `MenuId.ChatInputSecondary` order numbers are documented in
  `agentHostChatInputPicker.contribution.ts`. If upstream re-numbers that band, move
  `0.71`–`0.74` with it.
- **If upstream ever exposes option groups for the local session type**, delete this
  patch: `burrow-chat` should publish `ChatSessionProviderOptionGroup`s instead. That is
  the intended long-term shape and this is the stand-in.

## Budget note

`patches/README.md` sets a budget of **fewer than 15 core patches**. The tree was
already at 16 before this one; 0017 makes 17. Nothing here can move to layer 4 — that is
the whole reason the patch exists — but the budget is over and worth a deliberate
decision rather than silent drift.
