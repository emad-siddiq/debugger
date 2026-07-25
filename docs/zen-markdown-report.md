# Plan — First-class Markdown in Burrow

**Status: IMPLEMENTED & VERIFIED 2026-07-24** — five commits on burrow `main`
(`4afedb96..27f2c20d`), e2e-verified live via the launch skill. See
"Implementation report" at the end. Original plan below, unchanged.
All work lands in `burrow/` (the nested Code-OSS fork, its own git repo/rules).
Upstream pin 1.128.0.

---

## Technical summary (for product review)

Burrow already ships the two upstream markdown extensions (`markdown-basics` grammar +
`markdown-language-features` preview), so this is an upgrade, not a build-out. Five
workstreams:

1. **Preview is the default view.** One config default makes every open of a `.md` —
   single click, double click, quick-open — land in the rendered preview instead of the
   raw text. Editing becomes an explicit act: a new right-click **"Edit Markdown"** entry
   in the Explorer, plus the existing pencil button on the preview toolbar. Double-click
   inside the preview stays "do nothing" (upstream setting already defaults that way).

2. **Beautiful, readable typography.** The preview stylesheet gets a real reading design:
   centered measure (~72ch), larger default type (15px → configurable), 1.7 line height,
   a proper heading scale, styled tables/blockquotes/rules. A new **"Markdown: Choose
   Preview Font"** picker offers three curated system-font stacks (Sans / Serif /
   Humanist) — no bundled font files, so zero startup or licensing cost.

3. **Zen reading mode.** A **"Markdown: Read (Zen)"** command (toolbar book icon +
   keybinding) opens the preview and enters the workbench's built-in Zen Mode tuned for
   reading: full screen, centered layout, no tabs/status bar/activity bar. `Esc Esc`
   exits, as users already expect.

4. **Theme-true code-block colors.** Today fenced code blocks are colored by highlight.js
   with a **hard-coded** palette that ignores the active theme. The fork already contains
   a better mechanism (built for the experimental WYSIWYG editor): real TextMate
   tokenization via `computeFullSyntaxHighlighting`, which produces the exact colors of
   the active Burrow Xcode theme. We wire the classic preview to that path, keeping
   highlight.js as fallback for languages with no installed grammar — so *every* language
   still gets color.

5. **Restore stripped grammars: Python + Rust.** The Task-02 strip removed them
   (`STRIP.md`). Go was never removed; React (JSX kept all along, TSX restored with
   `burrow-ts-base` in commit `ed326481`). Python and Rust come back byte-identical from
   the pre-strip commit; the build packages whatever extension folders exist, so no build
   wiring is needed. This fixes highlighting for `.py`/`.rs` files **and** for fenced
   blocks in both the markdown text editor and the TextMate-powered preview. STRIP.md
   ledger is regenerated to record the reversal.

Cost/risk: small, additive, all inside `extensions/` + one config default; the only
proposed-API dependency (`computeFullSyntaxHighlighting`) is already used in-tree.

---

## Detailed plan (for the implementing agent)

### WS1 — Preview by default; edit is opt-in

| Change | Where |
|---|---|
| Add `"workbench.editorAssociations": { "*.md": "vscode.markdown.preview.editor" }` | `extensions/burrow-core/package.json` `configurationDefaults` (~line 92, alongside existing defaults) |
| Explorer context item **"Edit Markdown"** → `vscode.openWith(uri, 'default')` | new command in `extensions/markdown-language-features` (`src/commands/`), menu contribution `explorer/context` with `when: resourceLangId == markdown` (verify `resourceExtname == .md` works for explorer; langId may be unset for unopened files — use `resourceExtname`) |
| Same command on `editor/title/context` of the preview | menu contribution, `when: activeCustomEditorId == 'vscode.markdown.preview.editor'` |
| Keep `markdown.preview.doubleClickToSwitchToEditor` default `false` | already false (`markdown-language-features/package.json:766-771`) — assert in verify, don't change |

Notes:
- The custom editor `vscode.markdown.preview.editor` already exists with selector `*.md`,
  `priority: "option"` (`markdown-language-features/package.json:859-869`); the
  editorAssociations default overrides priority — leave priority as `option` so
  "Open With…" still lists both cleanly.
- The pencil ("Show Source", `markdown.showSource`) already appears on preview toolbars —
  confirm it works from the static custom-editor preview; if it targets only dynamic
  previews, extend its `when` clause.
- Users can still permanently opt out per-machine by overriding
  `workbench.editorAssociations` in settings — document in `burrow/docs/`.

### WS2 — Typography + font options

Files: `extensions/markdown-language-features/media/markdown.css` (base typography,
vars at lines 6-12, code font 404-408, code boxes 414-433);
settings plumbed via `src/preview/previewConfig.ts:29,55` →
`src/preview/documentRenderer.ts:209-215` (CSS custom props).

- Reading column: `body { max-width: 72ch; margin-inline: auto; padding: 0 2rem; }`
  (keep full-width for tables/code via horizontal scroll on the block, not the page).
- Defaults via burrow-core `configurationDefaults`: `markdown.preview.fontSize: 15`,
  `markdown.preview.lineHeight: 1.7` (upstream setting keys — no new plumbing).
- Heading scale (1.602/1.424/1.266/1.125), tightened heading `margin-top`, styled
  `blockquote` (left rule + muted fg via `--vscode-textBlockQuote-*`), zebra-free tables
  with hairline borders, `hr` as centered hairline.
- New command **`burrow.markdown.chooseFont`** ("Markdown: Choose Preview Font"), Quick
  Pick with three presets writing `markdown.preview.fontFamily` (global scope):
  - **Sans** — `-apple-system, 'SF Pro Text', 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif`
  - **Serif** — `Charter, 'Iowan Old Style', Georgia, 'Times New Roman', serif`
  - **Humanist** — `Seravek, 'Gill Sans Nova', Ubuntu, Calibri, Verdana, sans-serif`
  Plus "Custom…" input box. Lives in markdown-language-features (it owns the setting).
- Code font keeps following the editor (`var(--vscode-editor-font-family)`).

### WS3 — Zen reading mode

- New command **`burrow.markdown.readZen`** ("Markdown: Read (Zen)") in
  markdown-language-features:
  1. if active editor is a `.md` text editor → `vscode.openWith` preview (same tab);
  2. `workbench.action.toggleZenMode`.
- Zen tuning via burrow-core `configurationDefaults`: `zenMode.fullScreen: true`,
  `zenMode.centerLayout: true`, `zenMode.showTabs: "none"`, `zenMode.hideStatusBar: true`,
  `zenMode.hideActivityBar: true`, `zenMode.hideLineNumbers: true`. (All registered in
  `src/vs/workbench/browser/workbench.zenMode.contribution.ts` — core untouched.)
  **Trade-off to confirm with product:** these defaults change Zen Mode for *all* file
  types, not just markdown. Acceptable (zen is rarely used for code here) — if not,
  skip the defaults and set them imperatively inside `readZen` before toggling, restoring
  after exit via `onDidChangeZenMode`... simpler is better: prefer the config defaults.
- Toolbar: book icon (`$(book)`) on `editor/title` for markdown files and previews;
  keybinding suggestion `cmd+k z` is taken by upstream zen — use `cmd+k r`.
- Exit: built-in `Esc Esc` — no work.

### WS4 — Theme-aware fenced-code highlighting (all languages)

Current: `src/markdownEngine.ts:398-416` — markdown-it `highlight` = highlight.js with
`media/highlight.css` (hard-coded VS2015 palette, only gated by `.vscode-dark/.vscode-light`).
Existing in-fork alternative: `src/preview/markdownEditorProvider.ts:133-152` calls
proposed API `vscode.languages.computeFullSyntaxHighlighting(source, languageId)` →
theme tokens + colorMap; client renderer `markdown-editor-src/syntaxHighlighter.ts`
(colorMap → `.tok-mdhl-fg-N` CSS rules, re-render on `onDidChangeSyntaxHighlighting`).

Plan:
1. Extract the tokenize-and-style logic shared by the WYSIWYG editor into a helper
   (`src/preview/fencedHighlighting.ts`).
2. In the preview render path (extension side, where the engine runs), post-process
   fenced blocks: for each ` ```lang ` block whose `lang` maps to an installed language
   (`vscode.languages.getLanguages()` + the alias map from `markdownEngine.ts:418-442`),
   replace hljs output with TextMate-token spans + emit the colorMap CSS once per
   document. Re-render preview on `onDidChangeSyntaxHighlighting` (theme switch).
3. **Fallback:** language not installed → keep highlight.js output (hljs bundles ~190
   languages, so exotic fences stay colored), but restyle `media/highlight.css` so both
   palettes harmonize with Burrow Xcode dark/light (pull hex values from
   `extensions/burrow-theme-xcode/themes/xcode-{dark,light}.json` token rules).
4. Keep `.hljs` class + wrapper (`markdownEngine.ts:263-277`) so user `markdown.styles`
   overrides continue to work.

Risk note: `computeFullSyntaxHighlighting` is a proposed API already enabled for this
built-in in-tree — no new API surface. If perf on huge documents is a concern, tokenize
only visible-language fences and cap per-block size (e.g. 10k chars → hljs fallback).

### WS5 — Restore Python + Rust grammars

- `git checkout cfb88e87^ -- extensions/python extensions/rust`
  (`cfb88e87` = `strip: remove non-Go language extensions`; parent has the exact
  upstream-1.128.0 folders — verified present in that tree).
- No build wiring: `build/lib/extensions.ts:411-420` globs `extensions/*/package.json`
  minus `excludedExtensions` (python/rust not listed); both are grammar-only (no
  tsconfig), so `build/gulpfile.extensions.ts` compilations list is untouched.
- Status check (user's list): **Go** — never removed. **React** — `javascript` (JSX) kept;
  `typescript-basics` (TSX) already restored in `ed326481`. **Python, Rust** — restored
  here. This fixes: `.py`/`.rs` editor highlighting, fenced-block highlighting in the
  md **text editor** (markdown-basics embeds installed grammars), and WS4's TextMate
  preview path.
- Ledger: flip python/rust to keep in `tools/inventory.js` `DECISIONS`, regenerate
  `STRIP.md` (do not hand-edit tables), note the reversal reason ("markdown fenced-code
  fidelity").

### Order & commits (burrow repo, current branch, no Co-Authored-By)

1. `restore: python + rust grammar extensions (markdown fence fidelity)` + STRIP.md regen
2. `feat(md): preview-by-default + Edit Markdown context action`
3. `feat(md): reading typography + font picker`
4. `feat(md): zen read mode`
5. `feat(md): theme-true fenced-code highlighting with hljs fallback`

Each commit leaves the app booting (matches the strip-sequence discipline).

### Verification

- Type-check: `npm run gulp compile-extensions` (markdown-language-features has TS).
- Launch via the burrow `launch` skill (isolated profile) and verify with playwright:
  1. click `README.md` in Explorer → preview opens (no text editor); double-click → same;
  2. right-click → "Edit Markdown" → text editor opens;
  3. run "Markdown: Read (Zen)" → full-screen centered preview; `Esc Esc` exits;
  4. fenced ` ```go ```py ```rust ```tsx ` blocks colored with Burrow Xcode theme colors
     (compare against editor colors); unknown fence lang still colored (hljs fallback);
  5. font picker switches Sans/Serif/Humanist live;
  6. open `.py` / `.rs` files → editor syntax highlighting present.
- `STRIP.md` regen shows python/rust flipped to keep, no other drift.

### Out of scope (explicit)

- Bundled webfonts (system stacks only, for now); `markdown-math`/mermaid restoration;
  other stripped languages (cpp, ruby, …) unless requested; WYSIWYG editor changes;
  debugger-repo (`launcher/`, `simulator/`) — untouched, so `.claude/memory/*.yaml`
  there needs no update.

---

## Implementation report (2026-07-24)

Five commits on burrow `main`, each compile-checked (`0 errors`):

| Commit | What landed |
|---|---|
| `4afedb96` | `restore:` python + rust grammar folders (byte-identical from `cfb88e87^`); DECISIONS flipped, all 17 burrow-* extensions classified, STRIP.md regenerated (0 UNCLASSIFIED, keep 51) |
| `5c1d0ffb` | `feat(md):` `workbench.editorAssociations` `*.md → vscode.markdown.preview.editor` (burrow-core); new `markdown.editSource` "Edit Markdown" (URI-aware) in explorer/tab context + palette |
| `c4c17672` | `feat(md):` 72ch centered measure, modular heading scale, themed blockquotes, 15px/1.7 defaults; `markdown.choosePreviewFont` quick pick (Sans/Serif/Humanist/Custom/Reset) |
| `b5e3d4df` | `feat(md):` `markdown.readZen` (⌘K R, book icon) — reopen as preview + zen; `zenMode.showTabs: none` default |
| `27f2c20d` | `feat(md):` `FencedCodeHighlighter` — fences pre-tokenized via `computeFullSyntaxHighlighting` (theme-true, inline-styled spans), hljs fallback for unknown langs, cache cleared + previews refreshed on theme change |

**Deviations from plan (all minor):** commands live under the `markdown.` prefix
(extension idiom) instead of `burrow.markdown.*`; themed spans use inline styles
instead of a colorMap stylesheet (survives every preview update path, no
documentRenderer plumbing); `highlight.css` re-palettizing skipped — with grammars
restored, virtually all real fences take the TextMate path, so the hljs palette
only styles exotic languages (looked fine in verification); zen defaults limited
to `showTabs: none` because upstream already defaults fullScreen/centerLayout/
hideStatusBar/hideActivityBar to true.

**E2E verification** (launch skill, isolated profile, playwright over CDP —
screenshots in session scratchpad `md-verify-shots/`):
- Single **and** double click on `README.md` → rendered preview (tab "README.md,
  preview"; double-click pins, still preview; no text editor).
- Explorer right-click shows **Edit Markdown** first; clicking it opens the
  source text editor.
- **⌘K R** → full-screen zen reading: no tabs/status/activity bar, centered
  column, preview rendered.
- Fences: **Go, Python, Rust, TSX** all colored with the Burrow Xcode dark theme
  palette (matches editor tokens); unknown-language (elixir) fence still colored
  via hljs fallback.
- `check.py` / `check.rs` text editors: 5–6 distinct token colors (grammars live).
- **Markdown: Choose Preview Font** → picked Serif → prose re-rendered in Charter
  live; code kept SF Mono.

**Traps hit:** launch needs `TMPDIR=/tmp/bl` (103-char unix-socket cap) — known
from memory; a stray NUL byte initially made git treat `fencedHighlighting.ts`
as binary (fixed, amended); preview wheel-scroll overscrolls into the
scrollBeyondLastLine margin, which looks like a blank preview but isn't.
