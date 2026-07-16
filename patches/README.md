# Core patch ledger

**Layer 3** of the fork strategy (see [`../UPSTREAM.md`](../UPSTREAM.md)):
small, numbered diffs against upstream VS Code *source* that can't live as a
built-in extension or a config change.

## The rule

- Every commit that edits files under `src/`, `build/`, or other upstream
  source **must** have a ledger entry here. CI rejects core-source diffs
  without one (see `../build/burrow/check-ledger.js`, task 01).
- Budget: **< 15 patches total, each < 300 lines.** Bigger ⇒ move the logic to
  a built-in extension (`extensions/burrow-*`, layer 4).
- Config-only changes (`product.json`, build flags) are **layer 1** — tracked
  by git, *not* listed here.
- Pure deletions of built-in extensions / contributions are **layer 2** —
  listed in `../STRIP.md` (task 02), not here.

## Entry format

Each patch is `NNNN-short-slug.md`:

```
# 0001 — <title>

- **Layer:** 3 (core patch)
- **Task:** <NN> (architecture doc)
- **Upstream files touched:** src/vs/…/foo.ts, src/vs/…/bar.ts
- **Size:** ~<N> lines
- **Last verified against:** upstream 1.128.0

## Why
<one paragraph: why this cannot be a config change or an extension>

## What
<what the diff does, at a level that survives a rebase conflict>

## Rebase notes
<hazards when upstream changes these files>
```

## Ledger

| # | Title | Task | Files | Size | Status |
|---|-------|------|-------|------|--------|
| [0001](0001-register-burrow-core-extension.md) | Curate the extension compilation list (burrow-core; strip) | 01, 02 | build/gulpfile.extensions.ts | ~24 lines | active |
| [0002](0002-strip-unwire-removed-extensions.md) | Unwire removed extensions from the build | 02 | build/lib/extensions.ts, package.json, build/hygiene.ts | ~20 lines | active |
| [0003](0003-strip-leaf-contributions.md) | Strip leaf workbench contributions (surveys, issue, tunnel, sync) | 02 | workbench.common.main.ts, workbench.desktop.main.ts | 7 imports | active |
| [0004](0004-rd-debug-aux-bar-default.md) | Run & Debug defaults to the right auxiliary bar (RD) | 05 | debug.contribution.ts, debugService.ts, debugSession.ts | ~6 lines | active |
| [0005](0005-suppress-first-launch-onboarding.md) | Suppress the first-launch onboarding overlay | 02 | gettingStarted.contribution.ts | 1 line | active |

Task 02 (strip to Go-only) deletes 64 built-in extension dirs (layer 2, no
ledger entry each) and drops the js-debug `builtInExtensions` from `product.json`
(layer 1 config). The only core-source touches it needs are the two build-wiring
patches above — both pure deletions/guards that keep the build pointed only at
extensions that still exist. The Copilot/chat product-config + `contrib/chat`
excision is deferred (see 0002 → "Not done here"). Patch 0004 lands the task 05
RD slice (Run & Debug defaults to the right aux bar); the next core patch is task
03's scheme-bar toolbar host.
