# 17 — Panel persistence

_The rule every Burrow tool surface follows for surviving a rail switch, a
window reload and an app relaunch. Written for WO-60 (open gap #3), 2026-07-29._

## The gap this closes

Patch `0014` gave each rail its own set of editor tabs, so leaving Data and
coming back brings your files with you. It did not bring the **tools** back. The
reason is one line in upstream:

```ts
// src/vs/workbench/contrib/webviewPanel/browser/webviewEditorInputSerializer.ts
public canSerialize(input: WebviewInput): boolean {
	return this._webviewWorkbenchService.shouldPersist(input);
}
```

`shouldPersist` answers "is a reviver registered for this viewType?". No Burrow
extension registered one, so every webview panel failed `canSerialize`, was
dropped from the rail's saved working set rather than stored in it, and was gone
for good. The same line is why they did not survive `Developer: Reload Window`
or a relaunch. **A serializer is not an optimisation here; it is the difference
between the panel being persisted and not being persisted at all.**

## Where state lives

Two homes, and the split is not a preference — it follows from who renders.

| Home | Holds | Because |
|---|---|---|
| `webview.setState` | The panel's own view state: the SQL as typed, the picked request, scroll offsets, whether the help sheet is open, which route the diagram is for | The workbench persists it beside the editor (`toJson` → `state: input.webview.state`) and hands it back to `deserializeWebviewPanel`. Scoped to the panel, restored with the panel, no key management |
| `context.workspaceState` | Content the HOST renders and the webview never sees: the Test Lab's last verdict set | The webview is repainted from the host on every render, so the host must still have the thing. A run is also far larger than a state blob should be |

Everything else is **re-derived**, not stored: the diagram re-resolves its route
from the cached `flows.json`, the HTTP workbench re-parses its `.http` file, the
scratch page re-reads the plan from the scratch folder, the Go docs viewer
re-runs `go doc`. Deriving is cheaper than storing, and it cannot go stale.

## The four rules a restored panel obeys

1. **Restore is not a request.** No panel reconnects, spawns or fetches on the
   way back. The Data grid holds its SQL and does not run it; pgAdmin restores
   stopped; the frontend surfaces restore without a dev server; the Go docs
   viewer re-runs the toolchain with `GOPROXY=off` so a cold module cache cannot
   turn a restored tab into a download. Every one of them carries the single
   button that IS the request.
2. **Never blank, never faked.** A panel that cannot recover part of its state
   says which part and why: "Restored — not run", "the route index has not been
   built in this workspace", "this workbench was bound to `x.http`, which this
   window cannot open".
3. **The question, not the answer.** No result sets, no response bodies, no
   connection strings, no tokens. The grid persists its SQL and the connection's
   `user@host:port/db` label; it never persists a row. The HTTP workbench
   persists which request was picked; it never persists what came back.

   The API view's **Recent** list is the case where this rule cost something and
   was kept anyway (ruled in WO-60b). Ten sends with their statuses would be
   genuinely useful across a reload, and they are not persisted, because a record
   holds the *resolved* URL and a `.http` variable routinely puts an API key in a
   query string — persisting it writes a credential to workspace storage. Showing
   last session's statuses under a heading that reads "Recent" is also a small
   lie. So the list is session-scoped, and what survives is one boolean saying a
   send happened in this workspace — never what it was — so the empty list can
   say `Cleared on reload · a sent URL can carry a key, so it is never saved`
   instead of being silently empty. Grey-with-a-reason applies to a list that
   comes back empty exactly as it applies to a panel that comes back partial.
4. **Bounded.** Every blob has a ceiling and states what it dropped: SQL over
   32 KB, doc history over 50 hops, isolation props over 16 KB, a stored test run
   over 48 KB (failures' output goes first, then all output, and the panel says
   so).

## Registration

Each panel-owning extension registers its serializer from `activate` and adds
`onWebviewPanel:<viewType>` to `activationEvents` — without that event the
extension is not activated in time to revive, and the panel comes back as dead
chrome.

`burrow-scratch` is the deliberate exception: its serializer is registered from
`activateScratch`, so a window that is not a scratch has no reviver, the
workbench declines to persist the step page, and it never reappears somewhere it
would have nothing to point at.

## Interaction with the two tidying mechanisms

Both still run, and neither fights this:

- **Per-rail editor sets (patch `0014`)** save the outgoing rail's visible
  editors *before* the sweep runs, so the tool's panel is in the set it belongs
  to and `applyWorkingSet` revives it on the way back.

  0014 needed one fix of its own for any of that to be visible: it registered at
  `AfterRestored` and treated the user's first rail click after a window restore
  as a baseline rather than a switch, so the panel came back into the right set
  and was then not shown. A restored panel nobody can see is indistinguishable
  from a lost one. Fixed in WO-60b (0014 seeds itself from
  `getLastActivePaneCompositeId`); asserted by `P2-13`.
- **The tool-surface sweep (WO-23, `burrow-core/src/tools.ts`)** closes another
  tool's claimed surfaces 300 ms after a rail switch. By then the working set has
  already been applied, so it finds nothing of the *active* tool's to close.

The isolation preview is the one surface that is deliberately unclaimed: it is
one member of a trio (source | stylesheet | canvas) that closes as a unit, and a
core sweep of the canvas would take two of the user's editors with it.

## What restore does NOT do

- **It does not re-run the trio cascade.** `openIsolation` opens editors, closes
  the previous component's tabs and re-lays out the columns — right when a person
  asks for a component, wrong during a window restore, where the workbench is
  already putting the source and stylesheet back itself. The revive path paints
  the canvas, adopts the panel, re-baselines the trio, and stops.
- **It does not maximize anything.** `openMaximized` and the Go docs viewer's
  fullscreen describe what happens when YOU open a panel. Rearranging a layout
  during a window restore is not that.
- **It does not restore a debug session.** Nothing here has ever held one; the
  inspector, Watch and Frames views come back with no session, honestly.

## Ordering

Delegated to the workbench. Editors are restored in their serialized group and
index order, `toJson` keeps `group: input.group`, and each serializer is
independent of the others — no cross-panel ordering assumption exists, so several
panels open in one rail come back where they were.

## Unconditional

There is no setting. The workbench restores editors unconditionally; per-rail
sets have a setting because they *remove* tabs, which is the surprising
direction. A panel you left open coming back is the unsurprising one, and every
one of them comes back inert, so it costs nothing to have it there.
