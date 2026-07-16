import { create } from 'zustand'
import type { A11yResult, Box, ChildBox, Detail, HoverState, RoutesInfo, TokensResult, TreeNode } from './protocol'
import type { AppRoute } from './appRoutes'
import { hostFullScreen, openInBurrow } from './host'

export type Mode = 'interact' | 'pick' | 'theater'
export type Tab = 'tree' | 'styles' | 'props' | 'breakpoints' | 'source' | 'network'
export type AuditPanel = 'a11y' | 'tokens'
export type Orientation = 'portrait' | 'landscape'
// The embedded TARGET's data mode: devMock intercepts /api (mock) or a Vite
// proxy forwards /api/nodewatch to the backend under debug (live).
export type TargetMode = 'mock' | 'live'

// One captured fetch from inside the target iframe (agent `netreq` events).
export interface NetRequest {
  method: string
  url: string
  status: number
  ms: number | null
  requestId: string | null
  clickGap: number | null
  at: number
}

export interface Viewport {
  label: string
  w: number | null // null = fill (Fit)
  h: number | null
  dpr?: number
}

interface OpenSource {
  file: string
  line: number
  nonce: number
}

export interface Panel {
  x: number
  y: number
  w: number
  h: number
}

export interface StyleEdit {
  selectorText: string
  media: string | null
  prop: string
  value: string
  original: string
  existed: boolean
}

export interface Toast {
  id: number
  kind: 'info' | 'error' | 'ok'
  text: string
}

function defaultPanel(): Panel {
  const winW = typeof window !== 'undefined' ? window.innerWidth : 1280
  const winH = typeof window !== 'undefined' ? window.innerHeight : 800
  const w = 440
  const h = Math.min(660, Math.round(winH * 0.72))
  return { x: Math.max(16, winW - w - 20), y: 48, w, h }
}

interface State {
  // Mode B state: the target's data mode, whether a flip is in flight, and
  // whether preflight says the live backend is unreachable.
  targetMode: TargetMode | null
  modeFlipping: boolean
  backendDown: boolean
  netlog: NetRequest[]

  // Live route catalog parsed from the selected target's routes.ts (server
  // GET /api/routes). null = parse unavailable → static appRoutes.ts fallback.
  appRoutes: AppRoute[] | null

  // Route catalog discovered from the target's live react-router fibers (agent
  // `routes` event). Preferred over `appRoutes`; null = no router detected →
  // fall back to appRoutes / the static catalog.
  discovered: RoutesInfo | null

  targetUrl: string
  // The target's LIVE route (from the agent's ready/navigated events). Diverges
  // from targetUrl once the user navigates inside the iframe (Route Picker or an
  // in-app link) — navigation happens via location.assign in the iframe, so the
  // iframe's src attribute (targetUrl) never changes. The Gallery mounts fresh
  // iframes and must load THIS, not the stale boot URL, to show the current route.
  currentUrl: string
  ready: boolean
  mode: Mode
  prevMode: Mode
  viewport: Viewport
  orientation: Orientation
  pane: { w: number; h: number }
  autoZoom: boolean

  toolbarVisible: boolean
  toolbarPinned: boolean

  panel: Panel
  panelOpen: boolean
  pager: boolean // full-screen swipe-pager mode (preview ↔ styles windows)
  page: number // 0 = preview, 1 = styles
  // Browser view: the target fills the pane 1:1 (Fit viewport, no device
  // chrome, inspector closed). Embedded in Burrow it also maximizes the
  // editor group around the panel. Esc exits.
  fullScreen: boolean

  gallery: boolean // side-by-side multi-viewport comparison of the current route

  // Audit panels (a11y / design-token conformance) + a dedicated highlight box.
  auditPanel: AuditPanel | null
  a11y: A11yResult | null
  tokens: TokensResult | null
  auditHighlight: Box | null

  tree: TreeNode[]
  treeFilter: string
  selection: Detail | null
  revealNonce: number // bumps on each selection to replay the reveal-flash
  hover: HoverState | null
  drillChildren: ChildBox[]
  activeTab: Tab
  openSource: OpenSource | null

  styleEdits: Record<string, StyleEdit>
  toasts: Toast[]

  setTargetMode: (m: TargetMode | null) => void
  setModeFlipping: (b: boolean) => void
  setBackendDown: (b: boolean) => void
  pushNetRequest: (r: NetRequest) => void
  clearNetlog: () => void
  setAppRoutes: (r: AppRoute[] | null) => void
  setDiscovered: (r: RoutesInfo | null) => void

  setTargetUrl: (u: string) => void
  setCurrentUrl: (u: string) => void
  setReady: (r: boolean) => void
  setMode: (m: Mode) => void
  enterTheater: () => void
  exitTheater: () => void
  setViewport: (v: Viewport) => void
  toggleOrientation: () => void
  setPane: (w: number, h: number) => void
  setAutoZoom: (b: boolean) => void

  setToolbarVisible: (b: boolean) => void
  setToolbarPinned: (b: boolean) => void

  setPanel: (p: Partial<Panel>) => void
  openPanel: (tab?: Tab) => void
  closePanel: () => void
  setPager: (on: boolean) => void
  setPage: (n: number) => void
  setFullScreen: (on: boolean) => void
  toggleGallery: () => void

  setAuditPanel: (p: AuditPanel | null) => void
  setA11y: (r: A11yResult | null) => void
  setTokens: (r: TokensResult | null) => void
  setAuditHighlight: (b: Box | null) => void

  setTree: (t: TreeNode[]) => void
  setTreeFilter: (f: string) => void
  setSelection: (d: Detail | null) => void
  reveal: () => void
  setHover: (h: HoverState | null) => void
  setDrillChildren: (c: ChildBox[]) => void
  setActiveTab: (t: Tab) => void
  openInSource: (file: string, line: number, col?: number | null) => void

  setStyleEdit: (key: string, e: StyleEdit) => void
  removeStyleEdit: (key: string) => void
  clearStyleEdits: () => void

  toast: (kind: Toast['kind'], text: string) => void
  dismissToast: (id: number) => void
}

let toastId = 1

// Layout snapshot for restoring on full-screen exit (module-level, like toastId).
let beforeFullScreen: { viewport: Viewport; panelOpen: boolean } | null = null

export const useStore = create<State>((set, get) => ({
  targetMode: null,
  modeFlipping: false,
  backendDown: false,
  netlog: [],
  appRoutes: null,
  discovered: null,

  targetUrl: '',
  currentUrl: '',
  ready: false,
  mode: 'interact',
  prevMode: 'pick',
  viewport: { label: 'Fit', w: null, h: null },
  orientation: 'portrait',
  pane: { w: 800, h: 600 },
  autoZoom: true,

  toolbarVisible: false,
  toolbarPinned: false,

  panel: defaultPanel(),
  panelOpen: false,
  pager: false,
  page: 0,
  fullScreen: false,

  gallery: false,
  auditPanel: null,
  a11y: null,
  tokens: null,
  auditHighlight: null,

  tree: [],
  treeFilter: '',
  selection: null,
  revealNonce: 0,
  hover: null,
  drillChildren: [],
  activeTab: 'styles',
  openSource: null,

  styleEdits: {},
  toasts: [],

  setTargetMode: (m) => set({ targetMode: m }),
  setModeFlipping: (b) => set({ modeFlipping: b }),
  setBackendDown: (b) => set({ backendDown: b }),
  // Newest first, capped — this is a debugging aid, not a HAR archive.
  pushNetRequest: (r) => set((s) => ({ netlog: [r, ...s.netlog].slice(0, 200) })),
  clearNetlog: () => set({ netlog: [] }),
  setAppRoutes: (r) => set({ appRoutes: r }),
  setDiscovered: (r) => set({ discovered: r }),

  // Seeding targetUrl (boot config) also seeds currentUrl until the agent
  // reports a live route.
  setTargetUrl: (u) => set((s) => ({ targetUrl: u, currentUrl: s.currentUrl || u })),
  setCurrentUrl: (u) => set({ currentUrl: u }),
  setReady: (r) => set({ ready: r }),
  setMode: (m) => set({ mode: m, hover: null }),
  enterTheater: () =>
    set((s) => ({ prevMode: s.mode === 'theater' ? s.prevMode : s.mode, mode: 'theater', hover: null })),
  exitTheater: () => set((s) => ({ mode: s.prevMode || 'pick', drillChildren: [] })),
  setViewport: (v) => set({ viewport: v }),
  toggleOrientation: () => set((s) => ({ orientation: s.orientation === 'portrait' ? 'landscape' : 'portrait' })),
  setPane: (w, h) => set({ pane: { w, h } }),
  setAutoZoom: (b) => set({ autoZoom: b }),

  setToolbarVisible: (b) => set({ toolbarVisible: b }),
  setToolbarPinned: (b) => set({ toolbarPinned: b, toolbarVisible: b ? true : get().toolbarVisible }),

  setPanel: (p) => set((s) => ({ panel: { ...s.panel, ...p } })),
  openPanel: (tab) => set((s) => ({ panelOpen: true, activeTab: tab || s.activeTab })),
  closePanel: () => set({ panelOpen: false }),
  setPager: (on) => set({ pager: on, page: on ? 1 : 0, gallery: on ? false : get().gallery }),
  setPage: (n) => set({ page: Math.max(0, Math.min(1, n)) }),
  setFullScreen: (on) => {
    const s = get()
    if (on === s.fullScreen) return
    hostFullScreen(on)
    if (on) {
      beforeFullScreen = { viewport: s.viewport, panelOpen: s.panelOpen }
      set({
        fullScreen: true,
        viewport: { label: 'Fit', w: null, h: null },
        panelOpen: false,
        pager: false,
        gallery: false,
      })
    } else {
      set({
        fullScreen: false,
        viewport: beforeFullScreen?.viewport ?? s.viewport,
        panelOpen: beforeFullScreen?.panelOpen ?? s.panelOpen,
      })
      beforeFullScreen = null
    }
  },
  // Gallery is a distinct full-screen surface — leaving pager mode when it opens.
  toggleGallery: () => set((s) => ({ gallery: !s.gallery, pager: false })),

  setAuditPanel: (p) => set({ auditPanel: p }),
  setA11y: (r) => set({ a11y: r }),
  setTokens: (r) => set({ tokens: r }),
  setAuditHighlight: (b) => set({ auditHighlight: b }),

  setTree: (t) => set({ tree: t }),
  setTreeFilter: (f) => set({ treeFilter: f }),
  setSelection: (d) => set({ selection: d, panelOpen: d ? true : get().panelOpen }),
  reveal: () => set((s) => ({ revealNonce: s.revealNonce + 1 })),
  setHover: (h) => set({ hover: h }),
  setDrillChildren: (c) => set({ drillChildren: c }),
  setActiveTab: (t) => set({ activeTab: t }),
  openInSource: (file, line, col) => {
    // Embedded in Burrow the real editor takes the reveal; the Monaco Source
    // tab stays reachable manually as the standalone path.
    if (openInBurrow(file, line, col)) return
    set((s) => ({ activeTab: 'source', openSource: { file, line, nonce: (s.openSource?.nonce || 0) + 1 } }))
  },

  setStyleEdit: (key, e) => set((s) => ({ styleEdits: { ...s.styleEdits, [key]: e } })),
  removeStyleEdit: (key) =>
    set((s) => {
      const next = { ...s.styleEdits }
      delete next[key]
      return { styleEdits: next }
    }),
  clearStyleEdits: () => set({ styleEdits: {} }),

  toast: (kind, text) => {
    const id = toastId++
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }))
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 6000 : 3000)
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))

export const editKey = (selectorText: string, media: string | null, prop: string) =>
  `${selectorText}|${media || ''}|${prop}`
