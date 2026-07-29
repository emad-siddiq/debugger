# 0010 — Compact editor gutter (thinner line-number + decorations reserve)

- **Layer:** 3 (two default-value changes in the editor options registry)
- **Task:** — (UX polish; no architecture doc slice)
- **Upstream files touched:** `src/vs/editor/common/config/editorOptions.ts`
- **Size:** 2 lines (two option defaults)
- **Last verified against:** upstream 1.128.0

## Why

The editor gutter should be as compact as possible while keeping breakpoints
(glyph margin) and code folding fully functional. The two biggest width
contributors — `lineNumbersMinChars` (default 5) and `lineDecorationsWidth`
(default 10px) — have **no schema**, so they are not registered as `editor.*`
user settings and cannot be shipped via `configurationDefaults`. Changing the
defaults in the options registry is the only route. `editor.glyphMargin` and
`editor.folding` remain `true` (unchanged), so breakpoints and collapse/expand
are untouched.

## What

In `editorOptions.ts`:
- `EditorLineDecorationsWidth` constructor default `10` → **`3`** (the reserved
  space between line numbers and text; hugs the text without clipping line
  decorations).
- `lineNumbersMinChars` registration default `5` → **`3`** (reserves 3 digit
  widths; still auto-grows past 999-line files via
  `max(lineNumbersDigitCount, lineNumbersMinChars)` in the layout computer).

Both edits are tagged with a `// BURROW patch 0010` comment for grep-on-rebase.
Everything else about the gutter (glyph margin on, folding on, folding controls
`mouseover`, line numbers `on`) stays at upstream defaults.

## Rebase notes

- Both are single-token default changes inside `editorOptionsRegistry`. If
  upstream refactors these option classes, re-apply: `lineDecorationsWidth`
  default → 3, `lineNumbersMinChars` default → 3. Grep `BURROW patch 0010`.
- If a future need arises to make these user-tunable, add a schema to each and
  ship the compact values via `configurationDefaults` instead — that would
  retire this patch.
