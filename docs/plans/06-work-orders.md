# 06 — Work orders & parallel launch groups

> The execution index for plans `01`–`05`. Each WO is agent-sized (½–2 days), names its files,
> its gates, and its dependencies. **Launch groups** at the bottom tell you which WOs one agent
> batch can safely work in parallel (disjoint files, no semantic coupling).
>
> Every WO inherits the ground rules in `00 §2.1` and the verification contract in `00 §2.3`.
> App WOs commit in `burrow/` (nested repo, current branch, no Co-Authored-By); merkle WOs
> commit in `~/Projects/merkle` under *its* rules; outer-repo WOs update
> `.claude/memory/*.yaml` in the same change.

---

## The work orders

### WS1 — Chrome & Focus (`01`)

| WO | Title | Files (primary) | Depends |
|---|---|---|---|
| **WO-01** | Native title bar + kill Command Center/nav/layout controls + §2 regression checklist | `burrow/extensions/burrow-core/package.json` | — |
| **WO-02** | One search: tightened Search view + `burrow.find.everywhere` (Text·Files·Symbols) | `burrow-core` defaults, `burrow-go-nav/src/*` | WO-01 |
| **WO-03** | Focus Mode: `burrow.focus.toggle`, ⛶ in `editor/title`, `⌘⇧↩`, single-Esc keybinding (+ contingency patch 0011 only if needed) | `burrow-core/src/extension.ts`, `package.json` | WO-01 |
| **WO-04** | Esc-bridge + ⛶ in every webview surface (FD panel, isolation, DB grid, HTTP response, docs, md-readZen re-point) | `burrow-frontend-debugger/src/{panel,isolation}.ts`, `burrow-db`, `burrow-http`, `burrow-go-docs`, `markdown-language-features` | WO-03 |

### WS2 — Zen views (`02`)

| WO | Title | Files | Depends |
|---|---|---|---|
| **WO-05** | Rail consolidation: 7 containers, re-homed views, order, icons | all `extensions/burrow-*/package.json` (containers/views blocks only) | — |
| **WO-06** | Run view: tier status rows + Debug Full Stack + Tests/Debug-Config sections | `burrow-fullstack/src/*`, `burrow-go-test` | WO-05 |
| **WO-06b** | **Test Lab** editor surface (failures-first, want/got diff, coverage gutters) | `burrow-go-test/src/*` (+ shared lab shell, WO-13) | WO-06 |
| **WO-07** | API view: Routes+Requests sections, empty states, response-⛶ | `burrow-flow`, `burrow-http` | WO-05 |
| **WO-08** | Data view: DB+Docker merge, connection discovery, writes-lock as state | `burrow-db`, `burrow-docker` | WO-05 |
| **WO-08b** | **pgAdmin UX**: framed webview, auto-login `servers.json`, native-first routing, ⛶ | `burrow-db/src/*` | WO-08 |
| **WO-09** | Files/Find/Source contract pass + Components view status row & empty state | explorer/search defaults in `burrow-core`, `burrow-oracle`, `burrow-frontend-debugger/src/gallery.ts` | WO-05 |
| **WO-10** | Zen separators & layout defaults + theme seam-colours + cross-cutting deletions (`02 §5 + §7`) | `burrow-core/package.json`, `burrow-theme-xcode/themes/*` | — |
| **WO-23** | **Tool-surface isolation** (`02 §6`): burrow-core tab registry/`tools.activated` API + registration in every tool extension + singleton surfaces + `tidyToolTabs` setting. **Core half DONE** (burrow `2cbd8631`, 2026-07-25): `tools.ts`/`toolsLogic.ts` registry + setting + `Burrow: Close Tool Tabs` command, exported as `exports.tools`; unit-tested (4 pass). **Remaining:** per-tool `activated()`/`claim()` hooks — blocked on the uncommitted in-flight work in `burrow-db`/`burrow-frontend-debugger`/`burrow-fullstack` settling first | `burrow-core/src/{extension,tools,toolsLogic}.ts` ✅, then small hooks in `burrow-db`, `burrow-http`, `burrow-frontend-debugger`, `burrow-go-test`, `burrow-go-docs`, `burrow-fullstack` | WO-05; coordinates with WO-15 (isolation trio registers instead of rolling its own close logic where they overlap) |

### WS3 — Agent (`03`)

| WO | Title | Files | Depends |
|---|---|---|---|
| **WO-11** | `burrow-agent` phase A: panel webview, CLI transport (stream-json, resume, env-scrub), **vertical session tabs**, **docked/half/full size cycle**, cost line | `extensions/burrow-agent/*` (new) | WO-03 (Focus for full-screen state) |
| **WO-12** | Phase B: context engine + chips + `showContext` + read-only exports from FD/db/http/debug extensions | `burrow-agent/src/context.ts`; small `exports` additions in `burrow-frontend-debugger`, `burrow-db`, `burrow-http` | WO-11 |
| **WO-12b** | Phase C: merkle memory reader + contract reminders | `burrow-agent/src/memory.ts` | WO-12 |
| **WO-12c** | Phase D+E: auto-insights (debounce/cache/budget) + diff propose/preview/apply | `burrow-agent/src/{insights,diff}.ts` | WO-12 |

### WS4 — Frontend lab & breakpoints (`04`)

| WO | Title | Files | Depends |
|---|---|---|---|
| **WO-13** | Render triage sweep script + report + permanent `npm run sweep` gate; shared lab-shell CSS decision | `tools/frontend-debugger/test/renderSweep.mjs` | — |
| **WO-14** | Type-driven prop synthesis + `sampleRoute` + provenance labels | `burrow-frontend-debugger/src/propsSkeleton.ts`, `tools/frontend-debugger/server/isolateHarness.js` | WO-13 |
| **WO-14b** | merkle-side fixes from the sweep: samples/fixtures/providers (+ `DataTable.samples.ts` exemplar, convention in `frontend/README.md`) | `~/Projects/merkle/frontend/*` | WO-13 |
| **WO-14c** | Prod parity: prod-css toggle + font/token drift asserts in sweep | harness + sweep | WO-14 |
| **WO-14d** | Responsive **Breakpoints tab** in isolation (port of old `BreakpointsTab`) | harness + `isolation.ts` | WO-14 |
| **WO-15** | Explorer-stays-visible default + **tab-tidy isolation** + global tab defaults | `burrow-frontend-debugger/src/{isolation,panel}.ts`, `burrow-core` defaults | — |
| **WO-16** | Restore **js-debug** (vendored, pinned, STRIP.md reversal, notices) | `extensions/js-debug/`, `tools/inventory.js`, `STRIP.md` | — |
| **WO-17** | Full Stack compound: db→dlv→Vite(live)→Chrome fan-out + status wiring + teardown | `burrow-fullstack/src/*` | WO-16, WO-06 |

### WS5 — Simulation & walkthrough (`05`)

| WO | Title | Files | Depends |
|---|---|---|---|
| **WO-18** | Pass 1 script (`pass1.sh`) + endpoint sweep report | `debugger/docs/plans/scripts/` | — (runnable today) |
| **WO-19** | **Launchpad packaging**: see below | `burrow/build/*`, `Makefile` | WO-16 (ships js-debug in the .app), task-15-4 staging |
| **WO-20** | Pass 2 scenario scripts P2-1…P2-10 + orchestrator + report | `docs/plans/scripts/pass2/` | WS1–4 landed |
| **WO-21** | **The interactive walkthrough** `docs/plans/walkthrough.md` — performed once live, values frozen, then handed to the user | `docs/plans/walkthrough.md` | WO-18…20 |
| **WO-22** | Optional: Auth0 Mode-C leg + minikube chaos capstone verified | scripts + simulator | WO-21 |

### WO-19 in detail — the Launchpad goal (the user's end state)

The finish line is: **you open Launchpad, click Burrow, and you're in this project.**

1. `make dist` (`gulp vscode-darwin-arm64`) → `.build/electron/Burrow — Go IDE.app`, **with**
   the FD tool staged per `task-15-4-plan.md` (its "first slice" is the de-risk step: run the
   staged sidecar under `ELECTRON_RUN_AS_NODE=1` and hit `/healthz` before wiring the gulp
   stream + ledger entry `0012`), and with js-debug + all WS1–4 extension changes compiled in.
2. Install: copy to `/Applications/Burrow.app` (a `make install` target). Launchpad picks it up
   automatically from `/Applications`.
3. Signing: if no Developer ID cert is available, ad-hoc sign (`codesign --force --deep -s -`)
   so Gatekeeper allows a locally-built app; document the right-click-open first-run. Full
   notarization stays task 13.
4. First-run defaults: `window.restoreWindows: "all"` is fine, but add
   `burrow.defaultFolder` behaviour in `burrow-core` — if launched with no window state, open
   `~/Projects/merkle` (setting, default set for this machine).
5. Verify from a true cold start: `open -a Burrow` from a fresh login session — merkle opens,
   Full Stack debugs, isolation renders, agent panel answers. That run doubles as the
   walkthrough's Act 0 evidence.

---

## Parallel launch groups

Rule: WOs in one group touch disjoint files and can be one multi-agent batch. Groups run in
letter order; within a group, all WOs in parallel.

| Group | WOs | Why safe together |
|---|---|---|
| **A** (now) | WO-01 · WO-05 · WO-10 · WO-13 · WO-16 · WO-18 | Config block vs. container ids vs. theme/densities vs. a new test script vs. a vendored dir vs. outer-repo scripts — no file overlaps. ⚠️ WO-01/05/10 all touch `burrow-core/package.json`: give WO-01 the `configurationDefaults` block, WO-05 none of it, WO-10 lands after WO-01 merges or rebases trivially — or hand all `burrow-core/package.json` edits to one agent of the three. |
| **B** | WO-02 · WO-03 · WO-06 · WO-07 · WO-08 · WO-09 · WO-14 · WO-14b · WO-15 | Per-view/per-extension isolation; WO-14 (extension+harness) and WO-14b (merkle repo) are different repos entirely. |
| **C** | WO-04 · WO-06b · WO-08b · WO-11 · WO-14c · WO-14d · WO-17 | WO-04 needs the surfaces from B; WO-11 is a brand-new dir; the rest extend their own B-group files. ⚠️ WO-04 and WO-14d both edit `isolation.ts` — sequence those two or merge them into one agent. |
| **D** | WO-12 · WO-12b · WO-12c · WO-19 · WO-23 | Agent phases are sequential within one agent; WO-19 is independent packaging and can start as soon as C compiles. WO-23 goes here (not C) because it touches *every* tool extension — after C lands, its hooks are small and conflict-free; its burrow-core registry half can be built any time after WO-05. |
| **E** | WO-20 · WO-21 · WO-22 | Verification; inherently after everything. WO-21 is *the* user deliverable. |

**Standing note for every launched agent:** read `00-master-plan.md §2.1–2.3` first; the plan
file for your WO second; then the code. Report evidence, not adjectives.
</content>
