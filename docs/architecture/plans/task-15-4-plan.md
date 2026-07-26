# Task 15.4 — implementation plan

> 15.4 — Bundle the frontend-debugger tool into the shipped .app

Build-ready plan from the parallel planning pass (ultracode run), grounded in the current tree.

## Layer breakdown

config (layer 1): none strictly required if the bundle mirrors the repo layout (see alreadyExists); optionally a .gitignore row for .build/frontend-debugger-tool/. core-patch-with-ledger (layer 3): ONE small touch to build/gulpfile.vscode.ts — merge a frontendTool gulp stream into packageTask so the staged tree lands at resources/app/tools/frontend-debugger, and wire the staging task into the vscode task series. build/ is check-ledger CORE (/^build/(?!burrow/)/), so this needs a new ledger entry patches/0010-*.md + a patches/README.md table row. The staging script under build/burrow/ is EXCLUDEd (/^build/burrow//) so it needs NO ledger entry. new burrow-* extension (layer 4): a minimal, existence-checked toolPath fallback in extensions/burrow-frontend-debugger/src/config.ts (+ recompile out/) and a description tweak in its package.json — no new extension is created; task 15's tasks 1-3 already shipped it. outer-repo (task 14): none for 15.4 — the launcher 'Open Backend IDE' download link that points at the packaged .app is task 13.4/14 work, not this task; the compose frontend service is already retired.

## Already exists

1) The extension is complete and compiled: extensions/burrow-frontend-debugger/out/{extension,sidecar,panel,config,status}.js all present (tasks 15.1-15.3 landed). 2) The sidecar already spawns in a packaging-compatible way — sidecar.ts:94-98 does cp.spawn(process.execPath, [toolRoot/server/index.js], {env:{ELECTRON_RUN_AS_NODE:'1', NODE_ENV:'production', ...}}); in a packaged app process.execPath is the Electron binary and this runs as Node, identical to dev. 3) toolPath resolution already mirrors the packaged layout: config.ts:39-40 defaults to path.resolve(context.extensionPath,'..','..','tools','frontend-debugger'); in the .app extensionPath = resources/app/extensions/burrow-frontend-debugger, so ../../tools/frontend-debugger = resources/app/tools/frontend-debugger — meaning if we bundle there, resolution WORKS WITH NO CODE CHANGE. 4) preflight() (sidecar.ts:152-166) already asserts server/index.js, node_modules, and ui/dist/index.html exist — it validates the bundled tree for free. 5) The production dependency surface is already minimal and pure-JS: package.json dependencies = @babel/core, express, postcss; the tool's own vite/react/monaco are devDependencies only — targetServer.js:53-57 resolves vite/@vitejs/plugin-react from the TARGET repo's node_modules (createRequire anchored above the target node_modules), and index.js:135's `await import('vite')` is dev-only (NODE_ENV!==production). So pruning to production deps cannot break the sidecar. 6) ui/dist is built and the oracle is 0 FAIL (given). 7) Ledger discipline is in place: build/burrow/check-ledger.js, patches/README.md table, patches 0001-0009.

## Open items

- Task 13's release CI / signing-notarization pipeline does not exist yet (it is the stated dependency) — full 'signed, notarized, Gatekeeper-clean' verification is BLOCKED until 13.1/13.3 land; the interim gate is a local unsigned `gulp vscode-darwin-arm64` build that contains and runs the bundled tool.
- Decide bundle location: resources/app/tools/frontend-debugger (mirrors repo layout, zero config.ts change) vs resources/app/extensions/burrow-frontend-debugger/tool (rides the already-wired extension copy, avoids the core gulpfile touch but pollutes the extension dir and needs a config.ts re-point). Recommended: mirror to resources/app/tools/ with the small ledgered gulpfile patch — matches the doc's 'tool stays at tools/' layering.
- Confirm the staged node_modules is symlink-free and native-binary-free before notarization (express/@babel/core/postcss are pure JS, but `npm ci` writes node_modules/.bin symlinks — strip .bin and any nested test/ dirs in the staging script so hardened-runtime/notarytool sees no unsigned Mach-O and no dangling links).
- Confirm the pinned Electron runs the tool's ESM ('type':'module') server under ELECTRON_RUN_AS_NODE in the packaged app (dev already uses the identical spawn path, so expected fine — verify once on the built .app).
- Verify gulp packageTask picks up the injected stream deterministically (the plan uses an explicit gulp.src into mergeStreams rather than relying on .build/extensions copy semantics, to avoid ambiguity).
- Update docs/architecture/15-frontend-debugger.md: flip task 4 from ☐ to ✅ and move 'Packaging the tool into the .app' out of 'Out of scope'; add a bundled-tool smoke line to docs/architecture/13's task 6 runbook / RELEASING.md once that file exists.

## First slice

De-risk the pruned runtime before touching any build core. Add build/burrow/stage-frontend-tool.js that stages tools/frontend-debugger into .build/frontend-debugger-tool/ — copy server/, agent/, ui/dist/, package.json (NOT src/, test/, .claude/, ui/src, package-lock.json), then run `npm ci --omit=dev` in the staged dir (or copy node_modules + `npm prune --omit=dev`). Then prove the staged tree runs as a sidecar exactly as the extension does: `ELECTRON_RUN_AS_NODE=1 NODE_ENV=production MERKLE_REPO_ROOT=~/Projects/merkle UI_PORT=6099 <electron-execPath> .build/frontend-debugger-tool/server/index.js`, and confirm GET 127.0.0.1:6099/healthz returns ok and / serves the built SPA from ui/dist. (`MERKLE_FRONTEND_DIR` is deliberately *not* set: `server/config.js:32` probes `['frontend', 'nodewatch/frontend']` newest-first, so letting it detect proves the shipped detection works. An earlier draft of this line pinned `~/Projects/merkle/nodewatch/frontend`, which no longer exists — merkle flattened that nesting away.) This proves the production dep set (express/@babel/core/postcss; vite is loaded from the TARGET repo, not the tool — see targetServer.js:53) is sufficient, with zero core-source risk. Nothing ships yet.

## Files to touch

- `/Users/emadinfstones/Projects/debugger/burrow/build/burrow/stage-frontend-tool.js (NEW — stage + prod-prune, no ledger; under build/burrow/)`
- `/Users/emadinfstones/Projects/debugger/burrow/build/gulpfile.vscode.ts (CORE PATCH — merge frontendTool stream into packageTask mergeStreams ~line 369-377; wire staging task into the vscode task series ~line 643-688)`
- `/Users/emadinfstones/Projects/debugger/burrow/patches/0010-bundle-frontend-tool-into-app.md (NEW ledger entry)`
- `/Users/emadinfstones/Projects/debugger/burrow/patches/README.md (add row 0010 to the ledger table)`
- `/Users/emadinfstones/Projects/debugger/burrow/extensions/burrow-frontend-debugger/src/config.ts (existence-checked toolPath fallback; recompile out/config.js)`
- `/Users/emadinfstones/Projects/debugger/burrow/extensions/burrow-frontend-debugger/package.json (toolPath description: mention the bundled default)`
- `/Users/emadinfstones/Projects/debugger/burrow/docs/architecture/15-frontend-debugger.md (task 4 ✅; out-of-scope update; acceptance line for packaged run)`
- `/Users/emadinfstones/Projects/debugger/burrow/.gitignore or build/.gitignore (ignore .build/frontend-debugger-tool/ if not already covered by .build)`

## Core risk

The only core-source touch is the packageTask injection in build/gulpfile.vscode.ts (ledger 0010). The real hazard is the bundled node_modules, not the wiring: it must be production-pruned, pure-JS (no native .node needing per-arch rebuild or separate code-signing), symlink-free, and small, or it bloats the .app and breaks notarization/hardened-runtime. This is well-mitigated because the tool's only runtime deps are express/@babel/core/postcss — all pure JS — and vite is resolved from the TARGET repo at runtime (targetServer.js:53), never from the bundled tool, and index.js:135's vite import is dev-only. Secondary risk: toolPath must resolve to the bundled copy and must NOT silently fall back to a non-existent repo path in the packaged app — mitigated by bundling at resources/app/tools/frontend-debugger (so config.ts:39-40's existing ../../tools/frontend-debugger already resolves) plus an existence-checked fallback, and a test that renames the repo's tools/ dir to prove the .app uses its own bundled copy.

## Dependencies

Hard dependency: task 13 (docs/architecture/13-packaging-signing-updates.md) — specifically 13.1 Release CI (build→sign→notarize→staple) and 13.3 entitlements/outbound audit. 15.4's bundling can be built and verified against a LOCAL unsigned `gulp vscode-darwin-arm64` today, but 'notarized, Gatekeeper-clean, outbound-audit-clean' acceptance can only be signed off once 13.1/13.3 exist. Soft dependency: docs/architecture/13 task 6 RELEASING.md (the runbook where the bundled-tool smoke step should be recorded). No dependency on task 14/outer repo for 15.4 itself. Internal: builds on tasks 15.1-15.3 (already ✅) and patch 0001's standing rule for the extension's compilations line (already covered).

## Full plan

## Task 15.4 — Package the frontend-debugger tool into the shipped .app

Grounded in files read: docs/architecture/15-frontend-debugger.md (task 4 is the only ☐), docs/architecture/13-packaging-signing-updates.md, patches/README.md + 0008 (ledger discipline), build/gulpfile.vscode.ts (packageTask), build/burrow/check-ledger.js, extensions/burrow-frontend-debugger/src/{sidecar,config,extension}.ts, tools/frontend-debugger/{package.json,server/{index,config,targetServer,api}.js}.

### Why this is mostly already solved
- The sidecar spawn (sidecar.ts:94-98) is already packaging-shaped: `cp.spawn(process.execPath, [toolRoot+'/server/index.js'], {env:{ELECTRON_RUN_AS_NODE:'1', NODE_ENV:'production',…}})`. In the .app, process.execPath IS the Electron binary → runs as Node.
- toolPath default (config.ts:39-40) is `path.resolve(context.extensionPath,'..','..','tools','frontend-debugger')`. In the .app, extensionPath = `resources/app/extensions/burrow-frontend-debugger`, so this already points at `resources/app/tools/frontend-debugger`. **Bundle there and no resolution code changes.**
- preflight (sidecar.ts:152-166) already validates server/index.js + node_modules + ui/dist/index.html — it guards the bundled tree.
- Runtime deps are minimal + pure-JS: package.json `dependencies` = @babel/core, express, postcss. The tool's vite/react/monaco are devDependencies — targetServer.js:53-57 loads vite from the TARGET repo's node_modules, and index.js:135's vite import is dev-only. So production-pruning is safe.

So the whole task reduces to: (a) produce a pruned, ship-safe copy of the tool tree at build time, (b) place it at `resources/app/tools/frontend-debugger`, (c) harden the toolPath fallback, (d) ledger + docs + verify.

### Step 1 — build/burrow/stage-frontend-tool.js (NEW, no ledger)
A self-contained Node script (matches check-ledger.js style: node core only, CommonJS, under build/burrow/ which is ledger-EXCLUDEd).
- SRC = repo/tools/frontend-debugger; DEST = repo/.build/frontend-debugger-tool.
- rimraf DEST; copy ONLY: server/, agent/, ui/dist/, package.json. Explicitly skip src/, test/, .claude/, ui/src/, README.md, CLAUDE.md, package-lock.json, node_modules.
- Fail loudly if ui/dist/index.html is missing (names the bootstrap `cd tools/frontend-debugger && npm run build`, mirroring the sidecar preflight message).
- Install production deps into DEST: `cp package.json` then `npm ci --omit=dev --no-audit --no-fund` (or, to avoid a second lockfile resolution, copy SRC/node_modules then `npm prune --omit=dev` in DEST). Prefer `npm ci --omit=dev` using package-lock copied transiently for reproducibility, then delete the lock from DEST.
- Post-clean for notarization: remove node_modules/.bin (symlinks), any **/{test,tests}/** and **/*.md inside node_modules, and any stray *.node (there should be none). Assert no symlinks remain (walk + lstat).
- Print a size summary; assert node_modules/express, node_modules/@babel/core, node_modules/postcss exist and node_modules/vite does NOT.

### Step 2 — Wire into the packaging build (CORE PATCH → ledger **0014**)
> Numbering note: this plan was written when 0010 was the next free slot. The ledger has since
> reached 0013 (`rail-order-and-testing-location`), so this patch is **0014** — and that leaves
> exactly one slot under the <15 budget. Read `patches/README.md` before assuming a number.

Edit build/gulpfile.vscode.ts:
1. Define a staging gulp task (thin wrapper that shells `node build/burrow/stage-frontend-tool.js`) OR import a small exported fn from build/burrow. Add it to the vscode task series so it runs before packageTask — insert into both esbuild and non-esbuild branches of the BUILD_TARGETS loop (~lines 669-688), e.g. as an early series step alongside cleanExtensionsBuildTask. Guard it to run once per build.
2. In packageTask (~lines 369-377), add a `frontendTool` stream to mergeStreams:
   `const frontendTool = gulp.src('.build/frontend-debugger-tool/**', { base: '.build/frontend-debugger-tool', dot: true }).pipe(rename(p => { p.dirname = path.join('tools','frontend-debugger', p.dirname); }));`
   and push it into mergeStreams. With base rewrite it lands at `resources/app/tools/frontend-debugger/**`. Do NOT run it through createAsar (extensions/tools stay unpacked so spawn + fs.existsSync work).
3. Keep the touch under ~10 lines. This is the sole core-source diff.

### Step 3 — Harden toolPath resolution (layer 4, our extension)
Edit extensions/burrow-frontend-debugger/src/config.ts:39-40. Keep the explicit `toolPath` setting first; then resolve the first existing of [repo-relative `../../tools/frontend-debugger`, bundled `../../tools/frontend-debugger` (same path in .app), and a belt-and-suspenders `path.join(context.extensionPath,'tool')`], falling back to the repo-relative path. Because the bundle mirrors the layout, the existing expression already hits it; the existence check just makes intent explicit and future-proofs an alternate bundle location. Recompile via `gulp compile-extension:burrow-frontend-debugger`. Update the toolPath description in package.json to note the shipped default.

### Step 4 — Ledger + README (required by check-ledger.js)
Add patches/0014-bundle-frontend-tool-into-app.md following the 0008 format: Layer 3, Task 13/15, Upstream files touched = build/gulpfile.vscode.ts, Size ~10 lines, Why (the .app packageTask is the only place to inject a bundled tool; can't be an extension-only or config change because it merges into the darwin/linux package stream), What (frontendTool stream + staging task wiring), Rebase notes (if upstream restructures packageTask/mergeStreams, re-add the single stream + task-series entry; the staging script under build/burrow is rebase-inert). Add the 0014 row to the patches/README.md ledger table.

### Step 5 — Docs
docs/architecture/15-frontend-debugger.md: flip task 4 ☐→✅; remove 'Packaging the tool into the .app (task 13)' from Out of scope; add an acceptance line: 'Packaged .app: Open Frontend Debugger runs the bundled tools/frontend-debugger sidecar (repo tools/ absent).' In docs/architecture/13 task 6 (or RELEASING.md when it exists), add a smoke step: fresh-install .app → Open Frontend Debugger renders the SPA.

### Step 6 — Verify (see verifyStrategy). Commit per the standing WO authorization; author = user only; no Co-Authored-By; stay on current branch (main).

### Rejected alternative (documented for reviewers)
Bundling the pruned tool UNDER the extension dir (extensions/burrow-frontend-debugger/tool/) so it rides the already-wired extension copy and avoids the gulpfile.vscode.ts core touch. Rejected as primary because (a) it pollutes the extension with a large generated node_modules artifact, (b) it breaks the doc's deliberate 'tool stays at tools/, extension is separate layer-4' boundary, and (c) it depends on unverified .build/extensions wholesale-copy semantics. The chosen packageTask-stream approach is deterministic and costs exactly one small ledgered patch.

## Verify strategy

1) Staging unit check: run node build/burrow/stage-frontend-tool.js; assert .build/frontend-debugger-tool/ contains server/index.js, agent/agent.js, ui/dist/index.html, node_modules/express, node_modules/@babel/core, node_modules/postcss, and does NOT contain node_modules/vite or node_modules/react (dev-only) or node_modules/.bin symlinks or src/. 2) Standalone sidecar smoke on the staged tree (the firstSlice): spawn with ELECTRON_RUN_AS_NODE=1 NODE_ENV=production against ~/Projects/merkle, poll /healthz ok, GET / and confirm the built SPA (from ui/dist) is served. 3) Full packaged build: node build/burrow/stage-frontend-tool.js then `npm run gulp vscode-darwin-arm64` (unsigned); open ../VSCode-darwin-arm64/'Burrow — Go IDE.app'; temporarily rename the repo tools/frontend-debugger away to PROVE the app uses its bundled copy; run command 'Burrow: Open Frontend Debugger'; confirm the panel renders the SPA, /healthz OK in the Frontend Debugger output channel, and a component-source chip reveals a merkle .tsx Beside at line:col. 4) Ledger gate: BURROW_UPSTREAM_REF=upstream-v1.128 node build/burrow/check-ledger.js passes with 0010 present, and the only core diff is build/gulpfile.vscode.ts. 5) Extension compile: gulp compile-extension:burrow-frontend-debugger → 0 errors. 6) Tool oracle unaffected: cd tools/frontend-debugger && npm run oracle → 0 FAIL (packaging changes no routes/protocol/env). 7) Post-task-13: rerun the task-01 outbound audit on the signed build (the bundled tool adds no idle network) and confirm notarytool staples with no new unsigned Mach-O (pure-JS deps).
