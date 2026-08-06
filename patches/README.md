# Core patch ledger

**Layer 3** of the fork strategy (see [`../UPSTREAM.md`](../UPSTREAM.md)):
small, numbered diffs against upstream VS Code *source* that can't live as a
built-in extension or a config change.

## The rule

- Every commit that edits files under `src/`, `build/`, or other upstream
  source **must** have a ledger entry here, and that entry **must name the
  file**. `../build/burrow/check-ledger.js` fails on any core file no entry
  mentions — by path, basename or stem, so prose counts and a bullet list is
  not required, but silence is not an option.
- The baseline every diff is measured against is the SHA in `UPSTREAM_BASE`,
  not a branch name. It was a branch name until WO-60b, the branch was refetched
  past the fork commit, `git diff` began answering `no merge base`, and the gate
  stopped checking anything for weeks. **If you re-base the fork, update that
  file in the same commit.**
- **Bisect boundary** (recorded 2026-08-02, WO-2 side ruling): the tag
  `baseline/pre-integration-run` (annotated, at `4d73058a`) caps an 11-commit
  re-authored fork line that shares **no merge base** with `main` — the
  baseline is accepted as *content-only*, not ancestry. `git bisect` is valid
  **within the post-baseline line on `main`**, never across the tag's line.
  The `strip:`/`build:`/`feat:`/`fix:` commit discipline holds inside that
  window, which is where it matters.
- `make ledger-check` reads HEAD *and* the working tree, so it catches an
  unledgered edit before you commit it. `make ledger-check-ci` reads HEAD only —
  what CI sees on a clean checkout.
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
| [0010](0010-compact-editor-gutter.md) | Compact editor gutter (thinner line-number + decorations reserve) | — | editor/common/config/editorOptions.ts | 2 lines | active |
| [0011](0011-native-title-bar-default.md) | Default window.titleBarStyle to native (chrome removal) | — (WO-01) | workbench/electron-browser/desktop.contribution.ts | 1 line | active |
| [0012](0012-workspace-trust-off-by-default.md) | Workspace Trust off by default (single-project IDE) | — (WO-19) | workbench/contrib/workspace/browser/workspace.contribution.ts | 1 line | active |
| [0013](0013-rail-order-and-testing-location.md) | Declared rail order; Testing to the panel; Extensions after the seven | — (WO-28) | api/browser/viewsExtensionPoint.ts, testing.contribution.ts, extensions.contribution.ts | ~12 lines | active |
| [0016](0016-floating-window-surfaces.md) | Floating-window support for Burrow surfaces (`moveEditorToMainWindow`) | — | editorCommands.ts, editorActions.ts, editor.contribution.ts, extHost.protocol.ts, mainThreadEditorTabs.ts, extHostEditorTabs.ts, vscode.d.ts | ~55 lines | active |
| [0017](0017-burrow-chat-control-chips.md) | Extension-published control chips for the local chat input | chat | burrowControlsChips.ts (new), chatInputPart.ts | ~250 lines | active |
| [0018](0018-package-into-build-dir.md) | Package the app into `.build/packaged/` instead of beside the repo | — | gulpfile.vscode.ts | 4 lines | active |

The table above is missing rows for 0006–0009, 0014 and 0015, which exist on
disk. `check-ledger.js` matches prose in any `NNNN-*.md`, not this table, so the
gate never noticed; the table is the human index and is stale.

Task 02 (strip to Go-only) deletes 64 built-in extension dirs (layer 2, no
ledger entry each) and drops the js-debug `builtInExtensions` from `product.json`
(layer 1 config). The only core-source touches it needs are the two build-wiring
patches above — both pure deletions/guards that keep the build pointed only at
extensions that still exist. The Copilot/chat product-config + `contrib/chat`
excision is deferred (see 0002 → "Not done here"). Patch 0004 lands the task 05
RD slice (Run & Debug defaults to the right aux bar); the next core patch is task
03's scheme-bar toolbar host.
