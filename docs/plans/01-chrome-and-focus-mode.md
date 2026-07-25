# 01 — Chrome removal, one search, Focus Mode

> Workstream 1 of the [master plan](00-master-plan.md). Lands entirely in `burrow/`.
> Target: **zero Burrow-drawn chrome above the editor**, **one search surface**, and a
> **Focus Mode** button top-right that `Esc` exits.

---

## Part 1 — Technical summary (for product review)

Today Burrow paints a full-width row above everything: back/forward arrows, a Command Center
search box (currently reading "merkle"), a chat control, a **Sign In** button for a product we
don't ship, and four layout toggles. None of it earns its pixels; two of its controls
duplicate things that already exist one keystroke away.

**We delete the row.** macOS then draws its own thin title strip with the traffic lights —
system chrome, not ours. That single change removes the second search box, the account button,
and the layout toggles at once, and it costs one config block (no core patch).

What replaces the useful ~5% of that row:

| Was in the top row | Where it goes |
|---|---|
| Command Center search | Nothing — the **Search** rail item is the one search surface (`⇧⌘F`). `⌘P` (files) and `⌥⌘O` (Go symbols) stay as transient palettes, not bars |
| Back / forward | `⌃-` / `⌃⇧-` (already bound) + a two-item entry in the editor tab-bar overflow |
| Layout toggles | `⌘B` (sidebar), `⌘⌥D` (agent panel, already bound in `burrow-core`), `⌘J` (panel) |
| Chat "Sign In" | Deleted with the row; the real agent lives on the right (file `03`) |

**Focus Mode**: one button in the top-right of the editor area (`⛶`), one keybinding (`⌘⇧Return`),
and **`Esc` to exit**. It is Burrow's existing Zen Mode, tuned: full screen, centered, no tabs,
no status bar, no rails. The same affordance is added to every full-surface tool (isolation
preview, DB grid, HTTP workbench, docs) so "make this the whole screen" is always the same
gesture in the same corner.

Cost: ~1 day for the chrome + search, ~2 days for Focus Mode incl. the per-tool buttons. One
*possible* core patch (single-`Esc` exit), which we avoid if a keybinding `when`-clause suffices.

---

## Part 2 — Details for the implementing agent

### 1. Delete the top row

**Layer 1/4 — `extensions/burrow-core/package.json` → `configurationDefaults`** (the block that
today holds `editor.minimap.enabled`, `zenMode.showTabs`, etc.):

```jsonc
"window.titleBarStyle": "native",              // macOS draws the strip; Burrow draws nothing
"window.customTitleBarVisibility": "never",    // belt-and-braces if titleBarStyle is ever flipped
"window.commandCenter": false,
"window.navigationControl.enabled": false,
"workbench.layoutControl.enabled": false,
"chat.commandCenter.enabled": false,           // already present — keep
"workbench.editor.editorActionsLocation": "default",  // actions stay on the editor, never in a title bar
"window.title": "${rootName}"                  // short, no path soup, in case the native strip shows it
```

Verified setting ids in this tree: `window.customTitleBarVisibility`
(`src/vs/workbench/browser/workbench.contribution.ts:77`), `window.navigationControl.enabled`
(:776), `workbench.layoutControl.enabled` (:784), `window.commandCenter` (:864).

**The "Sign In" button** is upstream chat's entitlement control rendered *in the custom title
bar*; with `titleBarStyle: native` it is gone. Do **not** attempt the `contrib/chat` excision
here — `product.json:40 defaultChatAgent` is load-bearing (`STRIP.md:184`). Full excision is a
later, optional WO once file `03` ships (see `06` WO-15).

**Acceptance:** launch on merkle; screenshot shows the editor starting at the very top of the
window under a plain macOS strip; no search box, no Sign In, no layout icons anywhere in the
window. Also confirm the window still moves/zooms by dragging the native strip.

### 2. Verify nothing was load-bearing

Run through this list after the change (it is the whole set of things people lose when the
custom title bar goes):

- [ ] `⌘B`, `⌘J`, `⌘⌥D` still toggle sidebar / panel / auxiliary bar.
- [ ] `⌘P`, `⇧⌘P`, `⇧⌘F`, `⌥⌘O` all still open.
- [ ] Editor breadcrumbs still render (they live in the editor, not the title bar).
- [ ] Debug toolbar still appears when a dlv session starts (patch `0004` puts Run & Debug on
      the right; the floating debug toolbar is independent of the title bar).
- [ ] Full-screen (`⌃⌘F`) and Zen (`⌘K Z`) still work.

### 3. One search surface

**Option A — default (D2, do this):**
- The Command Center is deleted by §1. The **Search** view container is now the only search
  *bar* in the product.
- Tighten it so it reads as one thing, not three: in `burrow-core` defaults add
  ```jsonc
  "search.searchOnType": true,
  "search.showLineNumbers": true,
  "search.collapseResults": "auto",
  "search.useReplacePreview": true,
  "workbench.view.search.location": "sidebar"   // never split across rails
  ```
- Add `burrow.find.everywhere` (in `burrow-go-nav`, which already owns `⌥⌘O` and the package
  index): a single command that opens the Search view *focused*, with a header segmented
  control **Text · Files · Symbols**; Files delegates to `workbench.action.quickOpen`,
  Symbols to the existing `burrow.nav.goToSymbol` index. Bind `⇧⌘F`.
  *If the segmented control cannot be contributed to the stock search view header without a
  core patch, ship the command + keybinding only and note the deviation — three keystrokes,
  one visible bar, still satisfies "one search bar".*

**Option B — only if the user says the two bars they meant were the Search view and the symbol
palette:** build `burrow-find` as a single custom view (webview) owning one input with mode
chips, and stop registering the upstream Search view container in the rail (small ledgered core
patch in `src/vs/workbench/contrib/search/browser/search.contribution.ts`, ~10 lines, keeps the
search *service* and Quick Search intact). Cost ≈ 3 days. Do not start without the decision.

**Acceptance (A):** exactly one persistent input box exists in the whole window; `⇧⌘F` focuses
it; `⌘P`/`⌥⌘O` still work as overlays; a text search on `merkle` returns results with replace
working.

### 4. Focus Mode

**Command** `burrow.focus.toggle` — new, in `burrow-core` (`src/extension.ts`):

```ts
// Focus Mode = Zen, tuned for one-surface work. Enter: hide everything but the active editor.
// Exit: Esc (single) or the same button. State is workbench-owned; we only toggle it.
await commands.executeCommand('workbench.action.toggleZenMode');
```

**Zen tuning** (config defaults in `burrow-core`; upstream already defaults fullScreen,
centerLayout, hideStatusBar and hideActivityBar to `true` — verified during the markdown work,
see `report.md`):

```jsonc
"zenMode.showTabs": "none",          // already present
"zenMode.hideLineNumbers": false,    // classical SWE: keep line numbers
"zenMode.centerLayout": true,
"zenMode.restore": false,            // never boot into Focus
"zenMode.silentNotifications": true
```

**The button.** Contribute to `editor/title` in the **navigation** group so it renders at the
top-right of the editor area (where the layout toggles used to be, one row lower):

```jsonc
{ "command": "burrow.focus.toggle", "group": "navigation@100",
  "when": "editorIsOpen || activeWebviewPanelId" ,
  "icon": "$(screen-full)" }
```

Keybinding: `cmd+shift+enter` → `burrow.focus.toggle`.

**Esc to exit.** Try the keybinding route first (no patch):

```jsonc
{ "key": "escape", "command": "workbench.action.exitZenMode",
  "when": "inZenMode && !suggestWidgetVisible && !inQuickOpen && !findWidgetVisible && !parameterHintsVisible && !renameInputVisible && !inSnippetMode && !terminalFocus && !inlineSuggestionVisible" }
```

Keep upstream's `Escape Escape` as the always-works fallback. Verify the `when` clause against
`src/vs/workbench/browser/workbench.zenMode.contribution.ts:131` (`workbench.action.exitZenMode`)
and test each excluded widget by hand: open suggest, press Esc → suggest closes, still in Focus.
**Only if** the clause proves insufficient (e.g. Esc inside a webview never reaches the
workbench) add core patch `0011-single-esc-exits-focus.md` (< 30 lines, ledger row required).

**Webview caveat (expected):** while an FD preview/isolation webview has focus, `Esc` is
swallowed by the iframe. Fix inside the webview, not in core: the FD/agent webviews already own
their key handling — post `{type:'exitFocus'}` to the extension host on `Escape` and have the
extension run `workbench.action.exitZenMode`. Apply the same three lines in every Burrow webview
(`burrow-frontend-debugger/src/panel.ts`, `isolation.ts`, `burrow-db` grid, `burrow-http`
workbench, `burrow-agent` panel).

**Acceptance:** from a cold launch — click `⛶` on an editor → full-screen centered single
editor, no rails/tabs/status; press `Esc` once → back exactly where you were (same editor, same
scroll, same sidebar state). Repeat with the isolation preview focused and with the DB grid
focused. Screenshots of all three.

### 5. "Fullscreen this tool", not just this editor

Every full-surface tool gets the same corner button and the same `Esc`:

| Tool | Surface today | What to add |
|---|---|---|
| Frontend isolation | webview editor (`isolation.ts`) | `⛶` in its own toolbar → `burrow.focus.toggle`; Esc bridge (§4) |
| App preview / FD panel | webview panel (`panel.ts`) | same |
| Database | tree view + grid editor (`burrow-db`) | grid opens as an editor already → `editor/title` button covers it; add Esc bridge |
| HTTP workbench | `.http` editor + response webview | `editor/title` button covers the editor; Esc bridge for the response pane |
| Go docs | webview (`burrow-go-docs`) | already has a fullscreen story (task 07) — unify to the same command + icon |
| Markdown read | `markdown.readZen` (⌘K R, shipped) | re-point it at `burrow.focus.toggle` so there is one Focus implementation |

Rule for the agent: **one command, one icon, one keybinding, one exit.** No tool invents its own
maximize.

### 6. What must *not* change

- The right-hand debug dock behaviour (patch `0004`) — Run & Debug still auto-reveals on the
  right when a session starts, and Focus Mode hides it like everything else.
- `⌘⌥D` stays bound to `workbench.action.toggleAuxiliaryBar` (it becomes the agent toggle in
  file `03`).
- The FD tool's own auto-hiding toolbar (`tools/frontend-debugger/ui/src/components/TopBar.tsx`)
  is *inside* the preview and is unrelated to the workbench top row — leave it alone in this WO
  (file `02` decides its fate as part of the Components view spec).

### 7. Evidence bundle for this workstream

`before.png` (current, with the row) · `after-shell.png` (no row) · `after-search.png` (one box)
· `focus-editor.png` · `focus-isolation.png` · `focus-db.png` · `esc-returns.png`, plus the
compile/typecheck output. Store under the session scratchpad and link the paths in the WO report.
</content>
