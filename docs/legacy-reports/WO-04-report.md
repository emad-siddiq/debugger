# WO-04 report — IX slice 2: breadcrumb drill navigation (constant-depth anti-tree)
STATUS: DONE — committed `3a0530ae` (following the "complete sequential tasks first" directive; `main`, no push)

## Changed
- `extensions/burrow-go-inspect/src/extension.ts` — the preview tree becomes **`InspectorNavProvider`**: a drill stack (scopes → composite → composite), drilling **replaces** the level instead of indenting (task 05.4 "constant visual depth… no recursive indentation, ever"). Rows are flat (`collapsibleState.None`); composites carry a `burrow.inspect.drill` command + a `›` hint; a `◀ Back` row / view-title buttons pop; breadcrumb via `treeView.message`. Re-roots on stop / active-frame change. Change-diff + summary renderer (WO-3) carry over.
- `extensions/burrow-go-inspect/package.json` — `burrow.inspect.drill/up/home` commands + up/home/refresh view-title buttons.
- `testdata/debuggee/main.go` — a nested `Outer→Inner→Leaf` chain in `main`'s scope for multi-level drilling; `go run .` stays clean (`total: 28 leaf: 42`).
- Layer 4 + fixture only — **no core patch, no ledger entry** (gate still green: `9 core, 5 entries — OK`).

## Verified (host `dlv` 1.25.2, Go 1.24.1; fresh-profile CDP boot on `testdata/debuggee`)
- **compile** `compile-extension:burrow-go-inspect` → 0 errors. **unit** `npm test` → **23/23** (unchanged summary registry).
- **live drill (primary DoD):** stopped at `add()`, selected `main.main`, then drilled — one flat column + breadcrumb at every level, no indentation:
  - `Locals` → `cfg {…} ›`, `nums []int len=5 cap=5 ›`, `total 0`, `n 2`
  - `Locals › cfg` → `Title "root"`, `Inner {…} ›`
  - `Locals › cfg › Inner` → `Label "mid"`, `Leaf {Name: "leaf", Value: 42} ›`
  - `Locals › cfg › Inner › Leaf` → `Name "leaf"`, `Value 42`
  - `◀ Back` pops one level; frame re-scope (add↔main) works. Screenshot `scratchpad/wo4-drill-leaf.png` (breadcrumb + flat Leaf level + ←/⌂/↻ buttons).

## Discoveries
- **Cold debug build stalls ~2 min on macOS.** After the fixture changed, dlv's first `go build -gcflags=all=-N -l` hung on the CommandLineTools linker/dsymutil for 2m18s (a real stop looked like a non-start). Warming the Go build cache (`go build -gcflags 'all=-N -l'` once) drops it to <1s; subsequent launches are fast. Add to the boot recipe.
- **Multiple debug sessions = phantom auto-advance.** Repeated Start clicks across evals spawned several concurrent dlv sessions; the UI cycled their stopped states so *read-only* polls appeared to advance the program (0→2→17). One session only: hard-kill all dlv + free the port + one Start.
- **Contributed views default collapsed.** The Inspector pane renders 0 `monaco-list-row`s until its header is expanded — a "0 rows" read is a collapsed pane, not an empty model (cost a diagnosis loop; reuse the WO-3 reveal step). Confirmed the extension activates (`onDebug`) before `burrow-go-debug`.
- **CDP clicking still churns; reads don't.** Frame-select and drill in ONE atomic eval stays stable; separate clicking evals drift the session. (Same lesson as WO-3, re-confirmed.)

## Decisions
- made — this slice is the **layer-4, natively-rendered** realization of the Miller inspector (drill-replaces-level + breadcrumb), so it's CDP-verifiable and needs no core patch. The **literal side-by-side columns + rich value pane** (and with them the genuine webview-vs-core-view fork task 05 flags) are deferred to the next slice — reported here rather than picked silently.
- made — kept the view named "Inspector (Preview)" (the stock Variables tree isn't retired yet — task 05.8) and committed WO-4 per the "complete sequential tasks first" directive.

## Next
- **WO-5 — side-by-side Miller columns + value pane (task 05.4/05.5):** two live columns (current level + selected child preview), clickable breadcrumb segments, the value pane (full value, copy-as-Go-literal, watch/watchpoint mount). **This is the webview-vs-core-view decision point** — recommend prototyping the webview first (layer 4) and escalating to a core view only if keyboard/perf parity demands it. Then WO-6 retires the stock tree (05.8).
- Deeper fixtures (8-level, 50k-slice paging) needed to exercise the perf DoD; current fixture nests 4 deep.
