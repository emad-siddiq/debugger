# Task 03 — implementation plan

> TASK 03 — First-class Go toolchain (gopls, scheme bar, tool manager, modules)

Build-ready plan from the parallel planning pass (ultracode run), grounded in the current tree.

## Layer breakdown

**Layer 1 (config — git-tracked, no ledger):** `product.json` tool-pin constants (gopls v0.21.1 / dlv v1.27.0, matched to the Go minor) + `burrow.tools.useSystem` default; `[go]` format-on-save / organizeImports in `burrow-core` `configurationDefaults`; go-base wired into `build/gulpfile.extensions.ts` compilations.

**Layer 2 (deletions — STRIP.md, no per-entry ledger):** none new. Note: go-base's telemetry/survey/tool-nag/debugger stripping happens **in-tree within the vendored fork** (documented in `extensions/go-base/UPSTREAM.md`), not as an `extensions/*` dir deletion, so it is not a STRIP.md row.

**Layer 3 (core patch WITH ledger — patch 0010):** the scheme-bar **title-bar toolbar host** in `src/vs/workbench/browser/parts/titlebar/titlebarPart.ts`. This is the one core-source touch task 03 needs (README already names it as the next patch): a mount region + contribution point the `burrow-go-core` extension fills with the Run/Stop/Debug/scheme-picker/race controls. Keep it a host-only patch (<40 lines) — all logic lives in the extension so the patch survives rebases; add the 0010 row to `patches/README.md`.

**Layer 4 (built-in extensions — ~80% of the code):** (a) **`extensions/go-base`** — vendored, pinned vscode-go providing gopls client wiring + build diagnostics + test codelens plumbing, stripped per the doc; (b) **`extensions/burrow-go-core`** — the product layer on top: tool manager (pinned gopls/dlv install into `~/Library/Application Support/Burrow/tools/<go-version>/`, GOBIN-redirected, useSystem escape hatch), doctor panel + status item, the scheme-bar controller (fills the layer-3 host; scheme model from launch.json + `go list` auto-discovery reusing go-nav's `GoCli` pattern), run console, module views (explorer header + dependency tree + go.work switcher), save pipeline + `Go:` command surface + Run menu.

**Outer-repo (task 14):** retire the broken code-server `ide` service in `/Users/emadinfstones/Projects/debugger/docker-compose.yml`; migrate its Go/gopls/dlv pin values into Burrow's tool-manager constants (single source of truth); update `/Users/emadinfstones/Projects/debugger/.claude/memory/repo.yaml` ide row + gopls trap.

## Already exists

Confirmed present in `/Users/emadinfstones/Projects/debugger/burrow`:
- **Built-in `extensions/go` is grammar-only** — `package.json` has no `main`, contributes only `languages`, `grammars`, `configurationDefaults` (kept in `STRIP.md` line 25 "the point — Go language + grammar"). It provides NO gopls client. So Go language intelligence (hover/def/format-on-save) does NOT currently work in-tree.
- **No gopls language client anywhere.** No `extensions/go-base` / `vscode-go`; no `vscode-languageclient` usage in any `burrow-*` extension. `burrow-go-nav` calls `vscode.executeWorkspaceSymbolProvider` (depends on gopls) but nothing registers a gopls provider — nav resolves only if a user separately installed vscode-go.
- **Host Go/dlv resolution pattern exists.** `extensions/burrow-go-debug/src/extension.ts:45` resolves dlv via `BURROW_DLV_PATH` → `$GOBIN` → `$GOPATH/bin` → PATH, matching the doc's "Go is the host's". burrow-go-debug already contributes debugger type `go` (`Go (Delve)`) over `dlv dap` on an ephemeral port (WO-2 bootstrap; task 04 is the full engine).
- **A `go list` runner to reuse** for scheme auto-discovery: `extensions/burrow-go-nav/src/golist.ts` (`GoCli`, vscode-free, `execFile('go', ['list', ...])`, 128MB buffer).
- **Fork machinery is in place:** 4-layer model (`UPSTREAM.md`), ledger discipline + CI guard (`build/burrow/check-ledger.js`, `make ledger-check`), `patches/README.md` explicitly says "the next core patch is task 03's scheme-bar toolbar host". `product.json` already Burrow-identified. `burrow-core` already owns the `contributes.configuration` + `configurationDefaults` surface and gating-setting pattern (0006/0007/0008/0009). Title-bar part exists at `src/vs/workbench/browser/parts/titlebar/titlebarPart.ts` (with `commandCenterControl.ts` as a mount-point precedent).
- **Reference pins (from the legacy stack, task 14):** the outer code-server ide image baked Go 1.25 + `GOTOOLCHAIN=local`, gopls **v0.21.1** / dlv **v1.27.0** (`../.claude/memory/repo.yaml:31-32`). Outer `burrow/.devcontainer/Dockerfile` installs only VS Code build deps + node-gyp — no Go, no gopls. So the "gopls installed" prior art lives in a now-**broken orphan** service (`../.claude/memory/repo.yaml:13` marks the ide service `s: broken`, `backend/Dockerfile` deleted), not in Burrow.

## Open items

- go-base not vendored: no gopls language client, no re-pin doc, telemetry/survey/tool-nag not yet stripped (doc task 1)
- Tool manager absent: no pinned gopls/dlv auto-install into `~/Library/Application Support/Burrow/tools/<go-version>/` via GOBIN-redirected `go install`, no `burrow.tools.useSystem` escape hatch, no upgrade-on-pin-bump (doc task 2)
- Doctor panel + `go 1.2x · gopls ok · dlv ok` status item absent (doc task 2)
- Scheme bar absent: no title-bar toolbar host (core patch, not yet ledgered — will be patch 0010), no Run/Stop/Debug/scheme-picker/race controls, no launch.json+`go list` scheme model, no scheme editor UI (doc task 3)
- Run console absent: no per-scheme ANSI output channel with re-run/stop/exit-status, no ⌘R (doc task 4)
- Module views absent: no explorer module-identity header, no dependency tree (`go list -m all` / `-u`, tidy/why/upgrade), no `go.work` switcher (doc task 5)
- Save pipeline partial: goimports/vet defaults + staticcheck toggle + next-error (⌘') + Problems↔inline parity not wired (doc task 6)
- Command-surface audit: `Go:`-prefixed palette entries for build/run/test/generate/tidy/vet/env + a Run menu not present (doc task 7)
- Contract check not run: nodewatch backend's existing launch.json schemes appearing unmodified + `go run .` against compose db (doc task 8)
- Conflict to resolve: burrow-go-debug and go-base both contribute debugger type `go` — decide ownership (recommend strip go-base's debugger; burrow-go-debug/task 04 owns `go` DAP)
- Task 14 (outer repo): the orphaned code-server `ide` service must be retired and its Go/gopls/dlv pins migrated into Burrow's tool-manager pin constants; outer `repo.yaml` ide row + gopls-latest trap need updating

## First slice

Vendor `extensions/go-base/` (fork of golang/vscode-go, MIT, pinned) reduced to a single job: wire the gopls **language client** against the 1.128 extension API, stripped of telemetry, survey prompts, version-nag, and tool-install prompts, and with its `go` **debugger contribution removed** (burrow-go-debug already owns debug type `go`). Resolve `gopls`/`go` from host PATH/GOBIN for now (the tool manager is task 2). Add its tsconfig to `build/gulpfile.extensions.ts` compilations and register it as built-in. Land `editor.formatOnSave` + `source.organizeImports` defaults for `[go]` in burrow-core's `configurationDefaults`. Acceptance for the slice: open `merkle/nodewatch/backend`, get hover docs, jump-to-def, and goimports format-on-save with zero prompts — which also makes burrow-go-nav's `executeWorkspaceSymbolProvider` calls actually resolve (today no in-tree extension registers gopls, so nav silently returns nothing). This slice de-risks the one irreducible dependency (the vendored gopls client + re-pin discipline) that every later slice builds on; it needs no core patch, so it ships behind the existing gates first.

## Files to touch

- `/Users/emadinfstones/Projects/debugger/burrow/extensions/go-base/ (NEW: vendored vscode-go fork — package.json, src/goLanguageServer wiring, UPSTREAM.md re-pin doc; telemetry/survey/version-nag/tool-install + `go` debugger contribution stripped)`
- `/Users/emadinfstones/Projects/debugger/burrow/extensions/burrow-go-core/ (NEW built-in: src/toolManager.ts, doctor.ts, statusItem.ts, schemeBar.ts, schemeModel.ts, runConsole.ts, modules.ts, package.json with commands/configuration/pins)`
- `/Users/emadinfstones/Projects/debugger/burrow/build/gulpfile.extensions.ts (add extensions/go-base/tsconfig.json + extensions/burrow-go-core/tsconfig.json to the `compilations` array, lines 58-62)`
- `/Users/emadinfstones/Projects/debugger/burrow/product.json (layer-1 config: builtInExtensions/tool-pin constants + `burrow.tools.useSystem` default; keep gopls pin matched to Go minor)`
- `/Users/emadinfstones/Projects/debugger/burrow/extensions/burrow-core/package.json (configurationDefaults: `[go]` editor.formatOnSave + codeActionsOnSave organizeImports; any scheme-bar gating setting on the 0006-style pattern)`
- `/Users/emadinfstones/Projects/debugger/burrow/src/vs/workbench/browser/parts/titlebar/titlebarPart.ts (core patch: scheme-bar toolbar host mount point, ~<40 lines, alongside commandCenterControl precedent)`
- `/Users/emadinfstones/Projects/debugger/burrow/patches/0010-scheme-bar-toolbar-host.md (NEW ledger entry, format per patches/README.md)`
- `/Users/emadinfstones/Projects/debugger/burrow/patches/README.md (add row 0010 to the ledger table)`
- `/Users/emadinfstones/Projects/debugger/burrow/extensions/burrow-go-debug/package.json (resolve the `go` debugger-type ownership vs go-base)`
- `/Users/emadinfstones/Projects/debugger/docker-compose.yml (task 14: retire the orphaned code-server `ide` service, lines 32-60)`
- `/Users/emadinfstones/Projects/debugger/.claude/memory/repo.yaml (task 14: update the ide service row + gopls-latest trap — pins migrate into Burrow)`

## Core risk

Two coupled risks. (1) **Vendoring vscode-go cleanly against 1.128.** vscode-go is large and carries telemetry, survey, version-nag, and tool-install machinery the doc mandates removing; the re-pin discipline ("never patch go-base where go-core can wrap it") must hold or every quarterly rebase becomes expensive. The gopls client must wire against the pinned 1.128 extension API. (2) **The `go` debugger-type collision.** Both the vendored go-base and the existing `extensions/burrow-go-debug` contribute debugger type `go`; shipping both double-registers the debug type. Mitigation: strip go-base's `debuggers`/`breakpoints` contribution and keep burrow-go-debug as the sole `go` DAP provider (task 04 owns the eventual full Delve engine), so task 03 stays scoped to gopls + toolchain + scheme bar + modules. Secondary risk: the **gopls/Go-version pin coupling** — a gopls whose go.mod outruns the baked Go minor fails the toolchain (gopls v0.22.0 needs go 1.26; the pin is v0.21.1 for go 1.25 per the outer CLAUDE.md invariant and repo.yaml:32). The tool manager must install pins matched to the resolved host Go minor with `GOTOOLCHAIN=local`, never `@latest`.

## Dependencies

Depends on task 02 (Go-only strip — done; STRIP.md keeps `go` grammar + references-view) and task 01 (ledger CI guard + burrow-core registration — done, patches 0001-0002). Coordinates with task 04 (Delve engine): burrow-go-debug's `go` DAP is the interim owner of the debug type; go-base must NOT re-register it. The scheme bar's 🐞 Debug button targets the `go` debug type (task 04). Hooks left for task 06 (value visualizers via inspector), task 07 (module docs — `go doc`, already in burrow-go-docs), task 11 (tests — burrow-go-test already discovers/runs). Task 14 (outer repo) is a parallel dependency: the legacy code-server ide image is the source of the pin values and must be retired as Burrow's tool manager takes over — do task 03's tool-manager pins and task 14's ide-service retirement in lockstep so the pin numbers live in exactly one place.

## Full plan

# TASK 03 — First-class Go toolchain: build-ready plan

## Current state (verified against the tree)
- Built-in `extensions/go` is **grammar-only** (`package.json`: no `main`; contributes `languages`/`grammars`/`configurationDefaults`). **No gopls client exists in-tree** — `burrow-go-nav` calls `executeWorkspaceSymbolProvider` but nothing registers gopls, so navigation/hover/def/format-on-save do not work out of the box today.
- `burrow-go-debug` already provides debugger type `go` over `dlv dap` and resolves a **host** dlv (`BURROW_DLV_PATH`→`$GOBIN`→PATH). This is the interim DAP owner (task 04 = full engine).
- Reusable `go list` runner: `extensions/burrow-go-nav/src/golist.ts` (`GoCli`).
- Fork machinery ready: `UPSTREAM.md` (4 layers), ledger + `build/burrow/check-ledger.js`, `patches/README.md` names task 03's scheme-bar host as the next core patch. `burrow-core` owns the config/gating surface. Title-bar part: `src/vs/workbench/browser/parts/titlebar/titlebarPart.ts`.
- Pins (from the now-**broken** legacy code-server ide image, outer `repo.yaml`): Go 1.25, `GOTOOLCHAIN=local`, gopls **v0.21.1**, dlv **v1.27.0**. Burrow itself bakes none of this — its devcontainer installs no Go.

## Slice sequence (each slice compiles, passes gates, and is committed)

### Slice 1 — go-base vendoring (firstSlice; gopls only)
1. Fork `golang/vscode-go` at a pinned tag into `extensions/go-base/`. Add `extensions/go-base/UPSTREAM.md` documenting the source tag + the re-pin procedure and the strip list.
2. Strip: telemetry, survey/nag prompts, version-update UI, and **all tool-install prompts** (we manage tools in slice 2). **Remove the `go` `debuggers`/`breakpoints` contribution** — `burrow-go-debug` keeps ownership of debug type `go` (avoid double-registration; task 04 owns the engine).
3. Keep: gopls **language-client** wiring (against 1.128 API), build diagnostics, format/organizeImports provider. Tools resolved from host PATH/GOBIN for now.
4. Register: add `extensions/go-base/tsconfig.json` to `build/gulpfile.extensions.ts` `compilations` (after line 62).
5. In `burrow-core` `package.json` `configurationDefaults`, add `"[go]": { "editor.formatOnSave": true, "editor.codeActionsOnSave": { "source.organizeImports": "explicit" } }`.
6. **Verify:** compile-extensions + typecheck; launch skill → open nodewatch backend → hover/def/format-on-save work with zero prompts; burrow-go-nav now resolves. No core patch → no ledger entry. Commit.

### Slice 2 — Tool manager + doctor + status item (`burrow-go-core` skeleton)
1. Create built-in `extensions/burrow-go-core` (mirror an existing burrow-* package.json; add its tsconfig to gulpfile compilations). `activationEvents: onLanguage:go, onStartupFinished`.
2. `toolManager.ts`: resolve host `go` (respect `go env`, GOROOT, version managers); if none → one blocking welcome card with the official install link (no toasts). Read the Go minor; install pinned gopls/dlv via GOBIN-redirected `go install` into `~/Library/Application Support/Burrow/tools/<go-version>/` with `GOTOOLCHAIN=local`. Pins live as constants (single source of truth, migrated from the outer ide image). `burrow.tools.useSystem` escape hatch. Re-install on pin bump. **Never `@latest`** — pin must match the Go minor (gopls v0.22.0 needs go 1.26 and breaks the build).
3. Point go-base's gopls/dlv resolution at the tool-manager path (config the client's server path); keep host fallback under `useSystem`.
4. `statusItem.ts`: `go 1.2x · gopls ok · dlv ok`; click → `doctor.ts` webview panel (versions, paths, GOPATH/GOMODCACHE, proxy, re-install buttons).
5. **Verify:** fresh profile installs pinned tools; status item + doctor render. Commit.

### Slice 3 — Scheme bar (core patch 0010 + controller)
1. **Core patch:** in `titlebarPart.ts`, add a scheme-bar **toolbar host** region + contribution point (host only, <40 lines, follow the `commandCenterControl.ts` mount precedent). Write `patches/0010-scheme-bar-toolbar-host.md` (format per `patches/README.md`: Layer/Task/Upstream files/Size/Why/What/Rebase notes) and add the row to the ledger table. Keep all control logic in the extension so rebases only re-apply the host mount.
2. `schemeModel.ts` (in burrow-go-core): schemes = launch.json configs (existing NodeWatch configs verbatim) **plus** auto-discovered `main` packages via `go list` (reuse the `GoCli`/`golist.ts` pattern; keep vscode-free core + injected runner).
3. `schemeBar.ts`: fill the host with `▶ Run` / `⏹` / `🐞 Debug` / scheme picker / `race ☐` / `go 1.25 · branch ✓`. ▶ = `go run` semantics into the run console; 🐞 = same scheme under the `go` debug type; ⌘R/⌘D. `race` toggles `-race` globally on build/run/test/debug. Scheme editor UI writes launch.json (files stay source of truth).
4. `runConsole.ts`: dedicated ANSI output channel per scheme with re-run/stop/exit-status; ⌘R re-runs the active scheme.
5. **Verify:** ledger-check passes; nodewatch schemes appear unmodified; auto-discovered `cmd/*` runs without launch.json; race adds `-race`; run console shows output + exit status. Commit.

### Slice 4 — Modules, save pipeline, command surface (doc tasks 5-7)
1. `modules.ts`: explorer header module identity (module path + Go version from `go.mod`); dependency tree from `go list -m all` with `-u` upgrade markers and tidy/why/upgrade/open-docs (task 07 hook) actions; `go.work` module switcher.
2. Save pipeline: goimports (gopls) + vet defaults inline; optional bundled `staticcheck` toggle (off by default); ⌘' next-build-error; Problems ↔ inline marker parity.
3. Command surface: `Go:`-prefixed palette commands for build/run/test/generate/tidy/vet/env; a Run menu reflecting the same; tasks.json integration for repo chains (e.g. NodeWatch migrations).
4. **Verify:** each command runs; dependency tree + go.work switcher work on nodewatch; format/vet-on-save inline. Commit.

### Slice 5 (task 14, outer repo) — retire the legacy ide image
1. In `/Users/emadinfstones/Projects/debugger/docker-compose.yml`, remove/retire the broken code-server `ide` service (lines ~32-60; `backend/Dockerfile` no longer exists).
2. Ensure the Go/gopls/dlv pin values now live **only** in Burrow's tool-manager constants.
3. Update `/Users/emadinfstones/Projects/debugger/.claude/memory/repo.yaml`: ide service row (retired, superseded by Burrow) + the `gopls-latest-breaks-image` trap (pins moved into Burrow's tool manager). Bump `meta.updated_at`, add a gate/trap per the outer CLAUDE.md memory rule.
4. **Verify:** outer `make verify` green; `docker compose config -q` passes.

## Ownership decisions to lock in
- Debug type `go`: **burrow-go-debug** stays the sole registrant; go-base's debugger contribution is stripped. Task 04 later supersedes burrow-go-debug with the full Delve engine.
- Tool pins: single source of truth = burrow-go-core constants; the outer ide image is retired, not the pin owner.

## Out of scope (per doc)
Debug execution semantics (task 04), tests UI (task 11 — burrow-go-test exists), docs viewer (task 07 — burrow-go-docs exists).

## Verify strategy

Follow the doc's task-8 contract check + acceptance criteria, gated at each layer. (1) Build gates: `npm run gulp compile-extensions` (go-base + burrow-go-core compile), `npm run typecheck-client` for the titlebar core patch, `npm run valid-layers-check`. (2) Ledger gate: `make ledger-check` (`build/burrow/check-ledger.js`) must pass — the titlebarPart.ts touch requires the 0010 entry. (3) Language slice (firstSlice) — launch via the `launch` skill (Code-OSS, isolated profile), open `merkle/nodewatch/backend`, drive with Playwright: assert hover docs, jump-to-def, and goimports format-on-save all work with zero prompts; assert burrow-go-nav now resolves qualified symbols (proves gopls is wired). (4) Tool manager: on a profile with no prior tools, assert gopls+dlv install into the Burrow tools dir at pinned versions and the status item reads `go 1.25 · gopls ok · dlv ok`; click → doctor panel shows paths/versions. (5) Scheme bar: assert the nodewatch backend's existing launch.json schemes appear in the picker unmodified, an auto-discovered `main` (`cmd/*`) appears without launch.json, ▶ Run does `go run` into the Run console, and `race ☐` adds `-race`. (6) Assert no vscode-go telemetry/survey/update UI is reachable (command palette + settings search). (7) Regression: `make verify` in the outer repo (node/npm gates) still green after the docker-compose ide-service retirement; `docker compose config -q` passes. No new gopls-vs-Go-version build break (the pin-match invariant).
