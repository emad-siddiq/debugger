# Visual Component Editor — feature spec & implementation guide

> **Status 2026-07-24:** P1 (§1 provenance + right-file saves), P2 (§2 panel),
> §3 strata, P4-lite (§5 attribute/text JSX write-back + editable primitive
> props), and P5 themes (§6, minus side-by-side gallery + token-editor panel)
> are **landed and verified** (build · oracle 0 FAIL · tsc · test/jsxEdit.mjs ·
> Playwright e2e 22/22). Still open: §4 canvas direct manipulation, §7
> pending-edits tray/undo/copy-as/conflict-rev, §5's className chip editor +
> in-place text editing + Monaco dirty-buffer three-way check, §6 side-by-side
> theme gallery + token editing, §8 cheap wins. Bonus landed along the way:
> fiber path identity now survives live re-renders (see `pathOfFiber` /
> `currentOf` in agent.js — repo.yaml trap "path identity vs double-buffering").

**Goal:** when a component is selected in the embedded app, the Inspector becomes a full-fledged
visual editor — Figma-grade controls whose every value is *linked to the real source*: clicking a
control's provenance chip jumps to the CSS/JSX line that defines it, and changing the value edits
that line. Designers get direct manipulation; engineers get truthful source round-tripping.

This is a guide for an implementing agent: each feature says **what we want**, an
**implementation sketch** grounded in the current code, and **acceptance**. Sketches are the
intended shape, not a straitjacket — deviate where the code argues for it, but keep the
invariants and the acceptance bars.

---

## 0. Ground truth (current state — verified 2026-07-24)

- **Selection**: React-fiber walking in `agent/agent.js` (fake DevTools hook `agent.js:122`,
  picker `agent.js:1409`, stable path identity `pathOfFiber` `agent.js:323`). `describeFiber()`
  (`agent.js:954`) ships `Detail = { id, name, box, source, path, css, allMedia, inherited,
  computed, props, hooks, childCount }` (`ui/src/protocol.ts:70`), live-refreshed per React
  commit (`inspectUpdate`, 120ms throttle).
- **Source mapping**: build-time Babel stamping (`server/inspectorPlugin.js:16`) puts
  `data-inspect-file/line/col/name` on every *host* JSX element. React 19 killed
  `_debugSource`; this is the only reliable path — build on it.
- **CSS**: target app (merkle/frontend) uses **plain colocated .css files + CSS custom-property
  tokens** (`src/styles/tokens.css`, `theme-*.css`). No CSS modules / tailwind / CSS-in-JS.
  Server can locate a rule (`GET /api/css/locate`, `server/api.js:264`, postcss) and persist one
  declaration (`POST /api/css/edit`, `api.js:292`) — but the UI save path hardcodes
  `src/index.css` (`ui/src/components/StylesTab.tsx:35`). Live preview is CSSOM mutation via
  agent `previewRule` (`agent.js:1091`); **preview ≠ save** is an enforced invariant.
- **Code editing**: Monaco SourceTab (`SourceTab.tsx`) with `GET/POST /api/source`
  (allowlisted to `<target>/src`, atomic writes) → Vite Fast Refresh. Burrow embed can
  `openSource` / `openIsolation` via the `__fedbgHost` postMessage channel (`ui/src/host.ts`).
- **Isolation harness** (`server/isolateHarness.js`): single-component canvas with typed props
  panel + viewport presets — the seed of the Framer-style variant playground.
- **Hard invariants** (do not regress): agent stays plain ES2018, single IIFE, never throws
  into the page; selection identity is the stable child-index path, never fiber refs; live
  preview never auto-saves; `POST /api/source` & css writes stay allowlisted to `src/`;
  don't inject the agent via `String.replace`; launcher remains the only `/config` writer.
- **Process gates**: every change lands with its `.claude/memory/*.yaml` rows
  (`npm run oracle` → 0 FAIL): new `/api/*` routes → `routes.yaml`; new agent
  commands/events → `protocol.yaml`; new env → `env.yaml`; new UI component files →
  `components.yaml`; bump `repo.yaml` counts + `meta.updated_at`. Verify with
  `npm run build` and (against a running instance) `npm run verify`.

---

## 1. Provenance plumbing — every value knows its source line  *(foundation — do first)*

Everything else hangs off this.

**What we want.** For each matched CSS declaration on the selected component: which file and
line defines it, whether it's overridden, and which *origin class* it belongs to —
`component` (colocated `.css` next to the component's source file), `theme`
(`theme-*.css` / `tokens.css`), `global` (`index.css`, `app.css`, `styles/**`), `inherited`
(matched on an ancestor), or `inline`. The UI must never have to guess.

**Implementation sketch.**
- New route `POST /api/css/provenance`: body `{ selectors: [{selector, media?}] }`, returns
  `{ [key]: {file, line, col, origin} }`. Reuse the postcss walk from `css/locate`
  (`api.js:264`) but batch it and cache the parsed ASTs per file mtime — the Inspector will
  call this on every selection. Classify `origin` from the file path (component = same dir as
  the component's `data-inspect-file`, or same basename; theme = `styles/theme-*`/`tokens`;
  else global).
- Extend `Detail.css` rule entries (agent already has selector + declarations,
  `matchedRulesFor` `agent.js:659`) — keep the agent dumb: the **UI** joins agent rules with
  server provenance (agent has no fs; don't teach it files).
- Compute **effective vs overridden** per property in the UI: agent rules come in cascade
  order; mark a declaration overridden if a later rule (or inline style) sets the same
  property. Show DevTools-style strikethrough.
- Fix the save path: `StylesTab` save must send the **located file** to `POST /api/css/edit`,
  not `src/index.css`. When a property is *new* (no defining rule), target the component's
  colocated css file; if the component has none, create `<ComponentName>.css` beside its
  source and add the import to the component file (this needs a small `POST /api/css/ensure`
  route: create file + rule + inject `import './X.css'` — do the import edit with the same
  Babel/magic-string machinery as §5).
- `styleEdits` store keys (`store.ts:326`, currently `selector|media|prop`) must become
  file-aware: `file|selector|media|prop`.

**Acceptance.** Selecting `Tabs` shows its declarations attributed to
`src/primitives/tabs/Tabs.css:N` (not index.css); editing `padding` there and saving mutates
*that* file at *that* line; a brand-new property on a rule-less component creates and imports
a colocated css file. Overridden declarations render struck-through.

---

## 2. Inspector redesign — Figma-style control panel

**What we want.** Replace the flat declaration list with a sectioned design panel. Sections
(collapsible, only shown when relevant):

1. **Layout** — display, position, top/right/bottom/left, z-index, overflow.
2. **Auto-layout** (when element or parent is flex/grid) — direction, justify/align as Figma
   icon toggles, gap, wrap; child-side: flex-grow/shrink/basis, align-self ("fill / hug /
   fixed" mental model mapped onto width/flex).
3. **Spacing** — interactive margin/padding box (see §3).
4. **Size** — width/height/min/max with unit switcher.
5. **Fill** — background color/gradient/image.
6. **Stroke** — border per-side width/style/color, outline.
7. **Corners** — radius, per-corner splittable (Figma's linked/unlinked corners toggle).
8. **Effects** — box-shadow (stacked list, add/remove/reorder), opacity, filter/backdrop blur,
   transform.
9. **Typography** — family, size, weight, line-height, letter-spacing, color, align,
   transform, decoration.

Every control row carries a **provenance chip** (`Tabs.css:41`, colored by origin class per §1).
Click chip → open source at that line (`store.openInSource`, which already prefers Burrow and
falls back to Monaco). Values not set anywhere show the computed value dimmed ("from computed").

**Control behaviors (apply everywhere):**
- **Numeric scrubbing**: drag horizontally on a control's label to scrub the value
  (pointer-lock while dragging); ↑/↓ arrows ±1, Shift ±10, Alt ±0.1. Scrub = live preview
  (`previewRule`), release/blur = pending edit, explicit Save (or ⌘S in panel) = persist.
  Keep the existing preview-not-save contract.
- **Unit switching**: px/rem/%/em/auto/`var()` dropdown on numeric fields; converting px↔rem
  uses root font-size from computed.
- **Color fields**: swatch + hex/rgb/hsl input + native-quality picker (build a small popover
  picker — no new heavy deps; canvas-based SV square + hue/alpha sliders is ~200 lines).
  If the current value is `var(--x)`, show the token name and resolved swatch; a "token"
  dropdown lists candidates from the agent's token audit (`readTokens` `agent.js:1313`) so a
  raw color can be swapped for a token (this is the a11y/consistency win designers want).
  Inline contrast badge (AA/AAA) on text-color rows, reusing the a11y audit math.
- **Shorthand intelligence**: editing one side of `margin: 8px 12px` rewrites the shorthand
  correctly server-side (postcss knows the declaration; expand/collapse there, not in the UI).

**Implementation sketch.** New components under `ui/src/components/editor/`
(`EditorPanel.tsx`, `SectionLayout.tsx`, … `ControlRow.tsx`, `NumericField.tsx`,
`ColorField.tsx`, `ProvenanceChip.tsx`). The panel derives its model from
`selection.css + provenance + computed` via a pure `deriveStyleModel()` module with unit
tests — keep parsing (shorthands, var(), shadows) out of components. Replace StylesTab's body
with the new panel; keep a "raw rules" fold-out at the bottom (engineers still want the
cascade view). Register every new file in `components.yaml`.

**Acceptance.** Padding/margin/bg-color/radius/shadow/typography all adjustable with scrub +
units + picker; each row's chip jumps to the defining line; save writes to the right file;
raw cascade view still available.

---

## 3. Own vs inherited separation

**What we want.** Clear visual strata in the panel, in this order:
1. **Component** — rules whose origin is the component's own css (editable, primary).
2. **Inline** — `style=` (editable; but saving means a JSX edit, see §5 — until then show an
   "inline — edit in JSX" affordance).
3. **Global / theme** — matched rules from index/app/theme/tokens files (editable, but with a
   warning affordance "affects the whole app" + one-click **"override in component"** that
   copies the declaration into the component's css with the component's selector).
4. **Inherited** — from ancestors (`Detail.inherited`, `inheritedFor` `agent.js:747`), grouped
   by ancestor with its provenance chip; read-only in place, with the existing "override"
   action upgraded to write into the component css.

**Implementation sketch.** Pure UI/derivation work on top of §1's origin classes — the data is
already split (matched vs inherited) by the agent; the panel just needs to bucket matched
rules by origin and wire "override here" to `css/ensure`+`css/edit`.

**Acceptance.** A designer can tell at a glance which knobs are "mine" vs "the theme's" vs
"inherited from a parent", and can safely localize any of them to the component.

---

## 4. Direct manipulation on the canvas

**What we want.** Figma-feel editing in the target iframe itself:
- **Spacing handles**: with a selection, the overlay shows margin (orange) and padding (green)
  zones (the agent already draws boxes — extend it); dragging a zone's edge scrubs that side's
  value with a live numeric tooltip. Release → pending edit in the panel (same pipeline as §2).
- **Resize handles**: 8 grips on the selection box → width/height (writes explicit px; the
  panel is where you convert to %/rem).
- **Gap handles**: when the selected element is a flex/grid container, draggable gap strips
  between children.
- **Measurement mode**: hold Alt with a selection → red distance lines + px labels from the
  selection to the hovered element (offset math from the two `getBoundingClientRect`s).
- **Text editing in place**: double-click a text-bearing element → contenteditable overlay;
  commit is a **JSX edit** (§5) when the text maps to a static string literal, else fall back
  to opening the source line. Detect editability server-side: does the AST node at
  file:line contain a sole `JSXText`/string child?

**Implementation sketch.** All overlay/drag logic lives in the agent (ES2018! — no optional
chaining, declare every var, try/catch every handler). New agent **commands**: `setHandles`
(on/off + which), `measure` (on/off); new **events**: `handleDrag` (live, drives preview
locally in-agent for zero-lag), `handleCommit {prop, value}` (UI turns it into a pending
edit), `textEditCommit {file,line,col,text}`. Update `protocol.yaml` for every one. Drags must
`preventDefault` and cancel cleanly on Escape; never leave listeners attached
(agent-never-throws + no leaks across `pick` mode toggles).

**Acceptance.** Drag padding on a card, watch the tooltip count, release, hit Save — the
component's css file changes by exactly that declaration. Alt-hover shows correct distances.
Escape mid-drag reverts preview.

---

## 5. React code editing (JSX write-back + props)

**What we want.**
- **Editable props**: PropsTab becomes a form for serializable props (string/number/boolean/
  enum-guessable). Two lanes:
  - **Preview lane** (ephemeral): agent overrides the prop and re-renders — for "what does
    `variant="ghost"` look like". This already exists in spirit in the isolation harness;
    in-app, implement by wrapping: agent stores an override map keyed by path-id and patches
    `memoizedProps` on the fiber then schedules an update via the hook's `scheduleUpdate` if
    obtainable — **if this proves unreliable across React versions, don't force it**: fall
    back to "preview in isolation" (open the harness with these props) and keep the in-app
    lane persist-only.
  - **Persist lane**: writes the literal attribute value at the JSX callsite (below).
- **JSX mutation API**: new route `POST /api/jsx/edit` with ops:
  `setAttribute {file, line, col, name, value}` (add/update; `value` as string/number/bool/
  expression-string), `removeAttribute`, `setText {file, line, col, text}`,
  `setClassName` (sugar over setAttribute). Implementation: `@babel/core` is already a
  dependency — parse with `@babel/parser` (jsx+ts plugins), locate the `JSXOpeningElement`
  whose `loc.start` matches line:col (the stamped `data-inspect-*` values are exactly these),
  and apply the edit with **magic-string** style surgical slicing (add tiny dep
  `magic-string`, or hand-roll: you know exact source offsets from the AST — replace only the
  attribute's value range). **Never reprint the whole file** — formatting churn is the failure
  mode that makes engineers turn the tool off. Atomic write like `writeFileAtomic`
  (`api.js:25`), then Vite Fast Refresh does the rest.
- **Where's the callsite?** `data-inspect-*` stamps host elements inside the component —
  i.e. the component's *definition* renders them. For editing the *usage* (props passed by the
  parent), resolve the parent fiber's stamped source (the component fiber's own
  `_debugOwner`/return-path host) — the agent's `path` ancestor chain already carries per-
  ancestor `source`; use the selected component's element source for definition edits and its
  parent-side source for prop edits. Expose both in the UI ("Edit definition" / "Edit usage").
- **Monaco tightening**: when a component is selected, SourceTab auto-reveals + highlights the
  element's line range; edits made through panel controls appear in the open Monaco buffer
  (refetch on save; if the buffer is dirty, warn — last-write-wins is not acceptable, do a
  three-way check on `rev`/mtime and refuse with a clear message on conflict).
- **className editor**: chip-style multi-token editor on the selected element; adding a class
  that matches an existing rule shows its provenance; creating an unknown class offers to
  scaffold the rule in the component css (via `css/ensure`).

**Implementation sketch.** New `server/jsxEdit.js` (parser + op appliers + offset-slice
writer) with **direct unit tests** (this is the riskiest code — test cases: attr update,
attr add on multi-line tags, self-closing, spread present (refuse politely), template
literal className (refuse), text with expressions (refuse), TS generics). Route in `api.js`
+ `routes.yaml`. Refusals return a structured `{ok:false, reason}` the UI renders as "open in
source instead" — graceful degradation beats wrong edits.

**Acceptance.** Change a `label` prop string in the panel → parent JSX file's attribute
updates in place with zero formatting churn elsewhere; text double-click edit lands in JSX;
spread/dynamic cases refuse cleanly and deep-link to Monaco/Burrow at the right line.

---

## 6. Theme flipping & token editing

**What we want.**
- **Theme switcher** in the toolbar: enumerate available themes and flip the *target app*
  between them live; plus light/dark `prefers-color-scheme` emulation and a "cycle themes"
  key. Selection stays put across flips (stable path identity survives re-render).
- **Side-by-side**: in the existing gallery/pager, render the same view in N themes at once
  (theme applied per-frame) — designers' favorite regression check.
- **Token editor**: TokensPanel upgrade — edit a custom property's value with the §2 color/
  numeric controls, live-preview app-wide (agent sets it on `:root` via CSSOM), persist to the
  defining file (`tokens.css` / `theme-*.css`) via the same `css/edit` path with provenance.
  Show "N components use this token" (agent token audit already counts usage).

**Implementation sketch.** First **discover how the target app switches themes** (mechanism,
not assumption): server-side scan for `theme-*.css` + grep how they're applied
(`data-theme` attr? class on `<html>`? conditional import?). Expose
`GET /api/themes` → `{themes:[{name, file, applyMechanism}]}`. Agent command `setTheme`
implements the found mechanism (set attr/class; if themes are conditionally imported, have
the server inject all theme files in dev and gate by attr — dev-only, via
`transformIndexHtml`). New protocol entries + routes.yaml rows. If the app turns out to have
a JS theme store, prefer driving that (agent calls the app's own setter if it's exposed on
window; else DOM-level).

**Acceptance.** Flip themes from the toolbar without losing selection; edit `--color-accent`
in TokensPanel, watch the app repaint, save into `theme-dark.css:12`; gallery shows the same
screen in ≥2 themes side by side.

---

## 7. Editing session UX — pending changes, undo, safety

**What we want.** With this many write paths, edits need a shared lifecycle:
- **Pending-changes tray**: one panel listing every unsaved edit (css + jsx + token), grouped
  by file, each with a one-line diff preview, individually revertable, "Save all" / "Discard
  all". This generalizes today's `styleEdits`.
- **Undo/redo** (⌘Z/⇧⌘Z) over the pending-edit stack *and* over saved edits within the
  session (keep the pre-save value in each edit record; undo of a saved edit issues a
  compensating write).
- **Copy as…** on the selection: copy CSS (effective styles as a rule), copy JSX snippet
  (from source at the stamped range), copy token references.
- **Conflict safety**: all writes carry the file mtime/rev they were based on; server refuses
  stale writes (extend the `rev` idea from `/api/config`); UI offers reload-and-reapply.

**Implementation sketch.** Refactor `styleEdits` into a general
`pendingEdits: Edit[]` store slice (`{kind:'css'|'jsx'|'token', file, target, before, after,
saved}`), with the tray + undo as pure store operations. This should land alongside §1 (the
key-shape change touches the same code) — do the store refactor once, early.

**Acceptance.** Make five edits across three files, revert one, save the rest atomically;
⌘Z steps back through them; a file changed on disk under you produces a refusal, not a
clobber.

---

## 8. Smaller Figma/Framer niceties (cheap wins, sprinkle in as you go)

- **Zoom & pan** the device frame (⌘+/-/0, space-drag) — CSS transform on the frame wrapper;
  keep overlay math zoom-aware (agent must scale its boxes by the zoom factor — pass it in
  `rebox`).
- **Outline/wireframe toggle**: agent injects a dev stylesheet (`* { outline: 1px solid … }`
  by depth) — designers use this constantly to see structure.
- **Hover = Figma-style dims**: hovering any element (not just in pick mode) shows its size
  badge; already have hover events — render the W×H tag.
- **Component screenshot**: "Export PNG" of the selection — in-agent
  `element → SVG foreignObject → canvas` is fragile; simpler: server-side Playwright is
  already a dev dep for e2e — add `POST /api/screenshot {selector-path, viewport}` that
  drives a headless page of the target and clips to the element box. Dev-only, fine.
- **Keyboard layer**: `V` select, `Esc` clear/cancel drag, `⌘D` duplicate → (JSX duplicate op,
  only if §5 lands; otherwise omit), arrows nudge margin when a spacing side is focused,
  `⌥` measure, `T` cycle theme. Document in a `?` shortcuts overlay.
- **Font preview** in the typography family dropdown (render each option in itself; families
  from computed styles + any `@font-face` in the sheets).

---

## 9. Sequencing & non-goals

**Order** (each phase ships working + gated):
1. **P1 Foundation**: §1 provenance + right-file saves + §7 store refactor. *(Everything else
   depends on it; also fixes today's real bug — saves landing in index.css.)*
2. **P2 Panel**: §2 sectioned editor + §3 own/inherited strata.
3. **P3 Canvas**: §4 handles + measurement.
4. **P4 Code**: §5 JSX write-back + props editing.
5. **P5 Themes**: §6.
6. **P6 Polish**: §7 tray/undo completion + §8 picks.

**Per-phase definition of done**: `npm run build` green · `npm run oracle` 0 FAIL (memory
yamls updated **in the same change**) · new server logic (provenance, jsxEdit) has direct
unit tests · `npm run verify` e2e extended with at least one flow per phase (e.g. P1: "edit
padding → saved into Tabs.css") · invariants in §0 intact.

**Non-goals (explicitly out)**: drag-to-reparent/reorder DOM nodes (JSX structure moves are
a formatting minefield — revisit after §5 proves stable); arbitrary-canvas free-transform
(this is a debugger for a real DOM, not a drawing tool); supporting CSS-in-JS/tailwind
targets (the target stack is plain css + tokens — don't build for stacks we don't have);
editing files outside `<target>/src` (allowlist stays).
