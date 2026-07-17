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
