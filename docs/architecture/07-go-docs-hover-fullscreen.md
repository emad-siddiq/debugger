# 07 — Go docs: hover → fullscreen

> Part of the [Go IDE overhaul](00-overview.md). Depends on: 03. Effort: ~2 wk.

## Goal

The whole of Go's documentation, offline, inside the IDE. Hover any symbol for
its docs; expand the hover to a **fullscreen doc viewer** (exit with Esc or a
✕ icon); browse and search the entire stdlib and every dependency of the open
module without leaving the editor or touching a browser.

## Design

### Three doc sources, one viewer

1. **Stdlib, prebuilt.** At Burrow build time, generate a doc bundle from the
   pinned Go version's source using `go/doc` (JSON: packages → symbols → doc
   comments, signatures, examples). Shipped with the app (~single-digit MB
   compressed), so stdlib docs work with no toolchain and no network. Regenerate
   per Go minor we support; runtime picks the bundle matching the active
   toolchain (fallback: nearest version, banner noting the skew).
2. **Dependencies, from the module cache.** For anything in `go.mod`, docs are
   extracted on demand from `GOMODCACHE` source via `go doc -all -json`-style
   extraction (own extractor binary reusing `go/doc`, warmed lazily per module
   after `go list -m all`). Same data shape as the stdlib bundle.
3. **The open workspace itself.** Your own packages get the same treatment via
   gopls — the doc viewer renders workspace package pages too.

### Hover → expand

- Hover stays gopls-powered (signature + doc comment, markdown). We add a
  persistent **"Open docs ⤢"** affordance in the hover widget (small core
  patch to the hover UI — ledger entry) plus a keybinding (⌥Space on hover,
  or ⇧⌘0 on cursor symbol).
- Expanding opens the **doc viewer** focused on that exact symbol.

### The doc viewer

A webview-based editor tab (`extensions/burrow-go-docs/`), pkg.go.dev-quality
rendering, fully offline:

- **Layout:** left rail = package index (stdlib grouped by category, then
  module deps from `go.mod`, then workspace packages); main pane = package page
  (overview, index, constants/vars/funcs/types with methods grouped, examples
  with syntax highlighting and a "insert into editor" action on examples).
- **Navigation:** every identifier in signatures cross-links; history
  back/forward (⌘[ ⌘]); breadcrumb `net/http ▸ Request ▸ ParseForm`.
- **Search:** ⌘K fuzzy search across all indexed symbols (stdlib + deps +
  workspace), ranked exact-prefix > camel-match > doc-text hits.
- **Exit contract:** **Esc closes** (restores focus to the editor exactly
  where you were), and a **✕ icon** top-right does the same — the explicit
  requirement. The tab can also be kept/pinned like any editor tab; "fullscreen"
  = maximize-editor-group mode toggled on open, restored on close.
- Version-true: docs always reflect the **resolved versions in go.sum**, never
  "latest" — this is the advantage over alt-tabbing to pkg.go.dev.

## Tasks

1. **Doc extractor + bundle format.** `go/doc`-based extractor producing the
   JSON shape; build-time stdlib bundles per supported Go minor; runtime
   loader with version matching.
2. **Dependency indexer.** Lazy per-module extraction from `GOMODCACHE`,
   invalidated on `go.mod`/`go.sum` change; workspace packages via gopls.
3. **Viewer webview.** Package pages, cross-linking, history, breadcrumb,
   examples with insert action; maximize-on-open / restore-on-close;
   Esc + ✕ exit paths (focus restoration correct).
4. **Search.** Unified symbol index + ⌘K UI with the ranking rules.
5. **Hover affordance patch.** "Open docs ⤢" in the hover widget + cursor-
   symbol keybinding; resolves through gopls to the canonical symbol identity
   the viewer understands.
6. **Coverage pass.** Generics rendering (type params in signatures),
   examples, deprecation notices, `//go:build` variant notes; verify against
   awkward stdlib pages (`net/http`, `context`, `unsafe`).

## Acceptance criteria

- Wi-Fi off: hover `http.HandleFunc`, expand → full `net/http` docs; ⌘K
  "ParseForm" lands on the symbol; Esc returns to the editor with cursor
  position intact.
- Docs for a pinned dependency (e.g. `chi`) match its `go.sum` version.
- Hover-to-expanded-viewer < 300 ms warm.
- Every symbol in workspace code, stdlib, and deps has a doc page reachable
  by hover-expand and by search.

## Out of scope

- Non-Go docs (SQL, etc.). Third-party doc *websites*. Editing doc comments
  from the viewer (post-launch candidate).
