# 0003 — Strip leaf workbench contributions (surveys, issue, tunnel, sync)

- **Layer:** 3 (core patch — workbench contribution wiring)
- **Task:** 02 (strip to Go-only)
- **Upstream files touched:** `src/vs/workbench/workbench.common.main.ts`,
  `src/vs/workbench/workbench.desktop.main.ts`
- **Size:** 7 side-effect imports commented out
- **Last verified against:** upstream 1.128.0

## Why

Several subsystems on task 02's remove list are not extensions — they are
workbench *contributions* compiled into the shell, registered purely by a
side-effect `import` in the workbench entry point. Removing that import
un-registers the contribution (no view, command, or status-bar entry) without
touching the contribution's own code. These three are **leaf** contributions —
nothing else load-depends on their registration:

- `surveys/browser/nps` + `surveys/browser/languageSurveys` (common) and
  `surveys/browser/survey` (desktop) — CES/NPS feedback nags. On the remove list
  ("feedback/survey surfaces").
- `issue/electron-browser/issue` (desktop) — the issue reporter + "Report
  Issue" command. Not a Go-IDE surface.
- `remoteTunnel/electron-browser/remoteTunnel` (desktop) — "Remote Tunnel
  Access" (code-server-era); its `tunnel-forwarding` extension is already gone.
- `userDataSync/browser/userDataSync` (common) + `.../electron-browser/…`
  (desktop) — Settings Sync UI. The `configurationSync` store is already null in
  this OSS base, so sync has no backend; this removes the "Turn on Settings
  Sync" commands/views. The contribution registers no service (side-effect only),
  and the underlying `platform/userDataSync` service is untouched.

## What

Comments out the five side-effect imports (kept as `// burrow(strip 02): …`
lines so the rebase diff shows exactly what upstream had). No other file
imports these for their side effect, so the contributions drop from the bundle.

## Scope note

Burrow boots the **standard** workbench (`workbench.desktop.main.ts`). This fork
also has an alternate `src/vs/sessions/*.main.ts` (agent-sessions/chat surface)
that imports the same three contributions; those are left untouched here and are
part of the deferred Copilot/chat excision (see 0002 → "Not done here").

## Not done here (bigger, non-leaf — deferred)

- **Marketplace browse/install** (`contrib/extensions`) — the Extensions view is
  load-bearing for enable/disable of built-ins; needs surgical removal of the
  gallery/search/sideload paths, not the whole contrib. (`extensionsGallery` is
  already null in product.json, so browse is already non-functional.)
- **Settings Sync** (`contrib/userDataSync`) — has cross-contrib consumers.
- **Remote** (`contrib/remote`) status indicator/commands — infra with consumers.
- **Notebook** core (`contrib/notebook`) — many dependents; `.ipynb` is already
  unopenable with the ipynb extension gone.
- Walkthroughs / getting-started (`welcomeGettingStarted` provides the startup
  page, which injects `IOnboardingService`).

## Rebase notes

- If upstream moves a survey/issue/tunnel import, re-comment it at the new site.
- Re-derive the target list from task 02's remove ledger if upstream reshuffles
  the contribution graph.
