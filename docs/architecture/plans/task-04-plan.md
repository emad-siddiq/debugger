# Task 04 — the Delve (dlv) debug engine, hardened

> Build-ready plan for finishing the Go debug engine. `burrow-go-debug` today is the
> WO-2 minimal slice — enough to reach a live stopped session so the IX inspector has a
> real DAP model. This plan takes it to a production engine. Authored as milestone M8 of
> the Full Stack Debugger; each slice is independently landable. Everything here is
> **pure Layer-4** (the `go` adapter is an extension, not core) — **no core patch**.

## Where we are (WO-2 + M1)

- `extensions/burrow-go-debug` registers debug type `go`, spawns host `dlv dap` on an
  ephemeral port, parses the listen banner, bridges to the intact workbench debug UI, and
  is kill-safe (`extension.ts:90-138`). Launch + attach both resolve (`extension.ts:57-82`).
- **M1** closed the `envFile` gap: `resolveDebugConfigurationWithSubstitutedVariables`
  merges dotenv files into `env` (inline wins), so merkle's `.vscode/launch.json` configs —
  including the `envFile`-only Auth0-ON one — boot correctly (`envfile.ts`, 12 tests).
- dlv is the **host** binary via `resolveDelve()` (`BURROW_DLV_PATH` → `$GOBIN`/`$GOPATH/bin`
  → PATH). No pinned/bundled dlv yet.

## Invariant to protect throughout

**The seven merkle launch configs must keep working unmodified** (`~/Projects/merkle/.vscode/launch.json`):
Backend debug (Auth0 OFF/ON), attach to `:2345`, debug current test file, and the (dead in
Burrow — chrome stripped) frontend one. Every slice below re-runs them as its acceptance test.

---

## Slice 1 — Pinned, version-matched dlv `[L4]`

The one hard correctness constraint (repo trap): **dlv's `go.mod` must match the Go toolchain
building the debuggee**, or the build/inspect mismatches. Today we take whatever host dlv
exists.

- Extend `resolveDelve()` with a Burrow-managed pinned dlv: `BURROW_DLV_PATH` → a Burrow tool
  dir (`~/.burrow/tools/dlv-<version>`) → host fallback. Mirror `burrow-go-base`'s tool
  resolution; the tool manager (task-03 slice 2) provisions it.
- Pin the dlv version whose `go.mod` targets the same Go minor as the project's `go.mod`
  (`go 1.25.0` for merkle). Never `@latest` — a dlv built against a newer Go rejects older
  toolchains (the gopls-v0.22/go-1.26 class of breakage).
- **VERIFY**: `dlv version` matches the pin; a breakpoint in `router.go` stops with correct
  locals against merkle's Go 1.25 backend.

## Slice 2 — Breakpoint matrix `[L4]`

Prove every breakpoint kind the inspector relies on:
- Line, conditional (`cond`), hit-count, logpoint, function breakpoints; breakpoints set
  **before** launch and **while stopped**; breakpoints in a goroutine other than the current.
- `substitutePath` — map the on-disk path to dlv's build path so breakpoints bind when the
  module path and the workspace path differ (container vs host builds).
- **VERIFY**: a scripted matrix (extend `testdata/debuggee/gauntlet.go`) — each kind binds,
  stops, and reports the expected frame; goroutine-scoped breakpoints stop the right goroutine.

## Slice 3 — Panic / fatal decode + output demux `[L4]`

- On an unrecovered panic or `fatal error:`, surface the goroutine + the offending frame in the
  debug UI (not just raw stderr) — dlv reports these over DAP `output`/`stopped(reason:exception)`.
- **Output demux**: separate the debuggee's stdout/stderr from dlv's own `--log` noise into the
  right Debug Console channels (the WO-2 slice merges them).
- Route build failures (`go build` errors from `dlv debug`) to the **Problems** panel with
  file/line, not a silent failed launch.
- **VERIFY**: a deliberate panic in `gauntlet.go` shows the frame; a compile error appears in
  Problems; debuggee prints land in the Debug Console, dlv logs do not.

## Slice 4 — Attach + remote hardening `[L4]`

- `attach` local (by pid) and remote (`--headless` dlv on `:2345`, merkle's third config):
  confirm reconnection, `disconnect` vs `terminate` semantics (don't kill a process we merely
  attached to), and kill-safety only for processes **we** spawned.
- **VERIFY**: attach to a hand-started `dlv debug --headless --listen=:2345`, hit a breakpoint,
  detach — the backend keeps running.

## Slice 5 — Packaging into the darwin build `[L4 + task 15.4]`

Bundle everything the Full Stack Debugger needs into the `.app` so it is turnkey:
- **dlv** (pinned, slice 1) + **gopls** (burrow-go-base) + **typescript-language-server** +
  **typescript** (burrow-ts-base, already bundled via `dirs.ts`).
- **tools/frontend-debugger** (the FD sidecar + built `ui/dist`) — the FD-bundle patch (task
  15.4), allocated as the **next free `patches/NNNN`** (reconcile the contested-0010: task-03
  scheme bar, task-13 entitlements, and this each independently named `0010` — allocate by land
  order 0010/0011/0012 and fix the stale `patches/README.md` table in the same change).
- **burrow-db/tools/db-admin** (the pgAdmin compose) + a note that Docker itself is a host
  prerequisite (burrow-docker + pgAdmin + the orchestrator all shell out to `docker`).
- The **`pg`** driver for the deferred native DB explorer (pure-JS `pg`, never `pg-native` —
  keeps notarization clean), added to `burrow-db/package.json` + `dirs.ts` when that slice lands.
- **VERIFY**: a fresh `.app` on a clean `--user-data-dir` runs `⚡ Debug Full Stack` end to end
  with no host Go toolchain assumptions beyond Docker + a Go install for the debuggee build.

## Optional — the scheme-bar surface (core patch) `[L3]`

Once the task-03 scheme-bar title-bar host lands (its own next-free `patches/NNNN`, `<40`-line
mount in `titlebarPart.ts`), add a "Full Stack" scheme-model row in `burrow-go-core` invoking the
**same** `burrow.fullstack.debug` command. The **status-bar item stays canonical**; the scheme
row is an alternate surface, never a second implementation. This is the only place task 04's
neighbourhood touches core, and it is optional polish.

## Sequencing

Slice 1 (pin) → 2 (matrix) → 3 (panic/output) → 4 (attach) are order-independent after 1; each
re-runs the seven-config acceptance test. Slice 5 (packaging) lands last, after task-13 (packaging
scaffolding). The scheme-bar surface is orthogonal and optional.

## Commit discipline

Branch `main` only; stage explicit paths; no AI co-author trailers; `gulp
compile-extension:burrow-go-debug` + the unit tests green before each commit; `check-ledger.js`
OK (a ledger entry only for the one optional core patch, allocated next-free at land time).
