# 11 — First-class tests

> Part of the [Go IDE overhaul](00-overview.md). Depends on: 04. Effort: ~2 wk.

## Goal

`go test` as a first-class citizen: a test explorer that understands packages,
table-driven subtests, benchmarks, and fuzz targets; one-keystroke run/debug at
any granularity; coverage in the gutters; race toggle honored everywhere.

## Design

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

## Tasks

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

## Acceptance criteria

- NodeWatch backend: full-module run populates the tree live; a table-driven
  subtest can be debugged individually by name; `with DB` scheme env applies.
- Failure shows a rendered got/want diff and jumps to the assertion line.
- Coverage gutters + % appear at file/package/module levels; navigation to
  next uncovered region works.
- Benchmark re-run shows ns/op delta vs. previous run.
- A fuzz crash produces a tree node whose input debugs under Delve in two
  clicks.

## Out of scope

- CI orchestration, flaky-test quarantine, remote test sharding; non-`go test`
  frameworks.
