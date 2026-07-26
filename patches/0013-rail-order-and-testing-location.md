# 0013 — A declared rail order, and Testing off the rail

- **Layer:** 3 (core patch — view-container ordering + one container's default location)
- **Task:** — (docs/plans/02 §2, WO-28; found by the Pass 2 scenario `P2-1`)
- **Upstream files touched:** `src/vs/workbench/api/browser/viewsExtensionPoint.ts`,
  `src/vs/workbench/contrib/testing/browser/testing.contribution.ts`,
  `src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts`
- **Size:** 12 insertions / 2 deletions across 3 files
- **Last verified against:** upstream 1.128.0

## Why

Plan `02 §2` fixes the rail as seven items in one order and says to implement it
"by editing `viewsContainers.activitybar` ids/titles/icons in the owning
extensions — no core patch". That turned out to be impossible, and the Pass 2
scenario `P2-1` is what proved it: merkle opened on
`Explorer · Search · Source Control · Extensions · Testing · Data · API ·
Components · Run`.

A `viewsContainers` contribution has **no order property**. The extension point
assigns one from a running counter —
`CUSTOM_VIEWS_START_ORDER + <how many containers are already registered>`
(`viewsExtensionPoint.ts`) — so a container's rail position is decided by
whichever extension happened to activate first. That is not a thing an extension
can influence, and it is not stable between launches or machines.

The obvious workaround is worse than the patch: seed the composite bar's
`workbench.activity.pinnedViewlets2` from a contribution. Patch `0004` already
rejected exactly that reasoning for the debug container — per-profile view
storage is "silently overwritten by any user drag; writing it from outside
violates the storage-key ownership rule". It also cannot work at the right
moment: the bar reads that key while the parts are built, before most
contributions run.

So the default is changed where every other default lives: at the registration
site.

## What

1. **A declared order** — `viewsExtensionPoint.ts`: `IUserFriendlyViewsContainerDescriptor`
   and the JSON schema gain an optional `order: number`, and
   `registerCustomViewContainers` uses it when present, falling back to the
   running counter when absent. This is a generic capability, not a Burrow
   special case: any container can now state its position instead of racing for
   it. The four Burrow containers then declare theirs in their own manifests —
   `burrow-fullstack` 3 (Run), `burrow-flow` 4 (API), `burrow-db` 5 (Data),
   `burrow-frontend-debugger` 6 (Components) — which is exactly what `02 §2`
   wanted the shape of the fix to be.

2. **Testing moves to the panel** — `testing.contribution.ts`: its view container
   registers with `ViewContainerLocation.Panel` instead of `…Sidebar`. It is not
   deleted and loses nothing: the container, its views, the Testing API and every
   test controller keep working, and it sits beside Test Results where test
   output already lives. The rail slot goes because Burrow's Run view already
   owns tests — a **Tests** section indexing the packages and the **Test Lab**
   showing the runs — and a second, differently-shaped way to see the same runs
   is the redundancy `02` exists to remove.

3. **Extensions after the seven** — `extensions.contribution.ts`: the container's
   `order` moves from 4 to 20 so it sorts after the Burrow containers rather than
   between Source Control and Run. It stays on the rail (a deliberate call: it is
   how anything gets installed), just not inside the fixed seven. Note the
   `openCommandActionDescriptor.order` a few lines above is the **View menu**
   position, not the rail's — leave it alone.

## Rebase notes

- `CUSTOM_VIEWS_START_ORDER` and the counter arithmetic in
  `addCustomViewContainers` are the hazard: if upstream reworks how extension
  containers are ordered, re-check that a declared `order` still wins. The change
  is one `??` expression, so a conflict here is easy to re-apply.
- If upstream gives `viewsContainers` its own official `order`, drop part 1 of
  this patch entirely and keep the manifests.
- `testing.contribution.ts`'s registration is a single call; a conflict shows up
  as the location argument. Anything that opens the testing viewlet still works —
  the only reference outside that file is a `progressService.withProgress({
  location: Testing.ViewletId })`, which is location-agnostic.
- The rail order is now observable: `docs/plans/scripts/pass2/P2-1.mjs` asserts it
  and fails loudly if a future container muscles in.
