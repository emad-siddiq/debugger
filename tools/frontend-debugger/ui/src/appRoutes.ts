// Merkle (NodeWatch) route catalog — the debugger's "Go to ▸ <route>" picker.
//
// SOURCE OF TRUTH: ../../merkle/nodewatch/frontend/src/routes.ts (NAV_DESTINATIONS
// for the 5 primary destinations, ROUTE_TITLES for the secondary ones). Mirror
// changes there here so the picker doesn't drift. `path` is the POST-BASENAME
// pathname exactly as merkle uses it; the router basename is "/watch/app".
//
// Note the two path conventions in merkle: some routes are bare ("/",
// "/validators"), others carry an extra "/watch/" or "/admin/" prefix
// ("/watch/alerts", "/admin/usage"). We keep them verbatim so join() below
// produces the real iframe URL.

export interface AppRoute {
  id: string
  label: string
  /** Post-basename pathname, verbatim from merkle's routes.ts. */
  path: string
  group: 'Primary' | 'Secondary'
}

// Primary — from NAV_DESTINATIONS in merkle routes.ts (order preserved).
// Secondary — from ROUTE_TITLES (Settings, Superadmin, Usage, Status, Pricing).
export const APP_ROUTES: AppRoute[] = [
  { id: 'overview', label: 'My Fleet', path: '/', group: 'Primary' },
  { id: 'validators', label: 'Validators', path: '/validators', group: 'Primary' },
  { id: 'alerts', label: 'Alerts', path: '/watch/alerts', group: 'Primary' },
  { id: 'revenue', label: 'Revenue', path: '/watch/revenue', group: 'Primary' },
  { id: 'releases', label: 'Releases', path: '/watch/releases', group: 'Primary' },
  { id: 'settings', label: 'Settings', path: '/watch/settings', group: 'Secondary' },
  { id: 'superadmin', label: 'Superadmin', path: '/watch/superadmin', group: 'Secondary' },
  { id: 'usage', label: 'Usage', path: '/admin/usage', group: 'Secondary' },
  { id: 'status', label: 'Status', path: '/status', group: 'Secondary' },
  { id: 'pricing', label: 'Pricing', path: '/pricing', group: 'Secondary' },
]

// The router basename merkle mounts under (see routes.ts header comment).
export const APP_BASE = '/watch/app'

// join(base, path) → the iframe pathname, collapsing the double slash so a bare
// "/" doesn't produce "/watch/app//". Examples:
//   "/"              → "/watch/app/"
//   "/validators"    → "/watch/app/validators"
//   "/watch/alerts"  → "/watch/app/watch/alerts"
export function routePathname(path: string, base = APP_BASE): string {
  if (path === '/') return base + '/'
  return base + path
}

// Absolute iframe URL for a route, anchored on the current target's origin.
// `targetUrl` is the configured embed URL (e.g. http://localhost:5180/watch/app/);
// we only borrow its origin and swap the pathname so the merkle base + path win.
export function routeUrl(path: string, targetUrl: string, base = APP_BASE): string {
  const pathname = routePathname(path, base)
  try {
    const origin = new URL(targetUrl, window.location.href).origin
    return origin + pathname
  } catch {
    return pathname
  }
}

// Routes grouped for a grouped <select> in the toolbar.
export function buildRouteGroups(routes: AppRoute[]): { group: AppRoute['group']; routes: AppRoute[] }[] {
  return [
    { group: 'Primary', routes: routes.filter((r) => r.group === 'Primary') },
    { group: 'Secondary', routes: routes.filter((r) => r.group === 'Secondary') },
  ]
}

export const APP_ROUTE_GROUPS = buildRouteGroups(APP_ROUTES)
