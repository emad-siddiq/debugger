// The component-isolation harness PAGE (the Framer-like canvas). Served by the
// target's own Vite (see inspectorPlugin.js configureServer) so it shares the
// target module graph + HMR. One component mounts alone on a stage, wrapped in
// Router/Providers, with an interactive chrome around it:
//   top bar   — component name · labeled viewport presets (Fit / Phone 375 /
//               Tablet 768 / Desktop 1280; stage is also drag-resizable) ·
//               labeled backgrounds (App/Dark/Checker) · dev|prod-css ·
//               🎯 Inspect · panel ⚙
//   side panel — two tabs (⚙ toggles the whole panel).
//               Props: THE one props-editing surface — typed controls from the
//               extension's parsed schema (`schema` query param), grouped
//               Required then Optional, sample picker + Save-sample embedded,
//               per-prop ⟲ + Reset-all, raw JSON tucked behind an Advanced
//               disclosure (sole editor when there is no schema).
//               Breakpoints: the @media queries in the loaded stylesheets —
//               the ones affecting this component first, then the rest; a live
//               dot per query, → Npx sizes the stage, clicking one opens its
//               source line in the CSS editor.
//   inspect   — 🎯 toggle: hover highlights the rendered part with its
//               component name (from the data-inspect-* stamps); click reveals
//               its JSX + CSS in the editor (reveal envelope); Alt-click /
//               double-click a CHILD component's part re-isolates that child
//               (isolate envelope). Esc exits.
// Props come from the first rung that has them (plan 04 §2): a live capture
// off the running app ▸ a colocated <Component>.samples.* ▸ the module's own
// SAMPLE_PROPS export ▸ values the extension synthesized from the prop types
// ▸ nothing. The top-bar CHIP names the winner (live / sample:<name> /
// SAMPLE_PROPS / synth / empty) so a synthesized "Example Title" is never
// mistaken for what prod shows.
// Where a component mounts is data too: a `sampleRoute` export (module or
// samples file) or a per-sample `$route` feeds the MemoryRouter's
// initialEntries, so a route-dependent component (useParams) renders.
// Live edits re-render immediately. rawProps stays JSON-safe ('ƒ' markers);
// materialize() converts per-kind at render time: ƒ→no-op stub (returns null,
// so it also works as a component type), element strings→<span>, set→Set;
// $-prefixed keys are metadata and never reach the component.
// Envelopes up: ready | renderError | samples | props | saveSample | reveal |
// revealCss | isolate.
// Commands down: props | sample | reload | schema.

function esc(json) {
  return JSON.stringify(json).replace(/</g, '\\u003c')
}

export function buildIsolateHtml(cfg) {
  const routerImport = cfg.router
    ? "import { MemoryRouter as __BurrowMemoryRouter } from 'react-router-dom'"
    : ''
  // `isoRoute` is read at RENDER time, not at setup time: the route a component
  // wants (`sampleRoute` / a sample's `$route`) is only known after the module
  // and its samples have loaded. Boundary's key remounts the subtree on every
  // props change, so a sample that carries a different route re-navigates.
  const routerSetup = cfg.router
    ? "Router = (props) => h(__BurrowMemoryRouter, { initialEntries: [isoRoute] }, props.children)"
    : ''
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Burrow — Component Isolation</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body { font: 12px/1.5 system-ui, sans-serif; background: #ffffff; color: #111; display: flex; flex-direction: column; }
  #iso-top {
    flex: none; display: flex; align-items: center; gap: 6px; padding: 4px 8px;
    background: #15181e; color: #c9d1d9; border-bottom: 1px solid #2b3138;
    font-size: 11px; user-select: none;
  }
  #iso-top .name { font-weight: 700; font-size: 12px; color: #e6edf3; margin-right: 6px; }
  #iso-top .prov {
    font-size: 10px; color: #fff; background: #30363d; border-radius: 3px;
    padding: 1px 6px; letter-spacing: .02em; white-space: nowrap;
  }
  #iso-top .prov:empty { display: none; }
  #iso-top .tbtn.stale { border-color: #7d4e00; }
  #iso-top .sep { width: 1px; height: 14px; background: #2b3138; margin: 0 2px; }
  #iso-top .tlabel { color: #8b949e; font-size: 10px; text-transform: uppercase; letter-spacing: .05em; margin: 0 2px; }
  .tbtn {
    border: 1px solid #2b3138; background: #1c2128; color: #c9d1d9; border-radius: 4px;
    padding: 1px 7px; font: inherit; cursor: pointer;
  }
  .tbtn:hover { background: #262c34; }
  .tbtn.on { background: #2f81f7; border-color: #2f81f7; color: #fff; }
  #iso-pick-box {
    position: fixed; pointer-events: none; display: none; z-index: 9999;
    border: 1.5px solid #2f81f7; background: rgba(47, 129, 247, 0.08); border-radius: 2px;
  }
  #iso-pick-tag {
    position: fixed; pointer-events: none; display: none; z-index: 10000;
    background: #2f81f7; color: #fff; font: 10px/1.6 system-ui, sans-serif;
    padding: 0 6px; border-radius: 3px; white-space: nowrap;
  }
  #iso-pick-tag .enter { opacity: .85; font-style: italic; margin-left: 6px; }
  #iso-main { flex: 1; display: flex; min-height: 0; }
  #iso-canvas { flex: 1; overflow: auto; padding: 20px; display: flex; justify-content: center; align-items: flex-start; }
  #iso-canvas.bg-dark { background: #101418; }
  #iso-canvas.bg-checker {
    background-image: linear-gradient(45deg, #eee 25%, transparent 25%, transparent 75%, #eee 75%),
      linear-gradient(45deg, #eee 25%, transparent 25%, transparent 75%, #eee 75%);
    background-size: 16px 16px; background-position: 0 0, 8px 8px;
  }
  #iso-stage { background: inherit; min-width: 120px; max-width: 100%; }
  #iso-stage.frame { resize: both; overflow: auto; outline: 1px dashed #b6c2cf; background: #fff; }
  #iso-canvas.bg-dark #iso-stage.frame { background: #101418; outline-color: #333c45; }
  #burrow-iso-root { padding: 16px; min-height: 40px; }
  #iso-panel {
    flex: none; width: 280px; overflow: hidden; background: #15181e; color: #c9d1d9;
    border-left: 1px solid #2b3138; padding: 8px; display: flex; flex-direction: column; gap: 8px;
  }
  #iso-panel.hidden { display: none; }
  #iso-panel h3 { margin: 2px 0; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #8b949e; }
  #iso-panel .phint { color: #6e7681; font-size: 10px; margin-top: 1px; }
  #iso-tabs { flex: none; display: flex; gap: 2px; border-bottom: 1px solid #2b3138; }
  #iso-tabs .ptab {
    border: 0; background: none; color: #8b949e; font: inherit; cursor: pointer;
    padding: 3px 8px; border-bottom: 2px solid transparent;
  }
  #iso-tabs .ptab:hover { color: #e6edf3; }
  #iso-tabs .ptab.on { color: #e6edf3; border-bottom-color: #2f81f7; }
  #iso-body { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
  .bp-note { color: #6e7681; font-size: 10px; line-height: 1.45; }
  .bp-row { display: flex; align-items: center; gap: 6px; padding: 2px 0; }
  .bp-row.hl .bp-media { color: #e6edf3; }
  .bp-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: #30363d; border: 1px solid #444c56; }
  .bp-dot.active { background: #3fb950; border-color: #3fb950; }
  .bp-media {
    flex: 1; color: #8b949e; font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .bp-media.link { cursor: pointer; text-decoration: underline dotted #444c56; }
  .bp-media.link:hover { color: #58a6ff; }
  .mini {
    border: 1px solid #2b3138; background: #1c2128; color: #c9d1d9; border-radius: 4px;
    padding: 0 5px; font: 10px/1.6 system-ui, sans-serif; cursor: pointer; flex: none;
  }
  .mini:hover { background: #262c34; }
  #iso-panel details { border-top: 1px solid #2b3138; padding-top: 6px; }
  #iso-panel summary { cursor: pointer; color: #8b949e; font-size: 11px; user-select: none; }
  #iso-panel .pfoot { margin-top: 4px; }
  .prow { display: flex; flex-direction: column; gap: 2px; }
  .prow label { display: flex; align-items: center; gap: 5px; color: #c9d1d9; font-weight: 500; }
  .prow .req { width: 6px; height: 6px; border-radius: 50%; background: #f85149; flex: none; }
  .prow .tkind { color: #8b949e; font-weight: 400; margin-left: auto; }
  .prow .reset { margin-left: 4px; cursor: pointer; color: #8b949e; background: none; border: none; font: inherit; padding: 0 2px; }
  .prow .reset:hover { color: #e6edf3; }
  .prow input[type=text], .prow input[type=number], .prow select, .prow textarea {
    width: 100%; background: #0d1117; color: #e6edf3; border: 1px solid #2b3138; border-radius: 4px;
    padding: 3px 6px; font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .prow.unset input[type=text], .prow.unset input[type=number], .prow.unset select, .prow.unset textarea { color: #6e7681; }
  .prow textarea { resize: vertical; min-height: 34px; }
  .prow .invalid { border-color: #f85149; }
  .prow .stub { color: #8b949e; font-style: italic; }
  .srow { display: flex; gap: 6px; align-items: center; }
  .srow select { flex: 1; }
  .burrow-iso-error {
    margin: 12px; padding: 12px 14px; border-radius: 8px;
    background: #2b0f12; color: #ffd7d7; border: 1px solid #7f1d1d;
    font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    white-space: pre-wrap; word-break: break-word;
  }
  .burrow-iso-error .hint { display: block; margin-top: 8px; color: #e3b341; font-family: system-ui, sans-serif; }
</style>
<script>window.__BURROW_ISOLATE__ = ${esc(cfg)};</script>
</head>
<body>
<div id="iso-top"></div>
<div id="iso-main">
  <div id="iso-canvas"><div id="iso-stage"><div id="burrow-iso-root"></div></div><div id="iso-pick-box"></div><div id="iso-pick-tag"></div></div>
  <aside id="iso-panel" class="hidden"></aside>
</div>
<script type="module">
import { createElement as h, Component } from 'react'
import { createRoot } from 'react-dom/client'
${routerImport}

const CFG = window.__BURROW_ISOLATE__
const BASE = import.meta.env.BASE_URL
const EMBEDDED = window.parent !== window

const report = (type, detail) => { try { parent.postMessage({ __burrowIso: 1, type, detail }, '*') } catch (e) {} }
const loadOptional = async (spec) => { try { return await import(/* @vite-ignore */ spec) } catch (e) { return null } }
const el = (tag, attrs, ...kids) => {
  const n = document.createElement(tag)
  for (const k in (attrs || {})) {
    if (k === 'class') n.className = attrs[k]
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), attrs[k])
    else if (k === 'checked' || k === 'value') n[k] = attrs[k]
    else n.setAttribute(k, attrs[k])
  }
  for (const kid of kids) { if (kid != null) n.append(kid) }
  return n
}

let rawProps = {}
let seedProps = {} // boot-time snapshot (props param / first sample / skeleton) — "Reset all" target
let schema = Array.isArray(CFG.schema) ? CFG.schema : null
let sampleMap = {}
let renderFn = () => {}
// Where the props on screen came from — rendered as the top-bar chip so a
// preview never quietly passes synthesized values off as the real thing.
let provenance = 'empty'
// The route the component is mounted at (see routerSetup above).
let isoRoute = '/'
let sampleRoute = null
// Shallow, so a sample can carry REAL functions (a DataTable column's
// render, an onSelect) — a JSON round-trip would silently drop them and the
// component would crash on first use. Only the top level is copied because
// that is the only level the panel mutates: editing a prop replaces its whole
// value, it never reaches into one.
const clone = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? Object.assign({}, v) : v
// Props as something postMessage and JSON.stringify can carry: functions
// become the 'ƒ' marker the panel and materialize() already understand.
const jsonSafe = (p) => {
  const out = {}
  for (const k of Object.keys(p)) out[k] = typeof p[k] === 'function' ? 'ƒ' : p[k]
  return out
}
// A sample's $route says WHERE the component should mount; it is metadata,
// never a prop.
const routeOf = (props) => (props && typeof props.$route === 'string') ? props.$route : (sampleRoute || '/')

const isFnMarker = (v) => typeof v === 'string' && /^ƒ( |$)/.test(v)
const stubFor = (name) => (...a) => { try { console.log('[burrow-iso] ' + name, ...a) } catch (e) {} return null }

// JSON-safe rawProps → runtime props, per schema kind (fallback: markers only).
const materialize = (p) => {
  const out = {}
  for (const k of Object.keys(p)) {
    if (k.charAt(0) === '$') continue // $route and friends are metadata
    const v = p[k]
    const spec = schema && schema.find((s) => s.name === k)
    const kind = spec ? spec.kind : null
    if (typeof v === 'function') out[k] = v // a sample's real callback wins over a stub
    else if (isFnMarker(v) || kind === 'function' || kind === 'component') out[k] = stubFor(k)
    else if ((kind === 'element' || k === 'children') && typeof v === 'string') out[k] = h('span', null, v)
    else if (kind === 'set') out[k] = new Set(Array.isArray(v) ? v : [])
    else out[k] = v
  }
  return out
}

class Boundary extends Component {
  constructor(p) { super(p); this.state = { err: null } }
  static getDerivedStateFromError(err) { return { err } }
  componentDidCatch(err) { report('renderError', String((err && err.stack) || err)) }
  render() {
    if (this.state.err) {
      return h('pre', { className: 'burrow-iso-error' },
        String((this.state.err && this.state.err.stack) || this.state.err),
        h('span', { className: 'hint' }, 'Adjust the props in the panel on the right (⚙) — object-typed props may need realistic values.'))
    }
    return this.props.children
  }
}

const pickExport = (mod, name) => {
  const ok = (v) => typeof v === 'function' || (!!v && typeof v === 'object' && typeof v.$$typeof === 'symbol')
  if (name && ok(mod[name])) return mod[name]
  if (ok(mod.default)) return mod.default
  for (const k of Object.keys(mod)) { if (/^[A-Z]/.test(k) && ok(mod[k])) return mod[k] }
  return null
}
const showError = (msg) => {
  const root = document.getElementById('burrow-iso-root')
  root.innerHTML = ''
  root.append(el('pre', { class: 'burrow-iso-error' }, msg))
}

// ---- chrome: top bar (labeled viewport/background, inspect, panel) ---------
const canvas = document.getElementById('iso-canvas')
const stage = document.getElementById('iso-stage')
const panel = document.getElementById('iso-panel')

// Stage width has two callers — the top bar's presets and the breakpoints
// tab's jump buttons — so one function owns it and keeps the preset row's
// highlight honest (a jump to 480px lights no preset; a jump to 768 lights the
// tablet one). 0 = Fit: the stage hugs the component instead of framing it.
let widthButtons = []
function setStageWidth(w) {
  if (w === 0) { stage.classList.remove('frame'); stage.style.width = '' }
  else { stage.classList.add('frame'); stage.style.width = w + 'px' }
  for (const b of widthButtons) b.classList.toggle('on', Number(b.getAttribute('data-w')) === w)
}

function buildTopBar(label) {
  const top = document.getElementById('iso-top')
  top.innerHTML = ''
  const presets = [
    ['Fit', 0, 'Fit — the stage hugs the component'],
    ['📱 375', 375, 'Phone width — 375px (drag the stage corner to fine-tune)'],
    ['📱 768', 768, 'Tablet width — 768px'],
    ['💻 1280', 1280, 'Desktop width — 1280px'],
  ]
  widthButtons = presets.map(([txt, w, tip]) => el('button', {
    class: 'tbtn' + (w === 0 ? ' on' : ''), title: tip, 'data-w': w,
    onclick: () => setStageWidth(w),
  }, txt))
  const pbtns = widthButtons
  const bgs = [
    ['App', '', "The app's own background"],
    ['Dark', 'bg-dark', 'Dark canvas — check light-on-dark rendering'],
    ['▦ Checker', 'bg-checker', 'Transparency checkerboard — see through transparent areas'],
  ]
  const bbtns = bgs.map(([txt, cls, tip]) => el('button', {
    class: 'tbtn' + (cls === '' ? ' on' : ''), title: tip,
    onclick: (e) => {
      bbtns.forEach((b) => b.classList.remove('on')); e.currentTarget.classList.add('on')
      canvas.className = cls
    },
  }, txt))
  top.append(
    el('span', { class: 'name', title: CFG.module }, label),
    el('span', { class: 'prov', id: 'iso-prov' }),
    el('span', { class: 'sep' }),
    el('span', { class: 'tlabel' }, 'width'), ...pbtns,
    el('span', { class: 'sep' }),
    el('span', { class: 'tlabel' }, 'bg'), ...bbtns,
    ...cssButtons(),
    el('span', { style: 'flex:1' }),
    el('button', {
      class: 'tbtn', id: 'iso-inspect-btn',
      title: 'Inspect — hover a part to see which component renders it; click to open its code and CSS in the editor; Alt-click (or double-click) a child component to enter it. Esc exits.',
      onclick: () => setInspect(!inspectOn),
    }, '🎯 Inspect'),
    el('button', { class: 'tbtn', title: 'Show/hide the props panel', onclick: () => panel.classList.toggle('hidden') }, '⚙ props'),
  )
}

// dev | prod-css — the third lever (plan 07 WI-7). The dev graph is not what
// ships: the build minifies, reorders and drops. Toggling swaps in the target's
// BUILT stylesheet so a component can be checked against the CSS production
// actually serves. A stale bundle is labelled, never silently shown as current.
function cssButtons() {
  const prod = CFG.prodCss
  if (!prod || !prod.found) {
    return [
      el('span', { class: 'sep' }),
      el('span', { class: 'tlabel', title: (prod && prod.hint) || 'no built CSS found' }, 'dev css'),
    ]
  }
  let link = null
  const stale = prod.ageDays >= 3
  const tip = 'Swap the dev stylesheet for the built one (' + prod.file + ', built '
    + (prod.ageDays === 0 ? 'today' : prod.ageDays + 'd ago') + ')'
    + (stale ? ' — rebuild the target for a fair comparison' : '')
  const btn = el('button', {
    class: 'tbtn' + (stale ? ' stale' : ''), title: tip,
    onclick: (e) => {
      const on = !link
      if (on) {
        link = el('link', { rel: 'stylesheet', href: BASE + prod.file })
        document.head.append(link)
      } else {
        link.remove()
        link = null
      }
      e.currentTarget.classList.toggle('on', on)
      e.currentTarget.textContent = on ? 'prod-css' : 'dev css'
    },
  }, 'dev css')
  return [el('span', { class: 'sep' }), el('span', { class: 'tlabel' }, 'css'), btn]
}

// The chip that says where the props came from. Tone carries the meaning:
// real data (a sample, a live capture) reads confident, synthesized data reads
// provisional — so nobody mistakes "Example Title" for what prod shows.
const PROV_TONES = {
  live: ['#1f6feb', 'Props captured from the running app'],
  synth: ['#7d4e00', 'No sample for this component — values synthesized from its prop types'],
  SAMPLE_PROPS: ['#1a7f37', 'From the module\\'s exported SAMPLE_PROPS'],
  props: ['#30363d', 'Props supplied in the isolate URL'],
  empty: ['#30363d', 'No props — the component renders with its own defaults'],
}
function setProvenance(next) {
  if (next) provenance = next
  const chip = document.getElementById('iso-prov')
  if (!chip) return
  const key = provenance.indexOf('sample:') === 0 ? 'sample' : provenance
  const [bg, tip] = PROV_TONES[key] || ['#1a7f37', 'From a colocated ' + CFG.module.split('/').pop().replace(/\\.[jt]sx?$/, '') + '.samples file']
  chip.textContent = provenance
  chip.title = tip + (isoRoute !== '/' ? ' · mounted at ' + isoRoute : '')
  chip.style.background = bg
}

// ---- inspect mode: hover-highlight + click→reveal + drill-into-child -------
// The overlay lives OUTSIDE #burrow-iso-root (React must never reconcile it)
// and is pointer-events:none; picking uses document-level CAPTURE listeners
// active only while the mode is on. Stamps come from the Vite plugin's
// data-inspect-* attributes on host elements.
let inspectOn = false
const pickBox = document.getElementById('iso-pick-box')
const pickTag = document.getElementById('iso-pick-tag')

const stampedAt = (target) => {
  if (!target || !target.closest) return null
  const n = target.closest('[data-inspect-line]')
  return n && document.getElementById('burrow-iso-root').contains(n) ? n : null
}
// A part belongs to a CHILD component when its stamp names a different module.
// Out-of-src stamps (absolute-path fallback in the transform) can't be isolated.
const childFileOf = (n) => {
  const f = n.getAttribute('data-inspect-file') || ''
  return f !== CFG.module && f.indexOf('src/') === 0 ? f : null
}
const hidePick = () => { pickBox.style.display = 'none'; pickTag.style.display = 'none' }

function onPickMove(e) {
  const n = stampedAt(e.target)
  if (!n) { hidePick(); return }
  const r = n.getBoundingClientRect()
  pickBox.style.display = 'block'
  pickBox.style.left = r.left + 'px'
  pickBox.style.top = r.top + 'px'
  pickBox.style.width = r.width + 'px'
  pickBox.style.height = r.height + 'px'
  pickTag.innerHTML = ''
  pickTag.append(n.getAttribute('data-inspect-name') || n.tagName.toLowerCase())
  if (childFileOf(n)) pickTag.append(el('span', { class: 'enter' }, '⏎ Alt-click to enter'))
  pickTag.style.display = 'block'
  pickTag.style.left = r.left + 'px'
  pickTag.style.top = Math.max(2, r.top - 18) + 'px'
}
function detailOf(n) {
  return {
    file: n.getAttribute('data-inspect-file') || '',
    line: parseInt(n.getAttribute('data-inspect-line') || '0', 10),
    col: parseInt(n.getAttribute('data-inspect-col') || '0', 10),
    name: n.getAttribute('data-inspect-name') || n.tagName.toLowerCase(),
    classes: Array.prototype.slice.call(n.classList),
  }
}
function onPickClick(e) {
  const n = stampedAt(e.target)
  if (!n) return
  e.preventDefault(); e.stopPropagation()
  const child = childFileOf(n)
  if (e.altKey && child) report('isolate', { file: child, name: n.getAttribute('data-inspect-name') || null })
  else report('reveal', detailOf(n))
}
function onPickDblClick(e) {
  const n = stampedAt(e.target)
  if (!n) return
  e.preventDefault(); e.stopPropagation()
  const child = childFileOf(n)
  if (child) report('isolate', { file: child, name: n.getAttribute('data-inspect-name') || null })
}
function onPickKey(e) { if (e.key === 'Escape') setInspect(false) }

// Esc bridge (Burrow docs/plans/01 section 4). Focus lives in this iframe, so
// the IDE never sees the keystroke; report it up and the extension exits Focus
// Mode. Inspect mode claims Escape first (onPickKey above) — one Escape should
// leave inspect, not the whole mode, so this stays out of the way while it is on.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !inspectOn) report('exitFocus')
})

function setInspect(on) {
  if (on === inspectOn) return
  inspectOn = on
  const btn = document.getElementById('iso-inspect-btn')
  if (btn) btn.classList.toggle('on', on)
  const opts = { capture: true }
  if (on) {
    document.addEventListener('mousemove', onPickMove, opts)
    document.addEventListener('click', onPickClick, opts)
    document.addEventListener('dblclick', onPickDblClick, opts)
    document.addEventListener('keydown', onPickKey, opts)
  } else {
    document.removeEventListener('mousemove', onPickMove, opts)
    document.removeEventListener('click', onPickClick, opts)
    document.removeEventListener('dblclick', onPickDblClick, opts)
    document.removeEventListener('keydown', onPickKey, opts)
    hidePick()
  }
}

// ---- breakpoints tab -------------------------------------------------------
// The media queries in play, read straight off the live document.styleSheets —
// the same walk the in-page agent does for the whole app (agent.js
// matchedRulesFor), scoped to the isolated subtree: a query "affects this
// component" when one of its rules matches something under #burrow-iso-root.
//
// What the dot means matters. A width query matches against THIS DOCUMENT's
// viewport — the preview frame — not against the stage, because the stage is a
// div and resizing a div never crosses a breakpoint. So the dot reports what is
// actually rendering right now (and re-reads on resize, since dragging the
// editor group edge is how you cross one in the workbench), the → buttons size
// the stage for layout, and the note at the top of the tab says which is which
// instead of leaving the two to be confused.
const STATE_PSEUDO = /:(hover|focus|focus-within|focus-visible|active|visited|target|enabled|disabled|checked|valid|invalid|required|optional|placeholder-shown)/g
const PSEUDO_EL = /::?(before|after|first-line|first-letter|placeholder|selection|marker|backdrop|file-selector-button)/g

// Parse a width number out of a media query so we can jump the stage to it.
function widthOf(media) {
  const m = media.match(/(max|min)-width:\\s*(\\d+)px/)
  if (!m) return null
  const px = Number(m[2])
  // Both bounds are inclusive, so the number itself sits inside the rule.
  return m[1] === 'max' ? Math.max(320, px) : px
}

const mediaMatches = (mt) => { try { return window.matchMedia(mt).matches } catch (e) { return false } }

/** Does anything in the isolated subtree match this rule? A :hover rule still
 *  affects the component, so the state-free form of the selector counts too. */
function hitsComponent(root, selectorText) {
  if (!selectorText) return false
  for (const part of selectorText.split(',')) {
    const sel = part.trim()
    if (!sel) continue
    const base = sel.replace(PSEUDO_EL, '').replace(STATE_PSEUDO, '').trim()
    for (const s of (base && base !== sel) ? [sel, base] : [sel]) {
      try { if (root.querySelector(s)) return true } catch (e) {}
    }
  }
  return false
}

/** Every distinct @media in the loaded stylesheets: live match state, whether
 *  it touches this component, and one selector inside it — the handle the
 *  extension resolves back to an authored file:line. The CSSOM can't give that
 *  directly: a Vite dev <style> node names the module that imported the CSS
 *  (merkle's index.css manifest), not the file the rule was written in, so a
 *  selector + its media goes to the sidecar's provenance lookup instead. */
function scanBreakpoints() {
  const root = document.getElementById('burrow-iso-root')
  const seen = new Map()
  const walk = (rules, media) => {
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i]
      if (rule.type === 4) {
        const mt = rule.media && rule.media.mediaText
        if (mt && !seen.has(mt)) seen.set(mt, { media: mt, active: mediaMatches(mt), affects: false, selector: null })
        walk(rule.cssRules, mt || media)
      } else if (rule.type === 12) {
        walk(rule.cssRules, media)
      } else if (rule.type === 1 && media) {
        const entry = seen.get(media)
        if (!entry || !rule.selectorText) continue
        if (!entry.selector) entry.selector = rule.selectorText
        if (!entry.affects && root && hitsComponent(root, rule.selectorText)) {
          entry.affects = true
          // Prefer a rule that actually reaches this component: it lands the
          // reveal in the component's own stylesheet rather than wherever the
          // block happened to open.
          entry.selector = rule.selectorText
        }
      }
    }
  }
  const sheets = document.styleSheets
  for (let s = 0; s < sheets.length; s++) {
    let rules
    try { rules = sheets[s].cssRules } catch (e) { continue } // cross-origin sheet
    if (rules) walk(rules, null)
  }
  // Widest first, so the list reads as a ladder down to the smallest phone;
  // feature queries (reduced-motion, coarse pointers) are not breakpoints and
  // sit at the end.
  return [...seen.values()].sort((a, b) => (widthOf(b.media) || -1) - (widthOf(a.media) || -1))
}

function bpRow(entry) {
  const w = widthOf(entry.media)
  const canReveal = EMBEDDED && !!entry.selector
  const media = el('span', {
    class: 'bp-media' + (canReveal ? ' link' : ''),
    title: canReveal ? 'Open this block in the CSS editor (' + entry.selector + ')' : entry.media,
  }, entry.media)
  if (canReveal) media.addEventListener('click', () => report('revealCss', { media: entry.media, selector: entry.selector }))
  return el('div', { class: 'bp-row' + (entry.affects ? ' hl' : '') },
    el('span', {
      class: 'bp-dot' + (entry.active ? ' active' : ''),
      title: entry.active ? 'Matching right now' : 'Not matching at this preview width',
    }),
    media,
    w ? el('button', { class: 'mini', title: 'Size the stage to ' + w + 'px', onclick: () => setStageWidth(w) }, '→ ' + w + 'px') : null)
}

function buildBreakpointsTab(body) {
  const all = scanBreakpoints()
  const affecting = all.filter((e) => e.affects)
  body.append(el('div', { class: 'bp-note' },
    'Dots follow the preview frame (' + window.innerWidth + 'px wide) — drag the editor edge to cross a breakpoint. → sizes the stage.'))
  body.append(el('h3', null, 'Affecting this component'))
  if (!affecting.length) body.append(el('div', { class: 'phint' }, 'No responsive rules reach this component.'))
  for (const entry of affecting) body.append(bpRow(entry))
  body.append(el('h3', null, 'All breakpoints in the stylesheet'))
  if (!all.length) body.append(el('div', { class: 'phint' }, 'This preview loaded no @media rules.'))
  for (const entry of all) body.append(bpRow(entry))
}

// ---- props tab -------------------------------------------------------------
let textTimer = null
const applySoon = () => { clearTimeout(textTimer); textTimer = setTimeout(() => renderFn(), 200) }

function controlFor(spec) {
  const name = spec.name
  const set = (v) => { rawProps[name] = v }
  const unset = () => { delete rawProps[name] }
  const current = Object.prototype.hasOwnProperty.call(rawProps, name) ? rawProps[name]
    : (spec.fromDefault ? spec.value : undefined)
  const isSet = Object.prototype.hasOwnProperty.call(rawProps, name)

  if (spec.kind === 'function' || spec.kind === 'component') {
    return el('span', { class: 'stub' }, spec.kind === 'component' ? 'ƒ stub component' : 'ƒ stub — calls log to console')
  }
  if (spec.kind === 'boolean') {
    return el('input', {
      type: 'checkbox', checked: !!current,
      onchange: (e) => { set(e.target.checked); renderFn() },
    })
  }
  if (spec.kind === 'enum') {
    const sel = el('select', {
      onchange: (e) => { set(e.target.value); renderFn() },
    }, ...(spec.options || []).map((o) => el('option', { value: o }, o)))
    if (typeof current === 'string') sel.value = current
    return sel
  }
  if (spec.kind === 'number') {
    return el('input', {
      type: 'number', value: current == null ? '' : current,
      oninput: (e) => { const n = Number(e.target.value); if (!Number.isNaN(n)) { set(n); applySoon() } },
    })
  }
  if (spec.kind === 'string' || spec.kind === 'element') {
    return el('input', {
      type: 'text', value: typeof current === 'string' ? current : '',
      placeholder: spec.fromDefault && typeof spec.value === 'string' ? spec.value : '',
      oninput: (e) => { set(e.target.value); applySoon() },
    })
  }
  // array | set | object | json → JSON textarea
  const seed = current !== undefined ? current : (spec.shape !== undefined ? spec.shape : {})
  const ta = el('textarea', {
    oninput: (e) => {
      try { set(JSON.parse(e.target.value)); e.target.classList.remove('invalid'); applySoon() }
      catch (err) { e.target.classList.add('invalid') }
    },
  })
  ta.value = JSON.stringify(seed, null, 1)
  return ta
}

function propRow(spec) {
  const isSet = Object.prototype.hasOwnProperty.call(rawProps, spec.name)
  const row = el('div', { class: 'prow' + (!isSet && !spec.required ? ' unset' : '') })
  const label = el('label', null,
    spec.required ? el('span', { class: 'req', title: 'Required — the component needs this to render' }) : null,
    spec.name,
    el('span', { class: 'tkind' }, spec.kind))
  if (!spec.required && isSet) {
    label.append(el('button', {
      class: 'reset', title: 'Reset to the component default',
      onclick: () => { delete rawProps[spec.name]; buildPanel(); renderFn() },
    }, '⟲'))
  }
  row.append(label, controlFor(spec))
  const jsonKinds = { array: 1, set: 1, object: 1, json: 1 }
  if (jsonKinds[spec.kind]) row.append(el('div', { class: 'phint' }, 'Object value — edit as JSON'))
  else if (spec.kind === 'function') row.append(el('div', { class: 'phint' }, 'Calls are stubbed and logged to the console'))
  return row
}

/** Load a named sample: its props, its route, and the chip that names it. */
function applySample(name, sample) {
  rawProps = clone(sample)
  isoRoute = routeOf(rawProps)
  setProvenance('sample:' + name)
  buildPanel()
  renderFn()
}

// The panel is one aside with two tabs; ⚙ in the top bar shows/hides the whole
// thing. Every rebuild goes through here so the strip and the body can never
// disagree about which tab is showing.
let panelTab = 'props'
const PANEL_TABS = [
  ['props', 'Props', 'Edit the props this preview renders with'],
  ['breakpoints', 'Breakpoints', 'The media queries in play, and what they match right now'],
]

function buildPanel() {
  panel.innerHTML = ''
  const tabs = el('div', { id: 'iso-tabs' })
  for (const [key, label, tip] of PANEL_TABS) {
    tabs.append(el('button', {
      class: 'ptab' + (panelTab === key ? ' on' : ''), title: tip,
      onclick: () => { panelTab = key; buildPanel() },
    }, label))
  }
  const body = el('div', { id: 'iso-body' })
  panel.append(tabs, body)
  if (panelTab === 'breakpoints') buildBreakpointsTab(body)
  else buildPropsTab(body)
}

// Dots are only true for the width the frame has right now, so re-read them
// when it changes. Guarded to the breakpoints tab: rebuilding the props tab
// under a half-typed JSON textarea would throw the edit away.
let bpTimer = null
window.addEventListener('resize', () => {
  if (panelTab !== 'breakpoints' || panel.classList.contains('hidden')) return
  clearTimeout(bpTimer)
  bpTimer = setTimeout(buildPanel, 120)
})

function buildPropsTab(body) {
  const sampleNames = Object.keys(sampleMap)
  if (sampleNames.length || EMBEDDED) {
    const row = el('div', { class: 'srow' })
    if (sampleNames.length) {
      const sel = el('select', {
        title: 'Load a saved set of props',
        onchange: (e) => { const s = sampleMap[e.target.value]; if (s) { applySample(e.target.value, s) } },
      }, el('option', { value: '' }, '— pick a sample —'), ...sampleNames.map((n) => el('option', { value: n }, n)))
      row.append(sel)
    }
    if (EMBEDDED) {
      row.append(el('button', {
        class: 'tbtn', title: 'Save the current props as a named sample (writes <Component>.samples.ts beside the source)',
        onclick: () => report('saveSample', rawProps),
      }, '💾 Save as sample…'))
    }
    body.append(el('h3', null, 'Sample props'), row)
  }
  if (schema) {
    const required = schema.filter((s) => s.required)
    const optional = schema.filter((s) => !s.required)
    if (required.length) {
      body.append(el('h3', null, 'Required'))
      for (const spec of required) body.append(propRow(spec))
    }
    if (optional.length) {
      body.append(el('h3', null, 'Optional'))
      for (const spec of optional) body.append(propRow(spec))
    }
    body.append(el('div', { class: 'prow pfoot' }, el('button', {
      class: 'tbtn', title: 'Discard every edit and go back to the props this preview started with',
      onclick: () => { rawProps = JSON.parse(JSON.stringify(seedProps)); buildPanel(); renderFn() },
    }, '⟲ Reset all to defaults')))
  }
  // Raw JSON escape hatch — collapsed behind Advanced; the ONLY editor (and
  // expanded) when there is no schema to build controls from.
  const raw = el('textarea', {
    title: 'All props as one JSON object — applies on valid parse',
    oninput: (e) => {
      try { rawProps = JSON.parse(e.target.value); e.target.classList.remove('invalid'); applySoon() }
      catch (err) { e.target.classList.add('invalid') }
    },
  })
  raw.value = JSON.stringify(jsonSafe(rawProps), null, 1)
  const adv = el('details', null,
    el('summary', null, 'Advanced — all props as JSON'),
    el('div', { class: 'prow' }, raw))
  if (!schema) adv.setAttribute('open', '')
  body.append(adv)
}

// ---- boot ------------------------------------------------------------------
;(async () => {
  try {
    let Router = (props) => props.children
    ${routerSetup}

    let Providers = (props) => props.children
    if (CFG.providers) {
      const pm = await loadOptional(BASE + CFG.providers)
      const P = pm && (pm.default || pm.Providers)
      if (P) Providers = (props) => h(P, null, props.children)
    }
    if (CFG.css) await loadOptional(BASE + CFG.css)

    const mod = await import(/* @vite-ignore */ BASE + CFG.module)
    const Comp = pickExport(mod, CFG.export)
    if (!Comp) { report('renderError', 'no component export in ' + CFG.module); showError('No component export found in ' + CFG.module + (CFG.export ? ' (looked for "' + CFG.export + '")' : '')); return }

    if (CFG.samples) {
      const sm = await loadOptional(BASE + CFG.samples)
      const raw = sm && (sm.samples || sm.default)
      if (raw && typeof raw === 'object') sampleMap = raw
      // A samples FILE may also name the route its component belongs at.
      if (sm && typeof sm.sampleRoute === 'string') sampleRoute = sm.sampleRoute
    }
    // A component can carry its own realistic props without a samples file:
    // export const SAMPLE_PROPS = {…} right beside it. Same for the route.
    const modSampleProps = mod && mod.SAMPLE_PROPS && typeof mod.SAMPLE_PROPS === 'object' ? mod.SAMPLE_PROPS : null
    if (!sampleRoute && typeof (mod && mod.sampleRoute) === 'string') sampleRoute = mod.sampleRoute
    const sampleNames = Object.keys(sampleMap)
    if (sampleNames.length) report('samples', sampleNames)

    // Props precedence (plan 04 §2): live capture ▸ colocated samples ▸
    // exported SAMPLE_PROPS ▸ synthesized-from-types ▸ empty. Each rung is
    // more truthful than the one below it, and the chip says which one won.
    const seeded = (CFG.props && typeof CFG.props === 'object' && Object.keys(CFG.props).length) ? CFG.props : null
    if (seeded && CFG.propsSource === 'capture') {
      rawProps = seeded
      provenance = 'live'
    } else if (sampleNames.length) {
      rawProps = clone(sampleMap[sampleNames[0]])
      provenance = 'sample:' + sampleNames[0]
    } else if (modSampleProps) {
      rawProps = clone(modSampleProps)
      provenance = 'SAMPLE_PROPS'
    } else if (seeded) {
      rawProps = seeded
      provenance = CFG.propsSource === 'synth' ? 'synth' : 'props'
    } else {
      rawProps = {}
      provenance = 'empty'
    }
    isoRoute = routeOf(rawProps)
    seedProps = clone(rawProps)

    const label = CFG.export || (CFG.module.split('/').pop() || '').replace(/\\.[jt]sx?$/, '')
    buildTopBar(label)
    setProvenance()
    buildPanel()
    panel.classList.remove('hidden')

    const root = createRoot(document.getElementById('burrow-iso-root'))
    renderFn = () => {
      root.render(h(Boundary, { key: JSON.stringify(jsonSafe(rawProps)) }, h(Router, null, h(Providers, null, h(Comp, materialize(rawProps))))))
      report('props', jsonSafe(rawProps))
    }
    renderFn()
    report('ready', label)

    window.addEventListener('message', (e) => {
      const d = e.data
      if (!d || d.__burrowIsoCmd !== 1) return
      if (d.type === 'props') { rawProps = (d.props && typeof d.props === 'object') ? d.props : {}; isoRoute = routeOf(rawProps); setProvenance('live'); buildPanel(); renderFn() }
      else if (d.type === 'sample') { const s = sampleMap[d.name]; if (s && typeof s === 'object') { applySample(d.name, s) } }
      else if (d.type === 'schema') { if (Array.isArray(d.schema)) { schema = d.schema; buildPanel() } }
      else if (d.type === 'reload') location.reload()
    })
  } catch (err) {
    report('renderError', String((err && err.stack) || err))
    showError(String((err && err.stack) || err))
  }
})()
</script>
</body>
</html>`
}
