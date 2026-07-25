# Burrow — Complete Project Dossier

_A single-file export: build report + the full 15-task architecture plan + the
fork's reference docs (upstream pin, strip ledger, patch ledger). Generated
2026-07-13. Burrow is a host-native Go-first IDE — a fork of Code - OSS
(VS Code) 1.128.0 — replacing the old container `backend` debugger._

---

## Table of contents

**Part I — Where things stand**
- [1. Build Report](#1-build-report)

**Part II — The plan (tasks 00–14)**
- [2. Overview](#2-overview)
- [3. Task 01 — Fork bootstrap & branding](#3-task-01)
- [4. Task 02 — Strip to Go-only](#4-task-02)
- [5. Task 03 — Go toolchain first-class](#5-task-03)
- [6. Task 04 — Delve debugging engine](#6-task-04)
- [7. Task 05 — Debug panel (right) redesign](#7-task-05)
- [8. Task 06 — Go value visualizers](#8-task-06)
- [9. Task 07 — Go docs hover→fullscreen](#9-task-07)
- [10. Task 08 — Oracle codebase notes](#10-task-08)
- [11. Task 09 — HTTP workbench](#11-task-09)
- [12. Task 10 — Database explorer](#12-task-10)
- [13. Task 11 — First-class tests](#13-task-11)
- [14. Task 12 — Design system](#14-task-12)
- [15. Task 13 — Packaging, signing, updates](#15-task-13)
- [16. Task 14 — Stack migration](#16-task-14)

**Part III — Fork reference**
- [17. README](#17-readme)
- [18. UPSTREAM (pin & rebase)](#18-upstream)
- [19. STRIP ledger](#19-strip)
- [20. Patch ledger](#20-patches)

---

<a id="1-build-report"></a>

# 1. Build Report


> _source: `.claude/docs/burrow-build-report.md`_

### Burrow — Build Report

_Generated 2026-07-13. Snapshot of everything built so far on **Burrow**, the
host-native Go-first IDE that replaces the container `backend` debugger._

---

#### Note: the architecture plan was salvaged into the fork

`backend/` was deleted, restored, and deleted again — but its **master plan was
salvaged first**. The full 15-task Burrow plan (`00-overview.md` + tasks 01–14:
Delve engine, debug inspector, visualizers, Go docs, Oracle, HTTP workbench, DB
explorer, tests, design system, packaging, cutover) now lives **inside the fork**
at **`burrow/docs/architecture/`**. The old container `backend/` folder itself is
gone for good.

---

#### What Burrow is

A native macOS Go IDE + debugger, built as a **fork of Code - OSS (VS Code)
1.128.0**, stripped down to Go development and rebuilt around:

- first-class Delve debugging with a right-hand Miller-column inspector,
- Go data-structure visualizations,
- an integrated Postman-style HTTP workbench,
- a pgAdmin-style DB explorer,
- offline Go docs (hover → fullscreen),
- an agent-bootstrapped codebase "Oracle" (no integrated AI — initial-run agent
  instructions only),
- Xcode-like minimalist design (everything non-Go removed).

It **replaces** the old container-based "backend debugger" (code-server in the
Docker stack). Old vs new — task 14 was to retire the old `ide` container once
Burrow ships. (That old backend is now deleted.)

##### Location & repo shape

- Lives at **`~/Projects/debugger/burrow/`** (moved in-tree 2026-07-13 from the
  old `~/Projects/burrow`).
- It is a **nested independent git repo** — 4.5 GB, own history, branches
  `main` (Burrow work) + `upstream-v1.128` (pristine tag), `origin` →
  microsoft/vscode for rebasing onto future releases.
- `debugger/` itself is **not** git-initialized. If it ever is, `burrow/` must
  be gitignored or added as a submodule (nested `.git`).

##### Four change layers (the fork discipline)

1. **Config** — `product.json` (Burrow identity, kill-switches).
2. **Deletions** — removed built-in extension dirs.
3. **Core patches** — numbered ledger under `patches/NNNN-*.md` (enforced by
   `build/burrow/check-ledger.js`).
4. **Built-in extensions** — `extensions/burrow-*` (where most new code lands).

---

#### Task 01 — fork bootstrap & branding ✅ done + verified

- Fork pinned to upstream **1.128.0** (`UPSTREAM.md`).
- Burrow identity in `product.json`; telemetry / voice endpoints removed.
- Governance scaffolding: patch ledger, `BUILDING.md`, third-party notices,
  `Makefile`.
- First built-in extension **`extensions/burrow-core`** (patch `0001`).
- `npm ci` + build + branded **"Burrow — Go IDE.app"** boots; `burrow-core`
  activates on `onStartupFinished`.

---

#### Task 02 — strip to Go-only ✅ bulk done + boot-verified

**Inventory & ledger.** `tools/inventory.js` (ESM) joins an explicit `DECISIONS`
keep/remove map against every `extensions/*/package.json` and emits `STRIP.md`.
It runs as both planner (before) and verifier (after) — flags a vanished keeper,
exits non-zero on anything unclassified. Result: **32 keep / 64 remove**.

**Deleted 64 built-in extension dirs (99 → 35 on-disk):** all non-Go languages,
web (html/css/emmet/less/scss), notebooks (ipynb, notebook-renderers), JS
task-runners (grunt/gulp/jake/npm), accounts/remote (github+auth, ms-auth,
tunnel-forwarding), the Node auto-attach debugger, copilot, and 9 surplus stock
themes. Kept: go, git(+base), the json/yaml/sql/docker/shell/make/ini/dotenv/
markdown/log grammars, references-view, merge-conflict, terminal-suggest,
media-preview, debug-server-ready, theme-defaults+seti (interim until the design
task). Dependency audit first confirmed no keeper depends on a removed one.

**Re-wired the build (patches 0001/0002).** Three **hardcoded lists** name
extension dirs and break the build if left stale — pruned each in lockstep:
1. `compilations` in `build/gulpfile.extensions.ts` (TS compile — ~42 → 22),
2. `esbuildMediaScripts` in `build/lib/extensions.ts` (webview/notebook esbuild),
3. copilot npm scripts in root `package.json` + the copilot check in
   `build/hygiene.ts`.
(Packaging itself auto-globs `extensions/*/package.json`, so only these three
bite. `git rm -r` also leaves untracked `out/`/`node_modules/`/`dist` behind —
`rm -rf`'d the leftovers.)

**product.json:** dropped the three js-debug `builtInExtensions` (Delve is the
only debugger aboard); cleared `builtInExtensionsEnabledWithAutoUpdates` and
`trustedExtensionAuthAccess`.

**Leaf workbench-contribution strips (patch 0003).** Contributions are
registered by side-effect `import` in the workbench entry points. Commented out
surveys/NPS, issue reporter, remote-tunnel, and settings-sync UI in
`workbench.common.main.ts` + `workbench.desktop.main.ts` (7 imports). Boot-
verified gone from the bundle.

**Burrow baseline defaults** via `burrow-core` `configurationDefaults` (layer 4,
no patch): bash terminal on osx/linux, `editor.minimap.enabled:false`,
`workbench.welcomePage.experimentalOnboarding:false`,
`chat.commandCenter.enabled:false`.

**Verified:** `npm run compile` → **0 errors**. Dev boot: clean 10-process tree,
extension host up, `burrow-core` activates, **zero removed extensions
registered**, no errors.

##### Task 02 — what remains (sub-tasks 3–7)

- [ ] Non-leaf contribution strips: marketplace/extensions-view (browse/install/
      sideload), `contrib/remote`, `contrib/notebook` core, walkthroughs/
      getting-started.
- [ ] Settings-surface pruning; command-palette + menu-bar audit.
- [ ] Startup-budget numbers (needs a stock VS Code baseline boot to compare).
- [ ] Terminal PATH-inheritance polish.

##### Deferred as its own task — full Copilot/chat excision

This upstream is **chat-centric**: `product.defaultChatAgent` is **load-bearing**
— removing it crashes core services at startup (`welcomeOnboarding` module-level
`assertDefined`, then `defaultAccount.ts` reading `.chatExtensionId`). So the
copilot *extension dir* is deleted but the `defaultChatAgent` *config is kept* so
the app boots. Fully excising chat (config + `src/vs/workbench/contrib/chat` +
the second `src/vs/sessions/*` entry point + `@github/copilot*` /
`@vscode/copilot-api` deps + Azure copilot CI) is a substantial follow-on.

---

#### Later tasks (03–14) — NOT started; specs live in `burrow/docs/architecture/`

The Go toolchain/scheme bar, Delve engine, right-hand debug inspector,
visualizers, Go docs viewer, Oracle, HTTP workbench, DB explorer, first-class
tests, design system, packaging, and the stack cutover. Their detailed specs
were salvaged from the deleted `backend/` and now live at
[`burrow/docs/architecture/`](../../burrow/docs/architecture/00-overview.md).

---

#### Build & launch (quick reference)

Requires Node **24.17.0**, installed outside Homebrew at
`~/.local/burrow-node/current/bin` (brew was broken).

```sh
cd ~/Projects/debugger/burrow
export PATH="$HOME/.local/burrow-node/current/bin:$PATH"
node -v            # v24.17.0
make deps          # first time — npm ci (Electron + native, slow)
make dev           # compile if needed, launch "Burrow — Go IDE"
make dist          # gulp package → .build/electron/Burrow — Go IDE.app
```

**Gotchas** (from `burrow/README.md` + memory):
- Launch from a **normal Terminal**, not VS Code's — the integrated terminal
  exports `ELECTRON_RUN_AS_NODE`/`VSCODE_*` which boot Electron as plain Node and
  crash (`… does not provide an export named 'Menu'`). Scrub first if you must.
- Keep `--user-data-dir` short (e.g. `/tmp/bw`) — the macOS 103-char
  unix-socket limit overflows under deep paths.
- Don't boot the instant compile finishes — `gulp compile` flushes `out/` for a
  beat after exit; booting mid-flush dies with `ERR_MODULE_NOT_FOUND
  performance.js`. Let `out/` settle; give the boot ~40s to reach 10 procs.

---

#### Git / commit state

**Nothing is committed.** Task 01 + task 02 sit in burrow's `main` working tree
for review (per the commit-only-when-asked rule). `STRIP.md` carries the grouped
bisectable `strip:` commit plan. Ledger: patches 0001 / 0002 / 0003.

#### Source-of-truth files

| File | What |
|------|------|
| `burrow/docs/architecture/` | **the full 15-task plan (00–14)** — salvaged from deleted `backend/` |
| `burrow/README.md` | status + launch |
| `burrow/UPSTREAM.md` | upstream pin + rebase procedure |
| `burrow/BUILDING.md` | toolchain notes |
| `burrow/STRIP.md` | keep/remove ledger + commit plan |
| `burrow/patches/000{1,2,3}-*.md` | core-source patch ledger |
| `burrow/extensions/burrow-core/` | first built-in extension + defaults |
| `.claude/memory/burrow-go-ide-fork.md` (user memory) | durable gotchas |
| **this report** | high-level snapshot |


---

<a id="2-overview"></a>

# 2. Overview


> _source: `burrow/docs/architecture/00-overview.md`_

### 00 — Overview: the Go IDE overhaul

The backend debugger stops being a browser IDE in a container. It becomes a
**native, Go-first IDE + debugger** — a VS Code (Code - OSS) fork that runs on
the host, with first-class Go/Delve debugging, Go data-structure visualization,
an integrated HTTP workbench (Postman-class), a database explorer
(pgAdmin-class), offline Go docs, and an agent-bootstrapped codebase Oracle.
Everything that doesn't serve Go development is removed.

Working title: **Burrow** (a gopher lives in one). The name is a one-line
`product.json` change — bikeshed later.

#### Why a fork (alternatives considered)

| Option | Verdict |
|--------|---------|
| Keep code-server | Rejected: web IDE in a container; user wants host-native backend dev. Proxy/port pain (see the `PORT` collision incident) is structural. |
| Tauri + custom editor | Rejected: rebuilding an editor, LSP client, DAP client, terminal, and extension surface is years of work before feature #1. |
| Eclipse Theia | Rejected: same web-first architecture, smaller ecosystem, still not "beautiful like Xcode". |
| **Fork Code - OSS** | **Chosen**: MIT-licensed, battle-tested editor/DAP/LSP/terminal core; we delete instead of build, and put our features in built-in extensions. |

#### Fork strategy — the four change layers

The single biggest risk of a VS Code fork is upstream drift. Every change we
make lives in exactly one of four layers, ordered cheapest-to-rebase first:

1. **Configuration** — `product.json`, build flags. Branding, marketplace off,
   telemetry off. Zero source diff.
2. **Deletions** — built-in extensions and workbench contributions removed.
   Mechanical, conflict-free on rebase (deleted files stay deleted).
3. **Core patches** — small, numbered, documented diffs in a `patches/` ledger
   (default layout, debug-view redesign hooks, docs overlay host). Target:
   **< 15 patches, each < 300 lines**. Anything bigger must move to layer 4.
4. **Built-in extensions** — where ~80% of new code lives (`extensions/burrow-*`).
   Written against the stable extension API, insulated from upstream churn.

Rebase cadence: pin to one upstream stable minor; rebase quarterly, not monthly.

#### Where the code lives

A VS Code fork cannot be *vendored* (tracked as content) into this repo — it
keeps its own git history and an `origin`→vscode remote so it can rebase onto new
VS Code releases. It lives at **`debugger/burrow/`** as a **nested independent
git repo** (its `.git` stands alone; if this repo is ever git-initialized, add
`burrow/` to `.gitignore` or make it a submodule). `debugger/backend/` shrinks to
integration glue: these docs, the oracle bootstrap prompts, and the compose
migration (task 14). The current code-server `ide` container **keeps running as
the fallback until task 14 cuts over** — no gap in the stack.

#### Product principles

- **Go-first, Go-only.** `go.mod` is the project model. No polyglot ambitions.
- **Minimal.** Every surviving menu item, view, and setting must justify itself
  for Go backend work. Default answer is "remove".
- **Native + beautiful.** Host app, macOS-first, Xcode-calibre visual polish.
- **The debugger is the product.** Run & Debug on the right, always legible,
  never an endless tree.
- **No integrated AI.** The Oracle is agent-*bootstrapped* (external CLI, first
  run only); the IDE itself only ever reads the notes files.

#### Component map

```
┌────────────────────────── Burrow (VS Code fork, host app) ─────────────────────────┐
│  core patches: right-hand debug bar · inspector view host · docs overlay · layout  │
│                                                                                    │
│  built-in extensions (extensions/burrow-*):                                        │
│   go-core        toolchain mgmt, scheme bar (build/run/test), gopls, modules       │
│   go-debug       dlv DAP wiring, breakpoints, goroutines            (task 04)      │
│   go-inspect     data-structure visualizers over DAP                (task 06)      │
│   go-docs        offline stdlib + module docs, hover→fullscreen     (task 07)      │
│   oracle         first-run agent bootstrap + notes-on-highlight     (task 08)      │
│   http-workbench Postman-class client over .http files             (task 09)      │
│   db-explorer    schema tree, ERD, pandas-style data grid           (task 10)      │
│   go-test        test explorer, coverage, bench, fuzz               (task 11)      │
│   nodewatch      ported Routes/Drills/Trace/mode-toggle integration (task 14)      │
└────────────────────────────────────────────────────────────────────────────────────┘
        │ localhost:5432 (db)   │ :6060 launcher API   │ :6080/:6200 sibling tools
┌───────┴───────────────────────┴──────────────────────┴────────────────────────────┐
│  debugger compose stack (unchanged except: `ide` service retired in task 14)      │
└────────────────────────────────────────────────────────────────────────────────────┘
```

#### The numbered tasks

| # | Task | Delivers | Depends on | Effort |
|---|------|----------|------------|--------|
| [01](01-fork-bootstrap-and-branding.md) | Fork bootstrap & branding | Building, branded, telemetry-free fork | — | ~2 wk |
| [02](02-strip-to-go-only.md) | Strip to Go-only | Non-Go features removed; minimal shell | 01 | ~2 wk |
| [03](03-go-toolchain-first-class.md) | First-class Go toolchain | Toolchain mgmt, scheme bar, gopls, modules | 02 | ~3 wk |
| [04](04-delve-debugging-engine.md) | Delve debugging engine | Full breakpoint/step/attach/goroutines | 03 | ~2 wk |
| [05](05-debug-panel-right-redesign.md) | Right-hand debug panel redesign | Debug UI on the right; inspector, not endless tree | 04 | ~4 wk |
| [06](06-go-value-visualizers.md) | Go value visualizers | Slice/map/struct/chan/goroutine visualizations | 05 | ~3 wk |
| [07](07-go-docs-hover-fullscreen.md) | Go docs, hover → fullscreen | Whole Go docs offline; Esc/✕ fullscreen viewer | 03 | ~2 wk |
| [08](08-oracle-codebase-notes.md) | Codebase Oracle | First-run agent walk; notes on highlight | 03 | ~2 wk |
| [09](09-http-workbench.md) | HTTP workbench | Postman-class client, .http-file backed | 03 | ~3 wk |
| [10](10-database-explorer.md) | Database explorer | pgAdmin-class schemas + pandas-style grid | 03 | ~3 wk |
| [11](11-first-class-tests.md) | First-class tests | Test explorer, coverage, bench, fuzz, race | 04 | ~2 wk |
| [12](12-design-system.md) | Design system | Xcode-calibre theme, layout, typography | 02 | ~2 wk |
| [13](13-packaging-signing-updates.md) | Packaging & updates | Signed .app, releases, update channel | 01 | ~1 wk |
| [14](14-stack-migration.md) | Stack migration | `ide` container retired; launcher/digest/extension ported | 04, 09 | ~2 wk |

#### Milestones

- **M0 — it builds** (01, 02): branded fork, stripped, launches on macOS.
- **M1 — daily-drivable** (03, 04, 11-core, 13-minimal): edit/build/run/debug/test
  the NodeWatch backend end-to-end on the host. *Parity with code-server setup.*
- **M2 — the differentiators** (05, 06, 07, 12): right-hand debug inspector,
  visualizers, docs, design pass. *Better than VS Code for Go.*
- **M3 — the integrated tools** (09, 10, 11-full): HTTP workbench, DB explorer,
  full test UX. *Replaces Postman + pgweb.*
- **M4 — the brain & the cutover** (08, 13-full, 14): Oracle, signed releases,
  `ide` container retired.

#### Invariants carried forward from the stack

- Selection still flows through the launcher; the host IDE reads it via
  `GET :6060/api/selection` (it cannot mount the `config` volume). The launcher
  stays the ONLY `/config` writer (task 14).
- Route breakpoints anchor to handler **symbols**, never stored line numbers.
- The debug run contract (env in `launch.json`: `NODEWATCH_DEV_NO_AUTH`,
  `DATABASE_URL`, `PORT=8080`, empty Auth0/CORS) is preserved verbatim — only
  the DB host flips from `db:5432` to `localhost:5432` (task 14).


---

<a id="3-task-01"></a>

# 3. Task 01 — Fork bootstrap & branding


> _source: `burrow/docs/architecture/01-fork-bootstrap-and-branding.md`_

### 01 — Fork bootstrap & branding

> Part of the [Go IDE overhaul](00-overview.md). Depends on: —. Effort: ~2 wk.

#### Goal

A nested independent git repo at `debugger/burrow/` containing a pinned fork of
[Code - OSS](https://github.com/microsoft/vscode) that builds a branded,
telemetry-free, marketplace-free desktop app on macOS (arm64 first), with the
patch-ledger discipline that keeps the fork rebasable.

#### Why

Everything else stacks on this. Getting the *change-layer discipline* right on
day one (config → deletions → patches → built-in extensions, see
[00-overview](00-overview.md)) is the difference between a maintainable product
and an unrebasable hairball six months in.

#### Legal boundaries (non-negotiable)

- Code - OSS is MIT — the *source* is ours to fork. The **Microsoft product
  branding, icons, and the Visual Studio Marketplace are not**. Ship zero MS
  assets; never point at `marketplace.visualstudio.com` (its ToS only allows
  in-product access from Microsoft products).
- No Open VSX either — we have **no extension marketplace at all**. Every
  capability ships built-in (this is a feature: minimalism, task 02).
- Licenses of what we bundle: gopls (BSD-3), Delve (MIT), vscode-go (MIT) — all
  redistributable. Keep a `THIRD_PARTY_NOTICES.md` from the start.

#### Tasks

1. **Fork and pin.** Fork `microsoft/vscode` at the newest stable minor at
   start time. Branch model: `upstream-vX.Y` (pristine tag) → `main` (ours).
   Record the pin in `UPSTREAM.md` with the rebase procedure.
2. **Host build toolchain.** Get the stock build running on macOS arm64: Node
   (per upstream `.nvmrc`), native deps, `./scripts/code.sh` for dev,
   `npm run gulp vscode-darwin-arm64` for the packaged app. Document in
   `BUILDING.md`; add a `make dev` / `make dist` wrapper.
3. **`product.json` identity.** `nameShort: Burrow`, `nameLong: Burrow — Go IDE`,
   `applicationName: burrow`, `dataFolderName: .burrow`, own
   `darwinBundleIdentifier`, `urlProtocol: burrow` (task 14 deep-links depend
   on this). Replace all icons (app icon, dock, letterpress) with our own.
4. **Kill the network chatter.** In `product.json` + build config: no telemetry
   endpoints (`enableTelemetry: false`, empty `aiConfig`), no experiments
   (`tas-client` endpoints removed), no update server (own channel in task 13),
   no extension gallery block at all, no survey prompts, no default
   `extensionsGallery`, no recommendations. Acceptance: `lsof`/proxy audit
   shows **zero non-user-initiated outbound connections** at idle.
5. **Patch ledger.** Create `patches/README.md`: every core diff gets a number,
   a one-paragraph rationale, and the upstream files touched
   (`patches/0001-default-layout.md`, …). CI check: core diffs without a ledger
   entry fail review. This is layer-3 governance from day one.
6. **Built-in extension scaffold.** Create `extensions/burrow-core/` (empty
   activation, version-stamped) proving the built-in extension path: compiles
   in the product build, activates on startup, shows in an About dialog.
   All later tasks (03–11) plant their extensions the same way.
7. **CI.** GitHub Actions: lint + compile + smoke-launch (Electron opens, a Go
   file gets syntax highlighting) on every PR; `dist` artifacts on tags
   (unsigned until task 13).
8. **First-boot sanity.** Fresh-machine checklist: app launches offline, opens
   a folder, no login, no marketplace UI, no telemetry consent dialogs.

#### Acceptance criteria

- `make dev` gives a running branded app from a clean checkout in ≤ 30 min.
- Zero outbound connections at idle (audited).
- `patches/` ledger exists and CI enforces it.
- A trivial built-in extension ships inside the packaged .app.

#### Out of scope

- Signing/notarization, auto-update (task 13).
- Any feature removal (task 02) or Go functionality (task 03).


---

<a id="4-task-02"></a>

# 4. Task 02 — Strip to Go-only


> _source: `burrow/docs/architecture/02-strip-to-go-only.md`_

### 02 — Strip to Go-only

> Part of the [Go IDE overhaul](00-overview.md). Depends on: 01. Effort: ~2 wk.

#### Goal

Remove everything that doesn't serve Go backend development. What remains is a
minimal shell: editor, search, git, integrated terminal (bash), debugging
plumbing, and the surface our built-in extensions attach to.

#### Why

Minimalism is a stated product goal, and every removed subsystem is rebase
surface and startup cost we never pay again. Deletion is layer 2 of the fork
strategy — cheap to carry, so we do it aggressively and early.

#### The keep / remove ledger

**Keep** (with the reason):

| Subsystem | Why it stays |
|-----------|--------------|
| Editor core, multi-cursor, minimap-off-by-default | the point |
| Search / replace across files | daily driver |
| Git (built-in `git` extension + SCM view) | daily driver |
| Integrated terminal, default profile **bash** | explicit requirement |
| Debug core (DAP client, breakpoints service) | tasks 04–06 build on it |
| Tasks runner | `go generate`, migrations (task 03 wires it) |
| Extension *host* | our built-in extensions run in it |
| Settings UI (pruned), keybindings, command palette | usability |
| Markdown language basics + preview | READMEs, these docs |
| JSON/YAML/TOML/SQL/Dockerfile/shell **syntax** highlighting | configs a Go repo actually contains (`go.mod`, compose, migrations) |
| Themes: our two (task 12) | design system |

**Remove** (mechanism in parentheses — *d* = delete built-in extension dir,
*p* = patch ledger entry):

- All other language built-ins: PHP, Python-basics, Ruby, C#, C/C++, Java,
  Swift, Rust-basics, F#, VB, Perl, Lua, R, Julia, Groovy, Clojure, LaTeX,
  Razor, Handlebars, Pug, Less/SCSS, CoffeeScript, HTML/CSS/JS/TS language
  *services* (keep bare JS/JSON grammar for config files) (d)
- Emmet (d) · Notebooks/Jupyter workbench contrib (p) · Interactive window (p)
- Extension marketplace views, install/search UI, `.vsix` sideload command (p)
- Settings Sync, account/auth UI, GitHub auth built-ins (d/p)
- Remote development stubs (SSH/WSL/tunnels/dev-container UI), code-server-era
  web bits we'll never serve (p)
- Walkthroughs/Getting-started for removed features, release-notes viewer,
  issue reporter, feedback/survey surfaces (p)
- Node/JS debugger (`ms-vscode.js-debug` built-in) and every non-Go debug
  adapter (d) — Delve is the only debugger aboard
- Snippet-language built-ins for removed languages, TypeScript build tasks,
  npm-scripts view (d)
- Profiles UI, Copilot/chat hooks and `chat` contribution points (p)

Each removal lands as its own commit tagged `strip:` with the app still
booting — a bisectable strip sequence.

#### Tasks

1. **Inventory.** Script `tools/inventory.js`: dump every built-in extension +
   workbench contribution in the pinned upstream into `STRIP.md` with a
   keep/remove/why column. Review that table once, then execute it.
2. **Delete built-in extensions** per ledger (the easy 60%). Verify
   `npm run gulp vscode-darwin-arm64` excludes them from the bundle.
3. **Patch out workbench contributions** per ledger (marketplace UI, sync,
   remote, notebooks, chat, issue reporter…), one ledger entry each. Prefer
   the upstream-supported switches (`product.json` quality gates,
   contribution-point no-ops) over surgical deletes where they exist.
4. **Prune the settings surface.** Hide settings of removed subsystems from the
   Settings UI (they'd be dead controls). Curate a `burrow` settings category
   as the front page.
5. **Prune commands & menus.** Command-palette audit: every command referencing
   a removed feature is gone. Menu bar shrinks to: App, File, Edit, Selection,
   View, Go(to), Run, Terminal, Help.
6. **Startup budget.** Record cold-start and memory baselines before/after in
   `STRIP.md`. Target: measurably leaner than stock (numbers, not vibes —
   expect ~30–40% fewer activated built-ins).
7. **Terminal defaults.** Default profile bash (zsh/fish selectable), sane
   PATH inheritance from the login shell on macOS (`chsh`-agnostic), cwd =
   workspace root.

#### Acceptance criteria

- App boots and edits/searches/commits a Go repo with **no** marketplace, sync,
  remote, notebook, or non-Go-language UI reachable from any menu, palette
  entry, or setting.
- `STRIP.md` ledger complete; every removal is one bisectable commit.
- Cold start ≤ stock VS Code on the same machine (should beat it comfortably).
- Terminal opens bash in the workspace root out of the box.

#### Out of scope

- Adding anything Go (task 03). This task only ever deletes.
- Theme/visual work (task 12) beyond not shipping removed-feature icons.


---

<a id="5-task-03"></a>

# 5. Task 03 — Go toolchain first-class


> _source: `burrow/docs/architecture/03-go-toolchain-first-class.md`_

### 03 — First-class Go toolchain

> Part of the [Go IDE overhaul](00-overview.md). Depends on: 02. Effort: ~3 wk.

#### Goal

Go is not "a language extension" here — it's the product. Opening a folder with
a `go.mod` gives you, with zero setup: language intelligence (gopls), a
Xcode-style **scheme bar** (build/run/stop, target picker, env), inherent
module handling, and format/vet on save. Compiling, building, and running Go
are first-class verbs with dedicated UI, not tasks you configure.

#### Design

##### Foundation: vendor vscode-go, then build above it

Fork [golang/vscode-go](https://github.com/golang/vscode-go) (MIT) as the
built-in extension `extensions/go-base/`, pinned like upstream. It contributes
the battle-tested plumbing: gopls client wiring, the `go` debug type over
`dlv dap`, test codelenses, build diagnostics. We strip its telemetry, survey
prompts, version-nag UI, and its tool-install prompts (we manage tools
ourselves, below). Our own `extensions/burrow-go-core/` layers the product
experience on top. **Rule: never patch go-base where go-core can wrap it** —
go-base must stay cheap to re-pin.

##### Toolchain management (no prompts, ever)

- **Go itself is the host's** (respect `go env`, `GOROOT`, version managers).
  Minimum supported: two most-recent Go minors. If no `go` on PATH: a single
  blocking welcome card with the official install link — not seventeen toasts.
- **gopls and dlv are ours.** Pinned versions auto-installed into
  `~/Library/Application Support/Burrow/tools/<go-version>/` on first launch
  (`GOBIN`-redirected `go install`), upgraded when Burrow updates its pins.
  The user never sees "gopls is missing" dialogs. `burrow.tools.useSystem`
  escape hatch for people who insist.
- Status item shows `go 1.2x · gopls ok · dlv ok`; click → doctor panel
  (versions, paths, GOPATH/GOMODCACHE, proxy settings, re-install buttons).

##### The scheme bar (Xcode's best idea, stolen)

A slim toolbar across the title bar (core patch, ledger entry):

```
[ ▶ Run ] [ ⏹ ] [ 🐞 Debug ]   scheme: [ nodewatch-backend ▾ ]   [ race ☐ ]   go 1.25 · main ✓
```

- **Scheme = launch configuration.** The picker reads `launch.json` (the
  existing NodeWatch configs work verbatim) plus auto-discovered `main`
  packages (`./...` scan via `go list`). No `launch.json` needed for the
  common case: pick `cmd/migrate`, hit Run.
- ▶ Run = `go run` semantics (build + launch, output to a dedicated Run
  console); 🐞 = the same scheme under Delve (task 04). ⌘R / ⌘D.
- Scheme editor UI (env vars, args, build flags, working dir) writes
  `launch.json` — files stay the source of truth, git-diffable.
- `race ☐` toggles `-race` on build/run/test/debug globally — surfaced because
  the NodeWatch workflow uses it enough to have a dedicated launch config today.

##### Modules & build chain, inherent

- `go.mod` **is** the project model: module path + Go version in the explorer
  header; multi-module workspaces via `go.work` get a module switcher.
- Dependency tree view under the explorer: direct/indirect deps from
  `go list -m all`, per-module: version, available upgrade (`go list -u`),
  actions: upgrade, tidy, `go mod why`, open module docs (task 07 hook).
- Save pipeline: `goimports` format-on-save (gopls), vet diagnostics inline;
  optional `staticcheck` toggle (bundled, off by default — minimalism).
- `go generate`, `go mod tidy`, `go build ./...` as palette commands and
  explorer context items; tasks-runner integration for repo-specific chains
  (e.g. NodeWatch migrations) via plain `tasks.json`.
- Build errors land in Problems *and* as inline editor markers with the
  compiler's exact message; ⌘' jumps to next build error (Xcode muscle memory).

#### Tasks

1. **Vendor go-base.** Fork vscode-go, pin, strip telemetry/prompts/tool-mgmt,
   wire as built-in; document the re-pin procedure next to `UPSTREAM.md`.
2. **Tool manager.** Pinned gopls/dlv auto-install + doctor panel + status item.
3. **Scheme bar core patch.** Title-bar toolbar host (ledger entry) + the
   run/stop/debug/scheme/race controls, backed by `launch.json` + `go list`
   auto-discovery.
4. **Run console.** Dedicated output channel per scheme with ANSI, re-run,
   stop, and exit-status affordances; ⌘R re-runs the active scheme.
5. **Module views.** Explorer header (module identity), dependency tree with
   upgrade/tidy/why actions, `go.work` switcher.
6. **Save pipeline.** goimports + vet defaults; staticcheck toggle; next-error
   navigation; Problems ↔ inline marker parity.
7. **Command surface audit.** Every Go verb (`build`, `run`, `test`, `generate`,
   `tidy`, `vet`, `env`) reachable from palette with `Go:` prefix; menu bar
   "Run" menu reflects the same.
8. **Contract check.** Open `merkle/nodewatch/backend`: existing `launch.json`
   schemes appear in the picker unmodified; `go run .` from the scheme bar
   boots the backend against compose `db` (host `localhost:5432` variant).

#### Acceptance criteria

- Fresh machine + Go installed: open a `go.mod` folder → hover docs, jump to
  def, format-on-save, and ▶ Run of an auto-discovered `main` all work with
  **zero** configuration or prompts.
- The NodeWatch backend's seven existing launch configs surface as schemes and
  run unchanged.
- gopls/dlv versions are pinned by Burrow, not whatever `$PATH` has.
- No vscode-go telemetry/survey/update UI remains reachable.

#### Out of scope

- Debug execution semantics (task 04), tests UI (task 11), docs viewer (task 07).


---

<a id="6-task-04"></a>

# 6. Task 04 — Delve debugging engine


> _source: `burrow/docs/architecture/04-delve-debugging-engine.md`_

### 04 — Delve debugging engine

> Part of the [Go IDE overhaul](00-overview.md). Depends on: 03. Effort: ~2 wk.

#### Goal

Complete, reliable Go debugging over `dlv dap`: every breakpoint kind, every
step verb, launch/attach/test/remote modes, goroutine-aware execution control.
This task is the *engine* — correctness and coverage. The *presentation*
overhaul is task 05, visualizers are task 06.

#### Design

go-base (vendored vscode-go, task 03) already speaks DAP to `dlv dap`; we pin
dlv ourselves, own the session lifecycle from the scheme bar, and close the
gaps vscode-go leaves at defaults.

##### Breakpoints — full menu

- **Line** breakpoints with the standard gutter interaction.
- **Conditional** (`hitCondition`, expression conditions evaluated by dlv).
- **Logpoints** — non-suspending, interpolated `{expr}` output to the debug
  console; the tool of choice for hot paths like the ingest handlers.
- **Function breakpoints** — by symbol (`pkg.Func`, `(*Recv).Method`); this is
  what the Routes tree anchors to (symbol, never a line — stack invariant).
- **Watchpoints** (data breakpoints) — dlv supports hardware watchpoints on
  addressable values; expose "Break on Write" from the inspector (task 05
  surfaces the affordance; the engine capability lands here).
- Breakpoints all settable **before and during** a session, and preserved
  across rebuild-and-restart.

##### Execution control

- Step over / into / out (⌘F6-style bindings finalized in task 12), continue,
  pause, restart (rebuild-if-stale then relaunch — the scheme bar's Debug
  button doubles as Restart while a session runs).
- **Goroutine-true stepping**: steps pin to the stopped goroutine (dlv default);
  goroutine switcher in the call-stack UI switches evaluation context.
- Run-to-cursor, "Set Next Statement" where dlv allows it.
- `-race` scheme toggle carries into debug builds; panics and fatal signals
  land as first-class stop events with the panic value decoded.

##### Session modes

| Mode | Backing | Notes |
|------|---------|-------|
| Launch | `dlv dap` launch of a scheme | default; env from `launch.json` verbatim (NodeWatch contract preserved) |
| Test | `mode: test` | wired to task 11's explorer; per-test debug |
| Attach (local) | `dlv attach <pid>` | process picker filtered to Go binaries |
| Attach (remote) | `dlv dap --listen` / headless | for in-container targets; `substitutePath` UI so container paths map to host source — this replaces today's "debug inside the ide container" story |
| Core dump | `dlv core` | post-mortem; nice-to-have, keep if free |

##### Reliability details that matter

- Build failures before launch route to the Problems pane, not a dead session.
- Debug console evaluation uses dlv's expression language; document its limits
  (no arbitrary function calls unless `--allow-non-terminal-interactive`-class
  risk is accepted — default off, `call` behind an explicit setting).
- Output demux: program stdout/stderr vs. debugger messages kept distinct in
  the Run console.
- Session teardown never orphans the debuggee or dlv (SIGKILL escalation with
  timeout); port allocation for DAP is collision-free (ephemeral ports only).

#### Tasks

1. **dlv lifecycle ownership.** Scheme-bar Debug ▶ builds (respecting `-race`,
   build flags), launches pinned `dlv dap`, manages teardown/restart; kill-safe.
2. **Breakpoint matrix.** Verify + fix line/conditional/hit-count/logpoint/
   function breakpoints against a fixture repo; wire watchpoint requests.
3. **Attach modes.** Local pid picker; remote attach UI with `substitutePath`
   editor and a saved-target list (host `localhost:2345` default matches the
   old stack's published dlv port).
4. **Panic & signal UX.** Panic stop shows the panic value, unwound stack, and
   the goroutine that panicked selected by default.
5. **Debug console contract.** Expression evaluation, `{expr}` logpoint
   interpolation, and paste-multiline handling; document unsupported forms.
6. **Fixture gauntlet.** A `testdata/debuggee` Go module exercising: deep
   structs, big slices/maps, channels, mutexes, goroutine storms, panics,
   cgo-free and `-race` builds — used by CI to smoke the whole matrix headlessly
   via DAP scripting.
7. **NodeWatch end-to-end.** Breakpoint in an ingest handler; `curl /healthz`;
   hit, step, inspect, continue; attach-remote variant against a containerized
   backend with path substitution.

#### Acceptance criteria

- Every row of the breakpoint matrix and session-mode table demonstrably works
  on the fixture gauntlet (CI-scripted, not manual).
- Restart-with-rebuild round-trip < 3 s on the NodeWatch backend (warm cache).
- No orphaned dlv/debuggee processes across 100 scripted start/stop cycles.
- The seven NodeWatch launch configs all debug successfully unmodified.

#### Out of scope

- Variables/call-stack presentation (task 05), visualizers (task 06),
  test-explorer integration surface (task 11).


---

<a id="7-task-05"></a>

# 7. Task 05 — Debug panel (right) redesign


> _source: `burrow/docs/architecture/05-debug-panel-right-redesign.md`_

### 05 — Right-hand debug panel redesign

> Part of the [Go IDE overhaul](00-overview.md). Depends on: 04. Effort: ~4 wk.

#### Goal

Run & Debug lives in a **right-hand panel** by default, and the variables
experience is an **inspector, not an endless recursive tree**. Call stack,
variables, watches — everything you touch while stopped — is one glance away
and navigable in constant depth.

#### Why

The stock debug sidebar is the weakest part of VS Code for Go: a Variables
tree where a `*Server` five structs deep means eight disclosure triangles,
horizontal scrolling, and losing your place. Xcode's layout (navigation left,
inspection right) is the proven arrangement. This is the single highest-touch
UI surface in a debugger — it deserves the largest patch budget of the fork.

#### Design

##### Layout (core patch)

- The aux bar (secondary side bar) becomes the **Debug bar**, open on the
  right whenever a session runs (auto-reveal on first stop; manual toggle ⌥⌘D).
- Left sidebar keeps only file explorer / search / git — *navigation*.
  Right bar is *state*: *(top→bottom)* **Frames**, **Inspector**, **Watch**.
  Breakpoints management moves to a popover from the scheme bar's 🐞 menu —
  it's configuration, not hot state, and doesn't deserve permanent space.
- Debug console stays in the bottom panel with the Run console and terminal.

##### Frames (call stack, compact)

- One line per frame: `pkg.Func` bold, `file:line` dim, current frame accented.
  Stdlib/runtime frames collapse into a single expandable `runtime ⋯ (12)` row
  by default — you almost never want them.
- **Goroutine header**: current goroutine (id, state, wait reason) with a
  dropdown of interesting goroutines (running, blocked, at-breakpoint first,
  searchable, badge counts by state). Switching goroutines swaps frames and
  inspector context. The full goroutine table is task 06's visualizer.

##### Inspector (the anti-tree)

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

##### Watch

- Flat list, same summary renderer as the inspector, same value pane on
  select. Invalid-in-this-frame watches gray out instead of erroring.

##### Implementation shape (patch budget honesty)

The aux-bar default + view containers are small patches. The Inspector itself
is a **new workbench view** (layer 3, our largest core component, ~significant
patch) that talks to the existing debug service/DAP model — we reuse the DAP
session plumbing wholesale and replace only the presentation. Where feasible,
components live in `extensions/burrow-go-inspect/` webview/custom views to cap
core-diff size; the frames/inspector views likely need real workbench views
for keyboard/perf parity with the rest of the UI. Prototype both, pick one,
record in the patch ledger.

#### Tasks

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

#### Acceptance criteria

- Debugging opens the right bar; reaching any value nested 8 levels deep never
  shows more than breadcrumb + two columns, and never requires horizontal
  scrolling.
- A 50k-element slice and a 10k-key map stay responsive (paged) in the
  inspector.
- Goroutine switch < 100 ms perceived; changed values visibly tinted.
- Zero regressions in the task 04 CI gauntlet (presentation swap only).

#### Out of scope

- Rich per-type visualizations (task 06) — this task defines the mount point.
- Visual styling/polish beyond structure (task 12).


---

<a id="8-task-06"></a>

# 8. Task 06 — Go value visualizers


> _source: `burrow/docs/architecture/06-go-value-visualizers.md`_

### 06 — Go value visualizers

> Part of the [Go IDE overhaul](00-overview.md). Depends on: 05. Effort: ~3 wk.

#### Goal

Rich, type-aware visualizations for Go data structures while stopped in the
debugger — mounted in the inspector's value pane (task 05) and expandable to a
full editor tab. Seeing a 50k-row slice as a filterable table, a map as a
key-value grid, or the goroutine population as a live table is the payoff of
owning the debugger UI.

#### Design

##### Architecture

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

##### The launch set

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

##### Honesty about limits

Values are inspected via DAP variable traversal only — no calling methods on
the debuggee (no `String()` invocation) at defaults, matching task 04's
no-`call` posture. Where dlv can't see something (unexported runtime internals
vary by Go version), visualizers degrade to the struct card, never to an error.
Version-sensitive readers (chan/goroutine/sync internals) live behind a small
adapter tested per supported Go minor in the fixture gauntlet.

#### Tasks

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

#### Acceptance criteria

- Every launch-set row works against the task 04 fixture gauntlet across the
  two supported Go minors, degrading gracefully where dlv lacks data.
- A NodeWatch ingest payload (`[]Metric`, nested structs, `[]byte` JSON body)
  is: table-viewed, filtered, a body hex/JSON-inspected — without leaving the
  stopped session.
- Expanded visualizers open as tabs and close with Esc/✕, session-live.

#### Out of scope

- Charting/plotting numeric series (post-launch candidate).
- Calling debuggee methods for rendering (`String()`), custom user-written
  visualizers via config (post-launch: a `burrow-viz.json` per-repo registry
  is the natural extension).


---

<a id="9-task-07"></a>

# 9. Task 07 — Go docs hover→fullscreen


> _source: `burrow/docs/architecture/07-go-docs-hover-fullscreen.md`_

### 07 — Go docs: hover → fullscreen

> Part of the [Go IDE overhaul](00-overview.md). Depends on: 03. Effort: ~2 wk.

#### Goal

The whole of Go's documentation, offline, inside the IDE. Hover any symbol for
its docs; expand the hover to a **fullscreen doc viewer** (exit with Esc or a
✕ icon); browse and search the entire stdlib and every dependency of the open
module without leaving the editor or touching a browser.

#### Design

##### Three doc sources, one viewer

1. **Stdlib, prebuilt.** At Burrow build time, generate a doc bundle from the
   pinned Go version's source using `go/doc` (JSON: packages → symbols → doc
   comments, signatures, examples). Shipped with the app (~single-digit MB
   compressed), so stdlib docs work with no toolchain and no network. Regenerate
   per Go minor we support; runtime picks the bundle matching the active
   toolchain (fallback: nearest version, banner noting the skew).
2. **Dependencies, from the module cache.** For anything in `go.mod`, docs are
   extracted on demand from `GOMODCACHE` source via `go doc -all -json`-style
   extraction (own extractor binary reusing `go/doc`, warmed lazily per module
   after `go list -m all`). Same data shape as the stdlib bundle.
3. **The open workspace itself.** Your own packages get the same treatment via
   gopls — the doc viewer renders workspace package pages too.

##### Hover → expand

- Hover stays gopls-powered (signature + doc comment, markdown). We add a
  persistent **"Open docs ⤢"** affordance in the hover widget (small core
  patch to the hover UI — ledger entry) plus a keybinding (⌥Space on hover,
  or ⇧⌘0 on cursor symbol).
- Expanding opens the **doc viewer** focused on that exact symbol.

##### The doc viewer

A webview-based editor tab (`extensions/burrow-go-docs/`), pkg.go.dev-quality
rendering, fully offline:

- **Layout:** left rail = package index (stdlib grouped by category, then
  module deps from `go.mod`, then workspace packages); main pane = package page
  (overview, index, constants/vars/funcs/types with methods grouped, examples
  with syntax highlighting and a "insert into editor" action on examples).
- **Navigation:** every identifier in signatures cross-links; history
  back/forward (⌘[ ⌘]); breadcrumb `net/http ▸ Request ▸ ParseForm`.
- **Search:** ⌘K fuzzy search across all indexed symbols (stdlib + deps +
  workspace), ranked exact-prefix > camel-match > doc-text hits.
- **Exit contract:** **Esc closes** (restores focus to the editor exactly
  where you were), and a **✕ icon** top-right does the same — the explicit
  requirement. The tab can also be kept/pinned like any editor tab; "fullscreen"
  = maximize-editor-group mode toggled on open, restored on close.
- Version-true: docs always reflect the **resolved versions in go.sum**, never
  "latest" — this is the advantage over alt-tabbing to pkg.go.dev.

#### Tasks

1. **Doc extractor + bundle format.** `go/doc`-based extractor producing the
   JSON shape; build-time stdlib bundles per supported Go minor; runtime
   loader with version matching.
2. **Dependency indexer.** Lazy per-module extraction from `GOMODCACHE`,
   invalidated on `go.mod`/`go.sum` change; workspace packages via gopls.
3. **Viewer webview.** Package pages, cross-linking, history, breadcrumb,
   examples with insert action; maximize-on-open / restore-on-close;
   Esc + ✕ exit paths (focus restoration correct).
4. **Search.** Unified symbol index + ⌘K UI with the ranking rules.
5. **Hover affordance patch.** "Open docs ⤢" in the hover widget + cursor-
   symbol keybinding; resolves through gopls to the canonical symbol identity
   the viewer understands.
6. **Coverage pass.** Generics rendering (type params in signatures),
   examples, deprecation notices, `//go:build` variant notes; verify against
   awkward stdlib pages (`net/http`, `context`, `unsafe`).

#### Acceptance criteria

- Wi-Fi off: hover `http.HandleFunc`, expand → full `net/http` docs; ⌘K
  "ParseForm" lands on the symbol; Esc returns to the editor with cursor
  position intact.
- Docs for a pinned dependency (e.g. `chi`) match its `go.sum` version.
- Hover-to-expanded-viewer < 300 ms warm.
- Every symbol in workspace code, stdlib, and deps has a doc page reachable
  by hover-expand and by search.

#### Out of scope

- Non-Go docs (SQL, etc.). Third-party doc *websites*. Editing doc comments
  from the viewer (post-launch candidate).


---

<a id="10-task-08"></a>

# 10. Task 08 — Oracle codebase notes


> _source: `burrow/docs/architecture/08-oracle-codebase-notes.md`_

### 08 — Codebase Oracle: agent-bootstrapped notes on highlight

> Part of the [Go IDE overhaul](00-overview.md). Depends on: 03. Effort: ~2 wk.

#### Goal

The first time a codebase opens in Burrow, an **external agent** does a full
walk of it and writes structured notes — what each package/symbol is for, how
the pieces connect, the traps. Afterwards, **highlighting any code shows the
notes** the agent took about it. Modeled on the merkle repo's memory pattern
(`~/Projects/merkle/.claude/memory` — terse YAML rows, an index, a freshness
discipline). Bootstrap-only agent involvement: **no integrated AI analysis**;
after the walk, the IDE only ever reads files.

#### Design

##### Storage: in-repo, merkle-memory compatible in spirit

```
<repo>/.oracle/
  MEMORY.md          # human/agent-readable index — what's here, key dictionary
  repo.yaml          # meta, apps/module facts, decisions[], traps[]
  notes.yaml         # THE core artifact: per-symbol notes (schema below)
  packages.yaml      # per-package: purpose, key types, relations
  ORACLE.md          # provenance: agent, date, model, commit walked, coverage stats
```

`notes.yaml` rows are terse inline-flow (merkle-style), **symbol-anchored,
never line-anchored** (stack invariant):

```yaml
### sym: package-relative symbol path · f: file · h: content hash of the symbol's
### source at walk time (staleness) · n: the note · links: related syms
notes:
  - {sym: ingest.HandleIngest,        f: ingest/handler.go,  h: 9f3c21ab, links: [ingest.validateBatch, models.Metric],
     n: "Entry point for POST /api/v1/ingest. Decodes a metric batch, validates
         per-org quota, writes via the batched inserter — backpressure comes from
         the inserter's channel, not HTTP. Auth is org-scoped API key middleware."}
  - {sym: ingest.(*Inserter).loop,    f: ingest/inserter.go, h: 71bd0e44, links: [ingest.HandleIngest],
     n: "Single goroutine draining the insert channel into COPY batches every
         200ms or 5k rows. TRAP: blocking here stalls all ingest HTTP handlers."}
```

- `h` = short hash of the symbol's normalized source text at walk time. Cheap,
  local staleness: hash matches → note is fresh; differs → shown with a
  **stale** badge (still useful, honestly labeled). No AI re-analysis — a
  stale note stays stale until a human or a re-run refreshes it.
- Package-level notes in `packages.yaml` catch "what is this directory"
  questions; symbol notes catch "what does this function really do".

##### Bootstrap: agent instructions, external execution

- `extensions/burrow-oracle/` ships **`oracle-instructions.md`** — the complete
  prompt contract for the walk: read order (go.mod → entrypoints → routers →
  packages by dependency order), what to note (purpose, connections,
  invariants, traps — *why*, not what the code already says), the exact YAML
  schemas, hash computation, coverage expectations (every exported symbol +
  any unexported symbol with non-obvious behavior), and MEMORY.md/ORACLE.md
  requirements.
- On opening a repo with no `.oracle/`: one non-modal card — **"Bootstrap the
  Oracle"**. It runs the user's own agent CLI (default `claude -p`, command
  template configurable) in the integrated terminal with the instructions
  file. The IDE supplies the instructions and watches for `.oracle/` to
  appear; it does **not** embed an agent, hold API keys, or parse model
  output. Progress = the agent's own terminal output. Declining hides the
  card for the repo (`.oracle/DECLINED` marker, gitignored-optional).
- Re-runs: palette commands `Oracle: Re-walk package…` / `Re-walk repository`
  (same mechanism, scoped instructions). Suggested when > N% of notes go stale.

##### Read path: highlight → notes

- Selection (or cursor) → enclosing symbol chain via DocumentSymbolProvider
  (`ingest.(*Inserter).loop` → `ingest.(*Inserter)` → package) → look up
  notes for the innermost match, falling back outward to the package note.
- Surfaces:
  - **Oracle strip** in the right bar (below Watch when debugging, standalone
    otherwise): note text, links (click → jump to symbol), fresh/stale badge,
    provenance line.
  - Same note appended (dim, `— Oracle`) to the gopls hover, so knowledge
    shows up where your eyes already are. Setting-gated.
- Lookup is an in-memory index of `notes.yaml` (rebuilt on file change);
  YAML is the on-disk truth — hand-editable, git-diffable, reviewable in PRs.

#### Tasks

1. **Schemas + parser.** `notes.yaml`/`packages.yaml`/`repo.yaml` schemas,
   validating parser, symbol-path grammar (matching gopls symbol identity),
   normalized-source hasher (Go AST-based: whitespace/comment-insensitive).
2. **Instructions contract.** Write `oracle-instructions.md` (+ the scoped
   re-walk variant); validate by bootstrapping the NodeWatch backend with it
   and reviewing note quality; iterate until the merkle-memory bar is met.
3. **Bootstrap flow.** No-oracle detection, card UI, agent CLI launch template
   (`burrow.oracle.agentCommand`), `.oracle/` watcher, DECLINED marker,
   post-run validation report (schema errors, coverage %, orphan links).
4. **Note index + resolver.** In-memory index; selection → symbol chain →
   note resolution with outward fallback; staleness check via hasher.
5. **Surfaces.** Oracle strip view (notes, links, badges, "open notes.yaml at
   row" action) + hover append; both setting-gated.
6. **Re-walk commands + stale accounting.** Scoped re-run plumbing; status-bar
   stale-percentage indicator with re-walk suggestion threshold.

#### Acceptance criteria

- Fresh clone of the NodeWatch backend + one bootstrap run ⇒ highlighting
  `HandleIngest` shows a correct, useful note in < 50 ms, with working links.
- Editing a noted function flips its note to **stale** on save; the note
  remains visible and labeled.
- The IDE makes zero model/API calls at any point; deleting `.oracle/` and
  the agent CLI leaves a fully functional IDE (feature simply dormant).
- `notes.yaml` survives a hand edit + git round-trip (stable formatting).

#### Out of scope

- Integrated AI analysis, on-the-fly note generation, auto-refresh of stale
  notes (explicitly deferred by product decision).
- Cross-repo oracle federation; non-Go targets.


---

<a id="11-task-09"></a>

# 11. Task 09 — HTTP workbench


> _source: `burrow/docs/architecture/09-http-workbench.md`_

### 09 — HTTP workbench (the Postman replacement)

> Part of the [Go IDE overhaul](00-overview.md). Depends on: 03. Effort: ~3 wk.

#### Goal

A Postman-class HTTP client, integrated: collections, environments, a proper
request editor, and a rich response viewer — so exercising the backend under
debug never needs an external app. File-backed and git-friendly, compatible
with the `.http` scratchpads the stack already uses (`api.http`).

#### Design

##### Files are the database

- Requests live in **`.http` files** (the humao/JetBrains dialect the repo
  already has): `###`-separated requests, `@var` definitions, `{{var}}`
  interpolation. The existing `vscode/api.http` (54 NodeWatch requests) opens
  and works day one — that file is the compatibility fixture.
- **Environments** in `http-env.json` next to the collection
  (`{"dev": {"baseUrl": "http://localhost:8080"}, "compose": …}`), switcher in
  the workbench toolbar. Secrets never in-repo: `{{$env:VAR}}` reads process
  env; an OS-keychain-backed `{{$secret:name}}` for tokens.
- A **collection** = a directory of `.http` files. Tree view mirrors the
  files; no proprietary sidecar database, so PRs review requests like code.

##### Two faces, one model

- **In-editor:** `.http` files get syntax highlighting, `{{var}}` resolution
  hints, and a **Send** codelens per request (the workflow people already
  have, kept).
- **Workbench panel** (`extensions/burrow-http/`, editor-area webview): the
  Postman-style three-pane experience —
  - *left:* collection tree + history;
  - *center:* request editor — method/URL bar, tabs for **Params · Headers ·
    Body (raw/JSON editor/form/file) · Auth (bearer, basic, API-key header) ·
    Settings (timeout, redirects, TLS-verify toggle)** — all of it
    round-tripping losslessly to the `.http` text;
  - *right/bottom:* response — status + timing + size chips; headers table;
    body as **JSON tree with filter and path-copy (`$.items[3].id`)**, raw,
    or preview; large-body streaming with truncation guards; response history
    diffing (this run vs. last).
- Send executes via undici in the extension host: full timing breakdown
  (DNS/connect/TLS/TTFB/total), cookie jar per environment (inspectable,
  clearable), redirect chain shown.

##### Debugger + stack integration (the moat)

- **Breakpoint-aware sends:** hitting a breakpoint while a workbench request
  is in flight badges that request "paused in `ingest.HandleIngest`" — send,
  stop in handler, inspect (task 05/06), continue, see the response. The
  core loop of backend debugging, one window.
- Every send injects **`X-Request-Id`** (toggleable) and hands the id to the
  Request Trace feature (ported in task 14), linking request → slog lines.
- **Generate from routes:** the digest's route table (launcher `/api/digest`,
  see task 14) generates/refreshes a `routes.generated.http` — every backend
  route as a ready request (the existing `generateApiHttp` feature, upgraded).
- Export/import: copy-as-cURL, import-from-cURL; OpenAPI import (paths →
  collection) best-effort.

#### Tasks

1. **`.http` parser/printer.** Lossless round-trip (comments preserved) of the
   humao dialect: requests, `@vars`, `{{}}` interpolation, `###` separators;
   `api.http` as the golden fixture. Env resolution with `$env`/`$secret`.
2. **Send engine.** undici-based executor: timing phases, cookie jar, redirect
   capture, cancellation, streaming bodies, size guards.
3. **In-editor face.** Grammar, codelens Send, inline var hints, "open in
   workbench" jump.
4. **Workbench panel.** Three-pane webview: tree/history, request editor tabs
   with lossless text round-trip, response viewer (JSON tree + filter +
   path-copy, headers, timing chips, history diff).
5. **Environments + secrets.** `http-env.json` switcher, keychain-backed
   secrets, cookie-jar-per-env.
6. **Debug + trace hooks.** In-flight ⇄ breakpoint badge wiring,
   `X-Request-Id` injection + trace handoff interface (consumed in task 14),
   route-digest → generated collection.
7. **Import/export.** cURL both ways; OpenAPI import.

#### Acceptance criteria

- `vscode/api.http` opens with all requests sendable — codelens and workbench
  — against the backend under debug; auth-less NodeWatch dev contract works
  as-is.
- Send → breakpoint in handler → inspect → continue → response renders, with
  the request badge showing the pause; total flow inside one window.
- A 25 MB JSON response streams, renders truncated-safe, and the tree filter
  stays responsive.
- Round-trip test: parse → edit in UI → print yields a minimal, comment-
  preserving diff.

#### Out of scope

- Mock servers, contract testing, gRPC/WebSocket clients (post-launch
  candidates; gRPC is the most likely follow-on for a Go IDE).
- Postman collection-format import (cURL/OpenAPI cover the real cases).


---

<a id="12-task-10"></a>

# 12. Task 10 — Database explorer


> _source: `burrow/docs/architecture/10-database-explorer.md`_

### 10 — Database explorer (pgAdmin-class, pandas-feel)

> Part of the [Go IDE overhaul](00-overview.md). Depends on: 03. Effort: ~3 wk.

#### Goal

First-class Postgres visibility inside the IDE: schema browsing, an ERD, and —
the centerpiece — a **data grid that filters like a pandas DataFrame**. Good
enough that pgweb leaves the stack (task 14) and pgAdmin never enters it.

#### Design

##### Connections

- `extensions/burrow-db/`, driver = `pg` in the extension host (Postgres
  only at launch — that's the stack; the internal interface stays
  dialect-shaped for later).
- Zero-config first connection: parse `DATABASE_URL` from the active scheme's
  env (`launch.json`) — the NodeWatch contract means the right database is
  known the moment a scheme exists. Manual connections saved per workspace,
  passwords in the OS keychain.
- **Read-only by default.** Sessions open `default_transaction_read_only=on`;
  an explicit, visually-loud toggle (amber bar) enables writes. Row edits and
  DDL are deliberate acts, never a mis-click.

##### Schema surface

- Tree: connection → databases → schemas → tables/views/matviews →
  columns (type, null, default), indexes, constraints, FKs, triggers.
  TimescaleDB-aware: hypertables badged, chunk/compression stats on the
  table page (the stack's db *is* Timescale).
- **Table page** (webview tab): columns grid, DDL (generated, copyable),
  indexes with sizes, FK in/out lists (each a jump-link), row-count estimate,
  size on disk.
- **ERD**: FK-graph diagram per schema — tables as nodes (PK/FK columns
  shown), crow's-foot edges, drag-to-arrange (layout persisted per workspace),
  focus mode (selected table + neighbors), export SVG/PNG. Layered auto-layout;
  no physics toys.

##### The data grid (the pandas part)

- Virtualized, server-side everything: window fetches (keyset-paginated —
  LIMIT/OFFSET dies on big Timescale tables), so a 100M-row hypertable
  scrolls like a small one.
- **Filter chips per column, type-aware** — composing to a WHERE clause shown
  live (and copyable) at the bottom:
  - text: contains / = / regex / in-list;  numeric: = ≠ > ≥ < ≤ between;
  - timestamp: relative presets (`last 15m/1h/24h`) + absolute range picker —
    built for Timescale metric tables;
  - enum-ish (low-cardinality detected): checkbox set;  nullness: is/is not null.
- Sort (multi-column, shift-click), column hide/reorder/pin, cell popover
  for wide values (JSON cells get the task 06-style JSON tree), row detail
  pane, distinct-values + min/max/avg summary per column on demand
  (`pandas.describe()` energy).
- Export: visible window or full filtered set → CSV/JSON/`INSERT` statements.
- Edit mode (only when writes enabled): cell edits staged → reviewed as the
  literal UPDATEs → applied in one transaction.

##### SQL editor

- SQL tabs with schema-aware autocomplete (tables/columns from the live
  catalog), run-selection (⌘⏎), results in the same grid (filter chips work on
  result sets client-side), query history per connection, **EXPLAIN
  (ANALYZE, BUFFERS) visualizer** — plan tree with per-node cost/rows/time
  bars, hot path highlighted.
- Kill-safe: long queries show elapsed time + cancel (server-side
  `pg_cancel_backend` via a second connection).

#### Tasks

1. **Connection layer.** `pg` pooling, keychain secrets, `DATABASE_URL`
   auto-discovery from schemes, read-only session default + write toggle,
   cancel channel.
2. **Catalog + tree.** Introspection queries (pg_catalog + timescaledb
   catalog), tree view, table page with DDL/indexes/FK links.
3. **Data grid core.** Virtualized grid, keyset pagination, sort, column ops,
   cell/row detail panes.
4. **Filter chips.** Type-aware chip UI → parameterized WHERE composition,
   live SQL readout, distinct/summary popovers.
5. **SQL editor.** Autocomplete from catalog, run/cancel, history, results-
   into-grid, EXPLAIN visualizer.
6. **ERD.** FK graph, auto-layout + persisted manual layout, focus mode,
   SVG/PNG export.
7. **Write path.** Edit staging → SQL review → transactional apply; guarded
   by the write toggle; audit line in query history.
8. **Timescale + scale pass.** Hypertable badges/stats; correctness + latency
   against a seeded 100M-row metrics hypertable (the NodeWatch shape).

#### Acceptance criteria

- Open NodeWatch workspace → connection appears from the scheme's
  `DATABASE_URL` with zero config → browse to a metrics hypertable → filter
  `time: last 1h` + `node_name contains eth` + sort by value ⇒ first window
  < 500 ms on the 100M-row seed, WHERE readout correct.
- ERD of the NodeWatch schema renders with correct FK edges and survives
  reopen with layout intact.
- EXPLAIN ANALYZE of a seq-scan query visibly flags the hot node.
- Impossible to mutate data without having flipped the amber write toggle.

#### Out of scope

- Non-Postgres dialects; migration tooling (repo `tasks.json` owns that);
  server administration (roles, vacuum scheduling, replication) — explorer,
  not admin console.


---

<a id="13-task-11"></a>

# 13. Task 11 — First-class tests


> _source: `burrow/docs/architecture/11-first-class-tests.md`_

### 11 — First-class tests

> Part of the [Go IDE overhaul](00-overview.md). Depends on: 04. Effort: ~2 wk.

#### Goal

`go test` as a first-class citizen: a test explorer that understands packages,
table-driven subtests, benchmarks, and fuzz targets; one-keystroke run/debug at
any granularity; coverage in the gutters; race toggle honored everywhere.

#### Design

- `extensions/burrow-go-test/` builds on the native Testing API + go-base's
  discovery, with `go test -json` as the single execution protocol (parse
  events → live tree state; no output scraping).
- **Discovery:** static via gopls symbols (`Test*`, `Benchmark*`, `Fuzz*`,
  `Example*`) per package; **table-driven subtests** appear statically where
  literal `t.Run("name", …)` names are resolvable, and dynamically after a
  run from `-json` events (runtime names attach under their parent).
- **Explorer tree:** module → package → file → test → subtests. Status glyphs
  (pass/fail/skip + duration), sticky last-run state per workspace, filters:
  failed-only, changed-packages-only (git-aware).
- **Run/debug anywhere:** gutter icons per test/subtest (run ▶ / debug 🐞),
  package and module level from the tree, re-run-failed (⌃⌘R), re-run-last.
  Debug routes through the task 04 engine in `mode: test` with the exact
  `-run` regex for one test *or one subtest* (`-run 'TestIngest/quota_exceeded'`).
- **The scheme bar's race toggle** (task 03) applies to every test run; per-run
  overrides for `-count`, `-run`, tags, timeout, env in a run-config popover.
  The NodeWatch "Debug Package Tests (with DB)" env contract works via
  `launch.json` test schemes, honored by the explorer.
- **Failure UX:** `-json` failure output attaches to the test node; assertion
  diffs (got/want in stdlib style) rendered as a proper two-pane diff; output
  click-through to `file:line`; panics show the decoded stack with the failing
  frame focused.
- **Coverage:** run-with-coverage at any granularity → `-coverprofile`
  rendered as gutter shading (covered/uncovered/partial), per-package % in the
  tree and status bar, uncovered-only navigation (⌥F8-style next-uncovered).
- **Benchmarks:** run from gutter/tree → results table (ns/op, B/op,
  allocs/op) with **per-workspace history** — re-running shows delta vs. last
  run (± % colored). `benchstat`-grade comparison; no time-series dashboards.
- **Fuzz:** run fuzz targets with a duration picker; new crash corpus entries
  surface as tree children linking to `testdata/fuzz/…` inputs; "debug this
  input" runs the target on the corpus file under Delve.
- **Watch mode:** setting-gated; on-save re-run of the saved file's package
  tests (never the world), race-honoring, with a quiet status-bar pulse
  rather than focus stealing.

#### Tasks

1. **Runner core.** `go test -json` executor + event parser → Testing API
   state machine; cancellation; env/flag composition (schemes, race toggle,
   per-run overrides).
2. **Discovery.** gopls symbol scan + static `t.Run` literal resolution;
   dynamic subtest attachment from run events.
3. **Explorer + gutters.** Tree with status/duration/filters; gutter run/debug
   icons at test and subtest precision; re-run-failed / re-run-last.
4. **Debug integration.** `mode: test` sessions with exact `-run` regex
   composition; NodeWatch test schemes honored.
5. **Failure rendering.** Output attachment, got/want diff pane, click-through
   locations, panic stack focus.
6. **Coverage.** Profile capture → gutter shading + tree/status percentages +
   next-uncovered navigation.
7. **Bench + fuzz.** Results table with history deltas; fuzz duration runs,
   corpus surfacing, debug-corpus-input.
8. **Watch mode.** Save-triggered package-scoped re-runs, setting-gated.

#### Acceptance criteria

- NodeWatch backend: full-module run populates the tree live; a table-driven
  subtest can be debugged individually by name; `with DB` scheme env applies.
- Failure shows a rendered got/want diff and jumps to the assertion line.
- Coverage gutters + % appear at file/package/module levels; navigation to
  next uncovered region works.
- Benchmark re-run shows ns/op delta vs. previous run.
- A fuzz crash produces a tree node whose input debugs under Delve in two
  clicks.

#### Out of scope

- CI orchestration, flaky-test quarantine, remote test sharding; non-`go test`
  frameworks.


---

<a id="14-task-12"></a>

# 14. Task 12 — Design system


> _source: `burrow/docs/architecture/12-design-system.md`_

### 12 — Design system: minimal, Xcode-calibre

> Part of the [Go IDE overhaul](00-overview.md). Depends on: 02. Effort: ~2 wk
> (plus a continuous polish budget across tasks 03–11).

#### Goal

Burrow looks and feels like a native macOS developer tool of Xcode's calibre:
one opinionated layout, two first-party themes, restrained chrome, precise
typography. Minimalism as a design stance, not just a feature count.

#### Design principles

1. **One layout, opinionated.** Navigation left, editor center, state right
   (the task 05 debug bar), console bottom. Users can hide panes, not invent
   layouts. No drag-anything-anywhere; fewer states to design means every
   state can be *finished*.
2. **Chrome earns its pixels.** One toolbar (the scheme bar), slim activity
   rail (5 items max: Explorer, Search, Git, HTTP, DB), no breadcrumb-bar +
   tab-bar + title-bar triplication — title bar and scheme bar merge (task 03
   patch), breadcrumbs live in the editor's top edge only.
3. **Native fidelity.** Real vibrancy where macOS provides it (sidebars),
   native traffic lights, system font stack (SF Pro / SF Mono defaults;
   editor font user-configurable with ligature support), native menus, correct
   ⌘-key conventions throughout. Keybinding defaults audit: Xcode muscle
   memory where it doesn't fight VS Code muscle memory (⌘R run, ⌘. stop,
   ⇧⌘O quick-open parity aliases).
4. **Two themes, finished.** `Burrow Light` and `Burrow Dark`, designed
   together: one hue family (warm neutral surfaces, a single gopher-teal
   accent), WCAG AA everywhere, semantic-token-complete for Go (types,
   interfaces vs. structs distinguishable, error paths subtly warm). No theme
   gallery — these two, correct, in both appearances (follows system).
5. **Motion is information.** 120–180 ms ease-out for reveal/collapse (debug
   bar on stop, doc viewer maximize), none elsewhere. No bouncing, no
   skeleton shimmer.
6. **Empty states teach.** Every panel's empty state is one sentence + one
   action (e.g. Oracle strip: "No notes for this code yet — Bootstrap the
   Oracle"). No blank grey rectangles.

#### Deliverables & tasks

1. **Design tokens.** `burrow-tokens.json` — spacing scale, radii, type ramp,
   elevation, the two palettes; consumed by themes and every burrow-* webview
   (single source; webviews must not hand-roll colors — lint for it).
2. **The two themes.** Full workbench + semantic-token coverage, built from
   tokens; contrast-audited (automated AA check in CI).
3. **Chrome patches.** Merged title/scheme bar spacing, slim activity rail,
   pane header simplification, vibrancy adoption — each a ledger entry with
   before/after screenshots.
4. **Iconography.** Single-weight outline icon set (SF-Symbols-adjacent
   geometry) for the rail, scheme bar, tree glyphs, and the app icon set
   (gopher-in-a-burrow mark; light/dark/tinted variants per macOS 26 specs).
5. **Webview cohesion pass.** HTTP workbench, DB explorer, doc viewer,
   visualizers restyled onto tokens — the app must not feel like four websites
   in a trench coat.
6. **Keybinding + menu audit.** Final default map, printed cheat-sheet page in
   Help; menu bar reduced per task 02 with items in macOS-conventional order.
7. **Polish gauntlet.** A recorded 10-minute demo path (open repo → run →
   break → inspect → docs → test → DB) reviewed frame-by-frame each release;
   the standing bar for "does this still look finished".

#### Acceptance criteria

- Both themes pass automated AA contrast on every color pair in use.
- Every webview renders exclusively from tokens (lint passes).
- The demo-path recording shows no default-VS-Code-blue, no mismatched
  spacing between native views and webviews, no unstyled empty states.
- A designer's review of the demo signs off against the six principles.

#### Out of scope

- User theme galleries/marketplace; Windows/Linux native-chrome work (they get
  the same themes but native-fidelity work is macOS-first); icon fonts for
  user extensions (there are none).


---

<a id="15-task-13"></a>

# 15. Task 13 — Packaging, signing, updates


> _source: `burrow/docs/architecture/13-packaging-signing-updates.md`_

### 13 — Packaging, signing, updates

> Part of the [Go IDE overhaul](00-overview.md). Depends on: 01. Effort: ~1 wk
> (minimal channel at M1; hardened by M4).

#### Goal

Burrow installs like a real Mac app and stays current without phoning anyone
but us: signed + notarized `.app`, reproducible CI builds, a self-hosted
update feed, Homebrew cask. Linux secondary.

#### Design

- **Targets:** macOS arm64 (primary), macOS x64 (Rosetta escape hatch),
  Linux x64/arm64 tarball + `.deb` (secondary; the fork builds them nearly
  free). No Windows at launch.
- **Build:** the upstream gulp `vscode-darwin-arm64` pipeline, invoked from
  GitHub Actions on tags; version = `burrow 0.x (upstream 1.yy)` — both
  visible in About. Reproducibility: pinned Node, pinned npm lockfile, build
  provenance attestation on artifacts.
- **Signing/notarization:** Developer ID certificate, hardened runtime,
  entitlements audit (Electron needs JIT; nothing else — no camera/mic/etc.),
  `notarytool` staple in CI. Secrets via GitHub OIDC → keychain, never in
  repo.
- **Updates:** VS Code's built-in updater pointed at **our own static feed**
  (`product.json` `updateUrl` → an S3/Pages-hosted JSON + artifact bucket).
  Channel model: `stable` only at launch (an `insiders` channel is config,
  not code, when wanted). Delta updates are a non-goal — full archive
  replace, Electron-style. The updater is the **only** sanctioned outbound
  connection at idle (task 01's zero-chatter audit gets this one exemption,
  user-disableable).
- **Distribution:** GitHub Releases (canonical), `brew install --cask burrow`
  (tap in the org), the launcher's "Open Backend IDE" page links the download
  when Burrow isn't detected (task 14).
- **Toolchain pins ride along:** each release pins its gopls/dlv versions
  (task 03); the update feed's release notes state them.

#### Tasks

1. **Release CI.** Tag → build (arm64/x64 mac, linux) → sign → notarize →
   staple → attest → upload to Releases + update bucket; dry-runnable.
2. **Update feed.** Static feed generator (version, sha256, url per platform),
   `updateUrl` wiring, stable-channel semantics, user setting to disable.
3. **Entitlements + audit.** Minimal entitlement set; re-run the task 01
   outbound-connection audit on the packaged, signed build.
4. **Brew cask + download page.** Tap automation on release; a one-page
   download site (also the target of the launcher's install link).
5. **Crash triage (opt-in only).** Electron crashpad dumps **kept local** with
   a "reveal in Finder + attach to GitHub issue" helper — no telemetry
   backchannel, consistent with the zero-chatter stance.
6. **Release runbook.** `RELEASING.md`: version bump, upstream-pin statement,
   gopls/dlv pins, smoke checklist (install fresh, open NodeWatch, run/debug),
   rollback procedure (feed points at previous artifact).

#### Acceptance criteria

- A tag produces, unattended: notarized universal-install artifacts, a working
  update from the previous version on a clean Mac, and a brew-installable cask.
- Gatekeeper: fresh download opens with no right-click-open dance.
- Packaged-build outbound audit: update feed only, and only when enabled.
- Rollback rehearsed once: feed rollback restores prior version on next check.

#### Out of scope

- Windows packaging; MAS distribution; delta/differential updates; any crash
  or usage telemetry service.


---

<a id="16-task-14"></a>

# 16. Task 14 — Stack migration


> _source: `burrow/docs/architecture/14-stack-migration.md`_

### 14 — Stack migration: retire the ide container

> Part of the [Go IDE overhaul](00-overview.md). Depends on: 04, 09. Effort: ~2 wk.

#### Goal

Cut the debugger stack over from "code-server in the `ide` container" to
"Burrow on the host", with every integration the stack promises — selection
flow, digest feed, Routes/Drills/Trace, mode toggle, emitter traffic —
preserved or improved. The stack's other tools (launcher, frontend, simulator,
db) keep working untouched throughout; the old `ide` service survives one
release behind a compose profile as the rollback.

#### What moves where

| Today (container) | After (host Burrow) |
|---|---|
| code-server UI :6100 | Burrow.app (no port) |
| backend under debug in-container :8080 | backend under debug **on host** :8080 |
| `DATABASE_URL=…@db:5432` | `…@localhost:5432` (compose `db` stays, port already published) |
| emitters → `http://ide:8080` | emitters → `http://host.docker.internal:8080` |
| selection read from `/config` mount | selection read from launcher `GET :6060/api/selection` |
| digest via docker-exec **into ide** | digest computed by Burrow on host, **posted to** the launcher |
| nodewatch-debugger .vsix in code-server | `burrow-nodewatch` built-in extension |
| launcher restarts `ide` on select | launcher just writes selection; Burrow follows it live |

#### Design

##### Selection (invariant preserved: launcher is the only /config writer)

- Burrow's `burrow-nodewatch` extension polls `GET :6060/api/selection`
  (2s, ETag) when the launcher is reachable. Selection change → non-modal
  prompt: "Launcher selected `<project>` — switch workspace?" (auto-follow
  setting for the single-user flow). Burrow never writes selection; picking a
  project inside Burrow calls `POST /api/select` and lets the flow come back
  around.
- Launcher's "Open Backend IDE" button: `burrow://open?folder=<host path>`
  (the task 01 `urlProtocol`), resolving the container `/projects/...` path to
  the host path via the launcher's own `PROJECTS_DIR` knowledge. Burrow not
  installed → the button falls back to the task 13 download page. The launcher
  stops restarting an ide container on selection change (tool-restart list
  shrinks by one).

##### Digest (direction reverses; writer stays the launcher)

Today `launcher/digest.js` docker-execs merkle's oracle digest inside the ide
container (it had the Go toolchain + warm module cache). The host has both,
Burrow manages them (task 03), so:

- Burrow runs `test/cmd/oracle --digest` on the host (command from repo
  config, same as today's exec line) and `POST`s the raw markdown to a new
  launcher endpoint `POST /api/digest/ingest`.
- `digest.js` keeps its **parser and cache** (`/config/digest.json`, grammar
  unchanged — fixture tests still pass) but drops the docker-exec plumbing;
  `POST /api/digest` (the old "refresh" trigger) returns `410` pointing at the
  new flow when no ide container exists.
- Consumers are untouched: Routes tree and `routes.generated.http` (task 09)
  read the same parsed JSON via `GET /api/digest`.

##### The nodewatch integration extension (port, don't rewrite)

`extension/src/*` moves into the fork as `extensions/burrow-nodewatch/`,
feature-for-feature:

- **Routes tree** — digest-fed, breakpoints anchored to handler **symbols**
  (DocumentSymbolProvider, task 04 function-breakpoint fallback; the stored-
  line-numbers ban stands).
- **Drills tree** and **MOCK↔LIVE toggle** — unchanged REST calls to the
  launcher (`POST /api/mode` stays the durable path; frontend `POST /api/mode`
  stays ephemeral).
- **Request Trace** — the DAP tracker now taps Burrow's own debug sessions
  (same `vscode.debug.registerDebugAdapterTrackerFactory` API), joining slog
  output with the frontend's `/api/netlog` on `X-Request-Id`; the task 09
  workbench's injected ids feed the same join.
- **Tool panels** — webview iframes to the sibling tools by full public origin
  (`http://${NW_PUBLIC_HOST:-localhost}:6080|6200|6101`). In Electron there is
  no code-server `/proxy/<port>` rewriting, so the old `asExternalUri`
  landmine defuses itself — but the full-origin rule remains the documented
  invariant for remote-host stacks.
- **`.vscode` seeding** — the entrypoint's seed job (launch/tasks/settings/
  api.http, never clobbering) becomes a first-open offer from the extension,
  sourcing the same `backend/vscode/*` files, with the compose-host
  `DATABASE_URL` variants flipped to `localhost` as the new default scheme
  order.

##### Compose + repo cleanup

- `ide` service and its `nw_go` / `nw_code_server` volumes move behind
  `profiles: ["legacy"]` for one release (`docker compose --profile legacy up`
  = old world, rollback documented), then delete. `pgweb` follows the same
  two-step retirement once the task 10 explorer ships.
- Emitters: `API_URL: http://host.docker.internal:8080` (+
  `extra_hosts: host-gateway` for Linux hosts).
- Launcher health proxy: backend health probes `host.docker.internal:8080/healthz`
  (label it "backend (host)"), tolerating "not running" as a normal state.
- `debugger/backend/` slims to: these docs, `vscode/` seeds, oracle prompts,
  and a `test/verify.mjs` updated to check the seeds + the new launcher
  contract instead of the Dockerfile/entrypoint.
- Root `README.md` + `CLAUDE.md` rewritten where they promise the old shape
  (ide container, :6100, PORT-collision lore, `asExternalUri` invariant
  scoped to its remaining webview-origin form).

#### Tasks

1. **Selection follow.** Poll/prompt/auto-follow in `burrow-nodewatch`;
   `burrow://open` handler + launcher button with install fallback;
   remove ide from the launcher's restart set.
2. **Digest reversal.** `POST /api/digest/ingest` (parse + write, launcher
   still sole writer); Burrow-side digest runner on scheme-bar refresh + oracle
   command; retire exec plumbing; keep parser fixtures green.
3. **Extension port.** Move `extension/src` into `extensions/burrow-nodewatch/`;
   re-wire tracker to native debug sessions; panels to full-origin webviews;
   first-open `.vscode` seeding with localhost-first schemes.
4. **Compose changes.** Legacy profile for ide+volumes, emitter retarget with
   `extra_hosts`, health-proxy update; `docker compose config -q` and the
   launcher tests stay green.
5. **Docs + invariants.** README/CLAUDE.md updates; migration note for
   existing users (what happens to `nw_go`/`nw_code_server` data: nothing —
   host Go caches take over).
6. **Cutover rehearsal.** Fresh machine: `docker compose up -d` (no ide) +
   install Burrow → pick project in launcher → Burrow opens it → breakpoint
   via Routes tree → emitter traffic hits it → trace joins → drill runs →
   mode flips. Then `--profile legacy` rollback rehearsal.

#### Acceptance criteria

- The full demo loop (select → open → breakpoint → traffic → trace → drill →
  mode flip) passes on a fresh machine with **no ide container running**.
- `launcher/test` and `launcher/digest` fixture tests pass with the reversed
  digest flow; `/config` writes still originate only from the launcher.
- Old world reachable via `--profile legacy` for exactly one release; its
  removal PR deletes `backend/Dockerfile`, `scripts/entrypoint.sh`, and the
  code-server config in one commit.
- Route breakpoints still bind by symbol after the port (no line numbers in
  any persisted state).

#### Out of scope

- Multi-user/remote-host stacks beyond keeping `NW_PUBLIC_HOST` working for
  the webview origins; Burrow-in-a-container (explicitly the thing we're
  ending).


---

<a id="17-readme"></a>

# 17. README


> _source: `burrow/README.md`_

### Burrow — a Go-first IDE

A native, Go-first IDE + debugger. A fork of
[Code - OSS](https://github.com/microsoft/vscode) (upstream README preserved as
[`README.upstream.md`](README.upstream.md)) stripped to Go development and
rebuilt around first-class Delve debugging, Go data-structure visualization, an
integrated HTTP workbench, a database explorer, offline Go docs, and an
agent-bootstrapped codebase Oracle.

> Replaces the container-based "backend debugger" (code-server) of the
> `debugger` stack with a host-native app. Lives at `debugger/burrow/` (this dir)
> as an independent git repo. Full 15-task plan:
> [`docs/architecture/`](docs/architecture/00-overview.md) (salvaged from the
> now-deleted `debugger/backend/`).

#### Status

**Task 01 — fork bootstrap & branding: done + verified.**

- [x] Fork pinned to upstream `1.128.0` (see [`UPSTREAM.md`](UPSTREAM.md))
- [x] Burrow identity in `product.json`; telemetry/voice endpoints removed
- [x] Governance: patch ledger, `BUILDING.md`, third-party notices, `Makefile`
- [x] First built-in extension `extensions/burrow-core` (+ patch `0001`)
- [x] `npm ci` + build + branded app boots; `burrow-core` activates

**Task 02 — strip to Go-only: bulk done + boot-verified.**

- [x] `tools/inventory.js` → [`STRIP.md`](STRIP.md) keep/remove ledger (32 keep / 64 remove)
- [x] 64 built-in extension dirs deleted (99 → 35): non-Go languages, web,
      notebooks, JS task-runners, accounts/remote, surplus themes, Node debugger
- [x] Build re-wired to match (patches `0002`); js-debug dropped from `product.json`
- [x] Leaf contributions stripped — surveys, issue reporter, remote tunnel (patch `0003`)
- [ ] Non-leaf contributions (marketplace view, sync, remote, notebook core, walkthroughs)
- [ ] Settings/command/menu pruning · terminal defaults · startup-budget numbers
- [ ] **Deferred:** full Copilot/chat excision (`defaultChatAgent` is load-bearing here)

Later tasks (03–14) add the Go toolchain, Delve engine, right-hand debug
inspector, visualizers, docs viewer, Oracle, HTTP workbench, DB explorer, tests,
design system, packaging, and the stack cutover.

#### Layout

| Path | What |
|------|------|
| `product.json` | Burrow identity + kill-switches (layer 1: config) |
| `patches/` | numbered core-source patch ledger (layer 3) |
| `extensions/burrow-*` | Burrow's built-in extensions (layer 4 — most new code) |
| `build/burrow/` | Burrow-specific build tooling (e.g. `check-ledger.js`) |
| `UPSTREAM.md` | the upstream pin + rebase procedure |
| `BUILDING.md` | how to build (Node pin, `make deps/dev/dist`) |

Everything else is upstream VS Code, changed only through the four layers
documented in [`UPSTREAM.md`](UPSTREAM.md).

#### Launch

Requires Node **24.17.0** (`.nvmrc`). This repo installed it outside Homebrew
(brew was broken) at `~/.local/burrow-node` — put it on `PATH` first:

```sh
cd ~/Projects/debugger/burrow
export PATH="$HOME/.local/burrow-node/current/bin:$PATH"   # or: fnm use
node -v                                                    # must print v24.17.0

make deps    # first time only — npm ci (Electron + native modules, slow)
make dev     # compiles if needed, then launches the branded "Burrow — Go IDE" app
```

`make dev` runs `scripts/code.sh`, which opens the current folder. To open a Go
project, pass it after the flags — or just `File → Open Folder` once it's up:

```sh
./scripts/code.sh /path/to/your/go/project
```

**Run it from a normal Terminal, not from inside VS Code.** VS Code's integrated
terminal exports `ELECTRON_RUN_AS_NODE` + `VSCODE_*`, which make the Electron app
boot as plain Node and crash (`… does not provide an export named 'Menu'`). If
you must launch from within VS Code, scrub those first:

```sh
for v in $(env | grep -oE '^(VSCODE|ELECTRON)[A-Z_]*' | sort -u); do unset "$v"; done
./scripts/code.sh
```

On macOS also keep `--user-data-dir` short (e.g. `/tmp/bw`) — the instance IPC
socket overflows the 103-char unix-socket limit under deep paths.

##### Package a standalone .app

```sh
make dist    # gulp vscode-darwin-<arch> → .build/electron/Burrow — Go IDE.app
```

See [`BUILDING.md`](BUILDING.md) for the full toolchain notes.


---

<a id="18-upstream"></a>

# 18. UPSTREAM (pin & rebase)


> _source: `burrow/UPSTREAM.md`_

### Upstream pin & rebase procedure

Burrow is a fork of [Code - OSS](https://github.com/microsoft/vscode).

#### Current pin

| | |
|---|---|
| Upstream | `microsoft/vscode` |
| Tag | **`1.128.0`** |
| Pristine branch | `upstream-v1.128` (never commit onto this) |
| Work branch | `main` (all Burrow changes live here) |
| Cloned | shallow (`--depth 1`) — unshallow before the first rebase (below) |

#### Branch model

- `upstream-v1.128` — the pristine upstream tree at the pinned tag. Zero Burrow
  commits. Used as the merge-base/reference for rebases and for regenerating the
  patch ledger's "upstream files touched" audit.
- `main` — Burrow. Everything we change lands here, organized by the four
  change layers (see [`patches/README.md`](patches/README.md) and the
  architecture docs in `../backend/docs/architecture/`).

#### Change layers (rebase cost, cheapest first)

1. **Configuration** — `product.json`, build flags. Tracked by git; no source
   diff. (Done in task 01: Burrow identity + chatter removal.)
2. **Deletions** — built-in extensions / workbench contributions removed
   (task 02). Conflict-free on rebase.
3. **Core patches** — small numbered diffs, each with a `patches/` ledger entry.
   Target < 15 patches, each < 300 lines.
4. **Built-in extensions** — `extensions/burrow-*`, written against the stable
   extension API. Where ~80% of new code lives; insulated from upstream churn.

#### Rebasing onto a newer upstream (quarterly)

1. Unshallow if needed: `git fetch --unshallow origin` (origin = microsoft/vscode).
2. `git fetch --tags origin` and pick the new stable tag `1.YY.Z`.
3. `git branch upstream-v1.YY 1.YY.Z`
4. `git rebase --onto upstream-v1.YY upstream-v1.128 main`
   (replays Burrow's commits from the old base onto the new one).
5. Resolve conflicts **layer by layer**: layer-2 deletions re-apply as
   still-deleted; layer-3 core patches are where conflicts concentrate — for
   each, re-read its `patches/NNNN-*.md` rationale and the upstream files it
   lists. Layer-4 extensions rarely conflict (stable API).
6. Update this file's pin, rebuild, run the smoke path, update
   `patches/README.md` "last verified against" per entry.

Cadence: pin to one stable minor; rebase **quarterly**, not every release.


---

<a id="19-strip"></a>

# 19. STRIP ledger


> _source: `burrow/STRIP.md`_

### STRIP.md — Task 02 keep/remove ledger

> Generated by `node tools/inventory.js` over the UNION of on-disk
> extensions and the `DECISIONS` map, so it is stable across the strip:
> run it to plan (all removes `pending`), and again to verify (removes
> flip to `✓ removed`, a vanished keeper is flagged). Do not hand-edit the
> tables — edit `DECISIONS` in the script and regenerate. The commit plan
> and Startup budget prose are filled in by hand.

Upstream pin: **1.128.0**. Classified: **96** (keep 28, remove 64 [64 done], dev/test 4).

#### Keep

| Extension | Contributes | Why |
|---|---|---|
| `burrow-core` | — | our own extension (task 01) |
| `configuration-editing` | lang:jsonc/json | IntelliSense for settings/launch/tasks JSON |
| `debug-server-ready` | dbg:* | adapter-agnostic auto-open on server-ready (backend dev) |
| `diff` | lang:diff | diff/patch grammar — cheap, git artifacts |
| `docker` | lang:dockerfile | Dockerfile + compose (ledger: keep Dockerfile) |
| `dotenv` | lang:dotenv | .env files — Go backends read them |
| `extension-editing` | lang:ignore | lints our burrow-* package.json authoring |
| `git` | — | SCM daily driver |
| `git-base` | lang:git-commit/git-rebase/ignore | git extension dependency (repo picker/API) |
| `go` | lang:go | the point — Go language + grammar |
| `ini` | lang:ini/properties | .ini/.gitconfig/.editorconfig-adjacent configs |
| `javascript` | lang:javascriptreact/javascript/jsx-tags | bare JS grammar for the odd .js config (ledger) |
| `json` | lang:json/jsonc/jsonl/snippets | JSON grammar — configs everywhere |
| `json-language-features` | — | JSON schema validation for configs |
| `log` | lang:log | log-file colorizer — we read logs |
| `make` | lang:makefile | Makefiles — common in Go repos |
| `markdown-basics` | lang:markdown | READMEs + these docs (ledger: keep markdown) |
| `markdown-language-features` | notebook | markdown preview (ledger: keep preview) |
| `media-preview` | — | view images/diagrams in the repo (cheap, non-language) |
| `merge-conflict` | — | in-editor conflict resolution — part of git flow |
| `references-view` | — | find-all-references / call hierarchy tree (gopls) |
| `search-result` | lang:search-result | search-results editor highlighting |
| `shellscript` | lang:shellscript | bash scripts (ledger: keep shell) |
| `sql` | lang:sql | migrations (ledger: keep SQL) |
| `terminal-suggest` | — | completion in the integrated bash terminal |
| `theme-defaults` | 11 theme | default color + icon theme — task 12 replaces |
| `theme-seti` | 1 theme | default file-icon theme — task 12 replaces |
| `yaml` | lang:dockercompose/yaml | compose / k8s / CI configs |

#### Remove (delete extension dir — layer 2)

Grouped into cohesive `strip:` commits below (see Commit plan). Status
`pending` = still on disk, `✓ removed` = deleted.

| Extension | Contributes | Status | Why |
|---|---|---|---|
| `bat` | — | ✓ removed | non-Go language (Windows batch) |
| `clojure` | — | ✓ removed | non-Go language |
| `coffeescript` | — | ✓ removed | non-Go language |
| `copilot` | — | ✓ removed | Copilot/chat hooks (ledger: no integrated AI yet) |
| `cpp` | — | ✓ removed | non-Go language |
| `csharp` | — | ✓ removed | non-Go language |
| `css` | — | ✓ removed | non-Go language (web) |
| `css-language-features` | — | ✓ removed | CSS language service (web) |
| `dart` | — | ✓ removed | non-Go language |
| `debug-auto-launch` | — | ✓ removed | Node auto-attach debugger |
| `emmet` | — | ✓ removed | HTML/CSS abbreviation (web) |
| `fsharp` | — | ✓ removed | non-Go language |
| `github` | — | ✓ removed | GitHub PR/publish integration (ledger) |
| `github-authentication` | — | ✓ removed | GitHub auth (ledger) |
| `groovy` | — | ✓ removed | non-Go language |
| `grunt` | — | ✓ removed | JS task runner |
| `gulp` | — | ✓ removed | JS task runner |
| `handlebars` | — | ✓ removed | templating (web) |
| `hlsl` | — | ✓ removed | shader language |
| `html` | — | ✓ removed | non-Go language (web) |
| `html-language-features` | — | ✓ removed | HTML language service (web) |
| `ipynb` | — | ✓ removed | Jupyter notebooks |
| `jake` | — | ✓ removed | JS task runner |
| `java` | — | ✓ removed | non-Go language |
| `julia` | — | ✓ removed | non-Go language |
| `latex` | — | ✓ removed | non-Go language |
| `less` | — | ✓ removed | CSS preprocessor (web) |
| `lua` | — | ✓ removed | non-Go language |
| `markdown-math` | — | ✓ removed | KaTeX in preview — not needed for Go docs |
| `mermaid-markdown-features` | — | ✓ removed | diagram preview — now entangled with chat contribs |
| `microsoft-authentication` | — | ✓ removed | MSA auth for sync/marketplace |
| `notebook-renderers` | — | ✓ removed | notebook output renderers |
| `npm` | — | ✓ removed | npm-scripts view + JS task provider (ledger) |
| `objective-c` | — | ✓ removed | non-Go language |
| `perl` | — | ✓ removed | non-Go language |
| `php` | — | ✓ removed | non-Go language |
| `php-language-features` | — | ✓ removed | PHP language service |
| `powershell` | — | ✓ removed | non-Go language |
| `prompt-basics` | — | ✓ removed | chat .prompt.md grammar — chat is stripped |
| `pug` | — | ✓ removed | templating (web) |
| `python` | — | ✓ removed | non-Go language |
| `r` | — | ✓ removed | non-Go language |
| `razor` | — | ✓ removed | templating (web/.NET) |
| `restructuredtext` | — | ✓ removed | non-Go markup (Python docs) |
| `ruby` | — | ✓ removed | non-Go language |
| `rust` | — | ✓ removed | non-Go language |
| `scss` | — | ✓ removed | CSS preprocessor (web) |
| `shaderlab` | — | ✓ removed | shader language |
| `simple-browser` | — | ✓ removed | embedded web browser — task 09 HTTP workbench supersedes |
| `swift` | — | ✓ removed | non-Go language |
| `theme-abyss` | — | ✓ removed | surplus stock theme — task 12 ships ours |
| `theme-kimbie-dark` | — | ✓ removed | surplus stock theme — task 12 ships ours |
| `theme-monokai` | — | ✓ removed | surplus stock theme — task 12 ships ours |
| `theme-monokai-dimmed` | — | ✓ removed | surplus stock theme — task 12 ships ours |
| `theme-quietlight` | — | ✓ removed | surplus stock theme — task 12 ships ours |
| `theme-red` | — | ✓ removed | surplus stock theme — task 12 ships ours |
| `theme-solarized-dark` | — | ✓ removed | surplus stock theme — task 12 ships ours |
| `theme-solarized-light` | — | ✓ removed | surplus stock theme — task 12 ships ours |
| `theme-tomorrow-night-blue` | — | ✓ removed | surplus stock theme — task 12 ships ours |
| `tunnel-forwarding` | — | ✓ removed | remote tunnels / port forwarding (code-server-era) |
| `typescript-basics` | — | ✓ removed | TS grammar — not in Go repos (JS grammar kept) |
| `typescript-language-features` | — | ✓ removed | heavy TS/JS language service (ledger: drop language services) |
| `vb` | — | ✓ removed | non-Go language |
| `xml` | — | ✓ removed | rare in Go repos — minimalism |

#### Remove (product-level — edit product.json)

| Entry | Where | Status | Why |
|---|---|---|---|
| `ms-vscode.js-debug` | product.json builtInExtensions | ✓ done | Node/JS debugger — Delve is the only debugger aboard |
| `ms-vscode.js-debug-companion` | product.json builtInExtensions | ✓ done | js-debug browser companion |
| `ms-vscode.vscode-js-profile-table` | product.json builtInExtensions | ✓ done | js-debug profile viewer |
| `GitHub.copilot / copilot-chat (defaultChatAgent)` | product.json defaultChatAgent | DEFERRED | integrated AI — not yet (ledger); load-bearing config, excise separately |

#### Dev/test fixtures (left in place)

Not shipped in the product build (excluded by `build/lib/extensions.ts`).
Deleting them buys no runtime win and risks breaking `npm test`, so they stay.

| Extension | Contributes | Why |
|---|---|---|
| `vscode-api-tests` | dbg:mock, chat, notebook | VS Code API test suite — not shipped; keep to not break tests |
| `vscode-colorize-perf-tests` | — | colorizer perf suite — not shipped |
| `vscode-colorize-tests` | — | colorizer test suite — not shipped |
| `vscode-test-resolver` | — | remote test resolver fixture — not shipped |

#### Commit plan (bisectable `strip:` sequence)

The 64 dir deletions land as cohesive category commits (not 64 micro-commits);
each leaves the app booting, so the sequence stays bisectable by subsystem.

1. `build: burrow-curated extension compilations list` — prune stripped TS
   extensions from `build/gulpfile.extensions.ts` (patch 0001).
2. `strip: remove non-Go language extensions` — bat, clojure, coffeescript,
   cpp, csharp, css(+lang), dart, fsharp, groovy, handlebars, hlsl, html(+lang),
   java, julia, latex, less, lua, objective-c, perl, php(+lang), powershell,
   pug, python, r, razor, restructuredtext, ruby, rust, scss, shaderlab,
   swift, typescript-basics, typescript-language-features, vb, xml, markdown-math.
3. `strip: remove notebook + web-preview subsystems` — ipynb, notebook-renderers,
   mermaid-markdown-features, simple-browser, emmet.
4. `strip: remove JS task runners + npm scripts` — grunt, gulp, jake, npm.
5. `strip: remove accounts / remote / AI` — github, github-authentication,
   microsoft-authentication, copilot, prompt-basics, tunnel-forwarding,
   debug-auto-launch.
6. `strip: remove surplus stock themes` — abyss, kimbie-dark, monokai,
   monokai-dimmed, quietlight, red, solarized-dark, solarized-light,
   tomorrow-night-blue (keep theme-defaults + theme-seti until task 12).
7. `strip: product.json — drop js-debug builtInExtensions` — remove the three
   js-debug entries. Delve is the only debugger aboard.
8. `build: unwire removed extensions from the build` — prune esbuildMediaScripts
   (`build/lib/extensions.ts`), the copilot npm scripts (`package.json`), and
   guard the copilot hygiene check (`build/hygiene.ts`).

**Deferred — Copilot/chat excision (its own task).** This upstream is a
chat-centric fork: `product.defaultChatAgent` is load-bearing — core services
(accounts, welcomeOnboarding, sessions) read it synchronously at startup and
crash if it is absent. The copilot *extension dir* is deleted and js-debug is
gone, but the `defaultChatAgent` config is kept so the app boots. Fully
excising chat (product.json config + `src/vs/workbench/contrib/chat`, sessions,
the chat npm deps) is a substantial follow-on tracked separately.

Other layer-3 workbench-contribution patches (marketplace/sync/remote/notebook/
issue-reporter UI), settings/command/menu pruning, and terminal defaults are
their own follow-on `strip:` commits (task 02 sub-tasks 3–7).

#### Startup budget (fill in by hand)

| Metric | Stock 1.128 | Burrow (post-strip) | Δ |
|---|---|---|---|
| Activated built-ins (onStartupFinished) | TBD | TBD | TBD |
| Cold start to window (ms) | TBD | TBD | TBD |
| Main-process RSS at idle (MB) | TBD | TBD | TBD |



---

<a id="20-patches"></a>

# 20. Patch ledger


> _source: `burrow/patches/README.md`_

### Core patch ledger

**Layer 3** of the fork strategy (see [`../UPSTREAM.md`](../UPSTREAM.md)):
small, numbered diffs against upstream VS Code *source* that can't live as a
built-in extension or a config change.

#### The rule

- Every commit that edits files under `src/`, `build/`, or other upstream
  source **must** have a ledger entry here. CI rejects core-source diffs
  without one (see `../build/burrow/check-ledger.js`, task 01).
- Budget: **< 15 patches total, each < 300 lines.** Bigger ⇒ move the logic to
  a built-in extension (`extensions/burrow-*`, layer 4).
- Config-only changes (`product.json`, build flags) are **layer 1** — tracked
  by git, *not* listed here.
- Pure deletions of built-in extensions / contributions are **layer 2** —
  listed in `../STRIP.md` (task 02), not here.

#### Entry format

Each patch is `NNNN-short-slug.md`:

```
### 0001 — <title>

- **Layer:** 3 (core patch)
- **Task:** <NN> (architecture doc)
- **Upstream files touched:** src/vs/…/foo.ts, src/vs/…/bar.ts
- **Size:** ~<N> lines
- **Last verified against:** upstream 1.128.0

#### Why
<one paragraph: why this cannot be a config change or an extension>

#### What
<what the diff does, at a level that survives a rebase conflict>

#### Rebase notes
<hazards when upstream changes these files>
```

#### Ledger

| # | Title | Task | Files | Size | Status |
|---|-------|------|-------|------|--------|
| [0001](0001-register-burrow-core-extension.md) | Curate the extension compilation list (burrow-core; strip) | 01, 02 | build/gulpfile.extensions.ts | ~24 lines | active |
| [0002](0002-strip-unwire-removed-extensions.md) | Unwire removed extensions from the build | 02 | build/lib/extensions.ts, package.json, build/hygiene.ts | ~20 lines | active |
| [0003](0003-strip-leaf-contributions.md) | Strip leaf workbench contributions (surveys, issue, tunnel, sync) | 02 | workbench.common.main.ts, workbench.desktop.main.ts | 7 imports | active |

Task 02 (strip to Go-only) deletes 64 built-in extension dirs (layer 2, no
ledger entry each) and drops the js-debug `builtInExtensions` from `product.json`
(layer 1 config). The only core-source touches it needs are the two build-wiring
patches above — both pure deletions/guards that keep the build pointed only at
extensions that still exist. The Copilot/chat product-config + `contrib/chat`
excision is deferred (see 0002 → "Not done here"). The next core patches land in
task 03 (scheme-bar toolbar host) and task 05 (right-hand debug layout).


---


> _source: `burrow/patches/0001-register-burrow-core-extension.md`_

### 0001 — Curate the extension compilation list (burrow-core; strip)

- **Layer:** 3 (core patch — build manifest)
- **Task:** 01 (fork bootstrap & branding); extended by 02 (strip to Go-only)
- **Upstream files touched:** `build/gulpfile.extensions.ts`
- **Size:** ~24 lines (1 add + 22 removed + a comment)
- **Last verified against:** upstream 1.128.0

#### Why

Built-in extension **packaging** auto-discovers via
`glob.sync('extensions/*/package.json')`, but **TypeScript compilation** uses an
explicit hardcoded `compilations` array in `build/gulpfile.extensions.ts` (the
auto-glob is commented out upstream, line ~49). A new `extensions/burrow-*`
written in TS is not compiled unless registered there. This cannot be a config
change or live in the extension itself — it is upstream build wiring.

#### What

Adds `'extensions/burrow-core/tsconfig.json'` to the `compilations` array
(alphabetically first). Every future `extensions/burrow-*` written in TS adds
one analogous line here — this entry covers the pattern, not just the one file.

**Task 02 extension:** the same array is the curated source of truth for which
TS extensions compile, so the strip prunes it in lockstep with deleting dirs —
the 22 entries for removed extensions (css/html-language-features, emmet, github,
grunt/gulp/jake, ipynb, markdown-math, mermaid, microsoft-authentication,
notebook-renderers, npm, php-language-features, simple-browser, tunnel-forwarding,
typescript-language-features, debug-auto-launch) are gone. A stale entry points
gulp at a missing `tsconfig.json` and fails the build, so this must move with the
deletions. A prose comment on the array records the rule.

#### Rebase notes

- If upstream re-enables the auto-glob (uncomments line ~49), this whole array
  disappears and the registration becomes unnecessary — drop this patch.
- If upstream reorders/reformats the array, re-add the burrow line; order is
  cosmetic (alphabetical).
- Keep `burrow-*` entries grouped and alphabetized so the rebase diff is a
  clean insertion, not an interleave.


---


> _source: `burrow/patches/0002-strip-unwire-removed-extensions.md`_

### 0002 — Unwire removed extensions from the build

- **Layer:** 3 (core patch — build wiring)
- **Task:** 02 (strip to Go-only)
- **Upstream files touched:** `build/lib/extensions.ts`, `package.json`,
  `build/hygiene.ts`
- **Size:** ~20 lines net removed
- **Last verified against:** upstream 1.128.0

#### Why

Deleting an extension dir (layer 2) is not enough when the build names that dir
in a hardcoded list. Three such references, none glob-discovered, would each
break `npm run compile` / `make verify` against a missing path:

1. **`build/lib/extensions.ts` → `esbuildMediaScripts`** — an explicit array of
   webview/notebook esbuild entrypoints. It named `ipynb`, `markdown-math`,
   `mermaid-markdown-features`, `notebook-renderers`, and `simple-browser`
   (all removed). `compile-extension-media` fails with
   `Cannot find module '.../ipynb/esbuild.notebook.mts'` until these are pruned.
   Only the three kept `markdown-language-features` entries remain.
2. **`package.json` scripts** — `compile-copilot` / `watch-copilot` (and the
   `copilot:setup` / `copilot:get_token` helpers) shell into
   `extensions/copilot`, which is deleted. `npm run compile` fanned out to
   `compile-copilot` and failed. The copilot legs are removed from `compile`,
   `build-fast`, `watch`, and `watch-transpile`, and the dead script entries
   deleted.
3. **`build/hygiene.ts` → `checkCopilotEnginesVersion`** — reads
   `extensions/copilot/package.json` unconditionally and throws once the file is
   gone. Guarded to return clean (nothing to check) when the copilot extension
   is absent.

#### What

- Prune the five removed entries from `esbuildMediaScripts`; add a comment
  recording the keep-in-lockstep rule.
- Drop `compile-copilot` / `watch-copilot` / `watch-copilotd` /
  `kill-watch-copilotd` / `copilot:setup` / `copilot:get_token` and remove the
  copilot legs from the composite `compile` / `build-fast` / `watch` /
  `watch-transpile` scripts.
- Early-return `checkCopilotEnginesVersion` when
  `extensions/copilot/package.json` does not exist.

#### Not done here (deferred)

The **Copilot/chat product-config and `src/vs/workbench/contrib/chat` excision**
is a separate task. This upstream is chat-centric: `product.defaultChatAgent` is
load-bearing — accounts (`defaultAccount.ts`), `welcomeOnboarding`, and the
sessions services read it synchronously at startup and crash if it is absent.
The copilot *extension dir* and the js-debug *builtInExtensions* are removed, but
`defaultChatAgent` is intentionally kept so the app boots. The copilot **npm
dependencies** (`@github/copilot*`, `@vscode/copilot-api`) and the Azure CI
copilot pipelines are also left in place for that follow-on.

#### Rebase notes

- If upstream converts `esbuildMediaScripts` to a glob, drop that hunk.
- If upstream renames the copilot npm scripts or the hygiene check, re-apply the
  same shape (remove copilot legs / guard the missing-file read).
- All three hunks are deletions or guards — low conflict risk; re-derive from the
  keep/remove ledger (`STRIP.md`) if upstream reshuffles.


---


> _source: `burrow/patches/0003-strip-leaf-contributions.md`_

### 0003 — Strip leaf workbench contributions (surveys, issue, tunnel, sync)

- **Layer:** 3 (core patch — workbench contribution wiring)
- **Task:** 02 (strip to Go-only)
- **Upstream files touched:** `src/vs/workbench/workbench.common.main.ts`,
  `src/vs/workbench/workbench.desktop.main.ts`
- **Size:** 7 side-effect imports commented out
- **Last verified against:** upstream 1.128.0

#### Why

Several subsystems on task 02's remove list are not extensions — they are
workbench *contributions* compiled into the shell, registered purely by a
side-effect `import` in the workbench entry point. Removing that import
un-registers the contribution (no view, command, or status-bar entry) without
touching the contribution's own code. These three are **leaf** contributions —
nothing else load-depends on their registration:

- `surveys/browser/nps` + `surveys/browser/languageSurveys` (common) and
  `surveys/browser/survey` (desktop) — CES/NPS feedback nags. On the remove list
  ("feedback/survey surfaces").
- `issue/electron-browser/issue` (desktop) — the issue reporter + "Report
  Issue" command. Not a Go-IDE surface.
- `remoteTunnel/electron-browser/remoteTunnel` (desktop) — "Remote Tunnel
  Access" (code-server-era); its `tunnel-forwarding` extension is already gone.
- `userDataSync/browser/userDataSync` (common) + `.../electron-browser/…`
  (desktop) — Settings Sync UI. The `configurationSync` store is already null in
  this OSS base, so sync has no backend; this removes the "Turn on Settings
  Sync" commands/views. The contribution registers no service (side-effect only),
  and the underlying `platform/userDataSync` service is untouched.

#### What

Comments out the five side-effect imports (kept as `// burrow(strip 02): …`
lines so the rebase diff shows exactly what upstream had). No other file
imports these for their side effect, so the contributions drop from the bundle.

#### Scope note

Burrow boots the **standard** workbench (`workbench.desktop.main.ts`). This fork
also has an alternate `src/vs/sessions/*.main.ts` (agent-sessions/chat surface)
that imports the same three contributions; those are left untouched here and are
part of the deferred Copilot/chat excision (see 0002 → "Not done here").

#### Not done here (bigger, non-leaf — deferred)

- **Marketplace browse/install** (`contrib/extensions`) — the Extensions view is
  load-bearing for enable/disable of built-ins; needs surgical removal of the
  gallery/search/sideload paths, not the whole contrib. (`extensionsGallery` is
  already null in product.json, so browse is already non-functional.)
- **Settings Sync** (`contrib/userDataSync`) — has cross-contrib consumers.
- **Remote** (`contrib/remote`) status indicator/commands — infra with consumers.
- **Notebook** core (`contrib/notebook`) — many dependents; `.ipynb` is already
  unopenable with the ipynb extension gone.
- Walkthroughs / getting-started (`welcomeGettingStarted` provides the startup
  page, which injects `IOnboardingService`).

#### Rebase notes

- If upstream moves a survey/issue/tunnel import, re-comment it at the new site.
- Re-derive the target list from task 02's remove ledger if upstream reshuffles
  the contribution graph.


---

