# 0005 — Suppress the first-launch onboarding overlay

- **Layer:** 3 (core patch) + layer 4 (burrow-core `configurationDefaults`)
- **Task:** 02 (strip to Go-only) — finishes the onboarding-suppression the
  layer-4 defaults could not do alone.
- **Upstream files touched:** src/vs/workbench/contrib/welcomeGettingStarted/browser/gettingStarted.contribution.ts
- **Size:** 1 line (core) + a `configurationDefaults` swap in `extensions/burrow-core/package.json`
- **Last verified against:** upstream 1.128.0

## Why

burrow-core's `configurationDefaults` tried to quiet the first-launch welcome
noise with two keys that are **silently rejected** at registration because they
are not window/resource/machine-overridable/language-overridable scope:

- `terminal.integrated.inheritEnv: true` — this is **already** the upstream
  default (`terminalPlatformConfiguration.ts`, `ConfigurationScope.APPLICATION`),
  so the entry was a redundant no-op that only produced a rejection log line.
  **Dropped.**
- `workbench.welcomePage.experimentalOnboarding: false` — `ConfigurationScope.APPLICATION`,
  so an extension cannot override its default. This key is the **only** gate on
  the new AI onboarding overlay (`StartupPageRunnerContribution.tryShowOnboarding`
  in `startupPage.ts`, called from the constructor — independent of
  `workbench.startupEditor`). Left as-registered (`default: true`), the overlay
  showed the "Sign in to use GitHub Copilot" prompt and the "Make It Yours"
  theme picker on every fresh profile.

An extension `configurationDefaults` cannot change an APPLICATION-scoped default,
so the onboarding suppression has to be a core patch. The welcome/getting-started
*page* is a separate lever (`workbench.startupEditor`, RESOURCE scope) that an
extension default *can* set — so that half stays in layer 4.

## What

**Core (this patch):** flip the registered default of
`workbench.welcomePage.experimentalOnboarding` from `true` to `false` in
`gettingStarted.contribution.ts`. `tryShowOnboarding()` returns early when the
value is falsy, so the AI onboarding overlay (Copilot sign-in + theme picker)
never shows.

**Layer 4 (`extensions/burrow-core/package.json`):** in `configurationDefaults`,
remove the two rejected keys and add `workbench.startupEditor: "none"` (RESOURCE
scope, accepted) so the welcome/getting-started editor does not open at startup.
Needed as a pair: with `experimentalOnboarding` now false, the *classic* featured
walkthrough (`gettingStarted.ts`, the `!experimentalOnboarding` branch) would
otherwise render inside the welcome editor — `startupEditor: "none"` stops that
editor from opening at all.

Net: a fresh profile boots straight to the workbench, no welcome page, no
onboarding overlay.

## Rebase notes

- If upstream renames or removes `experimentalOnboarding` (it is tagged
  `experimental`), this default flip becomes a no-op — drop it and re-check
  whether `tryShowOnboarding`/its successor has a new gate. The
  `startupEditor: "none"` default is stable and lives in layer 4.
- A residual Copilot sign-in prompt could still originate from the chat
  extension itself (the `product.defaultChatAgent` / AgentHost path that the
  deferred chat excision owns), not from this onboarding overlay — verify at
  boot and, if present, track it with the chat-excision task, not here.
