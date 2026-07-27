# 0011 — No title bar, and the rail icons dropped below the window buttons

- **Layer:** 3 (window-frame defaults + one workbench layout class + its CSS)
- **Task:** — (WO-01, `debugger/docs/plans/01` — chrome removal)
- **Upstream files touched:**
  `src/vs/platform/window/common/window.ts`,
  `src/vs/platform/windows/electron-main/windows.ts`,
  `src/vs/workbench/electron-browser/desktop.contribution.ts`,
  `src/vs/workbench/services/layout/browser/layoutService.ts`,
  `src/vs/workbench/browser/layout.ts`,
  `src/vs/workbench/browser/parts/activitybar/media/activitybarpart.css`
- **Size:** one exported constant, two defaults, one predicate, one layout class, two CSS blocks
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

## The second thing that was tried and withdrawn (2026-07-27)

**`trafficLightPosition` is gone too.** It was set to `{ x: 7, y: 13 }` to park
the buttons neatly inside the reserved strip. That is what made them unclickable,
and it survived the drag-region fix below — the user reported them *still*
"partially hidden … and I can't click them" after the drag region moved out.

What was measured on the installed build before deciding, driving the running app
over CDP:

| Checked | Result |
|---|---|
| `window-controls-inset` on the workbench | **yes** |
| `.part.activitybar > .content` margin-top | **38px** at the time (now `max(3vh, 28px)`), rect started below it |
| `.part.titlebar` | **0×0** — no title row, as intended |
| **Every** element with computed `-webkit-app-region: drag` | **two, both 0×0** |
| `elementFromPoint` across x=10…64, y=19, walking each ancestor chain | **no drag region anywhere near the buttons** |

So the drag region is not the cause any more, and nothing in the DOM sits over
the buttons in a way the workbench can see. What is left is the one thing Burrow
does that upstream does not: upstream **never sets `trafficLightPosition`**, and
its traffic lights work on macOS over a custom title bar. The correlation is
exact — before this patch there was no `trafficLightPosition` and the user
confirmed the buttons worked ("the overlap was better"); the build that added it
is the build they could not click.

The mechanism fits both halves of the report. The buttons live inside macOS's own
titlebar container view, which is ~28pt tall and clips its subviews; `y: 13` puts
a 12–14pt button group at 13–27, at or past that edge — clipped at the bottom
("partially hidden") with a hit region that no longer matches where they draw
("can't click"). Electron has since **deprecated `trafficLightPosition`** in
favour of `setWindowButtonPosition()`, which is what a load-bearing API does not
do. Burrow now sets nothing and lets macOS place them, which is the only
configuration this project has evidence of working.

What stays is the **offset on the rail icons** — it is what stopped the buttons
landing on the first one, and that part of the complaint never came back. This is
the "overlap version" the user asked to return to: macOS puts the buttons where it
likes, they overhang the sidebar's empty top-left padding, and the only thing
Burrow does about it is start its icons lower down.

## What

Keep the frameless window, and **keep content out from under the buttons**:

1. `window.ts` exports `WindowControlsInset` — `{ STRIP_HEIGHT: 28 }`, a note for
   readers of the main-process side; the renderer owns the real value in CSS.
2. `windows.ts` pins `trafficLightPosition` to **`{ x: 0, y: 0 }`** — the
   top-left of the content — overridable at runtime by the new
   **`window.trafficLightPosition`** setting (registered in
   `desktop.contribution.ts`, macOS only, read by the MAIN process at window
   creation, so it takes a new window rather than a reload).

   Leaving it to macOS was tried in between and was worse: the buttons landed
   **outside the viewport entirely**. The user's instruction, three rounds in:
   *"make sure the traffic lights are at 0,0, not outside the viewport"*. The
   setting exists because every guess here costs a full rebuild and **there is
   no way to read the buttons' real position back** — they are native views
   outside the web contents, `screencapture -l` refuses an occluded window, and
   `CGWindowListCreateImage` is denied to an unentitled binary. Three rounds of
   inference; the fourth ships a knob.
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
4. `activitybarpart.css` drops `.activitybar > .content` by `max(3vh, 28px)`
   under that class — the user's own measure (*"go to the overlap version and
   just add 2-3vh to the left hand menu explorer icon"*, 2026-07-27), with a
   floor so a short window cannot close the gap: at the 270px minimum window
   height 3vh is 8px, and macOS centres the buttons in a 28pt band. The bar's
   background still starts at y=0, so this reads as the icons sitting lower,
   not as a strip.
5. `editorgroupview.css` puts the window's `-webkit-app-region: drag` on the
   editor title bar, with `no-drag` on the tabs, breadcrumbs and both toolbars —
   **and on `.editor-group-container.empty`**, because with no editors open that
   title bar has zero height and a fresh window would otherwise have no drag
   region at all. Measured: both drag elements reported a 0×0 rect on a window
   opened straight onto a folder.

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

- The buttons are ~52px wide and the activity bar is 48px, so they overhang the
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
