# 00 — Master plan: Burrow as the merkle production IDE

> **Scope:** turn Burrow (the Code-OSS fork at `debugger/burrow/`) from "a fork with
> many good tools bolted on" into **one calm, finished IDE** whose single purpose is
> getting `~/Projects/merkle` (NodeWatch) into production, with **AI assistance that
> stays advisory** — classical software engineering first.
>
> **Status:** planning artifact, written 2026-07-24. Nothing implemented yet.
> Companion files: `01`–`06` in this directory.

---

## Part 1 — Technical summary (for product review)

### What we have today

Burrow already carries almost all the *capability*; what it lacks is **coherence**.

| Surface | Today | Verified at |
|---|---|---|
| Left rail (activity bar) | 10+ items: Explorer(+Oracle Walk), Search, SCM, Tests, Database, Docker, API Flows, Components, Full Stack, Extensions | `extensions/burrow-*/package.json` `viewsContainers` |
| Top row | Custom title bar: back/forward nav, **Command Center search box**, chat control, **"Sign In"**, layout toggles | screenshot `burrow/.playwright-cli/iso-visual-dream.png` |
| Search | **Two** boxes: Command Center (top) + Search viewlet (rail) — plus `⌥⌘O` Go symbol palette | `burrow-go-nav`, upstream search |
| Right dock | Debug inspector (Frames / Miller inspector / Watch / Visualizer) via patch `0004` | `patches/README.md` |
| AI | None of ours. Upstream chat contrib still present and *load-bearing* (`defaultChatAgent` in `product.json`) — it draws the "Sign In" button | `STRIP.md:184`, `product.json:40` |
| Frontend debugging | **Broken by design**: `js-debug` was stripped, so `type: "chrome"` in merkle's `infra/test/vscode/launch.json` cannot run | `STRIP.md:137-139`, `product.json:39` |
| Frontend tool | Rich: components gallery, isolation workbench, props/samples, preview, reveal bridge | `extensions/burrow-frontend-debugger`, `tools/frontend-debugger` |
| Backend/DB/API | dlv debugging, DB explorer + pgAdmin, HTTP workbench (Postman import), flowscan routes, full-stack orchestrator | `burrow-go-debug`, `burrow-db`, `burrow-http`, `burrow-flow`, `burrow-fullstack` |

### What this plan changes

Five workstreams, each independently shippable:

1. **Chrome & Focus (file `01`)** — delete the entire top row (native title bar only),
   leaving exactly **one** search surface; add a **Focus Mode** button in the top-right
   of the editor area with **Esc** to exit; make the same affordance work per-tool
   (Database grid, HTTP workbench, isolation preview, docs).

2. **Zen views (file `02`)** — a written **view contract** (one purpose, one primary
   action, two visible sections, one designed empty state, one density) applied to every
   left-rail item, plus a rail consolidation from ~10 icons to **7**. This is the
   "not overwhelming" work, and it is mostly deletion.

3. **Agent panel (file `03`)** — a new `burrow-agent` extension: a toggleable **right-hand**
   panel driven by the user's **Claude Code account** (spawns the local `claude` CLI,
   v2.1.216 at `~/.local/bin/claude`, in streaming JSON mode — no API keys, no other
   provider). It knows *what you have open* (e.g. `Badge.tsx` + `Badge.css` + the live
   isolation preview together), offers **auto-insights**, answers **selection** questions,
   and reads merkle's `.claude/memory/*.yaml` contract instead of grepping. Advisory by
   default: every write is a reviewable diff; the IDE is fully usable with it closed.
   Upstream chat UI is removed so there is exactly one agent surface.

4. **Frontend debugging restored (file `04`)** — bring back **real TSX breakpoints** by
   vendoring `js-debug` (the same reversal pattern used for the python/rust grammars),
   wire a one-click **Full Stack** compound (Postgres → dlv-backed Go → Chrome on Vite),
   and restore the **responsive-breakpoints** (media-query) panel lost in the native port.

5. **End-to-end simulation (file `05`)** — a methodical, three-pass rehearsal of the whole
   merkle flow *through Burrow's own tools*, built on `~/Projects/merkle/infra`
   (`./merkle --start`, `infra/test/nodewatch.http`, the Postman collection, `infra/test/mock/seed.sh`,
   the six tutorials, and the minikube cluster lab). Pass 1 scripted/headless, Pass 2
   automated through the IDE, Pass 3 the human runbook you actually walk.

File `06` turns all of it into numbered work orders with **parallel-safe groupings** for
agent launches.

### Sequencing (what to do first)

- **Phase A — Calm the shell** (WS1 + WS2): the UI stops being overwhelming. Cheapest,
  highest daily payoff, mostly config + deletion. ~1 week of agent work.
- **Phase B — Make it debuggable end to end** (WS4): frontend breakpoints back, full-stack
  compound green. Unblocks the simulation. ~1 week.
- **Phase C — The agent** (WS3): panel, context engine, memory wiring, insights. ~2 weeks.
- **Phase D — Prove it** (WS5): run the three passes against merkle, fix what they expose,
  freeze the runbook. ~1 week + fixes.

Phases A/B/C overlap safely (different files) — see `06` for the collision map.

### Cost, risk, and the one thing to decide now

- **Risk 1 — core patches.** The fork's budget is *< 15 patches, each < 300 lines*
  (`patches/README.md`); we currently use 6. This plan adds **at most 2** (Esc-to-exit
  Focus Mode if the keybinding route proves insufficient; optional Search-view removal).
  Everything else is layer 1 (config) or layer 4 (extensions).
- **Risk 2 — chat excision.** `defaultChatAgent` is load-bearing (`STRIP.md:184`); removing
  the "Sign In" button is *free* once the title bar is native, but full `contrib/chat`
  excision stays deferred until the agent panel is real (WS3), and is optional even then.
- **Risk 3 — js-debug provenance.** Marketplace endpoints are stripped, so js-debug must be
  vendored deliberately (pinned version, licence noted, `STRIP.md` reversal row) rather than
  downloaded at build time.
- **Decision needed from you:** *which two search bars* do you mean? This plan assumes
  **(a) the Command Center box in the top row** and **(b) the Search viewlet's input**, and
  resolves it by deleting the top row and keeping the Search viewlet as the one search
  surface (`01 §3`). If you meant something else (e.g. Search viewlet vs. `⌥⌘O` symbol
  palette), say so — `01 §3 Option B` covers the alternative and costs one small patch.

---

## Part 2 — Details for the implementing agents

### 2.1 Ground rules (apply to every work order)

1. **All app work lands in `burrow/`** — a nested independent git repo with its own rules.
   Outer-repo files (`launcher/`, `simulator/`, `extension/`, `docs/`) are only touched when
   a WO says so.
2. **Never create or switch branches** (outer CLAUDE.md). Commit on whatever `HEAD` points at.
   **No `Co-Authored-By` trailers.**
3. **Respect the four layers** (`burrow/UPSTREAM.md`): config → deletion → *ledgered* core
   patch → built-in extension. Prefer the cheapest layer that works. Any `src/` or `build/`
   diff needs a `patches/NNNN-*.md` entry **and** a row in `patches/README.md`, or
   `build/burrow/check-ledger.js` fails.
4. **Memory is machine-enforced in two places.** Outer repo: `.claude/memory/{api,env,repo}.yaml`
   when launcher/simulator/extension change. Frontend tool: `cd burrow/tools/frontend-debugger
   && npm run oracle` must print `0 FAIL` when its env/routes/protocol/components change.
5. **Every WO ends with evidence**, not assertions — see 2.3.
6. **Classical-first.** No feature may make the agent mandatory. If the agent panel is closed
   or `claude` is missing, every other surface must behave identically.

### 2.2 Design north star (why these choices)

- **The top row is negative space.** A row that holds a search you don't use, an account
  button for a product we don't ship, and layout toggles you set once is a permanent tax on
  attention. Native title bar = macOS draws a thin strip with traffic lights; Burrow draws
  nothing.
- **One thing per view.** A view that shows four trees is a dashboard, and dashboards are
  read, not used. Each rail item answers exactly one question (§`02`).
- **Full-screen is a verb, not a mode you get stuck in.** Button top-right, `Esc` out — no
  hunting the command palette.
- **The agent is a colleague at your elbow, not a co-pilot on the yoke.** It sees your open
  files and your selection, it writes insights into a panel, and it never types into your
  buffer uninvited.

### 2.3 The verification contract

Every WO must produce, in its report:

| Gate | Command | Applies to |
|---|---|---|
| Extension type-check | `npm run gulp compile-extensions` (in `burrow/`) | any `extensions/**` TS change |
| Core type-check | `npm run typecheck-client` | any `src/**` change |
| Ledger | `node build/burrow/check-ledger.js` (or the CI task) | any `src/`/`build/` change |
| Outer gates | `make verify` (repo root) | `launcher/`, `simulator/`, `extension/` |
| FD oracle | `cd burrow/tools/frontend-debugger && npm run build && npm run oracle` → `0 FAIL` | anything under that tool |
| FD e2e | `npm run verify` (same dir, needs a running instance) | tool UI/protocol changes |
| **Live proof** | launch via the `launch` skill (`burrow/.agents/skills/launch/`), drive with `npx @playwright/cli` over CDP, save screenshots to the session scratchpad and link them | **every UI-visible WO** |

Launch traps already known (do not rediscover): `TMPDIR=/tmp/bl` (103-char unix socket cap),
Node **24.17.0** from `~/.local/burrow-node`, scrub `VSCODE_*`/`ELECTRON_*` before launching,
macOS **Developer Mode must be enabled** for dlv (`sudo DevToolsSecurity -enable`).

### 2.4 Incorporated existing work (nothing here is invented from scratch)

| Existing artifact | How this plan uses it |
|---|---|
| `burrow/docs/architecture/00-overview.md` tasks 01–16 | WS1/WS2 = the unfinished half of **task 12** (design system) and **task 02** (strip); WS4 extends **task 15** + **task 04**; WS5 is the acceptance test for **task 14** (stack migration) |
| `docs/architecture/12-design-system.md` §"Chrome earns its pixels" | The rail-consolidation and no-triplication rules in `02` are its unimplemented deliverable 3 |
| `docs/architecture/plans/task-12-plan.md` | Theme/token layer already planned; `02` consumes its tokens, does not redo them |
| `docs/architecture/plans/full-stack-debugger-plan.md` | Single-Postgres invariant + one-request-id join — WS5 tests exactly this |
| `docs/architecture/plans/task-15-4-plan.md` | Bundling the FD tool into the `.app`; WS4/WS5 must not break the packaged path |
| `burrow/tools/frontend-debugger/docs/component-app-roundtrip-plan.md` | Its round-trip (app ⇄ isolation) is a WS5 scenario and a WS2 view requirement |
| `debugger/docs/frontend-migration/*` | Explains why the FD lives where it does; `02`/`04` keep those invariants |
| `report.md` (markdown/zen work, 2026-07-24) | The Zen precedent: `zenMode.*` defaults + `⌘K R` already shipped — `01` generalizes it |
| `merkle/infra/test/tutorials/*` + `infra/test/nodewatch.{http,postman_collection.json}` | The literal script for WS5's three passes |
| `merkle/.claude/memory/*` | The agent's structured context source (WS3) |

### 2.5 Decision log (made here, reversible)

| # | Decision | Rationale | Reverse by |
|---|---|---|---|
| D1 | Native macOS title bar; Burrow draws no top row | Kills nav + command center + Sign In + layout toggles in one config change; keeps traffic lights | flip `window.titleBarStyle` |
| D2 | The **Search viewlet** is the single search surface; Command Center deleted | Cheapest path to "one search bar"; keeps upstream's excellent results/replace UI | `01 §3 Option B` |
| D3 | Focus Mode = tuned Zen Mode, not a new layout engine | Zen already exists and already ships in Burrow (`zenMode.showTabs: none`) | — |
| D4 | Agent panel spawns the `claude` CLI (no SDK dependency, no API key) | "Wired to my Claude Code account only"; zero new auth surface; survives CLI upgrades | swap transport module |
| D5 | Agent is **advisory-by-default**: reads freely, writes only through a diff you accept | "Emphasis on classical" | setting `burrow.agent.autoApply` |
| D6 | Restore `js-debug` by vendoring a pinned build, not by re-enabling the marketplace | Deterministic, offline, auditable; same pattern as the python/rust grammar restore | — |
| D7 | Rail consolidates to 7 items (Files, Find, Source, Run, API, Data, Components) | Design-system principle "rail ≤ 5–7"; each item stays one question | keep containers, change only order/visibility |

### 2.6 Open questions for the user

1. **Search**: confirm D2's reading of "two search bars" (see Part 1).
2. **Rail consolidation** (D7): merging Docker *into* Data and Tests *into* Run reduces icons
   but hides two tools one level deeper. Approve, or keep them as separate icons?
3. **"Frontend breakpoints"**: `04` restores **both** readings — real TSX/JS runtime
   breakpoints (js-debug) *and* the responsive media-query panel from the old tool UI. If you
   only meant one, say which and the other becomes a stretch WO.
4. **Auth0 (Mode C)** in the simulation: include the real-login path in Pass 3, or keep the
   whole rehearsal on `VITE_SKIP_AUTH=1`? (`05` includes it, flagged optional.)

### 2.7 Definition of done for the whole programme

- Burrow opens on merkle with **no top row**, **one search**, **7 rail items**, every view
  passing the `02` view checklist, and a Focus button that `Esc` exits.
- The agent panel toggles from the right, answers a question about the *currently open*
  `.tsx`+`.css` pair without being told the file names, cites a `merkle/.claude/memory` row,
  and can be closed with zero effect on the rest of the IDE.
- `F5` on **Full Stack** stops at a Go breakpoint *and* a `client.ts` TSX breakpoint in the
  same request, joined by one `X-Request-Id`.
- `05`'s scenario matrix is green, its evidence bundle is committed, and the runbook has been
  walked once by a human start to finish.
</content>
</invoke>
