# 00 — Overview: the Go IDE overhaul

The backend debugger stops being a browser IDE in a container. It becomes a
**native, Go-first IDE + debugger** — a VS Code (Code - OSS) fork that runs on
the host, with first-class Go/Delve debugging, Go data-structure visualization,
an integrated HTTP workbench (Postman-class), a database explorer
(pgAdmin-class), offline Go docs, and an agent-bootstrapped codebase Oracle.
Everything that doesn't serve Go development is removed.

Working title: **Burrow** (a gopher lives in one). The name is a one-line
`product.json` change — bikeshed later.

## Why a fork (alternatives considered)

| Option | Verdict |
|--------|---------|
| Keep code-server | Rejected: web IDE in a container; user wants host-native backend dev. Proxy/port pain (see the `PORT` collision incident) is structural. |
| Tauri + custom editor | Rejected: rebuilding an editor, LSP client, DAP client, terminal, and extension surface is years of work before feature #1. |
| Eclipse Theia | Rejected: same web-first architecture, smaller ecosystem, still not "beautiful like Xcode". |
| **Fork Code - OSS** | **Chosen**: MIT-licensed, battle-tested editor/DAP/LSP/terminal core; we delete instead of build, and put our features in built-in extensions. |

## Fork strategy — the four change layers

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

## Where the code lives

A VS Code fork cannot be *vendored* (tracked as content) into this repo — it
keeps its own git history and an `origin`→vscode remote so it can rebase onto new
VS Code releases. It lives at **`debugger/burrow/`** as a **nested independent
git repo** (its `.git` stands alone; if this repo is ever git-initialized, add
`burrow/` to `.gitignore` or make it a submodule). `debugger/backend/` shrinks to
integration glue: these docs, the oracle bootstrap prompts, and the compose
migration (task 14). The current code-server `ide` container **keeps running as
the fallback until task 14 cuts over** — no gap in the stack.

## Product principles

- **Go-first, Go-only.** `go.mod` is the project model. No polyglot ambitions.
- **Minimal.** Every surviving menu item, view, and setting must justify itself
  for Go backend work. Default answer is "remove".
- **Native + beautiful.** Host app, macOS-first, Xcode-calibre visual polish.
- **The debugger is the product.** Run & Debug on the right, always legible,
  never an endless tree.
- **No integrated AI.** The Oracle is agent-*bootstrapped* (external CLI, first
  run only); the IDE itself only ever reads the notes files.

## Component map

```
┌────────────────────────── Burrow (VS Code fork, host app) ─────────────────────────┐
│  core patches: right-hand debug bar · inspector view host · docs overlay · layout  │
│                                                                                    │
│  built-in extensions (extensions/burrow-*):                                        │
│   go-core        toolchain mgmt, scheme bar (build/run/test), gopls, modules       │
│   go-nav         qualified-symbol (pkg.Symbol) Search-Everywhere    (task 16)      │
│   go-debug       dlv DAP wiring, breakpoints, goroutines            (task 04)      │
│   go-inspect     data-structure visualizers over DAP                (task 06)      │
│   go-docs        offline stdlib + module docs, hover→fullscreen     (task 07)      │
│   oracle         first-run agent bootstrap + notes-on-highlight     (task 08)      │
│   http-workbench Postman-class client over .http files             (task 09)      │
│   db-explorer    schema tree, ERD, pandas-style data grid           (task 10)      │
│   go-test        test explorer, coverage, bench, fuzz               (task 11)      │
│   nodewatch      ported Routes/Drills/Trace/mode-toggle integration (task 14)      │
│   frontend-debugger  visual React tool panel + tools/ sidecar        (task 15)      │
└────────────────────────────────────────────────────────────────────────────────────┘
        │ localhost:5432 (db)   │ :6060 launcher API   │ :6080/:6200 sibling tools
┌───────┴───────────────────────┴──────────────────────┴────────────────────────────┐
│  debugger compose stack (unchanged except: `ide` service retired in task 14)      │
└────────────────────────────────────────────────────────────────────────────────────┘
```

## The numbered tasks

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
| [15](15-frontend-debugger.md) | Frontend debugger | `tools/` sidecar + editor panel; reveal bridge; full-screen | 01 | ~1 wk |
| [16](16-code-navigation.md) | Qualified-symbol navigation | `pkg.Symbol` / `pkg` Search-Everywhere jump to definition | 03 | ~1.5 wk |

## Milestones

- **M0 — it builds** (01, 02): branded fork, stripped, launches on macOS.
- **M1 — daily-drivable** (03, 04, 11-core, 13-minimal): edit/build/run/debug/test
  the NodeWatch backend end-to-end on the host. *Parity with code-server setup.*
- **M2 — the differentiators** (05, 06, 07, 12, 16): right-hand debug inspector,
  visualizers, docs, qualified-symbol navigation, design pass. *Better than VS
  Code for Go.*
- **M3 — the integrated tools** (09, 10, 11-full): HTTP workbench, DB explorer,
  full test UX. *Replaces Postman + pgweb.*
- **M4 — the brain & the cutover** (08, 13-full, 14): Oracle, signed releases,
  `ide` container retired.

## Invariants carried forward from the stack

- Selection still flows through the launcher; the host IDE reads it via
  `GET :6060/api/selection` (it cannot mount the `config` volume). The launcher
  stays the ONLY `/config` writer (task 14).
- Route breakpoints anchor to handler **symbols**, never stored line numbers.
- The debug run contract (env in `launch.json`: `NODEWATCH_DEV_NO_AUTH`,
  `DATABASE_URL`, `PORT=8080`, empty Auth0/CORS) is preserved verbatim — only
  the DB host flips from `db:5432` to `localhost:5432` (task 14).
