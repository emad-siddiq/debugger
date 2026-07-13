# 0002 — Unwire removed extensions from the build

- **Layer:** 3 (core patch — build wiring)
- **Task:** 02 (strip to Go-only)
- **Upstream files touched:** `build/lib/extensions.ts`, `package.json`,
  `build/hygiene.ts`
- **Size:** ~20 lines net removed
- **Last verified against:** upstream 1.128.0

## Why

Deleting an extension dir (layer 2) is not enough when the build names that dir
in a hardcoded list. Three such references, none glob-discovered, would each
break `npm run compile` / `make verify` against a missing path:

1. **`build/lib/extensions.ts` → `esbuildMediaScripts`** — an explicit array of
   webview/notebook esbuild entrypoints. It named `ipynb`, `markdown-math`,
   `mermaid-markdown-features`, `notebook-renderers`, and `simple-browser`
   (all removed). `compile-extension-media` fails with
   `Cannot find module '.../ipynb/esbuild.notebook.mts'` until these are pruned.
   Only the three kept `markdown-language-features` entries remain.
2. **`package.json` scripts** — `compile-copilot` / `watch-copilot` (and the
   `copilot:setup` / `copilot:get_token` helpers) shell into
   `extensions/copilot`, which is deleted. `npm run compile` fanned out to
   `compile-copilot` and failed. The copilot legs are removed from `compile`,
   `build-fast`, `watch`, and `watch-transpile`, and the dead script entries
   deleted.
3. **`build/hygiene.ts` → `checkCopilotEnginesVersion`** — reads
   `extensions/copilot/package.json` unconditionally and throws once the file is
   gone. Guarded to return clean (nothing to check) when the copilot extension
   is absent.

## What

- Prune the five removed entries from `esbuildMediaScripts`; add a comment
  recording the keep-in-lockstep rule.
- Drop `compile-copilot` / `watch-copilot` / `watch-copilotd` /
  `kill-watch-copilotd` / `copilot:setup` / `copilot:get_token` and remove the
  copilot legs from the composite `compile` / `build-fast` / `watch` /
  `watch-transpile` scripts.
- Early-return `checkCopilotEnginesVersion` when
  `extensions/copilot/package.json` does not exist.

## Not done here (deferred)

The **Copilot/chat product-config and `src/vs/workbench/contrib/chat` excision**
is a separate task. This upstream is chat-centric: `product.defaultChatAgent` is
load-bearing — accounts (`defaultAccount.ts`), `welcomeOnboarding`, and the
sessions services read it synchronously at startup and crash if it is absent.
The copilot *extension dir* and the js-debug *builtInExtensions* are removed, but
`defaultChatAgent` is intentionally kept so the app boots. The copilot **npm
dependencies** (`@github/copilot*`, `@vscode/copilot-api`) and the Azure CI
copilot pipelines are also left in place for that follow-on.

## Rebase notes

- If upstream converts `esbuildMediaScripts` to a glob, drop that hunk.
- If upstream renames the copilot npm scripts or the hygiene check, re-apply the
  same shape (remove copilot legs / guard the missing-file read).
- All three hunks are deletions or guards — low conflict risk; re-derive from the
  keep/remove ledger (`STRIP.md`) if upstream reshuffles.
