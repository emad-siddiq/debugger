# 0011 — No title bar, and a traffic-light strip in the activity bar

- **Layer:** 3 (window-frame defaults + one workbench layout class + its CSS)
- **Task:** — (WO-01, `debugger/docs/plans/01` — chrome removal)
- **Upstream files touched:**
  `src/vs/platform/window/common/window.ts`,
  `src/vs/platform/windows/electron-main/windows.ts`,
  `src/vs/workbench/electron-browser/desktop.contribution.ts`,
  `src/vs/workbench/services/layout/browser/layoutService.ts`,
  `src/vs/workbench/browser/layout.ts`,
  `src/vs/workbench/browser/parts/activitybar/media/activitybarpart.css`
- **Size:** one exported constant, one default, one `trafficLightPosition`, one predicate, one layout class, one CSS block
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

## What

Keep the frameless window, and **give the buttons a home instead of a row**:

1. `window.ts` exports `WindowControlsInset` — `{ x: 7, y: 13, STRIP_HEIGHT: 38 }`.
   Both processes load this file, which is why the constant lives here: the main
   process positions the buttons, the renderer reserves the space.
2. `windows.ts` sets `options.trafficLightPosition` from it on macOS whenever the
   native title bar is hidden.
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
3. `layout.ts` adds the `window-controls-inset` workbench class
   (`LayoutClasses.WINDOW_CONTROLS_INSET`), true when macOS + custom title-bar
   style + the custom title bar is not shown. Applied in `getLayoutClasses()` and
   refreshed from `updateCustomTitleBarVisibility()`.
4. `activitybarpart.css` insets `.activitybar > .content` by 38px under that
   class. The strip is background and nothing else.
5. `editorgroupview.css` puts the window's `-webkit-app-region: drag` on the
   editor title bar, with `no-drag` on the tabs, breadcrumbs and both toolbars.

### The drag region does NOT go in the strip (2026-07-27)

It did, for one build. **A drag region drawn over the traffic lights makes them
unclickable** — the buttons still paint, still hover, and swallow every click.
Reported by the user within the hour: *"now I can't even click the traffic
lights"*.

There is no room to keep both: the buttons are 52px wide and the activity bar is
48px, so any drag region in that strip covers them. The empty run of the editor
title bar to the right of the tabs is the next best handle, is nowhere near
x &lt; 64px, and is where a macOS user reaches for a window anyway. Every
interactive child of that bar needs an explicit `no-drag` or it stops responding
— drag regions swallow mouse events whole.

Fullscreen hides the traffic lights; the `fullscreen` class already on the
workbench turns the strip back off via `:not(.fullscreen)`.

## Known edges

- The buttons are 52px wide and the activity bar is 48px, so they overhang the
  sidebar's top-left corner by ~11px. That corner is empty padding above the
  view title, so nothing is covered. With the sidebar hidden the overhang lands
  on the leading edge of the first editor tab.
- Scoped to the activity bar on the left (Burrow's layout). If the activity bar
  is moved to the right or hidden, the strip goes with it and the overlap
  returns — no Burrow surface does either.

## Rebase notes

- Grep `BURROW patch 0011`. Four sites, listed above.
- If upstream gives the frameless window a drag region of its own, item 4's
  pseudo-element can drop the drag and keep only the spacing.
- If upstream exposes `trafficLightPosition` as a setting, items 1–2 retire.
