# 12 — Design system: minimal, Xcode-calibre

> Part of the [Go IDE overhaul](00-overview.md). Depends on: 02. Effort: ~2 wk
> (plus a continuous polish budget across tasks 03–11).

## Goal

Burrow looks and feels like a native macOS developer tool of Xcode's calibre:
one opinionated layout, two first-party themes, restrained chrome, precise
typography. Minimalism as a design stance, not just a feature count.

## Design principles

1. **One layout, opinionated.** Navigation left, editor center, state right
   (the task 05 debug bar), console bottom. Users can hide panes, not invent
   layouts. No drag-anything-anywhere; fewer states to design means every
   state can be *finished*.
2. **Chrome earns its pixels.** One toolbar (the scheme bar), slim activity
   rail (5 items max: Explorer, Search, Git, HTTP, DB), no breadcrumb-bar +
   tab-bar + title-bar triplication — title bar and scheme bar merge (task 03
   patch), breadcrumbs live in the editor's top edge only.
3. **Native fidelity.** Real vibrancy where macOS provides it (sidebars),
   native traffic lights, system font stack (SF Pro / SF Mono defaults;
   editor font user-configurable with ligature support), native menus, correct
   ⌘-key conventions throughout. Keybinding defaults audit: Xcode muscle
   memory where it doesn't fight VS Code muscle memory (⌘R run, ⌘. stop,
   ⇧⌘O quick-open parity aliases).
4. **Two themes, finished.** `Burrow Light` and `Burrow Dark`, designed
   together: one hue family (warm neutral surfaces, a single gopher-teal
   accent), WCAG AA everywhere, semantic-token-complete for Go (types,
   interfaces vs. structs distinguishable, error paths subtly warm). No theme
   gallery — these two, correct, in both appearances (follows system).
5. **Motion is information.** 120–180 ms ease-out for reveal/collapse (debug
   bar on stop, doc viewer maximize), none elsewhere. No bouncing, no
   skeleton shimmer.
6. **Empty states teach.** Every panel's empty state is one sentence + one
   action (e.g. Oracle strip: "No notes for this code yet — Bootstrap the
   Oracle"). No blank grey rectangles.

## Deliverables & tasks

1. **Design tokens.** `burrow-tokens.json` — spacing scale, radii, type ramp,
   elevation, the two palettes; consumed by themes and every burrow-* webview
   (single source; webviews must not hand-roll colors — lint for it).
2. **The two themes.** Full workbench + semantic-token coverage, built from
   tokens; contrast-audited (automated AA check in CI).
3. **Chrome patches.** Merged title/scheme bar spacing, slim activity rail,
   pane header simplification, vibrancy adoption — each a ledger entry with
   before/after screenshots.
4. **Iconography.** Single-weight outline icon set (SF-Symbols-adjacent
   geometry) for the rail, scheme bar, tree glyphs, and the app icon set
   (gopher-in-a-burrow mark; light/dark/tinted variants per macOS 26 specs).
5. **Webview cohesion pass.** HTTP workbench, DB explorer, doc viewer,
   visualizers restyled onto tokens — the app must not feel like four websites
   in a trench coat.
6. **Keybinding + menu audit.** Final default map, printed cheat-sheet page in
   Help; menu bar reduced per task 02 with items in macOS-conventional order.
7. **Polish gauntlet.** A recorded 10-minute demo path (open repo → run →
   break → inspect → docs → test → DB) reviewed frame-by-frame each release;
   the standing bar for "does this still look finished".

## Acceptance criteria

- Both themes pass automated AA contrast on every color pair in use.
- Every webview renders exclusively from tokens (lint passes).
- The demo-path recording shows no default-VS-Code-blue, no mismatched
  spacing between native views and webviews, no unstyled empty states.
- A designer's review of the demo signs off against the six principles.

## Out of scope

- User theme galleries/marketplace; Windows/Linux native-chrome work (they get
  the same themes but native-fidelity work is macOS-first); icon fonts for
  user extensions (there are none).
