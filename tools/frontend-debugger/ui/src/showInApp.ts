import { ipc, apiGet } from './ipc'
import { useStore } from './store'
import { askRouteChoice } from './host'
import { routeUrl, APP_BASE } from './appRoutes'
import type { DiscoveredRoute } from './protocol'

// "Show in App": the extension asks the app panel to reveal a component in the
// LIVE app (from the Components tree or the isolation preview). Flow: probe the
// current page first (agent `locate` matches the data-inspect-file stamps); if
// the component isn't mounted here, intersect its transitive importers
// (GET /api/usages) with the live route catalog to find the route that renders
// it, navigate there (full reload — the agent re-installs), and locate again
// once the fresh tree arrives. Ending in a plain `select` rides the central
// reveal in App.tsx (scroll + flash), exactly like a Pick-mode click.

interface Pending {
  file: string // frontendDir-relative posix path (matches data-inspect-file)
  name: string | null
  route: string | null // remembered/QuickPicked route from the extension
  stage: 'here' | 'awaiting-tree' | 'there'
  retries: number // delayed re-locates on the destination (lazy/auth-gated pages)
}

let pending: Pending | null = null

const describe = (p: Pending) => p.name || p.file

export function beginShowInApp(msg: Record<string, unknown>): void {
  const file = typeof msg.file === 'string' ? msg.file : ''
  if (!file) return
  pending = {
    file,
    name: typeof msg.name === 'string' ? msg.name : null,
    route: typeof msg.route === 'string' ? msg.route : null,
    stage: 'here',
    retries: 0,
  }
  ipc.send('locate', { file, name: pending.name })
}

/** App.tsx forwards agent `located` events here. */
export function onLocated(msg: { ids?: string[]; file?: string | null }): void {
  const p = pending
  if (!p || msg.file !== p.file) return
  const st = useStore.getState()
  const ids = msg.ids || []
  if (ids.length) {
    pending = null
    if (ids.length > 1) st.toast('info', `${ids.length} instances of ${describe(p)} — showing the first`)
    ipc.send('select', { id: ids[0] })
    return
  }
  if (p.stage === 'there') {
    // Lazy chunks and auth gates can mount the page AFTER the first tree —
    // a few delayed retries before declaring the component absent.
    if (p.retries < 3) {
      p.retries++
      setTimeout(() => {
        if (pending === p) ipc.send('locate', { file: p.file, name: p.name })
      }, 700)
      return
    }
    pending = null
    st.toast('error', `${describe(p)} isn't rendered on this route`)
    return
  }
  void resolveRouteAndGo(p)
}

/** Called on every agent `tree` event: after a Show-in-App navigation reloads
 *  the target, the fresh tree is the "page is ready" signal — locate again on
 *  the destination route. */
export function onTreeAfterNavigate(): void {
  const p = pending
  if (!p || p.stage !== 'awaiting-tree') return
  p.stage = 'there'
  ipc.send('locate', { file: p.file, name: p.name })
}

// The boot-time getRoutes can race the target's router mount (auth gates,
// lazy roots) and leave the catalog empty until the next navigation — ask
// again and give the app a moment to answer before deciding.
async function ensureRouteCatalog(): Promise<DiscoveredRoute[]> {
  const current = () => useStore.getState().discovered?.routes || []
  let routes = current()
  if (routes.length) return routes
  ipc.send('getRoutes', {})
  for (let i = 0; i < 10 && !routes.length; i++) {
    await new Promise((r) => setTimeout(r, 250))
    routes = current()
  }
  return routes
}

// Not mounted on the current page: pick the route whose page component is
// reachable from this component through the import graph, and go there.
async function resolveRouteAndGo(p: Pending): Promise<void> {
  const st = useStore.getState()
  try {
    const [res, freshRoutes] = await Promise.all([
      apiGet(`/usages?file=${encodeURIComponent(p.file)}`),
      ensureRouteCatalog(),
    ])
    if (pending !== p) return // superseded by a newer Show in App
    const usageCount: number = (res.usages || []).length
    const notFound = (why: string) => {
      pending = null
      st.toast(
        'error',
        usageCount
          ? `${why} — ${describe(p)} is used in ${usageCount} place${usageCount === 1 ? '' : 's'}`
          : `no usages of ${describe(p)} found`,
      )
    }
    const routes: DiscoveredRoute[] = freshRoutes
    if (!routes.length) return notFound('no live route catalog')
    // Page-component names reachable from this component — plus its own name
    // (the component may itself be a route's page).
    const names = new Set<string>(p.name ? [p.name] : [])
    for (const r of res.reachable || []) for (const n of r.names || []) names.add(n)
    const candidates = routes.filter((r) => r.name && names.has(r.name))
    const hinted = p.route
      ? candidates.find((r) => r.path === p.route) || routes.find((r) => r.path === p.route)
      : undefined
    if (hinted) return navigateTo(p, hinted)
    if (candidates.length === 1) return navigateTo(p, candidates[0])
    if (candidates.length > 1) {
      // Several routes render it — the extension QuickPicks natively and
      // answers by re-posting showInApp with the chosen `route`.
      askRouteChoice(
        p.file,
        p.name,
        candidates.map((c) => ({ path: c.path, label: c.label, name: c.name ?? null })),
      )
      pending = null
      return
    }
    notFound('no route renders it')
  } catch (e) {
    if (pending === p) pending = null
    st.toast('error', `usage lookup failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function navigateTo(p: Pending, route: DiscoveredRoute): void {
  const st = useStore.getState()
  p.stage = 'awaiting-tree'
  st.toast('info', `→ ${route.label} (showing ${describe(p)})`)
  ipc.navigate(routeUrl(route.path, st.targetUrl, st.discovered?.basename ?? APP_BASE))
}
