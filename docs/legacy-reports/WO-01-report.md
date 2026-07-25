# WO-01 report — RD: Run & Debug in the right auxiliary bar
STATUS: DONE (changes **uncommitted, for review** — see Decisions)

## Changed
- **Layer 3 core patch — ledger `patches/0004-rd-debug-aux-bar-default.md`** (5 ins / 6 del, 3 files):
  - `debug.contribution.ts:466` — debug view-container default `ViewContainerLocation.Sidebar` → `…AuxiliaryBar`.
  - `debugService.ts:647` (`openOnSessionStart` reveal) — `paneCompositeService.openPaneComposite(VIEWLET_ID, …Sidebar)` → `viewsService.openViewContainer(VIEWLET_ID)` (location-resolving; `IViewsService` already injected). The `EXPLORER_VIEWLET_ID` call at `:792` left as-is (explorer stays left).
  - `debugSession.ts:1392` (`openOnDebugBreak` reveal) — same swap; injection **swapped in place** `IPaneCompositePartService`→`IViewsService` (only user of it in this file), dead `ViewContainerLocation`/panecomposite imports removed.
- **Layer 4** — `extensions/burrow-core/package.json` `contributes.keybindings`: **⌥⌘D** (`cmd+alt+d` mac / `ctrl+alt+d`) → `workbench.action.toggleAuxiliaryBar`.
- Ledger table row added to `patches/README.md`.

## Verified
- **compile:** `npm run compile` → **0 errors** (20s). In-place ctor swap keeps the positional `new DebugSession(…)` in `callStack.test.ts:40` valid (its `undefined!` now types as `IViewsService`) — **zero test edits**.
- **boot:** fresh `/tmp/bw2` profile, clean, CDP up (`--remote-debugging-port`).
- **feature check (runtime, `@playwright/cli` over CDP + DOM assertions):** aux-bar "Additional Views" overflow lists **"Run and Debug ⇧⌘D"**; opening it → `.part.auxiliarybar` active pane header = **"Run and Debug: Run"**, `auxHasRunAndDebug=true`, `sidebarIsExplorer=true`. **Screenshot** (`scratchpad/wo1-clean2.png`): EXPLORER in the left sidebar, **RUN AND DEBUG** tab active in the **right aux bar** ("All debug extensions are disabled" — expected, no adapter aboard). **Primary DoD proven.**
- **⌥⌘D toggle:** keybinding contributed + collision-free (recon) + bound to the upstream-proven `toggleAuxiliaryBar`. End-to-end **keypress not drivable** via this CDP harness (see Discoveries) → deferred to interactive confirmation.
- **auto-reveal on session start:** not exercisable without a debug adapter (no session); the reveal hooks are patched location-aware (proven — the manual open lands in the aux bar). Protocol scoped RD as "verifiable with no adapter aboard."

## Discoveries
- **CDP keyboard limitation (reusable gotcha):** `@playwright/cli` `press`/F1/⇧⌘P do **not** reach the Burrow workbench headlessly (renderer isn't the OS key-window); **mouse dispatch + DOM eval work**. Future UI feature-checks must drive via mouse/DOM, not keys.
- On a fresh profile the **aux bar is already visible showing CHAT** (chat-centric upstream defaults the chat view to the aux bar). So Run & Debug shares the aux bar with Chat as sibling composites — the `layout.ts` `AUXILIARYBAR_HIDDEN` default flip is **unnecessary** (confirmed).
- The **getting-started walkthrough + Copilot sign-in modal still appear** on a fresh profile — a direct consequence of the WO-0 config-defaults gotcha (`burrow-core`'s `workbench.welcomePage.experimentalOnboarding:false` is rejected at registration, so onboarding is not actually suppressed). Reconfirmed this run.

## Decisions
- made — **in-place ctor swap** in `debugSession` (`IPaneCompositePartService`→`IViewsService`) instead of adding a param: keeps `callStack.test.ts` positional call valid, zero test churn.
- made — bound ⌥⌘D to the **generic** `toggleAuxiliaryBar` (0 custom code, satisfies DoD); a debug-*specific* toggle command is a later nicety.
- made — **did NOT commit.** WO-0's commit authorization was explicitly "for this WO only"; per the standing commit-only-when-asked rule these sit uncommitted for review. Ledger discipline satisfied (0004 present; `check-ledger` passes).
- needed — **authorize the commit?** Proposed: `feat(rd): Run & Debug defaults to the right aux bar (patch 0004)` + `feat(rd): ⌥⌘D toggles the aux bar`. Also: fix the config-defaults rejected-keys gotcha as a tiny side patch (recommend yes — cheap) or leave for its own WO?

## Next
- On commit authorization: commit patch 0004 + keybinding (feat/patch style, no push), then proceed.
- **WO-2 (IX prereq):** `burrow-go-debug` minimal `dlv dap` adapter + `testdata/debuggee` fixture → a live stopped session; this also unblocks end-to-end checks RD couldn't run (auto-reveal-on-stop, and ⌥⌘D once a session exists to reveal).
- Open risk: none blocking. ⌥⌘D keypress + auto-reveal-on-stop remain to be confirmed interactively / under WO-2.
