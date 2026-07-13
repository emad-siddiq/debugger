# 13 — Packaging, signing, updates

> Part of the [Go IDE overhaul](00-overview.md). Depends on: 01. Effort: ~1 wk
> (minimal channel at M1; hardened by M4).

## Goal

Burrow installs like a real Mac app and stays current without phoning anyone
but us: signed + notarized `.app`, reproducible CI builds, a self-hosted
update feed, Homebrew cask. Linux secondary.

## Design

- **Targets:** macOS arm64 (primary), macOS x64 (Rosetta escape hatch),
  Linux x64/arm64 tarball + `.deb` (secondary; the fork builds them nearly
  free). No Windows at launch.
- **Build:** the upstream gulp `vscode-darwin-arm64` pipeline, invoked from
  GitHub Actions on tags; version = `burrow 0.x (upstream 1.yy)` — both
  visible in About. Reproducibility: pinned Node, pinned npm lockfile, build
  provenance attestation on artifacts.
- **Signing/notarization:** Developer ID certificate, hardened runtime,
  entitlements audit (Electron needs JIT; nothing else — no camera/mic/etc.),
  `notarytool` staple in CI. Secrets via GitHub OIDC → keychain, never in
  repo.
- **Updates:** VS Code's built-in updater pointed at **our own static feed**
  (`product.json` `updateUrl` → an S3/Pages-hosted JSON + artifact bucket).
  Channel model: `stable` only at launch (an `insiders` channel is config,
  not code, when wanted). Delta updates are a non-goal — full archive
  replace, Electron-style. The updater is the **only** sanctioned outbound
  connection at idle (task 01's zero-chatter audit gets this one exemption,
  user-disableable).
- **Distribution:** GitHub Releases (canonical), `brew install --cask burrow`
  (tap in the org), the launcher's "Open Backend IDE" page links the download
  when Burrow isn't detected (task 14).
- **Toolchain pins ride along:** each release pins its gopls/dlv versions
  (task 03); the update feed's release notes state them.

## Tasks

1. **Release CI.** Tag → build (arm64/x64 mac, linux) → sign → notarize →
   staple → attest → upload to Releases + update bucket; dry-runnable.
2. **Update feed.** Static feed generator (version, sha256, url per platform),
   `updateUrl` wiring, stable-channel semantics, user setting to disable.
3. **Entitlements + audit.** Minimal entitlement set; re-run the task 01
   outbound-connection audit on the packaged, signed build.
4. **Brew cask + download page.** Tap automation on release; a one-page
   download site (also the target of the launcher's install link).
5. **Crash triage (opt-in only).** Electron crashpad dumps **kept local** with
   a "reveal in Finder + attach to GitHub issue" helper — no telemetry
   backchannel, consistent with the zero-chatter stance.
6. **Release runbook.** `RELEASING.md`: version bump, upstream-pin statement,
   gopls/dlv pins, smoke checklist (install fresh, open NodeWatch, run/debug),
   rollback procedure (feed points at previous artifact).

## Acceptance criteria

- A tag produces, unattended: notarized universal-install artifacts, a working
  update from the previous version on a clean Mac, and a brew-installable cask.
- Gatekeeper: fresh download opens with no right-click-open dance.
- Packaged-build outbound audit: update feed only, and only when enabled.
- Rollback rehearsed once: feed rollback restores prior version on next check.

## Out of scope

- Windows packaging; MAS distribution; delta/differential updates; any crash
  or usage telemetry service.
