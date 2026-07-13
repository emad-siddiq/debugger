# 04 — Delve debugging engine

> Part of the [Go IDE overhaul](00-overview.md). Depends on: 03. Effort: ~2 wk.

## Goal

Complete, reliable Go debugging over `dlv dap`: every breakpoint kind, every
step verb, launch/attach/test/remote modes, goroutine-aware execution control.
This task is the *engine* — correctness and coverage. The *presentation*
overhaul is task 05, visualizers are task 06.

## Design

go-base (vendored vscode-go, task 03) already speaks DAP to `dlv dap`; we pin
dlv ourselves, own the session lifecycle from the scheme bar, and close the
gaps vscode-go leaves at defaults.

### Breakpoints — full menu

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

### Execution control

- Step over / into / out (⌘F6-style bindings finalized in task 12), continue,
  pause, restart (rebuild-if-stale then relaunch — the scheme bar's Debug
  button doubles as Restart while a session runs).
- **Goroutine-true stepping**: steps pin to the stopped goroutine (dlv default);
  goroutine switcher in the call-stack UI switches evaluation context.
- Run-to-cursor, "Set Next Statement" where dlv allows it.
- `-race` scheme toggle carries into debug builds; panics and fatal signals
  land as first-class stop events with the panic value decoded.

### Session modes

| Mode | Backing | Notes |
|------|---------|-------|
| Launch | `dlv dap` launch of a scheme | default; env from `launch.json` verbatim (NodeWatch contract preserved) |
| Test | `mode: test` | wired to task 11's explorer; per-test debug |
| Attach (local) | `dlv attach <pid>` | process picker filtered to Go binaries |
| Attach (remote) | `dlv dap --listen` / headless | for in-container targets; `substitutePath` UI so container paths map to host source — this replaces today's "debug inside the ide container" story |
| Core dump | `dlv core` | post-mortem; nice-to-have, keep if free |

### Reliability details that matter

- Build failures before launch route to the Problems pane, not a dead session.
- Debug console evaluation uses dlv's expression language; document its limits
  (no arbitrary function calls unless `--allow-non-terminal-interactive`-class
  risk is accepted — default off, `call` behind an explicit setting).
- Output demux: program stdout/stderr vs. debugger messages kept distinct in
  the Run console.
- Session teardown never orphans the debuggee or dlv (SIGKILL escalation with
  timeout); port allocation for DAP is collision-free (ephemeral ports only).

## Tasks

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

## Acceptance criteria

- Every row of the breakpoint matrix and session-mode table demonstrably works
  on the fixture gauntlet (CI-scripted, not manual).
- Restart-with-rebuild round-trip < 3 s on the NodeWatch backend (warm cache).
- No orphaned dlv/debuggee processes across 100 scripted start/stop cycles.
- The seven NodeWatch launch configs all debug successfully unmodified.

## Out of scope

- Variables/call-stack presentation (task 05), visualizers (task 06),
  test-explorer integration surface (task 11).
