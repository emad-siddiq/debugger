export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export interface SourceLoc {
  file: string
  line: number
  col?: number | null
  name?: string | null
}

export interface Decl {
  prop: string
  value: string
  important: boolean
}

export interface MatchedRule {
  selectorText: string
  selectorPart: string
  stateOnly: boolean
  media: string | null
  mediaActive: boolean
  cssText: string
  declarations: Decl[]
}

export interface PathItem {
  id: string
  name: string
}

export interface ComputedBox {
  width: string
  height: string
  display: string
  position: string
  color: string
  background: string
  fontSize: string
  fontFamily: string
  margin: [string, string, string, string]
  padding: [string, string, string, string]
  border: [string, string, string, string]
  // Additional longhands (EXTRA_COMPUTED in agent.js) keyed by css property —
  // the editor panel's fallback when no authored rule defines a control's prop.
  extra?: Record<string, string>
}

export interface InheritedRule {
  selectorText: string
  media: string | null
  mediaActive: boolean
  declarations: Decl[]
}

export interface InheritedGroup {
  name: string
  tag: string
  source: SourceLoc | null
  rules: InheritedRule[]
}

export interface HookEntry {
  index: number
  kind: string
  value: unknown
}

export interface Detail {
  id: string
  name: string
  tag: string | null
  className?: string | null
  box: Box | null
  source: SourceLoc | null
  // Where the component is USED — prop edits land in the owner's file.
  owner?: SourceLoc | null
  path: PathItem[]
  css: MatchedRule[]
  allMedia: Record<string, boolean>
  inherited: InheritedGroup[]
  computed: ComputedBox | null
  props: Record<string, unknown> | null
  hooks: HookEntry[] | null
  childCount: number
}

// ---- Accessibility audit (agent event `a11y`) ------------------------------
export interface A11yIssue {
  severity: 'error' | 'warn'
  rule: string
  message: string
  selector: string
  box: Box | null
}
export interface A11yResult {
  issues: A11yIssue[]
}

// ---- Design-token conformance (agent event `tokens`) -----------------------
export interface TokenOffender {
  property: string
  usedValue: string
  nearestToken?: string | null
  selector: string
  box: Box | null
}
export interface TokensResult {
  tokens: number
  offenders: TokenOffender[]
}

// ---- Design-token catalog (agent event `tokenList`) ------------------------
export interface TokenInfo {
  name: string // --token-name
  value: string // currently-resolved value on :root
}

// ---- Discovered route catalog (agent event `routes`) -----------------------
// Read from the target's live react-router fibers, so the picker + navigation
// basename come from whatever app is loaded — not a hardcoded nodewatch catalog.
export interface DiscoveredRoute {
  id: string
  path: string
  label: string
  group: 'Primary' | 'Secondary'
  dynamic: boolean
  // The route element's component name when statically knowable (null for
  // lazy() routes) — "Show in App" matches usage-graph names against this.
  name?: string | null
}
export interface RoutesInfo {
  source: 'live' | 'none'
  basename: string
  active: string | null
  pageId: string | null
  routes: DiscoveredRoute[] // concrete (non-`:param`) routes, for the picker
  all: DiscoveredRoute[] // includes dynamic routes, for matching
  error?: string
}

export interface TreeNode {
  id: string
  name: string
  children: TreeNode[]
}

export interface ChildBox {
  id: string
  name: string
  box: Box | null
}

export interface HoverState {
  name: string
  box: Box | null
  nameChain?: string[]
}

export type RelativeDir = 'parent' | 'child' | 'prev' | 'next'
