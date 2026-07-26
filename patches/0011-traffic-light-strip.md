# 0011 — Default window.titleBarStyle to native

- **Layer:** 3 (one default-value change in the config schema the main process reads)
- **Task:** — (WO-01, `debugger/docs/plans/01` — chrome removal)
- **Upstream files touched:** `src/vs/workbench/electron-browser/desktop.contribution.ts`,
  `src/vs/platform/window/common/window.ts`
- **Size:** 2 lines (two defaults — see "The second half", below)
- **Last verified against:** upstream 1.128.0

## Why

WO-01 removes Burrow's custom top row so macOS draws a plain native title strip
(no Command Center, no "Sign In", no layout toggles). The intended route was a
built-in extension `configurationDefaults` (`window.titleBarStyle: native` in
`burrow-core`). Empirically that does **not** take effect: `window.titleBarStyle`
is `ConfigurationScope.APPLICATION` and is resolved by `getTitleBarStyle()`
(`src/vs/platform/window/common/window.ts`) from the configuration the **main
process** reads at window creation — before/without the renderer's
extension-contributed defaults. So the registered schema default (`'custom'`)
wins and the custom titlebar (which hosts the upstream chat "Sign In" entitlement
control) persists even after a window reload — verified live via the `launch`
skill + Playwright (`window.commandCenter: false` applied, but the 28px custom
titlebar and Sign In stayed). Changing the registered default is the only route.

## What

In `desktop.contribution.ts`, the `window.titleBarStyle` configuration property
default `'custom'` → **`'native'`** (tagged `// BURROW patch 0011`). Web is
unaffected — `getTitleBarStyle()` forces `CUSTOM` when `isWeb`. Users can still
opt back with an explicit `"window.titleBarStyle": "custom"`. The belt-and-braces
`window.customTitleBarVisibility: "never"` + `window.commandCenter: false` in
`burrow-core`'s `configurationDefaults` remain (they apply in the renderer).

## The second half — `getTitleBarStyle()` (added 2026-07-26)

The schema default above is **not enough**, and the reason is the mirror image of
the trap in "Why". `desktop.contribution.ts` is a **workbench** contribution:
only the renderer registers it. The **main process** decides the window frame at
creation time, and calls `getTitleBarStyle()`
(`src/vs/platform/window/common/window.ts`) with a configuration that carries no
such default — so it fell through to its hardcoded `return TitlebarStyle.CUSTOM`
and built a frameless *hidden-inset* window. The renderer, which **does** see
`'native'`, then drew no custom title bar, and `customTitleBarVisibility: never`
guaranteed it.

The result was a window with **no title strip at all**, and macOS painting the
traffic lights straight onto the activity bar's first icon (Explorer, at content
`(0,0)`–`(48,48)`). Measured from the main process: `getBounds().height ===
getContentBounds().height`, i.e. **zero window chrome**.

So the fallback in `getTitleBarStyle()` is flipped to `NATIVE` too. That file is
loaded by both processes, which is exactly why it is the right place for the
default to live. An explicit `"window.titleBarStyle": "custom"` still wins, and
`isWeb` still forces `CUSTOM` before this line is reached.

**Reported by the user, 2026-07-26** ("the mac traffic light buttons overlap with
the explorer"). Worth stating plainly: the original patch was verified by checking
that the *custom title bar was gone*, which it was — the half that was never
checked is that something native replaced it.

## Rebase notes

- Single-token default change. If upstream restructures this property, re-apply:
  `window.titleBarStyle` default → `native`. Grep `BURROW patch 0011`.
- **Two sites**, one per process boundary: the schema default in
  `desktop.contribution.ts` *and* the fallback `return` in `getTitleBarStyle()`.
  Changing only the first reproduces the traffic-light overlap.
- If upstream flips the default themselves, or exposes a `product.json` hook for
  the default title-bar style, this patch retires.
