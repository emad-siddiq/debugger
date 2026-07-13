# 03 — First-class Go toolchain

> Part of the [Go IDE overhaul](00-overview.md). Depends on: 02. Effort: ~3 wk.

## Goal

Go is not "a language extension" here — it's the product. Opening a folder with
a `go.mod` gives you, with zero setup: language intelligence (gopls), a
Xcode-style **scheme bar** (build/run/stop, target picker, env), inherent
module handling, and format/vet on save. Compiling, building, and running Go
are first-class verbs with dedicated UI, not tasks you configure.

## Design

### Foundation: vendor vscode-go, then build above it

Fork [golang/vscode-go](https://github.com/golang/vscode-go) (MIT) as the
built-in extension `extensions/go-base/`, pinned like upstream. It contributes
the battle-tested plumbing: gopls client wiring, the `go` debug type over
`dlv dap`, test codelenses, build diagnostics. We strip its telemetry, survey
prompts, version-nag UI, and its tool-install prompts (we manage tools
ourselves, below). Our own `extensions/burrow-go-core/` layers the product
experience on top. **Rule: never patch go-base where go-core can wrap it** —
go-base must stay cheap to re-pin.

### Toolchain management (no prompts, ever)

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

### The scheme bar (Xcode's best idea, stolen)

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

### Modules & build chain, inherent

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

## Tasks

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

## Acceptance criteria

- Fresh machine + Go installed: open a `go.mod` folder → hover docs, jump to
  def, format-on-save, and ▶ Run of an auto-discovered `main` all work with
  **zero** configuration or prompts.
- The NodeWatch backend's seven existing launch configs surface as schemes and
  run unchanged.
- gopls/dlv versions are pinned by Burrow, not whatever `$PATH` has.
- No vscode-go telemetry/survey/update UI remains reachable.

## Out of scope

- Debug execution semantics (task 04), tests UI (task 11), docs viewer (task 07).
