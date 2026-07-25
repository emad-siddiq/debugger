# WO-03 report — IX slice 1: path-addressed DAP value model + Go summary renderer
STATUS: DONE — WO-2 commit **landed** (authorized); WO-3 + a ledger-gate fix **uncommitted, for review**

## Changed
- **Committed (authorized this session)** on `main`, no push:
  - `d48a33ee` feat(debug): minimal dlv dap adapter + debuggee fixture (WO-2; the FD session committed first, so my delta was clean and cleanly ordered — the coordination blocker resolved itself).
- **Uncommitted — WO-3** (`extensions/burrow-go-inspect/`, layer 4, **no core patch**):
  - `src/summary.ts` — pure per-Go-type summary registry (slice `len/cap`, map size, pointer, struct brief, `[]byte`, `time.Duration` humanize, error, scalars, nil) + `briefFromChildren`.
  - `src/model.ts` — `InspectorModel`: `activeStackItem`→`stackTrace`→`scopes`→`variables` (indexed paging, `PAGE_SIZE=100`), name-path addressing, change-diff snapshot rolled on `stopped`, pointer one-level deref.
  - `src/extension.ts` — read-only **"Inspector (Preview)"** TreeView in the debug container; refresh on stop / active-frame change; `burrow.inspect.refresh`.
  - `test/summary.test.js` (23 cases), `package.json`, `tsconfig.json`, `.vscodeignore`; shared `build/gulpfile.extensions.ts` + `patches/0001` compile entry.
- **Uncommitted — infra fix** (separate): `build/burrow/package.json` `{"type":"commonjs"}` — see Discoveries.

## Verified (host `dlv` 1.25.2, Go 1.24.1; fresh-profile CDP boots on `testdata/debuggee`, trust off)
- **compile:** `compile-extension:burrow-go-inspect` → 0 errors. **unit:** `npm test` → **23/23**. **ledger gate:** now runs → `9 core, 5 entries — OK`.
- **live (primary DoD):** stopped at `runtime.Breakpoint()` in `add()` → Inspector (Preview) renders `Locals` with summaries `a=0 b=2 ~r0=0 sum=2`. Select `main.main` frame → re-scopes to `nums []int len=5 cap=5`, `total` int (frame re-scope). Expand `nums` → indexed children `[0]=2 [1]=3 [2]=5 [3]=7` at level 3 (path `Locals ▸ nums ▸ [i]`, `getChildren`). Continue iter1→iter2 → `a ● 2`, `b ● 3`, `sum ● 5` marked changed, `~r0 0` not (change-diff). Screenshot `scratchpad/wo3-inspector-revealed.png`.

## Discoveries
- **The ledger gate has been DEAD since the fork commit `69a5b163`.** `build/burrow/check-ledger.js` is CommonJS (`require`) but sits under `build/`, whose `package.json` is `"type":"module"` — so `node build/burrow/check-ledger.js` (what `make ledger-check`/CI run) always threw `require is not defined in ES module scope`. The "machine-enforced" layer-3 discipline never actually ran. Fixed by scoping CommonJS to that dir with `build/burrow/package.json` (reference-preserving; a `.cjs` rename would break Makefile + README + patches/README). Gate now green and enforcing.
- **Tracker model-capture bug (found + fixed mid-run):** `createDebugAdapterTracker` can fire before `onDidStartDebugSession` registers the model, so capturing `models.get(id)` at tracker creation left it `undefined` forever → `onStopped()` never called → snapshot never rolled → **no change markers**. Fix: look the model up **per message**. (First live run showed no `●`; fixed → confirmed.)
- **CDP headless notes:** separate eval calls that click can drift the debug state (stray step/continue) — do multi-click sequences in ONE eval; **reads are safe**. A recompiled extension needs a full app reboot (old app holds the CDP port → hard-kill + verify a new page-id). **SIGKILL of the app orphans `dlv`** (extension terminate skipped) — cleaned manually; a real quit is kill-safe.
- **dlv 1.25.2 value shapes:** slice `value` carries `len: N, cap: M` (+ an element dump we drop); `indexedVariables` = len; struct `value` = `pkg.T {…}`; scalars pass through. Registry leans on `type` + DAP counts, lightly condenses `value`.

## Decisions
- made — layer 4, **no core patch**: the Miller-column inspector is a real workbench view (task 05.4, the plan's pre-approved big patch) and belongs to a later WO; WO-3 is the data layer + renderer only. The preview TreeView is explicit **scaffolding**, retired when the Miller UI lands. Change marker is an amber `●` in the row description (icon color alone isn't headless-verifiable).
- needed — **(1) authorize the WO-3 commit?** proposed `feat(inspect): path-addressed DAP value model + Go summary renderer (IX)`. **(2) authorize the ledger-gate fix commit?** (separate, tiny) proposed `fix(build): run check-ledger as CommonJS (build/ is type:module)`. Both `main`, no push.

## Next
- **WO-4 — Inspector Miller-column UI (task 05.4):** columns + breadcrumb + keyboard model over this model; begin retiring the stock Variables tree from the debug bar. The pre-approved core view/patch.
- Open: the >100 paging pager is coded + unit-covered but not live-demoed (fixture has 5 elements); `time.Time` humanization, error-chain view, goroutine table are task 06.
