# 04 — Build wiring, ledger, burrow docs

> Part of the [frontend migration](00-overview.md). Zero new core patches.

## Build wiring

- `burrow/build/gulpfile.extensions.ts` — add
  `'extensions/burrow-frontend-debugger/tsconfig.json'` to the `compilations` array, next to
  the burrow-core line (~:58, keep the group's ordering). This is the ONLY core-source touch
  of the whole migration. Without it the extension never compiles (upstream's auto-glob is
  commented out).
- No `esbuildMediaScripts` entry needed — the webview loads the sidecar origin by URL; no
  bundled webview media.
- No `build/npm/dirs.ts` entry — the extension has zero npm deps by design.

## Ledger

- Amend `burrow/patches/0001-register-burrow-core-extension.md`: update the Size line and add
  one sentence in **What** naming the second entry (`burrow-frontend-debugger`, task/doc 15).
  Patch 0001's ledger entry explicitly covers the pattern ("every future `extensions/burrow-*`
  written in TS adds one analogous line here").
- Update the 0001 row in `burrow/patches/README.md`'s table (size ~25 lines). NOTE: this file
  currently carries uncommitted RD/WO-1 edits (patch 0004 row) — edit additively, do not
  revert anything.
- Gate: `node build/burrow/check-ledger.js` must pass.

## Burrow docs

- **New `burrow/docs/architecture/15-frontend-debugger.md`** in the house format (per
  `14-stack-migration.md`): title; `> Part of the [Go IDE overhaul](00-overview.md).
  Depends on: …`; sections Goal / What moves where / Design / Tasks / Acceptance criteria /
  Out of scope. Design covers: sidecar lifecycle + env contract, port strategy, the webview +
  `__fedbgHost` host protocol (openSource, setFullScreen), CSP, the full-screen browser mode,
  oracle-gate preservation, the bootstrap step, `ui/dist` untracked. Out of scope: packaging
  into the .app (task 13), multi-window sharing, auto-npm-install. Reference
  `debugger/docs/frontend-migration/` for the one-time move mechanics.
- `burrow/docs/architecture/00-overview.md` — one component-map line for task 15
  (`burrow-frontend-debugger` — visual React tool panel + `tools/` sidecar).

## Commits (burrow, only when the user asks)

On `main`, staged **selectively** (the tree carries uncommitted RD/WO-1 work — never
`git add -A`):

1. `tools/frontend-debugger: import the frontend debugger tool` — the moved tree + move edits
   + bridge/full-screen + memory yamls.
2. `burrow-frontend-debugger: editor panel + sidecar + bridge` — the extension, the
   compilations line, the 0001 amendment, the docs.

No `Co-Authored-By` trailers. Debugger-side edits are plain file changes (not a git repo).
