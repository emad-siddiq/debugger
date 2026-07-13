# 06 — Go value visualizers

> Part of the [Go IDE overhaul](00-overview.md). Depends on: 05. Effort: ~3 wk.

## Goal

Rich, type-aware visualizations for Go data structures while stopped in the
debugger — mounted in the inspector's value pane (task 05) and expandable to a
full editor tab. Seeing a 50k-row slice as a filterable table, a map as a
key-value grid, or the goroutine population as a live table is the payoff of
owning the debugger UI.

## Design

### Architecture

- `extensions/burrow-go-inspect/` registers **visualizers** against a
  **type-matcher registry**: exact type (`time.Time`), kind (slice, map,
  chan, struct, pointer), interface (`error`), and pattern
  (`[]T where T struct`) rules, priority-ordered. The inspector's value pane
  shows the best match inline with a `Viz ▾` switcher (every value always also
  has the plain summary from task 05 — visualizers are additive, never a wall).
- Data feed: the task 05 path-addressed DAP model, with **windowed fetches**
  (indexed paging) so a visualizer requests only what's on screen. Visualizers
  are webview components with a narrow query API (`fetch(path, range, filter)`)
  — they never own DAP connections.
- Every visualizer: inline (value-pane sized) and **expanded** (full editor
  tab, keeps live session binding, closes with Esc — same interaction contract
  as the docs viewer, task 07).

### The launch set

| Value | Visualization |
|-------|---------------|
| slice / array | Virtualized **table**; element columns auto-derived when `T` is a struct (field = column); len/cap bar; filter box (substring/expression); jump-to-index; copy page as JSON/CSV. |
| map | Key/value **grid**, sortable by key, filterable; bucket-agnostic (order stabilized by sort). |
| struct | **Card**: fields grouped, zero-valued fields dimmed, embedded structs inlined one level, tag row (`json:"…"`) shown dim — invaluable for API structs. |
| string / []byte | Auto-detecting viewer: plain / **JSON pretty-tree** / hex dump (offset+bytes+ascii) / base64-decoded tabs. Handles the classic "what's actually in this request body" moment. |
| time.Time / Duration | Humanized (`2026-07-09 14:03:11 +05 · 3m ago`), UTC/local/unix toggles. |
| error | **Chain view**: `Unwrap()` walk rendered as a causality list, `errors.Is/As` targets highlighted. |
| context.Context | Chain walk: deadline, cancel cause, and context values (best-effort via dlv). |
| chan | Buffer occupancy ring (`3/8 buffered`), element type, and blocked senders/receivers (goroutines parked on it, from dlv). |
| goroutines | Full-population **table** (id, state, wait reason, since, current func, source), group-by state, filter, click → switch inspector context (extends task 05's header dropdown). |
| pointer graphs | For self-referential types (linked lists, trees, graphs): bounded-depth **node-edge diagram** (default depth 3, expand-on-click per node, cycle-safe with back-edge styling). This one is explicitly *bounded scope*: layout = layered/dagre, no physics playground. |
| sync primitives | Mutex/RWMutex/WaitGroup: held/waiting state where dlv exposes it; degrade to struct card where not. |

### Honesty about limits

Values are inspected via DAP variable traversal only — no calling methods on
the debuggee (no `String()` invocation) at defaults, matching task 04's
no-`call` posture. Where dlv can't see something (unexported runtime internals
vary by Go version), visualizers degrade to the struct card, never to an error.
Version-sensitive readers (chan/goroutine/sync internals) live behind a small
adapter tested per supported Go minor in the fixture gauntlet.

## Tasks

1. **Registry + mount.** Type-matcher registry, `Viz ▾` switcher, inline/
   expanded lifecycles, Esc/✕ close contract; webview query API with windowed
   fetch and filter push-down.
2. **Tables first.** Slice/array table + map grid (virtualized, filter, sort,
   struct-field columns, copy-out). These two deliver most of the daily value.
3. **Byte/string viewer.** Plain/JSON/hex/base64 with auto-detect.
4. **Struct card + error/context/time.** The glanceable set.
5. **Runtime set.** Goroutine table (+ inspector context switch), chan
   occupancy with parked-goroutine cross-links, sync primitive states; Go
   minor-version adapter layer + gauntlet coverage.
6. **Pointer graph.** Bounded-depth node-edge renderer with cycle handling.
7. **Perf pass.** 50k-element slice table: first paint < 200 ms, scroll at
   60 fps (windowed fetches only); no visualizer may block the stop event.

## Acceptance criteria

- Every launch-set row works against the task 04 fixture gauntlet across the
  two supported Go minors, degrading gracefully where dlv lacks data.
- A NodeWatch ingest payload (`[]Metric`, nested structs, `[]byte` JSON body)
  is: table-viewed, filtered, a body hex/JSON-inspected — without leaving the
  stopped session.
- Expanded visualizers open as tabs and close with Esc/✕, session-live.

## Out of scope

- Charting/plotting numeric series (post-launch candidate).
- Calling debuggee methods for rendering (`String()`), custom user-written
  visualizers via config (post-launch: a `burrow-viz.json` per-repo registry
  is the natural extension).
