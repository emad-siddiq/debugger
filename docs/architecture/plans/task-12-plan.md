# Task 12 — implementation plan

> Task 12 — Burrow design system: themes, tokens, typography defaults

Build-ready plan from the parallel planning pass (ultracode run), grounded in the current tree.

## Layer breakdown

Four layers, mapped to the doc's deliverables:

1. CONFIG (layer 1 — no ledger). `product.json` `onboardingThemes` (:141-178) swap `Dark 2026`/`Light 2026` entries → `Burrow Dark`/`Burrow Light`. `extensions/burrow-core/package.json` `configurationDefaults` (:80-86) add: `window.autoDetectColorScheme: true`, `workbench.preferredDarkColorTheme: "Burrow Dark"`, `workbench.preferredLightColorTheme: "Burrow Light"` (principle 4 "follows system"), plus typography — `editor.fontFamily` = SF Mono stack, `editor.fontLigatures: true`, `terminal.integrated.fontFamily`, and type-ramp `editor.fontSize`/`lineHeight`. This alone makes Burrow the active look with zero core patches.

2. NEW burrow-* EXTENSION (layer 4 — no ledger). `extensions/burrow-theme/` JSON-only: `package.json` `contributes.themes` → `Burrow Light` (`uiTheme: vs`) and `Burrow Dark` (`uiTheme: vs-dark`), each pointing at `themes/burrow-light.json` / `themes/burrow-dark.json` (full workbench colors + Go semanticTokenColors). Ships deliverable 1 (`burrow-tokens.json`, single source) + deliverable 2 (the two themes). No `gulpfile.extensions.ts` entry (JSON). An optional token→theme generator lives under `build/burrow/` (EXCLUDE'd from ledger).

3. CORE PATCH + LEDGER (layer 3 — patch 0010). `src/vs/workbench/services/themes/common/workbenchThemeService.ts`: set `ThemeSettingDefaults.COLOR_THEME_DARK/LIGHT` to the Burrow ids (:42-43) and replace the two `*_INITIAL_COLORS` maps (:72, :214) with the Burrow surface/accent so the pre-extension startup splash matches (kills the VS-Code-blue flash). ~15 lines → ledger `patches/0010-*.md` + a row in `patches/README.md`. This makes Burrow the genuine default rather than a config override. The doc's "chrome patches" (merged title/scheme bar, slim rail, vibrancy — deliverable 3) are SEPARATE, larger core patches that belong to task 03/02 and are out of scope here (each its own future ledger entry).

4. OUTER REPO (task 14): none — no theme coupling found.

## Already exists

The design system is essentially unbuilt today; only the mechanisms it must plug into exist.

- Default themes are upstream's `Dark 2026` / `Light 2026`, wired as the product defaults in core: `src/vs/workbench/services/themes/common/workbenchThemeService.ts:42-43` (`ThemeSettingDefaults.COLOR_THEME_DARK = 'Dark 2026'`, `COLOR_THEME_LIGHT = 'Light 2026'`). Those two theme ids are contributed by `extensions/theme-defaults/package.json` → `themes/2026-dark.json` / `2026-light.json`, which `include` `dark_modern.json`/`light_modern.json` and DO carry `semanticTokenColors` (grep hit =1 each).
- The pre-extension startup splash colors are hardcoded in the same core file: `COLOR_THEME_DARK_INITIAL_COLORS` (:72) and `COLOR_THEME_LIGHT_INITIAL_COLORS` (:214), keyed to whichever id is the default.
- The config lever exists: `extensions/burrow-core/package.json:80-86` already has a `configurationDefaults` block (currently sets minimap off, startupEditor none, bash profile, chat.commandCenter off) — this is where typography + theme-follow defaults belong. The `configuration.properties` pattern (the four `burrow.inspector.hideStock*` booleans, :43-79) shows the house style for new settings.
- Layer-4 extension path is proven (burrow-core) and the ledger discipline is live: `patches/README.md` (rule: any `src/`|`build/` touch needs an `NNNN-*.md` entry, <15 patches total, each <300 lines) enforced by `build/burrow/check-ledger.js` (CORE = `^src/`,`^build/(?!burrow/)`; EXCLUDE = `^extensions/burrow-`, `^build/burrow/`). Ledger runs through 0009; next id is 0010.
- A JSON-only theme extension needs NO build wiring: `build/gulpfile.extensions.ts:59-62` (`compilations[]`, patch 0001) lists only TS extensions; JSON extensions are auto-discovered by packaging glob. So burrow-theme adds zero core/build patch just to ship.

Does NOT exist yet: any `Burrow Light`/`Burrow Dark` theme, `burrow-tokens.json` (single-source tokens — grep found none anywhere), a Go semantic-token palette, typography/font defaults, the icon set / app icon, the webview-cohesion restyle, and any AA-contrast CI gate.

Outer repo (task 14): no coupling. Grep of `launcher/`, `extension/`, `simulator/`, compose/Dockerfiles for `colorTheme|Burrow|Dark 2026|preferredDark` and for any baked `settings.json` returned nothing — the outer stack bakes no theme/settings, so task 12 has no outer-repo layer.

## Open items

- Confirm the theme-selection model with the product owner: follow-system (autoDetectColorScheme + preferredDark/Light) vs a single fixed workbench.colorTheme default — the doc says follow-system (principle 4), plan assumes that.
- Decide burrow-tokens.json canonical location: co-located in extensions/burrow-theme (simplest) vs a shared top-level path the webviews (burrow-http/db/docs/viz) also import for deliverable 5 cohesion. Affects the webview restyle later.
- Whether to hand-author the two theme JSONs or generate them from tokens via build/burrow/build-tokens.js — generator adds a build step but enforces single-source.
- SF Pro / SF Mono are macOS-only; pick the cross-platform fallback stack for the fontFamily defaults (Linux/Windows get the themes but not native fonts).
- Author the AA-contrast script and the webview token-lint (neither exists) and wire both into make verify — required by the acceptance criteria, out of scope for slices 1-2.
- Iconography (single-weight outline set) + gopher-in-a-burrow app icon (light/dark/tinted, macOS 26) is separate art not scoped here — confirm it's tracked elsewhere.
- Chrome deliverable 3 is blocked on task 03's scheme-bar host (per patches/README.md); confirm task 12 does not attempt it now.

## First slice

Ship a visible Burrow look with zero core patches, config + extension only:

1. Create `extensions/burrow-theme/` with `package.json` (contributes `Burrow Dark` uiTheme vs-dark, `Burrow Light` uiTheme vs) and two theme JSONs. To land fast and correct, each may start by `"include": "./..."` the 2026 base, then override only the identity layer: neutral-warm surfaces, the single gopher-teal accent (replace the `#297AA0`/`#3994BC` blues the 2026 theme uses), and the Go `semanticTokenColors` (types vs interface vs struct distinguishable, error paths warm). Extract those overrides from a co-located `burrow-tokens.json` so the single-source rule starts on day one.
2. In `extensions/burrow-core/package.json` `configurationDefaults`, add `window.autoDetectColorScheme: true`, `workbench.preferredDarkColorTheme: "Burrow Dark"`, `workbench.preferredLightColorTheme: "Burrow Light"`, and the SF Mono `editor.fontFamily` + `editor.fontLigatures: true`.
3. Update `product.json` onboardingThemes to the Burrow ids.

Verify by launching Code OSS (the `launch` skill) and confirming the active theme is Burrow Dark/Light following the system appearance. No `src/` touch, so no ledger and no check-ledger risk. The core patch (0010, defaults + initial-colors) is a clean second slice.

## Files to touch

- `extensions/burrow-theme/package.json (NEW — contributes.themes: Burrow Dark/Light)`
- `extensions/burrow-theme/themes/burrow-dark.json (NEW — workbench colors + Go semanticTokenColors)`
- `extensions/burrow-theme/themes/burrow-light.json (NEW)`
- `extensions/burrow-theme/burrow-tokens.json (NEW — single-source spacing/radii/type-ramp/palettes)`
- `extensions/burrow-core/package.json (configurationDefaults: preferredDark/LightColorTheme, autoDetectColorScheme, editor/terminal fontFamily, fontLigatures, type ramp)`
- `product.json (onboardingThemes: 2026 → Burrow, :141-178)`
- `src/vs/workbench/services/themes/common/workbenchThemeService.ts (SECOND SLICE — ThemeSettingDefaults :42-43 + *_INITIAL_COLORS :72/:214)`
- `patches/0010-burrow-default-themes.md (NEW ledger entry for the core patch)`
- `patches/README.md (add 0010 row to the ledger table)`
- `build/burrow/build-tokens.js (OPTIONAL — token→theme generator, ledger-excluded)`

## Core risk

The plumbing is small; the real risk is the design labor and two subtleties. (1) Theme-selection model: `configurationDefaults.workbench.colorTheme` and `window.autoDetectColorScheme`+`preferred*` are mutually exclusive mental models — the doc's principle 4 ("both appearances, follows system") requires the autoDetect + preferredDark/Light pair, not a single fixed colorTheme, or the theme will not track the macOS appearance. (2) Startup flash: until the core patch (0010) updates `*_INITIAL_COLORS` and `ThemeSettingDefaults`, the pre-extension splash still paints the 2026 palette for a beat before burrow-theme activates — acceptable for the first slice, but it is the reason the core patch exists. (3) The acceptance bar ("automated AA contrast on every color pair", "webviews render exclusively from tokens", Go types/interfaces/structs visually distinct) is genuine design + tooling work, not covered by getting the theme to load — budget for the contrast audit and the token-lint, which don't exist yet.

## Dependencies

- `burrow-tokens.json` (deliverable 1) is the upstream dependency of BOTH the themes (deliverable 2) and the webview-cohesion pass (deliverable 5, restyling burrow-http/db/docs/viz onto tokens) — build it first as the single source or the "not four websites in a trench coat" goal can't be enforced.
- Chrome patches (deliverable 3: merged title/scheme bar, slim activity rail, vibrancy) depend on task 03's scheme-bar toolbar host, which `patches/README.md` notes is "the next core patch" and is NOT yet landed — do not attempt the chrome layer under task 12 until 03 exists; each chrome change is its own ledger entry.
- AA-contrast CI gate + the webview token-lint are new gates to add (none exist); they gate the acceptance criteria, not the first slice.
- Iconography / app icon (deliverable 4) is independent art with no code dependency — parallelizable.
- No dependency on the outer repo (task 14).

## Full plan

# Task 12 — Burrow design system: build-ready plan

## What's actually there vs. the doc's asks (grounded)
- **Defaults today are upstream's 2026 themes.** `src/vs/workbench/services/themes/common/workbenchThemeService.ts:42-43` sets `ThemeSettingDefaults.COLOR_THEME_DARK='Dark 2026'`, `COLOR_THEME_LIGHT='Light 2026'`; contributed by `extensions/theme-defaults/package.json` → `themes/2026-dark.json`/`2026-light.json` (which `include` `dark_modern`/`light_modern` and carry `semanticTokenColors`). The 2026 accent is blue (`#297AA0`, `#3994BC…`) — exactly the "default-VS-Code-blue" the doc bans.
- **Startup splash is hardcoded** at `workbenchThemeService.ts:72` (`COLOR_THEME_DARK_INITIAL_COLORS`) and `:214` (`COLOR_THEME_LIGHT_INITIAL_COLORS`).
- **Config lever ready:** `extensions/burrow-core/package.json:80-86` `configurationDefaults`.
- **Ledger live:** `patches/README.md` + `build/burrow/check-ledger.js` (EXCLUDE `^extensions/burrow-`, `^build/burrow/`); next id **0010**.
- **JSON theme needs no build wiring:** `build/gulpfile.extensions.ts:59-62` `compilations[]` is TS-only (patch 0001); packaging auto-globs `extensions/*/package.json`.
- **No burrow theme, no `burrow-tokens.json`, no typography defaults, no AA/token gates** exist.
- **Outer repo (task 14): nothing to do** — no baked `settings.json`/theme in `launcher/`, `extension/`, compose.

## Layer split
**L1 config** (`product.json`, burrow-core `configurationDefaults`) · **L4 new extension** (`extensions/burrow-theme`, JSON) · **L3 core patch + ledger 0010** (`workbenchThemeService.ts` defaults + initial colors) · **outer**: none. Chrome/rail/vibrancy (deliverable 3) is deferred to task 03/02 — separate ledger entries, not this task.

## Slice 1 — visible Burrow look, zero core patches
1. **Create `extensions/burrow-theme/`.**
   - `burrow-tokens.json`: spacing scale, radii, type ramp, elevation, and the two palettes (warm-neutral surfaces + one gopher-teal accent). This is the single source (deliverable 1); model the palette keys after the color slots the 2026 theme fills so the mapping is mechanical.
   - `themes/burrow-dark.json` / `themes/burrow-light.json`: `{"$schema":"vscode://schemas/color-theme","name":"Burrow Dark","type":"dark","colors":{…},"semanticTokenColors":{…}}`. To land correct fast, `"include"` the corresponding 2026 base, then override (a) every blue accent slot → gopher-teal, (b) surfaces → warm neutrals, (c) Go `semanticTokenColors` so `type`/`interface`/`struct`/`namespace` are distinguishable and error paths read subtly warm. Emit these overrides FROM `burrow-tokens.json` (either hand-authored to match, or via the optional generator below).
   - `package.json`: `publisher: "burrow"`, `contributes.themes: [{id:"Burrow Dark",uiTheme:"vs-dark",path:"./themes/burrow-dark.json"},{id:"Burrow Light",uiTheme:"vs",path:"./themes/burrow-light.json"}]`. No `main`, no TS, no gulpfile entry.
2. **burrow-core `configurationDefaults`** (`extensions/burrow-core/package.json:80-86`) add:
   - `"window.autoDetectColorScheme": true`
   - `"workbench.preferredDarkColorTheme": "Burrow Dark"`
   - `"workbench.preferredLightColorTheme": "Burrow Light"`
   - `"editor.fontFamily": "'SF Mono', ui-monospace, 'JetBrains Mono', Menlo, monospace"`, `"editor.fontLigatures": true`, `"terminal.integrated.fontFamily": "'SF Mono', ui-monospace, Menlo, monospace"`, and type-ramp `editor.fontSize`/`editor.lineHeight` per tokens.
   (Use the autoDetect + preferred pair, NOT a fixed `workbench.colorTheme` — principle 4 requires following the system appearance.)
3. **`product.json`** onboardingThemes (:141-178): replace the two `2026` entries with `{id:"burrow-dark",label:"Burrow Dark",themeId:"Burrow Dark",type:"dark"}` and the light analogue.
4. **Verify** (see verifyStrategy): launch, confirm active theme follows system between Burrow Dark/Light, screenshots. No `src/` touch → no ledger.

## Slice 2 — make Burrow the genuine default (core patch 0010)
1. Edit `src/vs/workbench/services/themes/common/workbenchThemeService.ts`: `COLOR_THEME_DARK='Burrow Dark'`, `COLOR_THEME_LIGHT='Burrow Light'` (:42-43); replace the `COLOR_THEME_DARK_INITIAL_COLORS` (:72) and `COLOR_THEME_LIGHT_INITIAL_COLORS` (:214) maps with the Burrow surface/foreground/accent so the pre-extension splash matches.
2. Add `patches/0010-burrow-default-themes.md` (format per `patches/README.md`: Layer 3, Task 12, files touched, ~15 lines, Why = "config default-theme swap doesn't cover the hardcoded ThemeSettingDefaults + the pre-extension initial-colors splash", Rebase notes = "re-point the two default ids + both INITIAL_COLORS maps if upstream refactors ThemeSettingDefaults").
3. Add the `0010` row to the `patches/README.md` ledger table.
4. `make ledger-check` must pass; relaunch, confirm no 2026-flash at startup.

## Optional — token generator (ledger-excluded)
`build/burrow/build-tokens.js`: reads `burrow-tokens.json`, writes `burrow-dark.json`/`burrow-light.json` color+semanticToken blocks, so tokens stay the single source. Lives under `build/burrow/` → EXCLUDE'd by check-ledger, no entry needed. Wire as a prepublish/prebuild step if adopted.

## Deferred (own ledger entries, NOT task-12-now)
Chrome patches (merged title/scheme bar, slim 5-item rail, vibrancy) → gated on task 03 scheme-bar host; iconography + app icon → independent art; webview-cohesion restyle of burrow-http/db/docs/viz onto tokens → after tokens land; AA-contrast CI + webview token-lint → new gates to author.

## New gates to author (acceptance criteria)
- **AA contrast**: script over `burrow-tokens.json` pairs, fail <4.5:1 text / <3:1 UI; add to `make verify`.
- **Token-lint**: assert burrow-* webview CSS contains no raw hex (must reference tokens); add to `make verify`.

## Verify strategy

- First slice (config + extension): use the `launch` skill (Code OSS, throwaway profile) to open the workbench; assert the active color theme id is `Burrow Dark` under a dark system appearance and `Burrow Light` under light (flip `window.autoDetectColorScheme` behavior), screenshot both. Confirm `editor.fontFamily` resolves to SF Mono and ligatures render.
- Themes are JSON, so no `compile-extensions`; validate they parse and load (no "theme not found" in the workbench, and the Color Theme quick-pick lists exactly Burrow Light/Dark from burrow-theme).
- Core-patch slice (0010): run `build/burrow/check-ledger.js` (via `make ledger-check`) and confirm it reports the `src/vs/workbench/services/themes/...` change is covered by ledger 0010 (green); relaunch and confirm no 2026-palette startup flash before extensions load.
- Design gates (to build): an AA-contrast script iterating burrow-tokens.json fg/bg pairs (fail <4.5:1 for text) and a webview token-lint asserting no hand-rolled hex in burrow-* webview CSS. Wire both into `make verify` once written.
- No burrow oracle covers this task; the enforcement is the AA + token-lint gates above plus check-ledger for the core slice.
