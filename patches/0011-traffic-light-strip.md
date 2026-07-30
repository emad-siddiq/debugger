# 0011 — No title bar, and the rail icons dropped below the window buttons

- **Layer:** 3 (window-frame defaults + one workbench layout class + its CSS)
- **Task:** — (WO-01, `debugger/docs/plans/01` — chrome removal)
- **Upstream files touched:**
  `src/vs/platform/window/common/window.ts`,
  `src/vs/platform/windows/electron-main/windows.ts`,
  `src/vs/platform/windows/electron-main/windowImpl.ts`,
  `src/vs/platform/native/common/native.ts`,
  `src/vs/platform/native/electron-main/nativeHostMainService.ts`,
  `src/vs/workbench/electron-browser/desktop.contribution.ts`,
  `src/vs/workbench/electron-browser/actions/developerActions.ts`,
  `src/vs/workbench/services/layout/browser/layoutService.ts`,
  `src/vs/workbench/browser/layout.ts`,
  `src/vs/workbench/browser/parts/editor/editorGroupView.ts`,
  `src/vs/workbench/browser/parts/activitybar/media/activitybarpart.css`,
  `src/vs/workbench/browser/parts/editor/media/editorgroupview.css`,
  `src/vs/workbench/test/electron-browser/workbenchTestServices.ts`
- **Size:** one exported constant + one helper, three defaults, one predicate, one
  layout class, one guard in `updateWindowControls`, two native-host methods, two
  debug commands, one drag-region element, four CSS blocks
- **Last verified against:** upstream 1.128.0

## Why

WO-01 removes Burrow's top row. Upstream's custom title bar hosts the Command
Center and the chat "Sign In" entitlement control — none of which belong in a Go
IDE — and `burrow-core` already sets `window.customTitleBarVisibility: "never"`,
so the workbench draws no title bar.

On macOS that leaves a window with **zero chrome**, and macOS paints the traffic
lights onto content at (0,0): the activity bar's first icon. It also leaves the
window with **no drag region at all** — nothing in the workbench sets
`-webkit-app-region: drag` except the title bar — so the window cannot be moved.

## The route that was tried and withdrawn (2026-07-26)

The first fix defaulted `window.titleBarStyle` to `native` (schema default in
`desktop.contribution.ts`, plus the `getTitleBarStyle()` fallback that the main
process actually reads — a workbench contribution is registered only by the
renderer, so the schema default alone builds a frameless window while the
renderer thinks it is native).

That worked, and was wrong: it bought back a **28px native title strip that
displays nothing**. Withdrawn on the user's report the same day — "the overlap
was better than what we have now because at least it didn't add a top row that
adds nothing to the app". Both defaults are back to upstream's `custom`; the
lesson worth keeping is that the two processes disagree about this setting
unless the default lives in `window.ts`.

## The cause, found by measuring instead of guessing (2026-07-30)

Rounds two through five of this patch all tuned `trafficLightPosition` in
`windows.ts` — `{7,13}`, then nothing at all, then `{0,0}` — and each time the
buttons came back clipped, or landed outside the viewport. **None of those values
ever reached the window.**

Upstream re-places the buttons itself, in `BaseWindow.updateWindowControls()`
(`windowImpl.ts`), by centring them in the custom title bar:

```
const offset = Math.floor((options.height - buttonHeight) / 2);
win.setWindowButtonPosition({ x: offset + 1, y: offset });
```

It runs at window creation and again on every height report from the renderer.
Burrow **has no title bar**, so the renderer reports `height: 0`, and with
`buttonHeight` 16 the maths gives `offset = -8` → **`{x: -7, y: -8}`**: each
circle half off the top-left corner. That is the "partially hidden … can't click"
report, and it is why the constructor pin appeared to do nothing — it was
overwritten milliseconds after the window opened, every single time.

Measured on the running dev build, 2026-07-30, over Electron's **main-process
inspector** (`--inspect`), which is where `getWindowButtonPosition()` lives:

| Checked | Result |
|---|---|
| `getWindowButtonPosition()` with the pin at `{0,0}` | **`{x: -7, y: -8}`** — the clipping, quantified |
| the same call on a bare Electron window with `trafficLightPosition: {0,0}` | `{0,0}` — so it is **not** an Electron quirk |
| `setWindowButtonPosition()` round-trip, five values | identity, every time |
| after the guard below, fresh window | **`{x: 7, y: 6}`**, and still `{7,6}` after settle |
| a floating (auxiliary) window | **`{x: 7, y: 6}`** — same path, same result |

### Three claims this note used to make, all of them wrong

They are recorded because they are what kept the work in guess-mode for three
rounds, not because they are true:

1. *"Electron has deprecated `trafficLightPosition`."* It has not. The deprecated
   pair was `get/setTrafficLightPosition`, which no longer exists in the 42.5.0
   typings at all; the constructor option is undeprecated and works.
2. *"There is no way to read the buttons' real position back."*
   **`getWindowButtonPosition()`** returns it (`electron.d.ts:2869`). It is
   main-process only, which is why renderer probes never found it.
3. *"Every guess here costs a full rebuild."* **`setWindowButtonPosition()`**
   (`:3565`) moves them on a live window. Both are now exposed as
   `burrow.debug.{get,set}WindowButtonPosition`.

## What

Keep the frameless window, and **keep content out from under the buttons**:

1. `window.ts` exports `WindowControlsInset` — `{ x: 7, y: 6, STRIP_HEIGHT: 28 }`
   — and `getTrafficLightPosition()`, which applies the user's override. Both
   processes read it, and they must agree or the buttons move on their own.

   `7,6` is not a guess: it is upstream's own centring formula
   (`floor((barHeight - 16) / 2)`, then `{x: offset + 1, y: offset}`) evaluated
   for the 28px strip Burrow reserves instead of drawing. Verified by readback.
2. `windows.ts` sets it at window creation, and — the part that makes it hold —
   **`windowImpl.ts` guards `updateWindowControls()`**: when the centring maths
   yields `offset <= 0`, i.e. when there is no title bar to centre anything in,
   the configured pin wins instead. Upstream's `!offset` branch (hand placement
   back to macOS) is folded into that guard; on Burrow it put the buttons
   outside the viewport entirely.

   Overridable at runtime by the **`window.trafficLightPosition`** setting
   (registered in `desktop.contribution.ts`, macOS only, read by the MAIN
   process), and readable with `burrow.debug.getWindowButtonPosition`.
2a. `desktop.contribution.ts` defaults `window.customTitleBarVisibility` to
   **`never`** (was `auto`). This is the one that actually removes the bar, and it
   **cannot** be done from `burrow-core`'s `configurationDefaults`: the setting is
   `ConfigurationScope.APPLICATION`, and extension-contributed defaults at that
   scope are *silently rejected* at registration. The manifest entry looked
   correct and had never taken effect — it is now deleted rather than left to
   mislead the next reader.
2b. `layoutService.ts` — `shouldShowCustomTitleBar()` honours `never`
   unconditionally on macOS. Upstream gates it on `&& nativeTitleBarEnabled`,
   i.e. `never` only means never when a *native* bar is there to take over; with
   the custom style it falls through to the macOS branch and draws the bar
   anyway. Windows and Linux keep upstream's rule, where the custom bar hosts the
   only window controls the app has.
2c. `native.ts` + `nativeHostMainService.ts` add `getWindowButtonPosition()` and
   `setWindowButtonPosition()`; `developerActions.ts` surfaces them as the two
   `burrow.debug.*` commands (macOS only, palette only). They persist nothing —
   the instrument that ended the guessing, not the fix. `windowById()` resolves
   auxiliary windows too, so they read a floating window as well as the main one.
3. `layout.ts` adds the `window-controls-inset` workbench class
   (`LayoutClasses.WINDOW_CONTROLS_INSET`), true when macOS + custom title-bar
   style + the custom title bar is not shown. Applied in `getLayoutClasses()` and
   refreshed from `updateCustomTitleBarVisibility()`.
4. `activitybarpart.css` drops `.activitybar > .content` by `max(3vh, 28px)`
   under that class — the user's own measure (*"go to the overlap version and
   just add 2-3vh to the left hand menu explorer icon"*, 2026-07-27), with a
   floor so a short window cannot close the gap: at the 270px minimum window
   height 3vh is 8px, and macOS centres the buttons in a 28pt band. The bar's
   background still starts at y=0, so this reads as the icons sitting lower,
   not as a strip.
5. `editorgroupview.css` puts the window's `-webkit-app-region: drag` on the
   editor title bar, with `no-drag` on the tabs, breadcrumbs and both toolbars.
6. With **no editors open** that title bar has zero height, so a fresh window
   would have no drag region at all. The handle in that state is a dedicated
   element — `editorGroupView.ts` appends `.editor-group-drag-region` to the
   group container, before the watermark so the shortcut list still hit-tests
   above it, and `editorgroupview.css` insets it below the reserved strip.

   The **whole empty container** carried the drag until 2026-07-30, and that was
   the same defect as the strip build: with the sidebar hidden the container
   starts at x=48, the buttons span x=7…61, and an ancestor walk from (54,13)
   reached a live drag region — the zoom button's right half. Measured before and
   after: all six probe points across the button footprint now report no drag,
   and the handle's rect starts at y=28.

### The drag region does NOT go in the strip (2026-07-27)

It did, for one build. **A drag region drawn over the traffic lights makes them
unclickable** — the buttons still paint, still hover, and swallow every click.
Reported by the user within the hour: *"now I can't even click the traffic
lights"*.

There is no room to keep both: the buttons are ~52px wide and the activity bar is
48px, so any drag region in that gap covers them. The empty run of the editor
title bar to the right of the tabs is the next best handle, is nowhere near
x &lt; 64px, and is where a macOS user reaches for a window anyway. Every
interactive child of that bar needs an explicit `no-drag` or it stops responding
— drag regions swallow mouse events whole.

Fullscreen hides the traffic lights; the `fullscreen` class already on the
workbench turns the strip back off via `:not(.fullscreen)`.

## Known edges

- The buttons span x=7…61 and the activity bar is 48px, so they overhang the
  sidebar's top-left corner by ~13px. That corner is empty padding above the
  view title, so nothing is covered. With the sidebar hidden the overhang lands
  on the leading edge of the first editor tab.
- **Auxiliary (floating) windows keep the same pin** — ruled 2026-07-30. They go
  through `defaultBrowserWindowOptions` and hit the same `updateWindowControls`
  guard, and both were measured at `{7,6}`: in the viewport, and every point in
  their footprint resolves to `no-drag`, so the buttons work. What they do NOT
  have is an activity bar to inset, so the buttons sit over the leading edge of
  the first tab's icon. Cosmetic only. Exempting them was the alternative and is
  worse: unpinned is the configuration that put the buttons outside the viewport.
  A fix, if it is ever wanted, is a left inset on `.content.auxiliary` — not
  taken here because it costs 72px in every floating window to solve a cosmetic
  overlap, and the geometry is measurable but the look is not.
- Scoped to the activity bar on the left (Burrow's layout). If the activity bar
  is moved to the right or hidden, the strip goes with it and the overlap
  returns — no Burrow surface does either.

## Rebase notes

- Grep `BURROW patch 0011`. Twenty-one sites across the thirteen files above.
- **The guard in `updateWindowControls()` is the load-bearing one.** If upstream
  changes that centring formula, re-read it: anything that computes a position
  from the title bar's height will fight the pin, because Burrow's title bar has
  no height. `burrow.debug.getWindowButtonPosition` answers it in one call.
- If upstream gives the frameless window a drag region of its own, items 5–6 can
  go entirely.
- If upstream exposes `trafficLightPosition` as a setting, items 1–2 retire.
