# Upstream pin & rebase procedure

Burrow is a fork of [Code - OSS](https://github.com/microsoft/vscode).

## Current pin

| | |
|---|---|
| Upstream | `microsoft/vscode` |
| Tag | **`1.128.0`** |
| Pristine branch | `upstream-v1.128` (never commit onto this) |
| Work branch | `main` (all Burrow changes live here) |
| Cloned | shallow (`--depth 1`) — unshallow before the first rebase (below) |

## Branch model

- `upstream-v1.128` — the pristine upstream tree at the pinned tag. Zero Burrow
  commits. Used as the merge-base/reference for rebases and for regenerating the
  patch ledger's "upstream files touched" audit.
- `main` — Burrow. Everything we change lands here, organized by the four
  change layers (see [`patches/README.md`](patches/README.md) and the
  architecture docs in `../backend/docs/architecture/`).

## Change layers (rebase cost, cheapest first)

1. **Configuration** — `product.json`, build flags. Tracked by git; no source
   diff. (Done in task 01: Burrow identity + chatter removal.)
2. **Deletions** — built-in extensions / workbench contributions removed
   (task 02). Conflict-free on rebase.
3. **Core patches** — small numbered diffs, each with a `patches/` ledger entry.
   Target < 15 patches, each < 300 lines.
4. **Built-in extensions** — `extensions/burrow-*`, written against the stable
   extension API. Where ~80% of new code lives; insulated from upstream churn.

## Rebasing onto a newer upstream (quarterly)

1. Unshallow if needed: `git fetch --unshallow origin` (origin = microsoft/vscode).
2. `git fetch --tags origin` and pick the new stable tag `1.YY.Z`.
3. `git branch upstream-v1.YY 1.YY.Z`
4. `git rebase --onto upstream-v1.YY upstream-v1.128 main`
   (replays Burrow's commits from the old base onto the new one).
5. Resolve conflicts **layer by layer**: layer-2 deletions re-apply as
   still-deleted; layer-3 core patches are where conflicts concentrate — for
   each, re-read its `patches/NNNN-*.md` rationale and the upstream files it
   lists. Layer-4 extensions rarely conflict (stable API).
6. Update this file's pin, rebuild, run the smoke path, update
   `patches/README.md` "last verified against" per entry.

Cadence: pin to one stable minor; rebase **quarterly**, not every release.
