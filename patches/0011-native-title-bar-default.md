# 0011 — Default window.titleBarStyle to native

- **Layer:** 3 (one default-value change in the config schema the main process reads)
- **Task:** — (WO-01, `debugger/docs/plans/01` — chrome removal)
- **Upstream files touched:** `src/vs/workbench/electron-browser/desktop.contribution.ts`
- **Size:** 1 line (one setting default)
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

## Rebase notes

- Single-token default change. If upstream restructures this property, re-apply:
  `window.titleBarStyle` default → `native`. Grep `BURROW patch 0011`.
- If upstream flips the default themselves, or exposes a `product.json` hook for
  the default title-bar style, this patch retires.
