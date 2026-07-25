# 05 — Debugger-repo cleanup

> Part of the [frontend migration](00-overview.md). All edits in
> `/Users/emadinfstones/Projects/debugger` (not a git repo — plain file changes).

## docker-compose.yml

- Delete the `frontend` service block and the `fe_target_modules` volume; drop the
  header-comment caveat about frontend target switching.
- The stale `ide` service (references the deleted `backend/Dockerfile`) is pre-existing WO-00
  scope — note it, don't expand this migration to fix it.
- Gate: `docker compose config -q`.

## Makefile

- `verify`: remove the frontend gate (`cd frontend && npm install … && npm run oracle`) AND
  the dead `cd backend && node test/verify.mjs` leg (backend/ was deleted 2026-07-13).
- Update the `up` comment (line 4) — the stack no longer includes frontend.

## launcher/server.js

- Remove `'debugger-frontend'` from `TOOL_CONTAINERS` (~:30).
- Remove the frontend row from the health `SERVICES` list (~:35).
- `POST /api/mode`: keep `patchSelection({ frontendMode })` (durable persistence, still read
  by anything consuming selection.json) but drop the forward fetch to
  `http://frontend:6080/api/mode` (~:117-125), with a comment: the frontend tool lives in
  burrow now; its mode is driven by the burrow-frontend-debugger extension.
- Gate: `node launcher/test/verify.mjs` — fix any fixture asserting the removed service row
  or the forward behavior.

## CLAUDE.md (debugger root)

- **Shape**: frontend bullet → "moved into `burrow/tools/frontend-debugger` (its oracle gate
  travels with it)".
- **Memory**: drop the machine-enforced-frontend-memory paragraph; point at the tool's new
  home in burrow.
- **Verify**: gates minus frontend and backend.
- **Invariants**: drop the target-node_modules-Linux-volume invariant; re-home the agent.js
  and mode-flip invariants (they now describe `burrow/tools/frontend-debugger` paths); note
  the old `extension/` frontend panel is defunct (404s) pending the stack's dismantling.

## .claude/memory (debugger root)

- `repo.yaml` — remove the `frontend` apps row and gate row; reword the agent/mode-flip trap
  rows to their new burrow paths; delete the Linux-volume trap; update the frontend-oracle
  pref to point into burrow; bump `meta.updated_at`.
- `api.yaml` — `POST /api/mode` `what` → persistence only (no forward); header note: the
  frontend routes yaml now lives in burrow.
- `env.yaml` — header note; mark `NW_FRONTEND_URL` defunct (the old extension still reads it,
  but nothing listens).

## README.md + .env.example

- Sweep frontend/6080/5180/volume references (README compose table; `.env.example` PROJECT
  note lines).
