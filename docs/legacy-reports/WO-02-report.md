# WO-02 report — IX prereq: minimal `dlv dap` adapter + debuggee fixture
STATUS: DONE — WO-1/config commits **landed** (authorized); WO-2 **uncommitted, for review**

## Changed
- **Committed (authorized this session)** on `main`, no push — 3 commits atop the `baseline/pre-integration-run` tag:
  - `bdc6db2a` feat(rd): Run & Debug → right aux bar (patch 0004) · `0cecbe9a` feat(rd): ⌥⌘D toggles aux bar · `e96bf2d8` fix(onboarding): suppress first-launch onboarding (patch 0005).
- **Uncommitted (WO-2, for review):**
  - `extensions/burrow-go-debug/` — layer-4 extension: `go` debug type, breakpoints, `DebugAdapterDescriptorFactory` spawning `dlv dap --listen=127.0.0.1:0` (ephemeral port parsed from dlv's banner), `DebugConfigurationProvider` defaulting mode/program/**cwd**, kill-safe teardown. **No core patch** (debug core intact).
  - `testdata/debuggee/` — Go fixture (`add`/`main`) with an **env-gated `runtime.Breakpoint()`** (fires only when the config sets `BURROW_DEBUG_BREAK`) + `launch.json` (break-in-add, stop-on-entry).
  - `build/gulpfile.extensions.ts` + `patches/0001` note — my burrow-go-debug compile entry (shared file, see Discoveries).

## Verified (host `dlv` 1.25.2, Go 1.24.1; fresh-profile boots over CDP)
- **compile:** targeted `compile-extension:burrow-go-debug` → 0 errors; `typecheck-client` → 0 errors for the patch-0005 core edit.
- **patch 0005 (onboarding):** fresh profile → **no** getting-started editor, **no** onboarding overlay, **no** Copilot sign-in modal, **no** welcome tab (was the WO-0/WO-1 eyesore). Proven via CDP DOM.
- **WO-2 live stopped session (primary DoD):** clicked Start → factory spawned `dlv dap`, dlv built + launched the fixture, stopped at `runtime.Breakpoint()`. **CALL STACK** `[Go 1] main.add` (main.go:16) ← `main.main` (main.go:25), goroutine-aware (`[Go 2..] runtime.gopark`); **VARIABLES/Locals** `a=0 b=2 sum=2 ~r0=0`; full exec-control toolbar (Continue/Step×3/Restart/Stop). Screenshot `scratchpad/wo2-stopped-in-add.png`. **Kill-safe:** 0 orphaned dlv after teardown.

## Discoveries
- **cwd bug (found + fixed):** `dlv dap` builds via `go build` from its **process cwd**; unset, it built from the IDE root (no go.mod) → "cannot find main module". Fix: default `config.cwd` to the folder **and** spawn dlv with that cwd.
- **Workspace trust gate:** a freshly-opened folder is **untrusted** → burrow-go-debug (`untrustedWorkspaces.supported:false`) is disabled ("All debug extensions are disabled"). Granting trust mid-session **restarts the exthost** (in dev it killed the renderer). Verified by pre-seeding `security.workspace.trust.enabled:false`.
- **Headless editor gotcha:** the editor viewport renders **no `.view-line`s** under CDP, so gutter/line breakpoints aren't clickable — drove the stop via the env-gated `runtime.Breakpoint()` instead.
- **CONCURRENT SESSION:** another session is integrating **`burrow-frontend-debugger`** (task 15) into this same tree — it edited `build/gulpfile.extensions.ts`, `patches/0001`, `docs/architecture/00-overview.md` and added `extensions/burrow-frontend-debugger/`, `docs/architecture/15-*`, `tools/frontend-debugger/`. The two **shared files now carry both sessions' hunks.**

## Decisions
- made — hand-rolled `dlv dap` adapter (no vscode-go vendoring, no core patch); env-gated fixture breakpoint (keeps `go run .` clean); trust pre-disabled only for the headless proof.
- made — **did NOT commit WO-2.** The commit authorization was for WO-1 + the config fix; WO-2's commit is a separate call. Leaving it uncommitted also avoids splitting the shared `gulpfile`/`patch-0001` from the FD session's hunks.
- needed — **authorize the WO-2 commit?** (`feat(debug): minimal dlv dap adapter + debuggee fixture`). And **coordinate the shared `gulpfile.extensions.ts` + `patches/0001`** with the FD session before either commits.

## Next
- **WO-3 (IX inspector):** builds directly on this proven DAP model (Variables `getChildren`/paging, call-stack frames, goroutine switch). Adapter breadth (attach, conditional/function breakpoints, panic UX) is the rest of architecture task 04.
- Open: the trust default — decide whether Burrow ships trust-relaxed for Go projects or keeps upstream trust (a product call, not this WO's).
