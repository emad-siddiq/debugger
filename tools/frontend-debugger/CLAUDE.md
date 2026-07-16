# Claude / agent notes — frontend_debugger

A standalone, IDE-style **visual React component debugger**: it embeds a target
React app, lets you drill from a parent component down to leaf components, and
inspect/edit each component's CSS, breakpoints, and source — with live preview
and save-back. Lives at `burrow/tools/frontend-debugger` and runs as a **Burrow
sidecar** (spawned by the `burrow-frontend-debugger` extension) or standalone on
the host; **`~/Projects/merkle`** (`nodewatch/frontend`) is the default testing
ground.

## Agents: start here
All product context, the iteration loop, the memory model, and subagent
definitions live in **`.claude/docs/README.md`**. Read that first — it's a short
index with pointers. Then read **`.claude/memory/MEMORY.md`** for the current
state snapshot.

## Architecture in one breath
One Node process: `server/` starts the *target* app's own Vite dev server
in-process (instrumented by a Vite plugin that injects `agent/agent.js` and
stamps `data-inspect-*` source coords), and serves the React **`ui/`** + a
path-allowlisted write-back API. The in-page **agent** walks the React fiber
tree and bridges to the UI over `postMessage`. Full map:
[`.claude/docs/architecture.md`](.claude/docs/architecture.md).

## Never ask a question
If you need to ask, stop and output the question(s) in prose so the user can
reply. Don't use interactive prompts.

## Branching (no new branches, no switches)
Work on the current branch — never create OR switch branches. Do not run
`git checkout -b`, `git switch -c`, `git branch <name>`, or
`git checkout/switch <branch>` unless the user explicitly asks. The PreToolUse
guard `.claude/scripts/branch-guard.sh` prompts before any create-or-switch
(file-restore `git checkout -- <path>` stays allowed).

## Commit authorship
**Never add `Co-Authored-By: Claude ...` (or any AI assistant) trailers.** Author
is the user only. Never `git push` unless asked — commits stay local for review.

## Memory is part of every change (enforced)
Every commit that changes code MUST keep `.claude/memory/` in sync in the same
commit. Memory is the cached source of truth; drift silently misleads every
future iteration. The **Oracle** (`bash .claude/oracle/run.sh`, self-contained
Node) proves memory and code agree; a PreToolUse hook runs it on `git commit`
and **blocks** on drift (override only with `ORACLE_SKIP=1` for a deliberate
memory-leads-code step, resolved the same session). After landing code, sync:
- **routes.yaml** — Express routes added/changed/removed (`server/api.js`,
  `server/index.js`).
- **protocol.yaml** — agent↔UI message `case '<cmd>'` (commands) or
  `send({type:'<event>'})` (events) added/removed (`agent/agent.js`).
- **env.yaml** — any new `process.env.X` referenced under `server/`.
- **components.yaml** — UI components added/removed under `ui/src/components/`.
- **repo.yaml** — bump `meta.updated_at`; fix `summary` counts (the Oracle
  checks these against code).

## Quick commands (flows in `.claude/commands/`)
- `/scout` — one-paragraph state + 3 ranked improvements (read-only).
- `/iterate` — one full improvement cycle (scout → implement → verify → oracle → log → commit).
- `/oracle` — run the memory↔code Oracle and report PASS/FAIL.
- `/verify` — run the Playwright end-to-end checks against a running instance.
- `/visual` — screenshot the debugger UI for a quick look.
- `/sprint [N]` — chain N `/iterate` runs.

## Running it
- Bootstrap (once): `npm install && npm run build` (builds `ui/dist`, which is
  untracked — the Burrow extension refuses to open the panel until it exists).
- From Burrow: command palette → **Burrow: Open Frontend Debugger**. The
  `burrow-frontend-debugger` extension spawns `node server/index.js` with
  `MERKLE_*`/ports from its settings, or **attaches** if something already
  answers on the UI port. Ports auto-fall-back when 6080/5180 are taken.
- Standalone: `npm install`, then `npm run dev` (serves UI with HMR + the
  instrumented target on :6080/:5180). Point at another app with
  `MERKLE_FRONTEND_DIR` / `MERKLE_REPO_ROOT`.
- Verify: `npm run verify` (needs the app running + `npx playwright install chromium`).
- Oracle: `npm run oracle` (or `bash .claude/oracle/run.sh`).

## Coding principles (apply to every edit)
- **DRY** — extract a helper at the third copy, not sooner; name it for behavior.
- **Readable before clever** — meaningful names, small functions, guard clauses,
  flat control flow.
- **Match the surrounding code** — the agent is plain ES2018 IIFE (no imports);
  the UI is React + zustand + a `postMessage` bridge (`ui/src/ipc.ts`); the
  server is Node ESM. Keep new code in the idiom of the file it lives in.
- **The agent never throws into the page** — wrap handlers in try/catch; it must
  not break the target app.
- **Writes are allowlisted** to the target's `src/` (see `server/api.js`).
