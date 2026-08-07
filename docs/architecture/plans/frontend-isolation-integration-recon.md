# Frontend component-isolation — recon & integration report

> Goal (user): a Framer-like workbench — a component and its CSS in one subdir, previewed and
> edited **in isolation** with **sample props**, live. The isolation workbench exists
> (commit `8981e5bd`) but real merkle components crash in the preview:
> `useNavigate() may be used only in the context of a <Router> component`. This report is the
> recon needed to integrate it properly: how the harness works, the exact root cause, merkle's
> provider/CSS/mock reality, and a staged plan. All findings are `path:line`-cited.

---

## 1. Executive summary

The isolation preview mounts **one component alone** on a blank canvas wrapped in a *generic*
shell. That shell supplies (at best) a Router and an optional per-project providers module. Real
merkle feature components need **more than a Router** — and the generic Router detection is itself
**broken**. Net effect: any component using a context hook (`useNavigate`, `useToast`, `useAuth0`)
throws on mount. `IncidentsInbox` is a textbook case: all-optional props (mounts bare) but hard-
requires **Router + ToastProvider** and **fetches** on mount.

Two defects + three product gaps:

- **DEFECT A — generic Router detection never runs** ([inspectorPlugin.js:176](../../tools/frontend-debugger/server/inspectorPlugin.js#L176)): the harness imports `react-router-dom` with `/* @vite-ignore */`, so the browser gets a **bare specifier** it can't resolve → `rr = null` → the Router wrapper stays a passthrough → `useNavigate` crashes.
- **DEFECT B — no merkle provider shell**: the harness looks for a per-project `src/burrow.isolate.tsx` ([inspectorPlugin.js:255-260](../../tools/frontend-debugger/server/inspectorPlugin.js#L255-L260)) but merkle doesn't ship one, so `ToastProvider` (the **most-used** context, 35 files), Auth0, and the fetch mock are all absent.
- **GAP 1 — sample props aren't first-class** (Framer's core feature): props are a single JSON textarea seeded from a live capture; there is no per-component named-sample convention.
- **GAP 2 — no component gallery/browser**: you can only isolate the *currently selected/open* component; there's no "browse all components and preview one."
- **GAP 3 — colocation nuance**: merkle's components do **not** import their own CSS (styles are global-only, enforced by a test). The user's "component + CSS in one subdir" is already true *on disk*, but the mental model differs from how styles load. The harness already handles this correctly (it imports `index.css`); this is a documentation/UX point, not a defect.
- **GAP 4 — surface/windowing ("code-like tab")**: the debugger opens as an **editor-area webview tab** (`ViewColumn.Active`), so it competes with source tabs and reads as "just another file." A full-screen path exists but is opt-in. **§8** lays out options for a proper, prominent surface.

**Good news:** the styling side already works (the harness imports `src/index.css`, [inspectorPlugin.js:261-267](../../tools/frontend-debugger/server/inspectorPlugin.js#L261-L267)), and `IncidentsInbox`'s props are all-optional — so once the **providers + mock** are supplied, it renders with zero sample props. The single highest-leverage fix is one new merkle file (`src/burrow.isolate.tsx`).

---

## 2. How the isolation harness works today

Two halves — a target-Vite middleware (the preview) and a Burrow extension (the editor+webview layout).

### 2a. The preview harness — `tools/frontend-debugger/server/inspectorPlugin.js`

The `inspectorPlugin` (injected into the target's own in-process Vite) serves an isolation entry at
`<base>__isolate?module=<src/…>&export=<Name>&props=<json>` ([configureServer, :227-276](../../tools/frontend-debugger/server/inspectorPlugin.js#L227-L276)):

1. `safeSrcRel` confines `module`/providers paths to the target's `src/` ([:93-99](../../tools/frontend-debugger/server/inspectorPlugin.js#L93-L99)).
2. It assembles `cfg = { base, module, export, props, providers, css }` — `providers` = first of `src/burrow.isolate.{tsx,jsx,ts,js}` that exists; `css` = first of `src/index.css|main.css|styles.css|App.css|global.css` ([:250-268](../../tools/frontend-debugger/server/inspectorPlugin.js#L250-L268)).
3. `buildIsolateHtml(cfg)` returns an HTML doc whose inline `<script type="module">` ([:137-210](../../tools/frontend-debugger/server/inspectorPlugin.js#L137-L210)):
   - **statically** imports `react` + `react-dom/client` (Vite's `transformIndexHtml` rewrites these bare imports to the optimized dev deps — same instances as the app);
   - builds a generic `Router` by **dynamically** importing `react-router-dom` via `loadOptional` ([:145](../../tools/frontend-debugger/server/inspectorPlugin.js#L145), [:176-177](../../tools/frontend-debugger/server/inspectorPlugin.js#L176-L177));
   - builds `Providers` from the per-project module if present ([:180-185](../../tools/frontend-debugger/server/inspectorPlugin.js#L180-L185));
   - imports `CFG.css` for global styles ([:187](../../tools/frontend-debugger/server/inspectorPlugin.js#L187));
   - dynamically imports the component module (`BASE + CFG.module`), picks the export ([:189-191](../../tools/frontend-debugger/server/inspectorPlugin.js#L189-L191)), and renders `Boundary > Router > Providers > Comp(props)` in a `createRoot` ([:194-196](../../tools/frontend-debugger/server/inspectorPlugin.js#L194-L196));
   - a React error boundary + `postMessage({__burrowIso:1,type:'renderError'|'ready'})` surface failures ([:147-155](../../tools/frontend-debugger/server/inspectorPlugin.js#L147-L155), [:197](../../tools/frontend-debugger/server/inspectorPlugin.js#L197));
   - a `message` listener applies live prop edits (`{__burrowIsoCmd:1,type:'props'|'reload'}`) and re-renders ([:199-204](../../tools/frontend-debugger/server/inspectorPlugin.js#L199-L204)).
   - `server.transformIndexHtml(url, html)` runs it through Vite → HMR client injected, bare imports rewritten ([:273](../../tools/frontend-debugger/server/inspectorPlugin.js#L273)).

**Editing the component → Vite Fast Refresh → the preview re-renders.** Colocated CSS edits propagate through the global manifest (see §4c).

### 2b. The editor+preview layout — `extensions/burrow-frontend-debugger/src/isolation.ts`

`openIsolation` opens the component's **real source** in editor column One and an **isolated preview
webview** Beside it ([:46-82](../../extensions/burrow-frontend-debugger/src/isolation.ts#L46-L82)). The webview is a slim shim: a toolbar (name, Reload, **Props** editor) over an iframe pointed at the target's `__isolate` URL ([buildPreviewHtml, :149-214](../../extensions/burrow-frontend-debugger/src/isolation.ts#L149-L214)). Props are seeded from a live capture, `sanitizeProps` strips function/element placeholders ([:111-123](../../extensions/burrow-frontend-debugger/src/isolation.ts#L111-L123)), and the Props panel pushes JSON edits down over `postMessage` ([:197-204](../../extensions/burrow-frontend-debugger/src/isolation.ts#L197-L204)). Triggered by the inspector's **⛶ isolate** button ([Inspector.tsx:190](../../tools/frontend-debugger/ui/src/components/Inspector.tsx#L190)) or the `burrow.frontendDebugger.isolate` command ([extension.ts:81](../../extensions/burrow-frontend-debugger/src/extension.ts#L81)).

---

## 3. Root cause of the `useNavigate` crash

`loadOptional(spec)` is `import(/* @vite-ignore */ spec)` ([:145](../../tools/frontend-debugger/server/inspectorPlugin.js#L145)). `@vite-ignore` tells Vite **not** to transform the specifier, and `spec` is a runtime variable, so for `loadOptional('react-router-dom')` ([:176](../../tools/frontend-debugger/server/inspectorPlugin.js#L176)) the string `'react-router-dom'` reaches the browser **verbatim** — a **bare specifier browsers cannot resolve** → the import rejects → `rr = null` → `Router` stays `props => props.children` → the component mounts with **no Router** → `useNavigate()` invariant fires.

Why the *component* still loads: it's imported by **URL** (`BASE + CFG.module`), and when Vite serves that module it rewrites the component's *own* `react-router-dom` import to the optimized `.vite/deps` copy. So the component is fine; only the harness's separate attempt to grab `react-router-dom` fails. (This is also why a naive "just static-import react-router-dom" would still need to resolve to that **same** optimized instance, or React Router's context object won't match — the classic dual-instance trap.)

**Even with Defect A fixed, a bare Router is not enough for merkle** — see §4.

---

## 4. merkle's reality (what the shell must reproduce)

Base: `~/Projects/merkle/nodewatch/frontend` (`@` → its `src/`; `@shared` → `~/Projects/merkle/shared`).

### 4a. Provider stack — `src/main.tsx:119-150` (main app tree)

Outermost → innermost: `StrictMode` → **`Auth0Provider`** (`@auth0/auth0-react`; domain/clientId from `@shared/auth-config`) → `AuthGuard` (`@shared`) → `ErrorBoundary` (`@shared`) → **`ToastProvider`** (`@shared/index`; optional `storageKey`/`centerPolicy`) → **`BrowserRouter`** (react-router-dom v7, **no basename**) → `App`. `App` itself calls `useLocation`/`useSearchParams` immediately.

### 4b. Which context hooks components depend on (non-test files; 228 `.tsx` total)

| Hook | Source | Files | Meaning for the shell |
|---|---|---|---|
| **`useToast`** | `@shared/index` | **35** | **must** provide `ToastProvider` (the #1 dependency) |
| **any react-router hook** | react-router-dom | **28** | must provide a Router (`useNavigate` 21, `useParams` 10, `useLocation` 5, `useSearchParams` 4) |
| `useAuthed` | `@/lib/useAuthed` | 11 | wraps `useAuth0`; returns true under `VITE_SKIP_AUTH=1` |
| `useAuth0` | `@auth0/auth0-react` | 10 | need an Auth0 context (real or stub) or the hook throws |
| `useApiToken` | `@shared` | 1 (App only) | wires the token getter once; calls `useAuth0` |

`IncidentsInbox` uses `useNavigate`/`useParams` ([IncidentsInbox.tsx:120-121]) + `useToast` ([:119]) and fetches `getIncidents` ([:5]).

### 4c. CSS architecture — **global-only, enforced** (critical nuance)

The user's "component + CSS in one subdir" **is already the on-disk reality**: e.g. `src/escalation/incidents-inbox/` holds `IncidentsInbox.tsx` + `incidents-inbox.css` + `.test.tsx`. **But:**

- **214 `.css` files, zero imported by a component.** `src/index.css` is a **213-line `@import` manifest** that inlines every colocated stylesheet in a load-bearing cascade order (`incidents-inbox.css` at `index.css:197`).
- `src/test/css-architecture.test.ts` **enforces** that only `src/main.tsx` and `src/harness/main.tsx` import CSS, and only `src/index.css`. A prior "components import their own CSS" refactor (post-mortem `9c7f47a`) put shared-primitive styles in lazy chunks → unstyled renders.
- **Implication:** a component mounted in isolation has **zero styles unless `src/index.css` (the whole cascade) is imported** — which the harness already does ([:261-267](../../tools/frontend-debugger/server/inspectorPlugin.js#L261-L267)). ✅ So styling works today. **Do not add a component-level CSS import** — it breaks the css-architecture test. Editing a colocated `.css` still hot-reloads because the manifest imports it.

### 4d. Exports & props

Overwhelmingly `export default function X({…}: Props)` with a named `interface Props` just above (feature components, pages, modals); **settings cards** are named exports (`export function OrgMembersCard`). Many top-level feature components have **all-optional props** → mount bare. `IncidentsInbox`: `export default`, `Props = { rules?: AlertRule[]; onViewPolicy?: (id)=>void }` — both optional.

### 4e. Auth + fetch mock (already half-wired)

- The FD sidecar **already sets `VITE_SKIP_AUTH=1`** ([targetServer.js:28](../../tools/frontend-debugger/server/targetServer.js#L28)). Under it: `useAuthed` returns true, `AuthGuard` renders through, the API client sends no token/org header. **But `AuthGuard`/`useAuthed`/`useApiToken` still call `useAuth0()` unconditionally** → an Auth0 context (real or stub) must exist in the tree.
- **`installDevMock()`** (`src/lib/devMock.ts`) is a `window.fetch` interceptor serving hardcoded fixtures when `VITE_SKIP_AUTH=1` — installed in `main.tsx` **before** render. Fetching components (like `IncidentsInbox`) need this or they error on the first `fetch`.

### 4f. The existing `/harness.html` gallery (precedent, not reusable as-is)

`src/harness/{main.tsx,gallery.tsx}` imports `../index.css` (the pattern the isolation harness already uses), installs a *small* bespoke fetch mock, and wraps **only individual demos** in `MemoryRouter` where needed. It's a **DS-primitive** gallery with **hard-coded inline demo data** — no reusable "wrap a feature component in the real providers + typed sample props" mechanism. It confirms the `MemoryRouter`-wrap precedent but is not the shell we need.

---

## 5. Integration design

### FIX 1 (primary) — ship merkle `src/burrow.isolate.tsx` (the provider shell)

One new file in merkle is the highest-leverage fix; the harness already imports it. It should:

1. **Install the fetch mock** as an import side-effect (so fetching components get fixtures):
   ```tsx
   import { installDevMock } from '@/lib/devMock'
   installDevMock()   // idempotent-guard inside, or wrap in a "once" check
   ```
2. **Export a `Providers` (or default) component** wrapping the real contexts, innermost matching merkle's tree order:
   ```tsx
   import { MemoryRouter } from 'react-router-dom'
   import { ToastProvider } from '@shared/index'
   export default function Providers({ children }: { children: React.ReactNode }) {
     return (
       <FakeAuth0Provider>            {/* §5 decision — stub vs real */}
         <MemoryRouter initialEntries={['/']}>
           <ToastProvider>{children}</ToastProvider>
         </MemoryRouter>
       </FakeAuth0Provider>
     )
   }
   ```
   The harness then renders `Router(passthrough) > Providers > Comp` — so `MemoryRouter`+`ToastProvider` are present and `IncidentsInbox` renders. **No harness change strictly required** for merkle to work.
   - **Auth0 decision (needs your call):** a **stub Auth0 context** (`isAuthenticated:true`, `isLoading:false`, no-op `getAccessTokenSilently`) is more robust for isolation — no network, and components that read `useAuth0()` directly render in their *signed-in* state. A **real `Auth0Provider`** is one line but does a session check on mount (network) and leaves `isAuthenticated:false` (signed-out visuals) absent a session. Recommendation: **stub**, colocated in `burrow.isolate.tsx`.
   - This file is **dev-only** (never imported by the prod build). Confirm it doesn't trip the css-architecture test (it imports no CSS) or the harness allowlist (it lives in `src/`).

### FIX 2 — make the harness's generic Router detection actually work (out-of-the-box)

So router apps isolate correctly **without** a per-project module. Resolve `react-router-dom` **through
Vite** instead of as a bare specifier. Cleanest: resolve it server-side and pass a URL:

- In `configureServer`, `server.pluginContainer.resolveId('react-router-dom')` (or `server.moduleGraph`) → the optimized dep id → add `cfg.routerUrl`; the harness does `import(BASE-relative or absolute routerUrl)` (a URL, not a bare specifier).
- Or: emit the router import as a **static** import in the harness only when detected, and let `transformIndexHtml` rewrite it. Guarding a static import is harder; the server-resolve approach is preferred.
- When a `providers` module already supplies a Router, **skip** the generic one (avoid nested routers) — track via a `cfg.hasProviders` flag.
- Same latent bug affects `loadOptional(BASE + CFG.providers)` and `loadOptional(BASE + CFG.css)` — those use **URLs**, so they're fine; only bare specifiers break.

### FIX 3 (Framer parity) — first-class **sample props**

Today: one JSON textarea seeded from a live capture. Target: **named sample sets per component**, editable, persisted.

- **Convention:** a colocated `<Component>.samples.ts` (or a `samples` named export on the component module) exporting `Record<string, Props>` — e.g. `{ empty: {}, withRules: { rules: [...] } }`. Typed against the colocated `interface Props`.
- **Harness:** if a samples module resolves, load it; the preview toolbar gains a **sample picker** (dropdown) beside the Props editor; picking one sets `props` and re-renders (reuse the existing `{__burrowIsoCmd:1,type:'props'}` path). Editing in the JSON panel forks from the selected sample.
- **Persistence:** write edited samples back via the sidecar's allowlisted `POST /api/source` to the `.samples.ts` file (opt-in "Save sample"), so a curated sample becomes durable — the Framer "set sample props once" workflow.
- **Live capture still seeds** the first sample when no samples file exists (today's behavior as the zero-config default).
- **Oracle:** any new agent command/event or route lands with its `.claude/memory/*.yaml` row (`npm run oracle` = 0 FAIL).

### FIX 4 (Framer parity) — a **component gallery / browser**

So you can *browse* components, not just isolate the open one.

- **Index:** a sidecar endpoint (e.g. `GET /api/components`) walks `src/**` for default-/named-exported components + colocated `.css` + `.samples.ts`, returning `{ name, file, export, hasSamples }[]`. (Confine to `src/`, mirror `safeSrcRel`.)
- **UI:** a gallery panel in the FD UI (grid of components; click → isolate). Reuse the existing isolate flow. Optionally group by `<feature>` dir (matches merkle's layout).
- This is the biggest new surface; stage it **after** FIX 1–3 prove the single-component path.

### Colocation UX (GAP 3) — mostly documentation

The user's "component + CSS in same subdir" is already merkle's layout. The one surprise is that **components don't import their CSS** (global manifest). The isolation harness handles it (imports `index.css`), so **no code change** — but the workbench should **document** this so editing `incidents-inbox.css` (which hot-reloads via the manifest) is understood, and should **not** offer a "extract CSS to component import" affordance (it would break the css-architecture test).

---

## 6. Staged plan (each independently verifiable; FD oracle 0 FAIL on every FD change)

| # | Change | Files | Verify |
|---|---|---|---|
| **W1** | **merkle provider shell** (unblocks everything) | NEW `~/Projects/merkle/nodewatch/frontend/src/burrow.isolate.tsx` (MemoryRouter + ToastProvider + Auth0 stub + `installDevMock()`) | Isolate `IncidentsInbox` → renders (no `useNavigate` crash), toasts work, fetch returns fixtures. Merkle build + css-architecture test still pass. |
| **W2** | **Harness Router fix** (out-of-the-box) | `server/inspectorPlugin.js` (server-resolve `react-router-dom` → `cfg.routerUrl`; skip generic Router when `providers` present) | Isolate a router component in a project **without** `burrow.isolate.tsx` → renders. FD `npm run build` + `npm run oracle` 0 FAIL. |
| **W3** | **Sample props** | `server/inspectorPlugin.js` (+samples resolve), `extensions/.../isolation.ts` + preview shim (sample picker), optional `POST /api/source` save; memory yaml | Isolate a component with a `.samples.ts` → picker switches states; edit+save persists. Oracle 0 FAIL. |
| **W4** | **Component gallery** | sidecar `GET /api/components` (`server/api.js` + `routes.yaml`), FD UI gallery panel (+`components.yaml`) | Browse → click → isolate. Oracle 0 FAIL; Playwright `npm run verify`. |
| **W5** | **Docs** | FD `.claude/docs` / `docs/frontend-migration` | The colocation/global-CSS model + the `burrow.isolate.tsx` contract documented. |

Land W1 first (one file, immediate unblock), then W2 (robustness), then W3/W4 (the Framer feel).

---

## 7. Open decisions for you

1. **Auth0 in isolation — stub or real?** Recommend a **stub** (no network, always signed-in visuals). A real `Auth0Provider` is simpler to write but does a session check and renders signed-out without a session.
2. **Where does `burrow.isolate.tsx` live / who owns it?** It's a merkle source file (dev-only). OK to add it to merkle, or would you rather the harness inject a merkle-specific shell it ships itself (keeps merkle clean but couples the tool to merkle)? Recommend the merkle file — it's the documented, generic extension point and stays with the app it describes.
3. **Sample-props convention:** colocated `<Component>.samples.ts` (recommended — matches your one-dir-per-component goal) vs a central registry vs a `samples` export on the component. 
4. **Gallery scope now or later?** W4 is the largest; fine to defer until single-component isolation feels right.
5. **Fetch mock default:** always `installDevMock()` in the shell (fixtures), or make it toggle with the existing MOCK↔LIVE mode so isolated components can hit the real dlv-debugged backend? (Live mode + isolation = a powerful combo but needs the backend up.)
6. **Surface/windowing (§8):** how prominent should the debugger be — maximize-in-place (cheapest), a dedicated maximized source|preview layout (recommended default for the isolation workbench), a **separate OS window** (the "whole screen" option), or a core-patched dedicated workbench mode (heaviest)? Pick the default + which extras to offer.

---

## 8. Surface & windowing (the "code-like tab" problem)

You flagged that the frontend debugger "being a code-like tab" is unsatisfying and want it to "take
up the whole screen or whatever." This is the **surface** layer — separate from the isolation
mechanics above. Here's exactly what it does today and the options.

### 8a. Current implementation

There are **two** webview surfaces, both in the **editor grid** (which is why they read as "code tabs"):

1. **The main debugger panel** — `openPanel` creates a webview **as an editor tab** in the active column: `vscode.window.createWebviewPanel('burrow.frontendDebugger', 'Frontend Debugger', vscode.ViewColumn.Active, { enableScripts, retainContextWhenHidden })` ([panel.ts:42-47](../../extensions/burrow-frontend-debugger/src/panel.ts#L42-L47)). It iframes the whole FD SPA. So it lives **beside your source tabs, same size, same chrome** — indistinguishable from a file.
2. **The isolation preview** — `openIsolation` opens the component's **real source in `ViewColumn.One`** and the **preview webview in `ViewColumn.Beside`** ([isolation.ts:53-81](../../extensions/burrow-frontend-debugger/src/isolation.ts#L53-L81)) — a 2-column editor layout, but still ordinary editor tabs.

A **full-screen path already exists** but is **opt-in from inside the SPA**: the SPA's fullscreen button posts `setFullScreen`, and the extension runs `workbench.action.maximizeEditorHideSidebar` + `workbench.action.closePanel` (restored on exit / dispose) — `panel.ts` `setEditorFullScreen` + the `maximized` flag ([panel.ts:34,50-55](../../extensions/burrow-frontend-debugger/src/panel.ts#L34)). So today: it opens as a normal tab, and you must click the in-SPA fullscreen toggle to make it fill the window.

**Why it feels "code-like":** it's a `WebviewPanel` in the editor area — the same container as text editors — with default sizing. Nothing signals "this is a dedicated tool surface."

### 8b. Options (all Layer-4 unless noted)

| Option | What it is | Effort | Trade-off |
|---|---|---|---|
| **A. Maximize on open** | Call the existing `setEditorFullScreen(true)` when the panel opens (hide side bars + panel, maximize the group) — a setting `burrow.frontendDebugger.openMaximized` (default on). | **Tiny** (reuse existing code) | Still a tab, but fills the screen immediately. Esc / toggle restores. |
| **B. Dedicated source \| preview layout, maximized** *(recommended for isolation)* | `openIsolation` sets a 2-column editor group (slim source left, large preview right), maximizes it, hides side bars — a purpose-built "design mode." Optionally lock the split ratio. | **Small** (isolation.ts already does 2-col; add maximize + ratio) | The Framer feel: code + canvas, nothing else. A toggle returns to normal. |
| **C. Separate OS window** *(the "whole screen" option)* | Move the panel/preview into its own **auxiliary window** via `workbench.action.moveEditorToNewWindow` (VS Code 1.128 supports floating editor windows). The debugger lives on its **own screen/monitor**, fully separate from code. | **Small–Med** (a command + wiring; webview reparenting caveats to verify) | True full-screen, multi-monitor friendly; the most literal "whole screen." Slightly more moving parts (window lifecycle). |
| **D. Activity-bar viewlet / secondary side bar** | Make the FD a left/right **view** like Docker/Database. | Med | **Wrong aspect** for a big component canvas — a narrow column. Good only for *controls* (a component list), not the preview. Could pair with A/B: list in the side bar, canvas in the editor. |
| **E. Bottom panel** (Terminal-style) | Host it in the bottom panel. | Med | Wrong aspect ratio for a preview; rejected. |
| **F. Dedicated workbench "Frontend" mode** | A **core patch** that gives Burrow a full-page frontend surface (its own part), like a mode switch. | **Large — L3 core patch + ledger** | Most "integrated," least lean; overlaps the task-03 scheme-bar/UX work. Defer unless you want a first-class mode. |
| **G. Layout preset** | Save/restore a named editor layout ("Design": preview big, source slim, chrome hidden) toggled by a command. | Small | Composes with B; a lighter, user-toggleable version. |

### 8c. Recommendation

Lean, layered, all pure Layer-4 — no core patch:

1. **Default the isolation workbench to Option B** — open **source | preview maximized** with side bars hidden (a dedicated "design mode"), with an Esc/toggle back to the normal layout. This directly answers "component code beside preview, filling the screen, like Framer."
2. **Default the main whole-app panel to Option A** — `openMaximized` on (setting to disable), reusing the existing full-screen code so it fills the window instead of sitting as a small tab.
3. **Offer Option C as an explicit action** — a "Open in New Window" command for a truly separate, whole-screen surface (great on a second monitor). Verify webview reparenting behaves across auxiliary windows before committing it as default.
4. **Defer Option F** (core-patched dedicated mode) unless you decide the frontend workbench deserves a first-class Burrow "mode"; it's the only option that isn't Layer-4.

**Windowing is independent of the isolation fixes (§5).** It can land as its own small WO (**W6**) — a setting + reusing `setEditorFullScreen` + the 2-column maximize in `isolation.ts` + an optional "new window" command — verified live via the launch skill (open the panel → confirm it maximizes / opens in its own window). No merkle changes, no oracle impact beyond the FD build.
