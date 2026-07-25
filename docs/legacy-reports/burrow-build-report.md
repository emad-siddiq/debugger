# Burrow — Build Report

_Generated 2026-07-13, updated 2026-07-23. Snapshot of everything built so far on **Burrow**, the
host-native Go-first IDE that replaces the container `backend` debugger._

---

## Note: the architecture plan was salvaged into the fork

`backend/` was deleted, restored, and deleted again — but its **master plan was
salvaged first**. The full 15-task Burrow plan (`00-overview.md` + tasks 01–14:
Delve engine, debug inspector, visualizers, Go docs, Oracle, HTTP workbench, DB
explorer, tests, design system, packaging, cutover) now lives **inside the fork**
at **`burrow/docs/architecture/`**. The old container `backend/` folder itself is
gone for good.

---

## What Burrow is

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

### Location & repo shape

- Lives at **`~/Projects/debugger/burrow/`** (moved in-tree 2026-07-13 from the
  old `~/Projects/burrow`).
- It is a **nested independent git repo** — 4.5 GB, own history, branches
  `main` (Burrow work) + `upstream-v1.128` (pristine tag), `origin` →
  microsoft/vscode for rebasing onto future releases.
- `debugger/` itself is **not** git-initialized. If it ever is, `burrow/` must
  be gitignored or added as a submodule (nested `.git`).

### Four change layers (the fork discipline)

1. **Config** — `product.json` (Burrow identity, kill-switches).
2. **Deletions** — removed built-in extension dirs.
3. **Core patches** — numbered ledger under `patches/NNNN-*.md` (enforced by
   `build/burrow/check-ledger.js`).
4. **Built-in extensions** — `extensions/burrow-*` (where most new code lands).

---

## Task 01 — fork bootstrap & branding ✅ done + verified

- Fork pinned to upstream **1.128.0** (`UPSTREAM.md`).
- Burrow identity in `product.json`; telemetry / voice endpoints removed.
- Governance scaffolding: patch ledger, `BUILDING.md`, third-party notices,
  `Makefile`.
- First built-in extension **`extensions/burrow-core`** (patch `0001`).
- `npm ci` + build + branded **"Burrow — Go IDE.app"** boots; `burrow-core`
  activates on `onStartupFinished`.

---

## Task 02 — strip to Go-only ✅ bulk done + boot-verified

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

### Task 02 — what remains (sub-tasks 3–7)

- [ ] Non-leaf contribution strips: marketplace/extensions-view (browse/install/
      sideload), `contrib/remote`, `contrib/notebook` core, walkthroughs/
      getting-started.
- [ ] Settings-surface pruning; command-palette + menu-bar audit.
- [ ] Startup-budget numbers (needs a stock VS Code baseline boot to compare).
- [ ] Terminal PATH-inheritance polish.

### Deferred as its own task — full Copilot/chat excision

This upstream is **chat-centric**: `product.defaultChatAgent` is **load-bearing**
— removing it crashes core services at startup (`welcomeOnboarding` module-level
`assertDefined`, then `defaultAccount.ts` reading `.chatExtensionId`). So the
copilot *extension dir* is deleted but the `defaultChatAgent` *config is kept* so
the app boots. Fully excising chat (config + `src/vs/workbench/contrib/chat` +
the second `src/vs/sessions/*` entry point + `@github/copilot*` /
`@vscode/copilot-api` deps + Azure copilot CI) is a substantial follow-on.

---

## Task progress (updated 2026-07-23; specs live in `burrow/docs/architecture/`)

First slices of most tracks now EXIST as built-in `extensions/burrow-*`
extensions (68 commits on burrow `main`): `burrow-go-debug` (task 04 first
slice — dlv dap bridge + envFile + macOS dev-mode fail-fast), `burrow-go-test`
(task 11 — explorer + runner, module-root aware), `burrow-http` (task 09 —
.http workbench + Postman import), `burrow-db` (task 10 — Postgres explorer,
zero-config DSN discovery + pg driver), `burrow-docker`, `burrow-fullstack`
(M6 ⚡ db + dlv + FD-live orchestrator), `burrow-oracle`, `burrow-go-inspect`/
`-viz`/`-docs`/`-nav`, `burrow-theme-xcode`, and the task-15
`burrow-frontend-debugger` (+ `tools/frontend-debugger`) with gallery,
isolation (mock+live), samples, and the W6 maximized/design-layout surfaces.
All activity-bar surfaces were live-verified against `~/Projects/merkle` +
its `infra/` stack on 2026-07-23 (see
`.claude/docs/convos/2026/07/22/isolation-preview-404-targetbase-fix.md`).
Remaining large items: deep task 03 (scheme bar), the rest of 04–06
(breakpoint matrix, right-hand inspector, visualizer depth), 12–14
(design/packaging/cutover). Known machine blocker: Go debugging needs the
user's one-time `sudo DevToolsSecurity -enable`.

---

## Build & launch (quick reference)

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

## Git / commit state

**68 commits on burrow `main`** as of 2026-07-23 (the earlier "nothing is
committed" state is history). `STRIP.md` carries the grouped bisectable
`strip:` commit plan. Ledger: patches 0001 / 0002 / 0003.

## Source-of-truth files

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
