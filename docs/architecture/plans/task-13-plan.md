# Task 13 — implementation plan

> Burrow packaging, signing & update channel (task 13)

Build-ready plan from the parallel planning pass (ultracode run), grounded in the current tree.

## Layer breakdown

**Layer 1 — config (product.json, build flags, feed):** Add `quality: "stable"` and `updateUrl` to `product.json` (currently absent — `nodejsArtifactFeed`/`electronArtifactFeed` are empty strings, no `updateUrl`/`quality` key at all). Version-bump mechanics. This is the update-channel wiring; the upstream updater already consumes `product.updateUrl` + `quality`, so no core patch is needed to point it at our feed.

**Layer 3 — core patch + ledger:** One unavoidable upstream-source touch — trimming `build/azure-pipelines/darwin/app-entitlements.plist` (and helper plists) from the current camera/audio-input/apple-events set down to JIT-only per task 13.3. `build/burrow/check-ledger.js:18` counts `^build/(?!burrow/)` as core source, so any edit under `build/azure-pipelines/` trips the ledger gate → needs new `patches/0010-trim-darwin-entitlements.md`. (All *new* release tooling goes under `build/burrow/` and `.github/workflows/`, both ledger-excluded, so they need no patch.)

**Layer 4 — new burrow-* extension:** `extensions/burrow-crash-triage` (task 13.5) — reveal-in-Finder + attach-crashpad-dump-to-GitHub-issue, no telemetry backchannel. Lowest priority; ships last.

**Outer-repo (task 14):** `launcher/` — a one-page download/"install Burrow" surface shown when Burrow isn't detected, targeting the GitHub Release / brew cask. The Backend IDE card already exists (`launcher/ui/app.js:12`, `launcher/server.js:35`) but has no download link.

## Already exists

The upstream macOS packaging pipeline is fully present and Burrow-branded — this task is mostly *wiring + a GitHub Actions harness + secrets*, not building a pipeline from scratch:
- **Build:** `build/gulpfile.vscode.ts:624-681` defines `vscode-darwin-arm64(-min)` / `vscode-darwin-x64(-min)` tasks producing `../VSCode-darwin-<arch>`; `BUILD_TARGETS` already lists both darwin arches + linux x64/armhf/arm64.
- **Universal + DMG:** `build/darwin/create-universal-app.ts`, `build/darwin/create-dmg.ts`, `build/darwin/dmg-settings.py.template`, `patch-dmg.py`, `dmg-background-stable.tiff`.
- **Sign/notarize primitives:** `build/darwin/sign.ts`, `build/darwin/verify-macho.ts`, `build/azure-pipelines/darwin/codesign.ts` (spawnCodesign + notarize), entitlements plists `build/azure-pipelines/darwin/{app,helper,helper-renderer,helper-gpu,helper-plugin,server}-entitlements.plist`. `@electron/osx-sign` is vendored (`build/node_modules/@electron/osx-sign`).
- **Identity (task 01) already set** in `product.json`: `nameShort":"Burrow"`, `applicationName":"burrow"`, `darwinBundleIdentifier":"dev.burrow.ide"`, `urlProtocol":"burrow"`, `reportIssueUrl` → `github.com/burrow-ide/burrow`, `enableTelemetry":false`.
- **Ledger discipline:** `build/burrow/check-ledger.js`, `patches/README.md` (9 entries 0001-0009), `UPSTREAM.md` (pinned upstream `1.128.0`, work branch `main`).

## Open items

- product.json has NO `updateUrl` and NO `quality` field — the updater is unwired; empty `nodejsArtifactFeed`/`electronArtifactFeed`. Need the actual bucket/Pages origin decided before wiring.
- No release CI: `.github/workflows/` holds only upstream PR/test workflows; real build infra is `build/azure-pipelines/` (Microsoft ESRP/OIDC, internal — NOT reusable). A new `burrow-release.yml` reimplementing sign/notarize with `@electron/osx-sign`+`notarytool` is required.
- Entitlements still grant camera + audio-input + apple-events (`build/azure-pipelines/darwin/app-entitlements.plist`) — task 13.3 wants JIT-only; a trim + audit is outstanding (and trips check-ledger).
- No update-feed generator (version/sha256/url per platform) and no user-facing disable setting surfaced (upstream `update.mode` exists but isn't documented as Burrow's on/off switch).
- No `RELEASING.md` runbook (task 13.6), no Homebrew cask/tap automation, no download page (task 13.4).
- No crash-triage helper extension (task 13.5).
- Apple Developer ID cert + notarytool credentials + the self-hosted feed bucket do not exist in-repo — the signed/notarized/Gatekeeper acceptance path cannot be verified until those are provisioned; only an UNSIGNED local build is exercisable now.
- Decide whether release tooling reuses `build/azure-pipelines/darwin/codesign.ts` verbatim (ESRP-coupled) or a fresh `build/burrow/release/*` sign script — recommend the latter to stay ledger-free and secrets-portable.
- Gate 15.4 dependency: the .app must bundle `tools/frontend-debugger` (built `ui/dist` + pruned deps) and re-point `toolPath` (docs/architecture/15-frontend-debugger.md:104) — a packaging step this task must expose.

## First slice

Wire the update channel + a dry-runnable feed, with zero secrets and no heavy build: (1) add `"quality": "stable"` and `"updateUrl": "https://updates.burrow-ide.dev"` (placeholder origin) to `product.json`; (2) add `build/burrow/release/gen-feed.js` — a dependency-free Node script that, given a version + a directory of built artifacts, emits the per-platform feed JSON (`{version, productVersion, quality, timestamp, platforms:{darwin-universal:{url,sha256,supportsFastUpdate:false}, ...}}`) matching what the VS Code updater fetches from `updateUrl`; (3) `build/burrow/release/test/verify.mjs` that runs gen-feed against a fixture artifact dir and asserts schema + sha256 correctness. This proves the update-channel contract and lands the config, verifiable with `node build/burrow/release/test/verify.mjs` — no Apple creds, no gulp compile.

## Files to touch

- `/Users/emadinfstones/Projects/debugger/burrow/product.json`
- `/Users/emadinfstones/Projects/debugger/burrow/build/burrow/release/gen-feed.js`
- `/Users/emadinfstones/Projects/debugger/burrow/build/burrow/release/build-darwin.sh`
- `/Users/emadinfstones/Projects/debugger/burrow/build/burrow/release/sign-notarize.js`
- `/Users/emadinfstones/Projects/debugger/burrow/build/burrow/release/test/verify.mjs`
- `/Users/emadinfstones/Projects/debugger/burrow/build/burrow/release/test/fixtures/`
- `/Users/emadinfstones/Projects/debugger/burrow/.github/workflows/burrow-release.yml`
- `/Users/emadinfstones/Projects/debugger/burrow/build/azure-pipelines/darwin/app-entitlements.plist`
- `/Users/emadinfstones/Projects/debugger/burrow/patches/0010-trim-darwin-entitlements.md`
- `/Users/emadinfstones/Projects/debugger/burrow/patches/README.md`
- `/Users/emadinfstones/Projects/debugger/burrow/RELEASING.md`
- `/Users/emadinfstones/Projects/debugger/burrow/extensions/burrow-crash-triage/`
- `/Users/emadinfstones/Projects/debugger/launcher/server.js`
- `/Users/emadinfstones/Projects/debugger/launcher/ui/app.js`

## Core risk

The signed/notarized/Gatekeeper path is UNVERIFIABLE in this environment: it needs an Apple Developer ID certificate, notarytool credentials, and a live self-hosted feed bucket — none exist in-repo. So the pipeline can only be proven UNSIGNED locally; the acceptance criteria ("fresh download opens with no right-click dance", "update from previous version on a clean Mac", "rollback restores prior version") are deferred until secrets + bucket are provisioned. Compounding this: the existing sign/notarize code (`build/azure-pipelines/darwin/codesign.ts`) is ESRP/Microsoft-OIDC-coupled and cannot be run outside their infra — it must be reimplemented as plain `@electron/osx-sign` + `xcrun notarytool` in the new workflow, not reused. Second-order risk: editing the upstream entitlements plists trips `check-ledger.js` (build/ non-burrow = core source), so the trim must ship with `patches/0010-*.md` or the CI ledger gate fails.

## Dependencies

Depends on task 01 (fork bootstrap/branding — done in product.json; and the zero-chatter outbound audit that 13.3 re-runs on the signed build) and task 02 (strip-to-Go-only determines what ships in the .app). Toolchain pins from task 03 (gopls/dlv) must be stamped into release notes (13.6). GATES / is gated-by: **15.4** (docs/architecture/15-frontend-debugger.md:104 — "ship the tool with built ui/dist + pruned deps inside the .app and re-point toolPath"); the packaging step in this task is the prerequisite that 15.4 consumes. Feeds **task 14** (outer launcher's "Open Backend IDE"/download link points at this task's GitHub Release + brew cask).

## Full plan

## Task 13 — Packaging, signing, updates (build-ready)

Grounded in files actually read: `docs/architecture/13-packaging-signing-updates.md`, `product.json`, `build/gulpfile.vscode.ts`, `build/darwin/*`, `build/azure-pipelines/darwin/*`, `build/burrow/check-ledger.js`, `patches/README.md`, `UPSTREAM.md`, outer `launcher/*`.

### State of the world (what exists vs. what the doc asks)
The **macOS packaging machinery already exists** from upstream and is Burrow-branded — this task is *wiring, a GitHub Actions harness, secrets, and a trim*, not a green-field pipeline.

- Build tasks: `build/gulpfile.vscode.ts:624-681` (`vscode-darwin-arm64-min` → `../VSCode-darwin-arm64`).
- Universal/dmg/sign/verify: `build/darwin/{create-universal-app,create-dmg,sign,verify-macho}.ts`, dmg templates + `dmg-background-stable.tiff`.
- Notarize + entitlements: `build/azure-pipelines/darwin/{codesign.ts,*-entitlements.plist}` — **but** this is ESRP/Microsoft-OIDC-internal, unusable outside their CI, and `app-entitlements.plist` still grants camera/audio-input/apple-events.
- Identity done (task 01): `product.json` has `applicationName":"burrow"`, `darwinBundleIdentifier":"dev.burrow.ide"`, `urlProtocol":"burrow"`, `enableTelemetry":false`.
- **Missing entirely:** `product.json.updateUrl`/`quality`; any GitHub Actions release workflow; a feed generator; `RELEASING.md`; brew cask/tap; download page; crash-triage extension; the frontend-debugger bundling step (15.4).

### Slice 1 — Update channel + dry-run feed (the firstSlice; no secrets)
1. Edit `/Users/emadinfstones/Projects/debugger/burrow/product.json`: add `"quality": "stable"` and `"updateUrl": "https://updates.burrow-ide.dev"` (placeholder — confirm final origin with product owner; S3 or GitHub Pages per doc §Design). Leave `nodejsArtifactFeed`/`electronArtifactFeed` empty (Electron/Node come from public feeds; not our update path).
2. Create `build/burrow/release/gen-feed.js` (dependency-free CommonJS, matching `build/burrow/package.json` `"type":"commonjs"`). Input: `--version`, `--commit`, `--artifacts <dir>`. Output: the JSON the VS Code updater fetches at `${updateUrl}/api/update/darwin-universal/stable/<commit>` — fields `{ url, name (version), version (commit), productVersion, hash (sha256), timestamp, supportsFastUpdate:false }`. Emit one object per platform key (`darwin-universal`, `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`). Compute sha256 with `node:crypto` over each artifact.
3. Create `build/burrow/release/test/verify.mjs` + `test/fixtures/` (a couple of tiny fake artifact files). Assert: every platform present, `hash` matches a recomputed sha256, `productVersion`/`quality` correct, URLs are absolute under `updateUrl`.
4. **Verify:** `node build/burrow/release/test/verify.mjs`. Wire it into `make verify` if a Burrow-level make target exists; otherwise document the command in `RELEASING.md`.

### Slice 2 — Entitlement trim + ledger (the one core patch)
1. Edit `build/azure-pipelines/darwin/app-entitlements.plist`: remove `com.apple.security.device.camera`, `com.apple.security.device.audio-input`, `com.apple.security.automation.apple-events`; keep only `com.apple.security.cs.allow-jit` (Electron needs JIT — doc §Design). Review the helper plists (`helper-*.plist`) the same way; keep only what Electron requires to launch.
2. Add `patches/0010-trim-darwin-entitlements.md` (format per `patches/README.md`): Layer 1-adjacent but ledgered because `check-ledger.js:18` treats `build/azure-pipelines/**` as core source. Task 13; files = the plists; ~4 lines removed; rationale = zero-privilege hardening / 13.3 audit. Add the row to `patches/README.md` table.
3. **Verify:** `node build/burrow/check-ledger.js` prints OK; `grep -c 'camera\|audio-input\|apple-events' build/azure-pipelines/darwin/app-entitlements.plist` = 0.

### Slice 3 — Release harness (GitHub Actions, sign/notarize; secrets-gated)
1. `build/burrow/release/build-darwin.sh`: pinned-Node preflight → `npm ci` → `npm run gulp vscode-darwin-arm64-min` and `vscode-darwin-x64-min` → `create-universal-app` → `create-dmg`. Bundle the frontend-debugger here (see Slice 5). Purely local, unsigned-capable.
2. `build/burrow/release/sign-notarize.js`: reimplement signing with the vendored `@electron/osx-sign` (hardened runtime, the trimmed entitlements) + `xcrun notarytool submit --wait` + `xcrun stapler staple`. Do **not** import `build/azure-pipelines/darwin/codesign.ts` (ESRP-coupled). Certs/creds come from env (`APPLE_ID`, `APPLE_TEAM_ID`, `NOTARY_KEYCHAIN_PROFILE`, Developer ID cert imported into a CI keychain).
3. `.github/workflows/burrow-release.yml`: trigger on tag `v*` + `workflow_dispatch` (with a `dry_run` input that skips sign/notarize/upload). Steps: checkout → setup pinned Node → build-darwin.sh → (unless dry-run) sign-notarize.js → `verify-macho.ts` → `spctl -a -vv` gate → `gen-feed.js` → upload to GitHub Releases + push feed JSON to the update bucket. Secrets via GitHub OIDC → keychain (doc §Design), never in repo.
4. **Verify (reachable):** `workflow_dispatch` with `dry_run=true` produces an unsigned universal .app + dmg + feed JSON as artifacts. **Deferred:** the signed/notarized/Gatekeeper path — blocked on Apple creds + bucket.

### Slice 4 — Runbook, brew, download (13.4/13.6)
1. `RELEASING.md`: version-bump procedure, upstream-pin statement (from `UPSTREAM.md`, currently 1.128.0), gopls/dlv pins (task 03), smoke checklist (install fresh, open NodeWatch, run/debug a Go program), rollback = repoint feed JSON at previous artifact.
2. Homebrew cask + tap automation (a release-workflow job that opens a PR to `burrow-ide/homebrew-tap` with the new dmg URL + sha256) and a one-page static download site (also the target of task 14's launcher link).

### Slice 5 — Frontend-debugger bundling (gates 15.4)
In `build-darwin.sh`, before packaging: `cd tools/frontend-debugger && npm ci && npm run build` (produces `ui/dist`), prune to production deps, copy the tool into the .app Resources, and ensure the `burrow-frontend-debugger` extension's `toolPath` resolves to the bundled copy (docs/architecture/15-frontend-debugger.md:104-105). Expose this as the packaging contract 15.4 consumes.

### Slice 6 — Crash triage extension (13.5; last)
`extensions/burrow-crash-triage` (layer 4, `burrow-*`, ledger-free): a command that reveals the Electron crashpad dump dir in Finder and pre-fills a GitHub issue with the dump attached — no telemetry backchannel (consistent with zero-chatter). Register via the burrow-core contribution pattern used by existing `burrow-*` extensions.

### Outer repo (task 14 slice — do in the outer repo, `/Users/emadinfstones/Projects/debugger`)
When Burrow isn't detected, the launcher's "Open Backend IDE" surface (`launcher/ui/app.js:12`, `launcher/server.js:35`) should render a download/install page pointing at the GitHub Release + `brew install --cask burrow`. Follow outer `CLAUDE.md`: launcher stays the only `/config` writer, add a route in `server.js` + a card state in `ui/app.js`, and update `.claude/memory/api.yaml` (new route) in the same change. Verify with `node launcher/test/verify.mjs`.

### Sequencing
Slice 1 (config+feed, no secrets) → Slice 2 (entitlement trim+ledger) → Slice 5 (frontend bundling, unblocks 15.4) → Slice 3 (harness, dry-run only until secrets) → Slice 4 (runbook/brew/download, feeds task 14) → Slice 6 (crash triage) → outer task-14 link. Slices 1, 2, 5 are fully verifiable now; 3-4's signed path is deferred behind Apple creds + bucket provisioning.

## Verify strategy

Tiered, honest about what's reachable now:
1. **Feed generator (now, no secrets):** `node build/burrow/release/test/verify.mjs` — asserts feed JSON schema, per-platform url+sha256, quality/version fields against fixture artifacts. Matches the repo's `test/verify.mjs` idiom.
2. **Ledger gate (now):** `node build/burrow/check-ledger.js` must print OK — proves the entitlements edit carries `patches/0010`.
3. **Config sanity (now):** `product.json` parses; `updateUrl`/`quality` present; entitlements plist contains only `com.apple.security.cs.allow-jit` (grep-assert no camera/audio/apple-events).
4. **Unsigned local darwin build (heavy, no secrets):** `npm run gulp vscode-darwin-arm64-min` → `build/darwin/create-universal-app.ts` → `create-dmg.ts`; then `build/darwin/verify-macho.ts` on the output. Confirms the pipeline assembles a launchable (unsigned) .app + dmg.
5. **Signed/notarized/Gatekeeper (DEFERRED — needs Apple creds + bucket):** the `burrow-release.yml` `workflow_dispatch` dry-run on a tag; `spctl -a -vv` Gatekeeper check; clean-Mac update-from-previous + rollback rehearsal. Document as blocked-on-secrets, not attempted.
6. **Outer repo (task 14 slice):** `node launcher/test/verify.mjs` for the new download route/page.
