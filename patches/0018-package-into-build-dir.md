# 0018 — Package the app into `.build/packaged/`, not beside the repo

- **Layer:** 3 (core patch)
- **Task:** — (user request 2026-08-06, "remove the build and make sure this
  doesn't happen again or is git ignored or smth")
- **Upstream files touched:** `build/gulpfile.vscode.ts`
- **Size:** 4 lines (one constant, three call sites folded onto it)
- **Last verified against:** upstream 1.128.0

## Budget note

The **18th** entry against a stated budget of *"< 15 patches total"*
(`README.md` § The rule). Recorded rather than hidden, as 0016 and 0017 were.
This one is unusual in that the checker would not have caught it: patch 0002
already names `build/gulpfile.vscode.ts` (for `prepareBuiltInCopilotRipgrepShim`)
and `check-ledger.js` matches at filename granularity, so this change rode in on
0002's coverage. An entry that only exists because someone chose to write it is
exactly the entry most worth writing.

## Why

`packageTask` wrote the finished app to `path.dirname(root)` — the checkout's
**parent** directory:

```ts
const destination = path.join(path.dirname(root), destinationFolderName);
```

That is a CI assumption. On a build agent the checkout sits in a scratch
directory and the sibling artefact is collected and thrown away. On a
developer's machine the parent directory is wherever they happen to keep the
repo, so `gulp vscode-darwin-arm64` deposits ~1 GB (10 926 files, measured
2026-08-06) *outside the repository* — which means outside every `.gitignore`,
because ignore rules cannot reach past the repo root. It is invisible to
`git status` and highly visible to every file-tree, search and watcher in the
editor.

This fork had been living with it by nesting: the repo sat at
`Projects/debugger/burrow/`, so the parent, `Projects/debugger/`, acted as a
sandbox that caught the artefact. That is a directory level whose only job is to
absorb a hardcoded `..`, and it confused the layout for anyone reading it. The
repo is now at `Projects/debugger/` directly and this patch is what makes that
safe.

`.build/` is already listed in `.gitignore`, so the artefact is now both
contained and permanently unignorable-by-accident.

## What changed

`build/gulpfile.vscode.ts` — `buildRoot` is redefined, and the three inline
copies of the old expression now read it, so the destination and the `rimraf`
that cleans it before packaging cannot drift apart:

```diff
-const buildRoot = path.dirname(root);
+const buildRoot = path.join(root, '.build', 'packaged');

-	const destination = path.join(path.dirname(root), destinationFolderName);   // packageTask
-	const cwd = path.join(path.dirname(root), destinationFolderName);           // patchWin32DependenciesTask
-	const outputDir = path.join(path.dirname(root), destinationFolderName);     // prepareCopilotRipgrepShimTask
+	const destination = path.join(buildRoot, destinationFolderName);
+	const cwd = path.join(buildRoot, destinationFolderName);
+	const outputDir = path.join(buildRoot, destinationFolderName);
```

`buildRoot` is declared after those three functions, which is fine: they are
function bodies, evaluated long after the module finishes and the temporal dead
zone has ended.

## What was deliberately NOT changed

- **CI.** The pipelines never read this constant. They address the app through
  `$(agent.builddirectory)/VSCode-darwin-$(VSCODE_ARCH)` and the
  artifact-staging paths (`build/azure-pipelines/darwin/*.yml`), and
  `codesign.ts` globs artefact *names*, not local paths.
- **`build/gulpfile.vscode.linux.ts`**, which keeps its three
  `'../VSCode-linux-' + arch` literals. A different file, a platform this fork
  does not build locally, and folding it in would widen the patch for no gain
  here. If a Linux package is ever produced on a workstation, it needs the same
  treatment.
- **The Windows path**, `build/gulpfile.vscode.win32.ts:23`, which computes its
  own `buildPath` from `path.dirname(repoPath)`. Same reasoning as Linux.

## Retirement

Delete the constant's new value and restore `path.dirname(root)`. Nothing else
depends on the location; the artefact is disposable by definition.
