# Frontend Debugger

A visual, IDE-style debugger for **React** frontends — the frontend counterpart to
setting backend breakpoints. It embeds a running target app, lets you **drill from
a parent component down to leaf components in "theater mode"**, and shows each
component's **matched CSS, responsive breakpoints, and source code** — which you
can **edit and save back to disk** with live HMR.

It lives at `burrow/tools/frontend-debugger` and opens as a **Burrow editor
panel** (via the `burrow-frontend-debugger` extension), pre-wired against the
**NodeWatch** frontend (`~/Projects/merkle/nodewatch/frontend`) as a testing
ground — but it works on any Vite + React app.

## Where this fits — the merkle learning path

This tool is the **visual frontend layer** of merkle's guided debugging
tutorials (`merkle/infra/test/tutorials/` in the merkle repo). It implements the
**component-side** of **Tutorial 03 — Debug the Frontend**
(`03-debug-the-frontend.md`), giving you a no-VSCode way to do the frontend
inspection blocks:

| Tutorial 03 goal | In this tool |
| --- | --- |
| Open any page of the app | Toolbar **`▸ route…`** picker (all 10 NodeWatch routes) |
| Breakpoint / inspect a component | **Pick** + **Theater** drill-down; **Tree** tab; **Props** tab shows live props **& hooks** |
| Edit a component live (HMR) | **Source** tab (Monaco `.tsx`) → **Save** = Vite Fast Refresh; **Styles** → Save = CSS HMR |
| Responsive behavior | **device** picker + **🖼 Gallery** (Mobile 375 / Tablet 768 / Desktop 1280 side-by-side) |
| Quality checks | **♿ Audit** (contrast/alt/label/tap-target a11y) + **🎨 Tokens** (design-token conformance) |

**What stays in VSCode (not covered here, by design):** Tutorial 03's
`client.ts` request-funnel breakpoint and the **full-stack "one click, two
debuggers"** trace (frontend → Vite proxy → Go) use the repo's
`.vscode/launch.json` (`Frontend: debug in Chrome (:5173)` + the `Full stack:
backend + Chrome` compound) — this tool runs the target against the **in-memory
mock** (`VITE_SKIP_AUTH=1`, no backend), so it never issues real `/api` calls to
break on. Use the VSCode configs for the network/full-stack half; use this tool
for the component / responsive / audit half. Tutorial index:
`merkle/infra/test/tutorials/` (in the merkle repo).

```
┌──────────── debugger UI (http://localhost:6080) ────────────────────────┐
│  toolbar: inspect · theater · viewport presets · auto-zoom                │
│ ┌───────────────────────────────┐ ┌────────────────────────────────────┐ │
│ │  TARGET APP (iframe)           │ │ INSPECTOR                          │ │
│ │  rendered at a chosen viewport │ │  breadcrumb: App › Sidebar › …     │ │
│ │  size, with theater dim +      │ │  [ Tree | Styles | Props | Break-  │ │
│ │  drill-down child highlights   │ │    points | Source ] + audits      │ │
│ │  + zoom-to-component           │ │  matched rules · box model ·       │ │
│ │                                │ │  @media · Monaco editor (save)     │ │
│ └───────────────────────────────┘ └────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
```

## Quick start (Burrow)

Bootstrap once from this directory (the built `ui/dist` is untracked):

```bash
npm install && npm run build
```

Then in Burrow: command palette → **Burrow: Open Frontend Debugger**. The
extension spawns `node server/index.js` as a sidecar (settings under
`burrow.frontendDebugger.*` pick the target project and ports), or **attaches**
to an already-running instance on the UI port. Mode (mock↔live) flips from the
`FE:` status-bar pill; component/CSS reveals open in the Burrow editor.

Logs / status: the "Frontend Debugger" output channel, or
`curl -s localhost:6080/healthz`.

## Quick start (standalone)

Requires Node ≥ 22 and the merkle frontend deps installed
(`cd ~/Projects/merkle/nodewatch/frontend && npm install`).

```bash
npm install
npm run dev          # serves the UI with HMR + starts the instrumented target
# open http://localhost:6080
```

Point it at a different app:

```bash
MERKLE_FRONTEND_DIR=/path/to/app/frontend \
MERKLE_REPO_ROOT=/path/to/app \
TARGET_BASE=/ \
npm run dev
```

## How to use it

The **render owns the whole screen**. The toolbar is hidden — hover the **top
edge** for a moment (or click the `⋯` grip) to reveal it; **pin** it to keep it
open. The inspector is a **floating, draggable, resizable panel** that appears
over the render when you select a component (close it with ✕; it re-opens on the
next selection). This way you edit while seeing the app at its true device size.

There are three modes (top toolbar, or press **P** to toggle Pick, **Esc** for Interact):

1. **Interact** (default): the embedded app is fully live — **navigate between
   pages**, click, type. The debugger doesn't intercept anything. You can still
   select via the **Tree** tab while in this mode.
2. **Pick**: hover to highlight the component under the cursor (with its ancestor
   chain), click to select it. **Right-click** a component to drop into Theater.
3. **Theater + drill-down**: the rest of the app dims, the component is
   spotlighted and zoomed to fit, and its **first-level child components** light
   up as dashed boxes. Click a child to drill in; repeat to a leaf.

**Navigating the recursive component tree** (the reliable part): once anything is
selected, use the inspector's **↑ parent / ↓ child / ‹ › siblings** buttons or the
**arrow keys**, the clickable **breadcrumb** (`App › Sidebar › SidebarTree › …`),
or the **Tree** tab (searchable, click-to-select, hover-to-highlight). Component
identity is a stable fiber path, so selection survives re-renders and route
changes.

4. **Device / responsive mode**: pick a device (phones — iPhone, Pixel, Galaxy;
   tablets — iPad, Galaxy Tab; laptops — MacBook Air/Pro; desktops — 1080p/1440p/4K;
   or NodeWatch's breakpoints) and the app renders at that exact size, centered,
   scaled to fit when larger than the screen. **Rotate** swaps W/H, type a custom
   `W×H`, or **drag the right/bottom/corner handles** on the frame to resize
   freely (Responsive). The matched **@media** rules update live. The selection
   boundary tracks the component when you scroll or resize.
5. **Live CSS edits = preview, not save**: in **Styles**, edit a value — it
   previews live in the page immediately and a banner shows *N live edits — not
   saved*. **Discard** reverts the preview, or **Save to index.css** persists them
   (Vite CSS HMR reflects the saved file). The `↗` opens the exact rule line in
   the **Source** editor. The **Inherited** section lists the rules the element
   inherits from each ancestor (with the file:line it came from — click to open),
   and an **override** button copies a property onto the selected element.
6. **Full-screen styles window + swipe**: the floating panel's **⤢** button makes
   the styles/code panel a full-screen window. Then move between the **Preview**
   and **Styles** windows by: a **two-finger trackpad swipe**, **holding the mouse
   at a screen edge** to reveal a click-arrow (or **dragging in from that edge**),
   the bottom **‹ ›** controls, or **←/→**. **⤡ dock** (or **Esc**) returns to the
   floating panel.
7. **Edit JSX**: the **Source** tab opens the component's `.tsx` (Monaco, with JSX
   enabled) at the right line. Edit, then **Save** (Fast Refresh reloads) or
   **Revert**. Nothing is ever written without an explicit Save.
8. **Route Picker**: the toolbar **`go to ▸ route…`** select jumps the embedded
   app to any NodeWatch page (grouped Primary / Secondary; catalog in
   `ui/src/appRoutes.ts`, mirrored from merkle's `routes.ts`).
9. **Props & hooks**: the **Props** tab shows the selected component's live props
   and its React hooks (state/effect/memo/ref…) read from the fiber.
10. **Audits & Gallery**: **🖼 Gallery** renders the current route at Mobile /
   Tablet / Desktop side-by-side (read-only). **♿ Audit** runs an in-page a11y
   scan (contrast, missing `alt`, unlabeled controls, small tap targets);
   **🎨 Tokens** flags colors that bypass the design-token system. Both open a
   floating results panel with click-to-select on each finding.

## Architecture

Single Node process, two listeners, host-native (spawned by Burrow or run
standalone):

- **`server/index.js`** — starts the instrumented **target** Vite dev server
  in-process (using the *target's own* installed Vite + plugin-react) and serves
  the debugger **UI + write-back API**.
- **`server/inspectorPlugin.js`** — a Vite plugin injected into the target that
  (a) injects the in-page **agent** as the first `<head>` script and (b) stamps
  every host JSX element with `data-inspect-file/line/col/name` via a Babel pass.
  React 19 removed `fiber._debugSource`, so this build-time stamping is how
  DOM → source mapping survives.
- **`agent/agent.js`** — runs inside the target page: installs the React DevTools
  global hook (before React loads), walks the **fiber tree** for the component
  tree + parent/child relationships + bounding boxes, resolves **matched CSS**
  in-page via the CSSOM (incl. `@media` breakpoints), and bridges to the UI over
  `postMessage`.
- **`server/api.js`** — `GET/POST /api/source` (read/write `.tsx`) and
  `POST /api/css/edit` + `GET /api/css/locate` (postcss edits to `index.css`),
  with a path allowlist restricting writes to the target's `src/`.
- **`ui/`** — the React inspector UI (target pane + overlays, tree, styles, box
  model, breakpoints, Monaco source editor).

## Configuration (env)

| var | default | meaning |
| --- | --- | --- |
| `MERKLE_REPO_ROOT` | `~/Projects/merkle` (fallback) | repo root (so `@shared` resolves) |
| `MERKLE_FRONTEND_DIR` | `<root>/nodewatch/frontend` | target Vite project |
| `TARGET_BASE` | `/watch/app/` | target app base path |
| `TARGET_PORT` / `TARGET_PUBLIC_PORT` | `5173` | target port (in-container / browser) |
| `UI_PORT` | `6080` | debugger UI + API port |

## Notes & limits

- The target is launched with `VITE_SKIP_AUTH=1` (auto-enables NodeWatch's
  in-memory mock), so no backend is required.
- Writes are restricted to the target frontend's `src/`. Files are written
  atomically. There is **no** undo — commit/stash before heavy edits.
- The Source editor (Monaco) loads its assets from a CDN on first use, so the
  first source view needs internet (the merkle app already loads web fonts, so
  this matches its environment).
- This is a dev tool — `allowedHosts`/CORS are open and `postMessage` uses `*`.
  Run it locally, not exposed to the internet.
