// The component-isolation harness PAGE (the Framer-like canvas). Served by the
// target's own Vite (see inspectorPlugin.js configureServer) so it shares the
// target module graph + HMR. One component mounts alone on a stage, wrapped in
// Router/Providers, with an interactive chrome around it:
//   top bar   — component name · viewport presets (Fit/375/768/1280, stage is
//               also drag-resizable) · background (app/dark/checker) · panel ⚙
//   props panel — typed controls generated from the extension's parsed schema
//               (`schema` query param): text/number/checkbox/select per prop,
//               required dot, the component's own destructuring defaults shown
//               grayed until overridden (⟲ resets), JSON textareas for object
//               kinds, sample picker + Save-sample, and a raw-JSON fallback.
// Live edits re-render immediately. rawProps stays JSON-safe ('ƒ' markers);
// materialize() converts per-kind at render time: ƒ→no-op stub (returns null,
// so it also works as a component type), element strings→<span>, set→Set.
// Envelopes up: ready | renderError | samples | props | saveSample.
// Commands down: props | sample | reload | schema.

function esc(json) {
  return JSON.stringify(json).replace(/</g, '\\u003c')
}

export function buildIsolateHtml(cfg) {
  const routerImport = cfg.router
    ? "import { MemoryRouter as __BurrowMemoryRouter } from 'react-router-dom'"
    : ''
  const routerSetup = cfg.router
    ? "Router = (props) => h(__BurrowMemoryRouter, { initialEntries: ['/'] }, props.children)"
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
  #iso-top .name { font-weight: 600; color: #e6edf3; margin-right: 6px; }
  #iso-top .sep { width: 1px; height: 14px; background: #2b3138; margin: 0 2px; }
  .tbtn {
    border: 1px solid #2b3138; background: #1c2128; color: #c9d1d9; border-radius: 4px;
    padding: 1px 7px; font: inherit; cursor: pointer;
  }
  .tbtn:hover { background: #262c34; }
  .tbtn.on { background: #2f81f7; border-color: #2f81f7; color: #fff; }
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
    flex: none; width: 280px; overflow-y: auto; background: #15181e; color: #c9d1d9;
    border-left: 1px solid #2b3138; padding: 8px; display: flex; flex-direction: column; gap: 8px;
  }
  #iso-panel.hidden { display: none; }
  #iso-panel h3 { margin: 2px 0; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #8b949e; }
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
  <div id="iso-canvas"><div id="iso-stage"><div id="burrow-iso-root"></div></div></div>
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
let schema = Array.isArray(CFG.schema) ? CFG.schema : null
let sampleMap = {}
let renderFn = () => {}

const isFnMarker = (v) => typeof v === 'string' && /^ƒ( |$)/.test(v)
const stubFor = (name) => (...a) => { try { console.log('[burrow-iso] ' + name, ...a) } catch (e) {} return null }

// JSON-safe rawProps → runtime props, per schema kind (fallback: markers only).
const materialize = (p) => {
  const out = {}
  for (const k of Object.keys(p)) {
    const v = p[k]
    const spec = schema && schema.find((s) => s.name === k)
    const kind = spec ? spec.kind : null
    if (isFnMarker(v) || kind === 'function' || kind === 'component') out[k] = stubFor(k)
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

// ---- chrome: top bar (viewport presets, background, panel toggle) ----------
const canvas = document.getElementById('iso-canvas')
const stage = document.getElementById('iso-stage')
const panel = document.getElementById('iso-panel')
function buildTopBar(label) {
  const top = document.getElementById('iso-top')
  top.innerHTML = ''
  const presets = [['Fit', 0], ['375', 375], ['768', 768], ['1280', 1280]]
  const pbtns = presets.map(([txt, w]) => el('button', {
    class: 'tbtn' + (w === 0 ? ' on' : ''),
    onclick: (e) => {
      pbtns.forEach((b) => b.classList.remove('on')); e.target.classList.add('on')
      if (w === 0) { stage.classList.remove('frame'); stage.style.width = '' }
      else { stage.classList.add('frame'); stage.style.width = w + 'px' }
    },
  }, txt))
  const bgs = [['app', ''], ['dark', 'bg-dark'], ['▦', 'bg-checker']]
  const bbtns = bgs.map(([txt, cls]) => el('button', {
    class: 'tbtn' + (cls === '' ? ' on' : ''),
    onclick: (e) => {
      bbtns.forEach((b) => b.classList.remove('on')); e.target.classList.add('on')
      canvas.className = cls
    },
  }, txt))
  top.append(
    el('span', { class: 'name' }, label),
    el('span', { class: 'sep' }), ...pbtns,
    el('span', { class: 'sep' }), ...bbtns,
    el('span', { style: 'flex:1' }),
    el('button', { class: 'tbtn', title: 'Props panel', onclick: () => panel.classList.toggle('hidden') }, '⚙ props'),
  )
}

// ---- props panel -----------------------------------------------------------
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

function buildPanel() {
  panel.innerHTML = ''
  const sampleNames = Object.keys(sampleMap)
  if (sampleNames.length || EMBEDDED) {
    const row = el('div', { class: 'srow' })
    if (sampleNames.length) {
      const sel = el('select', {
        onchange: (e) => { const s = sampleMap[e.target.value]; if (s) { rawProps = JSON.parse(JSON.stringify(s)); buildPanel(); renderFn() } },
      }, el('option', { value: '' }, '— sample —'), ...sampleNames.map((n) => el('option', { value: n }, n)))
      row.append(sel)
    }
    if (EMBEDDED) {
      row.append(el('button', { class: 'tbtn', title: 'Persist current props as a named sample', onclick: () => report('saveSample', rawProps) }, '💾 save'))
    }
    panel.append(el('h3', null, 'Samples'), row)
  }
  panel.append(el('h3', null, 'Props'))
  if (schema) {
    for (const spec of schema) {
      const isSet = Object.prototype.hasOwnProperty.call(rawProps, spec.name)
      const row = el('div', { class: 'prow' + (!isSet && !spec.required ? ' unset' : '') })
      const label = el('label', null,
        spec.required ? el('span', { class: 'req', title: 'required' }) : null,
        spec.name,
        el('span', { class: 'tkind' }, spec.kind))
      if (!spec.required && isSet) {
        label.append(el('button', {
          class: 'reset', title: 'Reset to the component default',
          onclick: () => { delete rawProps[spec.name]; buildPanel(); renderFn() },
        }, '⟲'))
      }
      row.append(label, controlFor(spec))
      panel.append(row)
    }
  }
  // Raw JSON escape hatch — always available (and the ONLY editor when no schema).
  const raw = el('textarea', {
    title: 'All props as JSON — applies on valid parse',
    oninput: (e) => {
      try { rawProps = JSON.parse(e.target.value); e.target.classList.remove('invalid'); applySoon() }
      catch (err) { e.target.classList.add('invalid') }
    },
  })
  raw.value = JSON.stringify(rawProps, null, 1)
  panel.append(el('h3', null, 'All props (JSON)'), el('div', { class: 'prow' }, raw))
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
    }
    const sampleNames = Object.keys(sampleMap)
    if (sampleNames.length) report('samples', sampleNames)

    rawProps = (CFG.props && typeof CFG.props === 'object') ? CFG.props : {}
    const first = sampleNames.length ? sampleMap[sampleNames[0]] : null
    if (!Object.keys(rawProps).length && first && typeof first === 'object') rawProps = JSON.parse(JSON.stringify(first))

    const label = CFG.export || (CFG.module.split('/').pop() || '').replace(/\\.[jt]sx?$/, '')
    buildTopBar(label)
    buildPanel()
    panel.classList.remove('hidden')

    const root = createRoot(document.getElementById('burrow-iso-root'))
    renderFn = () => {
      root.render(h(Boundary, { key: JSON.stringify(rawProps) }, h(Router, null, h(Providers, null, h(Comp, materialize(rawProps))))))
      report('props', rawProps)
    }
    renderFn()
    report('ready', label)

    window.addEventListener('message', (e) => {
      const d = e.data
      if (!d || d.__burrowIsoCmd !== 1) return
      if (d.type === 'props') { rawProps = (d.props && typeof d.props === 'object') ? d.props : {}; buildPanel(); renderFn() }
      else if (d.type === 'sample') { const s = sampleMap[d.name]; if (s && typeof s === 'object') { rawProps = JSON.parse(JSON.stringify(s)); buildPanel(); renderFn() } }
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
