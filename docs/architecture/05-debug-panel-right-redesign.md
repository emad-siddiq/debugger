# 05 — Right-hand debug panel redesign

> Part of the [Go IDE overhaul](00-overview.md). Depends on: 04. Effort: ~4 wk.

## Goal

Run & Debug lives in a **right-hand panel** by default, and the variables
experience is an **inspector, not an endless recursive tree**. Call stack,
variables, watches — everything you touch while stopped — is one glance away
and navigable in constant depth.

## Why

The stock debug sidebar is the weakest part of VS Code for Go: a Variables
tree where a `*Server` five structs deep means eight disclosure triangles,
horizontal scrolling, and losing your place. Xcode's layout (navigation left,
inspection right) is the proven arrangement. This is the single highest-touch
UI surface in a debugger — it deserves the largest patch budget of the fork.

## Design

### Layout (core patch)

- The aux bar (secondary side bar) becomes the **Debug bar**, open on the
  right whenever a session runs (auto-reveal on first stop; manual toggle ⌥⌘D).
- Left sidebar keeps only file explorer / search / git — *navigation*.
  Right bar is *state*: *(top→bottom)* **Frames**, **Inspector**, **Watch**.
  Breakpoints management moves to a popover from the scheme bar's 🐞 menu —
  it's configuration, not hot state, and doesn't deserve permanent space.
- Debug console stays in the bottom panel with the Run console and terminal.

### Frames (call stack, compact)

- One line per frame: `pkg.Func` bold, `file:line` dim, current frame accented.
  Stdlib/runtime frames collapse into a single expandable `runtime ⋯ (12)` row
  by default — you almost never want them.
- **Goroutine header**: current goroutine (id, state, wait reason) with a
  dropdown of interesting goroutines (running, blocked, at-breakpoint first,
  searchable, badge counts by state). Switching goroutines swaps frames and
  inspector context. The full goroutine table is task 06's visualizer.

### Inspector (the anti-tree)

Replaces the Variables tree with **Miller columns + a value pane** — constant
visual depth no matter how deep the data:

```
┌ Frames ──────────────────────────────┐
│ ▶ ingest.HandleIngest    ingest.go:87│
│   chi.(*Mux).routeHTTP   mux.go:442  │
│   runtime ⋯ (9)                      │
├ Inspector ── req ▸ Body ▸ Metrics ───┤  ← breadcrumb path, click to jump back
│ args      │ req *http.Request        │
│ locals    │ ▸ Body  io.ReadCloser    │
│ m Metric  │ ▸ Header http.Header(7)  │
│ err nil   │   ctx   context.Context  │
├──────────────────────────────────────┤
│ m.Value  float64        =  0.973     │  ← value pane: full value, copyable,
│ [Watch] [Break on write] [Viz ▾]     │    actions, visualizer slot (task 06)
└ Watch ───────────────────────────────┘
```

- Column 1: scope groups (args / locals / package vars / registers-off).
  Selecting a composite value opens its children in the next column; the
  breadcrumb records the path (`req ▸ Body ▸ Metrics[3]`). **Depth on screen is
  always ≤ 2 columns + breadcrumb** — no recursive indentation, ever.
- **Type-aware one-line summaries** so you rarely need to drill at all:
  `[]Metric len=1204 cap=2048`, `map[string]Node (17)`, `*User → {id:42 …}`
  (pointers auto-deref one level for their summary), `err → "conn refused"`
  (error chain unwrapped in the summary), `time.Time → 2026-07-09 14:03:11`.
- **Large collections page**: slices/maps show 100 at a time with
  `next / jump-to-index / filter` controls (DAP `indexed/named` paging) —
  scrolling 50k elements is a visualizer job (task 06), not a tree job.
- Value pane (bottom of inspector): the selected value in full — string
  unquoted/expandable, number with type, copy-as-Go-literal / copy-JSON,
  **Watch** and **Break on write** (task 04 watchpoints) buttons, and the
  visualizer mount point (task 06).
- Changed-since-last-stop values tint amber (DAP `variablesReference` diffing).
- Inline editor decorations: current values ghost-texted after `:=`/params for
  the active frame (off-switch in settings; subtle by design).

### Watch

- Flat list, same summary renderer as the inspector, same value pane on
  select. Invalid-in-this-frame watches gray out instead of erroring.

### Implementation shape (patch budget honesty)

The aux-bar default + view containers are small patches. The Inspector itself
is a **new workbench view** (layer 3, our largest core component, ~significant
patch) that talks to the existing debug service/DAP model — we reuse the DAP
session plumbing wholesale and replace only the presentation. Where feasible,
components live in `extensions/burrow-go-inspect/` webview/custom views to cap
core-diff size; the frames/inspector views likely need real workbench views
for keyboard/perf parity with the rest of the UI. Prototype both, pick one,
record in the patch ledger.

## Tasks

1. **Layout patch.** Debug views to right aux bar, auto-reveal on stop,
   ⌥⌘D toggle, breakpoints popover off the scheme bar.
2. **Frames view.** Compact rows, runtime-frame collapsing, goroutine header +
   switcher backed by dlv goroutine listing.
3. **Inspector — data layer.** Path-addressed value model over DAP (`scopes` →
   `variables` with paging), summary renderer registry (per-Go-type rules),
   change-diffing between stops.
4. **Inspector — Miller UI.** Columns, breadcrumb, keyboard model (←→ traverse
   depth, ↑↓ within column, type-ahead filter per column), virtualized lists.
5. **Value pane.** Full-value rendering, copy actions, watch/watchpoint
   buttons, visualizer mount (interface consumed by task 06).
6. **Watch view.** CRUD, persistence per workspace, frame-invalid graying.
7. **Inline value decorations.** Active-frame ghost values with the same
   summary renderer; setting-gated.
8. **Keyboard + perf pass.** Stop→painted inspector < 150 ms on the fixture
   gauntlet's deep-struct case; full navigation without the mouse.

## Acceptance criteria

- Debugging opens the right bar; reaching any value nested 8 levels deep never
  shows more than breadcrumb + two columns, and never requires horizontal
  scrolling.
- A 50k-element slice and a 10k-key map stay responsive (paged) in the
  inspector.
- Goroutine switch < 100 ms perceived; changed values visibly tinted.
- Zero regressions in the task 04 CI gauntlet (presentation swap only).

## Out of scope

- Rich per-type visualizations (task 06) — this task defines the mount point.
- Visual styling/polish beyond structure (task 12).
