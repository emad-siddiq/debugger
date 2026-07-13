# 01 — Fork bootstrap & branding

> Part of the [Go IDE overhaul](00-overview.md). Depends on: —. Effort: ~2 wk.

## Goal

A nested independent git repo at `debugger/burrow/` containing a pinned fork of
[Code - OSS](https://github.com/microsoft/vscode) that builds a branded,
telemetry-free, marketplace-free desktop app on macOS (arm64 first), with the
patch-ledger discipline that keeps the fork rebasable.

## Why

Everything else stacks on this. Getting the *change-layer discipline* right on
day one (config → deletions → patches → built-in extensions, see
[00-overview](00-overview.md)) is the difference between a maintainable product
and an unrebasable hairball six months in.

## Legal boundaries (non-negotiable)

- Code - OSS is MIT — the *source* is ours to fork. The **Microsoft product
  branding, icons, and the Visual Studio Marketplace are not**. Ship zero MS
  assets; never point at `marketplace.visualstudio.com` (its ToS only allows
  in-product access from Microsoft products).
- No Open VSX either — we have **no extension marketplace at all**. Every
  capability ships built-in (this is a feature: minimalism, task 02).
- Licenses of what we bundle: gopls (BSD-3), Delve (MIT), vscode-go (MIT) — all
  redistributable. Keep a `THIRD_PARTY_NOTICES.md` from the start.

## Tasks

1. **Fork and pin.** Fork `microsoft/vscode` at the newest stable minor at
   start time. Branch model: `upstream-vX.Y` (pristine tag) → `main` (ours).
   Record the pin in `UPSTREAM.md` with the rebase procedure.
2. **Host build toolchain.** Get the stock build running on macOS arm64: Node
   (per upstream `.nvmrc`), native deps, `./scripts/code.sh` for dev,
   `npm run gulp vscode-darwin-arm64` for the packaged app. Document in
   `BUILDING.md`; add a `make dev` / `make dist` wrapper.
3. **`product.json` identity.** `nameShort: Burrow`, `nameLong: Burrow — Go IDE`,
   `applicationName: burrow`, `dataFolderName: .burrow`, own
   `darwinBundleIdentifier`, `urlProtocol: burrow` (task 14 deep-links depend
   on this). Replace all icons (app icon, dock, letterpress) with our own.
4. **Kill the network chatter.** In `product.json` + build config: no telemetry
   endpoints (`enableTelemetry: false`, empty `aiConfig`), no experiments
   (`tas-client` endpoints removed), no update server (own channel in task 13),
   no extension gallery block at all, no survey prompts, no default
   `extensionsGallery`, no recommendations. Acceptance: `lsof`/proxy audit
   shows **zero non-user-initiated outbound connections** at idle.
5. **Patch ledger.** Create `patches/README.md`: every core diff gets a number,
   a one-paragraph rationale, and the upstream files touched
   (`patches/0001-default-layout.md`, …). CI check: core diffs without a ledger
   entry fail review. This is layer-3 governance from day one.
6. **Built-in extension scaffold.** Create `extensions/burrow-core/` (empty
   activation, version-stamped) proving the built-in extension path: compiles
   in the product build, activates on startup, shows in an About dialog.
   All later tasks (03–11) plant their extensions the same way.
7. **CI.** GitHub Actions: lint + compile + smoke-launch (Electron opens, a Go
   file gets syntax highlighting) on every PR; `dist` artifacts on tags
   (unsigned until task 13).
8. **First-boot sanity.** Fresh-machine checklist: app launches offline, opens
   a folder, no login, no marketplace UI, no telemetry consent dialogs.

## Acceptance criteria

- `make dev` gives a running branded app from a clean checkout in ≤ 30 min.
- Zero outbound connections at idle (audited).
- `patches/` ledger exists and CI enforces it.
- A trivial built-in extension ships inside the packaged .app.

## Out of scope

- Signing/notarization, auto-update (task 13).
- Any feature removal (task 02) or Go functionality (task 03).
