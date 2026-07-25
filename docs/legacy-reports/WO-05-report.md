# WO-05 report — IX slice 3: Miller-column inspector + value pane (webview prototype)

STATUS: DONE — committed `4b231ed2` (`main`, no push)

## What this slice is

Task 05.4 ("Inspector — Miller UI": columns, breadcrumb, keyboard) + 05.5 ("Value
pane": full value, copy-as-Go-literal, watch/watchpoint mounts). Task 05 explicitly
flags this as the **webview-vs-core-view fork** ("Prototype both, pick one, record
in the patch ledger"). WO-5 is the **layer-4 webview prototype** — no core patch —
running **alongside** the WO-4 native drill tree so WO-6 can pick one and retire the
other (task 05.8).

## Changed (all layer 4 + fixture-free — no core patch, no ledger entry)

- `extensions/burrow-go-inspect/src/miller.ts` (new) — **`MillerInspectorProvider`**,
  a `WebviewViewProvider`. Renders the task-05 Xcode layout in a webview: a
  **breadcrumb**, **≤ 2 live columns** (current level + a preview of the selected
  composite), and a **value pane** (full value + `Copy as Go literal` / `Watch` /
  `Break on write`). Depth on screen is always breadcrumb + two columns — no
  recursive indentation. Host↔webview message protocol (`ready`/`select`/`drill`/
  `up`/`jump`/`copyLiteral`/`watch`/`breakOnWrite`); the host owns the drill stack +
  selection and answers with `{breadcrumb, columns, value}`. Reuses the WO-3 model
  (paths, summaries, change-diff `●`) and owns no DAP connection. Self-contained HTML
  (nonce CSP, workbench CSS vars for theming); keyboard ↑↓ select, → / Enter drill,
  ← up.
- `extensions/burrow-go-inspect/src/literal.ts` (new) — pure `toGoLiteral(v)` for the
  value pane's copy action (vscode-free, like `summary.ts`). Exact for nil / strings
  (quote iff dlv didn't) / bools / numbers; composites fall back to dlv's own value
  string.
- `extensions/burrow-go-inspect/test/literal.test.js` (new) — 7 standalone tests.
- `extensions/burrow-go-inspect/src/extension.ts` — registers the webview provider,
  resets it on the same stop / frame-change / terminate triggers as the WO-4 tree
  (shared model map).
- `extensions/burrow-go-inspect/package.json` — new webview view `burrowInspectorMiller`
  ("Inspector (Miller Preview)", `when: inDebugMode && debugType == go`); `npm test`
  now runs both suites.

## Verified (host `dlv` 1.25.2, Go 1.24.1; fresh-profile CDP boot on `testdata/debuggee`)

- **compile** `compile-extension:burrow-go-inspect` → 0 errors. **unit** `npm test` →
  **30/30** (23 summary + 7 literal). **ledger** → `9 core, 5 entries — OK` (WO-5 adds
  no core file).
- **live (primary DoD) — read over CDP inside the webview** (reached via flatten
  auto-attach; the webview is a separate CDP target, so I enumerate its execution
  contexts and evaluate in the frame that holds `#columns`):
  - At `add()` stop: breadcrumb `Scopes`; **col 1 SCOPES** [`Locals ›`]; **col 2
    preview LOCALS** [`a 0`, `b 2`, `~r0 0`, `sum 2`] — the selected scope's children
    preview in the next column.
  - Selected `main.main` frame → **col 1 LOCALS** [`cfg {…} ›`, `nums []int len=5 cap=5 ›`,
    `total 0`, `n 2`], **col 2 preview CFG** [`Title "root"`, `Inner {…} ›`], **value
    pane** `cfg  main.Outer = main.Outer {Title: "root", …}` + [`Copy as Go literal`,
    `Watch`, `Break on write`].
  - Full drill `Locals › cfg › Inner › Leaf`: each level is one flat column of that
    level's children; the **value pane tracks the selected leaf** — `Title string "root"`
    → `Label string "mid"` → `Name string "leaf"` → **`Value int 42`**. The preview
    column appears only when the selected row is composite (correct Miller semantics).
  - **Breadcrumb jump**: clicking the `cfg` segment pops back to `Scopes › Locals › cfg`.
  - Screenshot `scratchpad/wo5-miller.png` — the "Inspector (Miller Preview)" pane
    showing breadcrumb `Scopes › Locals` + side-by-side `LOCALS │ CFG` columns, with
    the stock VARIABLES tree and the WO-4 INSPECTOR (PREVIEW) coexisting above.

## Discoveries (CDP method, added to memory)

- **VS Code webviews are a separate CDP target, not in `/json/list` and not visible
  from the page target's `Runtime`.** Reaching webview DOM needs
  `Target.setAutoAttach {flatten:true}` (recursively, per attached session), then
  enumerating `Runtime.executionContextCreated` and probing each context for a marker
  element (`#columns`). New reusable helper `scratchpad/cdp-attach.js`. This is the
  general recipe for CDP-verifying **any** Burrow webview (the FD tool, future
  visualizers).
- **Webview views resolve lazily on first expand.** The pane must be expanded
  (`aria-expanded`) before the `.webview` iframe is created — same "contributed views
  default collapsed" lesson as WO-4, now also gating webview instantiation.
- **A timed-out CDP eval keeps running in the webview** and mutates host drill state,
  so a following read starts mid-drill. Force a clean state by re-selecting frames
  (fires `onDidChangeActiveStackItem` → `miller.reset()`) before a fresh capture.

## Decisions

- made — **layer-4 webview prototype** (task 05's explicit "prototype both" step),
  kept **alongside** the WO-4 native tree rather than replacing it, so WO-6 makes the
  webview-vs-core-view call with both in hand.
- made — `Watch` / `Break on write` are **mounted but deferred**: they post messages
  that show an info toast pointing at their real owners (Watch view = task 05.6;
  watchpoints = task 04). The value-pane *surface* is complete; the wiring lands with
  those tasks. `Copy as Go literal` is fully wired (writes `toGoLiteral` to the
  clipboard).
- needed — authorize the **WO-5 commit**? Suggested:
  `feat(inspect): Miller-column inspector + value pane (webview prototype, IX)`
  (`main`, no push). All layer 4 — ledger stays green untouched.

## Next

- **WO-6 — pick the inspector + retire the stock tree (task 05.8), or push the webview
  toward keyboard/perf parity (05.4 keyboard model, 05.8 perf: stop→painted < 150 ms).**
  This slice gives the concrete artifact to judge webview vs. core view on. The value
  pane's mount interface is the seam task 06's visualizers consume next.
- Deeper fixtures still needed for the perf DoD (8-level struct, 50k-slice paging);
  current fixture nests 4 deep.
