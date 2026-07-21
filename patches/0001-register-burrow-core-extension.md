# 0001 — Curate the extension compilation list (burrow-core; strip)

- **Layer:** 3 (core patch — build manifest)
- **Task:** 01 (fork bootstrap & branding); extended by 02 (strip to Go-only)
- **Upstream files touched:** `build/gulpfile.extensions.ts`
- **Size:** ~24 lines (1 add + 22 removed + a comment)
- **Last verified against:** upstream 1.128.0

## Why

Built-in extension **packaging** auto-discovers via
`glob.sync('extensions/*/package.json')`, but **TypeScript compilation** uses an
explicit hardcoded `compilations` array in `build/gulpfile.extensions.ts` (the
auto-glob is commented out upstream, line ~49). A new `extensions/burrow-*`
written in TS is not compiled unless registered there. This cannot be a config
change or live in the extension itself — it is upstream build wiring.

## What

Adds `'extensions/burrow-core/tsconfig.json'` to the `compilations` array
(alphabetically first). Every future `extensions/burrow-*` written in TS adds
one analogous line here — this entry covers the pattern, not just the one file.

**WO-2 extension:** `'extensions/burrow-go-debug/tsconfig.json'` (the `dlv dap`
adapter, architecture task 04 slice) is added right after burrow-core, following
this same rule — `burrow-*` entries grouped and alphabetized at the top.

**WO-3 extension:** `'extensions/burrow-go-inspect/tsconfig.json'` (the IX value
inspector — path-addressed DAP model + summary renderer, architecture task 05.3)
is added right after burrow-go-debug, same rule.

**Task 15 extension:** `'extensions/burrow-frontend-debugger/tsconfig.json'`
(the frontend-debugger editor panel + sidecar host, architecture task 15) is
added between burrow-core and burrow-go-debug, same rule.

**Task-03 extension (`burrow-go-base`):** the gopls language client
(`'extensions/burrow-go-base/tsconfig.json'`) registers here like the others, but
it is the FIRST `burrow-*` extension with a runtime npm dependency
(`vscode-languageclient`), so it also needs an entry in **`build/npm/dirs.ts`**
(`'extensions/burrow-go-base'`) — the curated list of dirs `postinstall` runs
`npm install` in. That is a second build-list touch beyond this file; the two
lists are the same "curated Burrow build wiring" concern, so this ledger entry
covers both. Dep-free `burrow-*` extensions stay out of `dirs.ts` (correctly).

**Full-Stack-Debugger extension (`burrow-ts-base`):** the `typescript-language-server`
client (milestone M4/N3) registers here (`'extensions/burrow-ts-base/tsconfig.json'`) AND,
being the SECOND `burrow-*` with runtime npm deps (`vscode-languageclient` + the bundled
`typescript-language-server` + `typescript`), also gets a `build/npm/dirs.ts` row
(`'extensions/burrow-ts-base'`) — exactly like `burrow-go-base`. Same two-list concern;
this entry covers both touches. Its sibling, the restored built-in
`extensions/typescript-basics` grammar (un-stripped from `upstream-v1.128` so `.ts`/`.tsx`
register + highlight and back the LSP + the FD isolation editor), is grammar-only (no
`tsconfig.json` → not in this array; auto-globbed for packaging) and dep-free (not in
`dirs.ts`), so it needs no build-list row and no ledger touch of its own.

**Full-Stack-Debugger extension (`burrow-docker`):** the Docker activity-bar viewlet
(`'extensions/burrow-docker/tsconfig.json'`, Full Stack Debugger milestone M3) registers
here like the others — grouped alphabetically among the `burrow-*` entries (after
`burrow-db`). It is a self-contained layer-4 extension (activity-bar viewsContainers +
TreeDataProviders + the `docker` CLI; no runtime npm dep, so no `dirs.ts` entry, and no
core change beyond this one compilation line), so this ledger entry — covering the
*pattern* — is the only ledger touch it needs.

**Tool-extension batch (tasks 06/07/08/09/10/11/16):** seven new first-slice tool
extensions register the same way, grouped and alphabetized among the `burrow-*`
entries at the top of the array — `burrow-db` (task 10 DB explorer),
`burrow-go-docs` (07 Go docs), `burrow-go-nav` (16 qualified-symbol nav),
`burrow-go-test` (11 test explorer), `burrow-go-viz` (06 value visualizers),
`burrow-http` (09 HTTP workbench), `burrow-oracle` (08 codebase Oracle). All are
self-contained layer-4 extensions (no core-source change beyond this one line
apiece), so this ledger entry — which covers the *pattern* — is the only ledger
touch they need.

**Task 02 extension:** the same array is the curated source of truth for which
TS extensions compile, so the strip prunes it in lockstep with deleting dirs —
the 22 entries for removed extensions (css/html-language-features, emmet, github,
grunt/gulp/jake, ipynb, markdown-math, mermaid, microsoft-authentication,
notebook-renderers, npm, php-language-features, simple-browser, tunnel-forwarding,
typescript-language-features, debug-auto-launch) are gone. A stale entry points
gulp at a missing `tsconfig.json` and fails the build, so this must move with the
deletions. A prose comment on the array records the rule.

## Rebase notes

- If upstream re-enables the auto-glob (uncomments line ~49), this whole array
  disappears and the registration becomes unnecessary — drop this patch.
- If upstream reorders/reformats the array, re-add the burrow line; order is
  cosmetic (alphabetical).
- Keep `burrow-*` entries grouped and alphabetized so the rebase diff is a
  clean insertion, not an interleave.
