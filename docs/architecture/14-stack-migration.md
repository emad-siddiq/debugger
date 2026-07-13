# 14 — Stack migration: retire the ide container

> Part of the [Go IDE overhaul](00-overview.md). Depends on: 04, 09. Effort: ~2 wk.

## Goal

Cut the debugger stack over from "code-server in the `ide` container" to
"Burrow on the host", with every integration the stack promises — selection
flow, digest feed, Routes/Drills/Trace, mode toggle, emitter traffic —
preserved or improved. The stack's other tools (launcher, frontend, simulator,
db) keep working untouched throughout; the old `ide` service survives one
release behind a compose profile as the rollback.

## What moves where

| Today (container) | After (host Burrow) |
|---|---|
| code-server UI :6100 | Burrow.app (no port) |
| backend under debug in-container :8080 | backend under debug **on host** :8080 |
| `DATABASE_URL=…@db:5432` | `…@localhost:5432` (compose `db` stays, port already published) |
| emitters → `http://ide:8080` | emitters → `http://host.docker.internal:8080` |
| selection read from `/config` mount | selection read from launcher `GET :6060/api/selection` |
| digest via docker-exec **into ide** | digest computed by Burrow on host, **posted to** the launcher |
| nodewatch-debugger .vsix in code-server | `burrow-nodewatch` built-in extension |
| launcher restarts `ide` on select | launcher just writes selection; Burrow follows it live |

## Design

### Selection (invariant preserved: launcher is the only /config writer)

- Burrow's `burrow-nodewatch` extension polls `GET :6060/api/selection`
  (2s, ETag) when the launcher is reachable. Selection change → non-modal
  prompt: "Launcher selected `<project>` — switch workspace?" (auto-follow
  setting for the single-user flow). Burrow never writes selection; picking a
  project inside Burrow calls `POST /api/select` and lets the flow come back
  around.
- Launcher's "Open Backend IDE" button: `burrow://open?folder=<host path>`
  (the task 01 `urlProtocol`), resolving the container `/projects/...` path to
  the host path via the launcher's own `PROJECTS_DIR` knowledge. Burrow not
  installed → the button falls back to the task 13 download page. The launcher
  stops restarting an ide container on selection change (tool-restart list
  shrinks by one).

### Digest (direction reverses; writer stays the launcher)

Today `launcher/digest.js` docker-execs merkle's oracle digest inside the ide
container (it had the Go toolchain + warm module cache). The host has both,
Burrow manages them (task 03), so:

- Burrow runs `test/cmd/oracle --digest` on the host (command from repo
  config, same as today's exec line) and `POST`s the raw markdown to a new
  launcher endpoint `POST /api/digest/ingest`.
- `digest.js` keeps its **parser and cache** (`/config/digest.json`, grammar
  unchanged — fixture tests still pass) but drops the docker-exec plumbing;
  `POST /api/digest` (the old "refresh" trigger) returns `410` pointing at the
  new flow when no ide container exists.
- Consumers are untouched: Routes tree and `routes.generated.http` (task 09)
  read the same parsed JSON via `GET /api/digest`.

### The nodewatch integration extension (port, don't rewrite)

`extension/src/*` moves into the fork as `extensions/burrow-nodewatch/`,
feature-for-feature:

- **Routes tree** — digest-fed, breakpoints anchored to handler **symbols**
  (DocumentSymbolProvider, task 04 function-breakpoint fallback; the stored-
  line-numbers ban stands).
- **Drills tree** and **MOCK↔LIVE toggle** — unchanged REST calls to the
  launcher (`POST /api/mode` stays the durable path; frontend `POST /api/mode`
  stays ephemeral).
- **Request Trace** — the DAP tracker now taps Burrow's own debug sessions
  (same `vscode.debug.registerDebugAdapterTrackerFactory` API), joining slog
  output with the frontend's `/api/netlog` on `X-Request-Id`; the task 09
  workbench's injected ids feed the same join.
- **Tool panels** — webview iframes to the sibling tools by full public origin
  (`http://${NW_PUBLIC_HOST:-localhost}:6080|6200|6101`). In Electron there is
  no code-server `/proxy/<port>` rewriting, so the old `asExternalUri`
  landmine defuses itself — but the full-origin rule remains the documented
  invariant for remote-host stacks.
- **`.vscode` seeding** — the entrypoint's seed job (launch/tasks/settings/
  api.http, never clobbering) becomes a first-open offer from the extension,
  sourcing the same `backend/vscode/*` files, with the compose-host
  `DATABASE_URL` variants flipped to `localhost` as the new default scheme
  order.

### Compose + repo cleanup

- `ide` service and its `nw_go` / `nw_code_server` volumes move behind
  `profiles: ["legacy"]` for one release (`docker compose --profile legacy up`
  = old world, rollback documented), then delete. `pgweb` follows the same
  two-step retirement once the task 10 explorer ships.
- Emitters: `API_URL: http://host.docker.internal:8080` (+
  `extra_hosts: host-gateway` for Linux hosts).
- Launcher health proxy: backend health probes `host.docker.internal:8080/healthz`
  (label it "backend (host)"), tolerating "not running" as a normal state.
- `debugger/backend/` slims to: these docs, `vscode/` seeds, oracle prompts,
  and a `test/verify.mjs` updated to check the seeds + the new launcher
  contract instead of the Dockerfile/entrypoint.
- Root `README.md` + `CLAUDE.md` rewritten where they promise the old shape
  (ide container, :6100, PORT-collision lore, `asExternalUri` invariant
  scoped to its remaining webview-origin form).

## Tasks

1. **Selection follow.** Poll/prompt/auto-follow in `burrow-nodewatch`;
   `burrow://open` handler + launcher button with install fallback;
   remove ide from the launcher's restart set.
2. **Digest reversal.** `POST /api/digest/ingest` (parse + write, launcher
   still sole writer); Burrow-side digest runner on scheme-bar refresh + oracle
   command; retire exec plumbing; keep parser fixtures green.
3. **Extension port.** Move `extension/src` into `extensions/burrow-nodewatch/`;
   re-wire tracker to native debug sessions; panels to full-origin webviews;
   first-open `.vscode` seeding with localhost-first schemes.
4. **Compose changes.** Legacy profile for ide+volumes, emitter retarget with
   `extra_hosts`, health-proxy update; `docker compose config -q` and the
   launcher tests stay green.
5. **Docs + invariants.** README/CLAUDE.md updates; migration note for
   existing users (what happens to `nw_go`/`nw_code_server` data: nothing —
   host Go caches take over).
6. **Cutover rehearsal.** Fresh machine: `docker compose up -d` (no ide) +
   install Burrow → pick project in launcher → Burrow opens it → breakpoint
   via Routes tree → emitter traffic hits it → trace joins → drill runs →
   mode flips. Then `--profile legacy` rollback rehearsal.

## Acceptance criteria

- The full demo loop (select → open → breakpoint → traffic → trace → drill →
  mode flip) passes on a fresh machine with **no ide container running**.
- `launcher/test` and `launcher/digest` fixture tests pass with the reversed
  digest flow; `/config` writes still originate only from the launcher.
- Old world reachable via `--profile legacy` for exactly one release; its
  removal PR deletes `backend/Dockerfile`, `scripts/entrypoint.sh`, and the
  code-server config in one commit.
- Route breakpoints still bind by symbol after the port (no line numbers in
  any persisted state).

## Out of scope

- Multi-user/remote-host stacks beyond keeping `NW_PUBLIC_HOST` working for
  the webview origins; Burrow-in-a-container (explicitly the thing we're
  ending).
