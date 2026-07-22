import fs from 'node:fs'
import path from 'node:path'
import babel from '@babel/core'

// ---------------------------------------------------------------------------
// Babel plugin: stamp every host JSX element with its source coordinates.
//
// React 19 removed fiber._debugSource, so we cannot recover the file/line a
// rendered element came from at runtime. Instead we stamp the information onto
// the DOM at build time as data-inspect-* attributes. This runs BEFORE the
// target's own React transform (enforce: 'pre' on the Vite plugin) so it sees
// raw TSX; we only add attributes — we do NOT strip types or transform JSX,
// leaving the real transform to the target's @vitejs/plugin-react.
// ---------------------------------------------------------------------------
function stampBabelPlugin({ rel }) {
  return function ({ types: t }) {
    return {
      name: 'fedbg-stamp',
      visitor: {
        JSXOpeningElement(p) {
          const name = p.node.name
          if (!name || name.type !== 'JSXIdentifier') return
          // Host elements only (lowercase tag). Component elements (Capitalized)
          // don't render their own DOM node, so stamping them is meaningless.
          if (!/^[a-z]/.test(name.name)) return
          const loc = p.node.loc
          if (!loc) return
          const attrs = p.node.attributes
          if (
            attrs.some(
              (a) =>
                a.type === 'JSXAttribute' &&
                a.name &&
                a.name.name === 'data-inspect-line',
            )
          )
            return
          const comp = enclosingComponentName(p)
          const add = (k, v) =>
            attrs.push(
              t.jsxAttribute(t.jsxIdentifier(k), t.stringLiteral(String(v))),
            )
          add('data-inspect-file', rel)
          add('data-inspect-line', loc.start.line)
          add('data-inspect-col', loc.start.column + 1)
          if (comp) add('data-inspect-name', comp)
        },
      },
    }
  }
}

// Walk up from a JSX element to the nearest enclosing component name (a function
// whose name is Capitalized, or that is assigned to a Capitalized const).
function enclosingComponentName(p) {
  let fn = p.getFunctionParent()
  while (fn) {
    if (fn.node.id && /^[A-Z]/.test(fn.node.id.name)) return fn.node.id.name
    const parent = fn.parentPath
    if (
      parent &&
      parent.isVariableDeclarator() &&
      parent.node.id &&
      parent.node.id.name &&
      /^[A-Z]/.test(parent.node.id.name)
    )
      return parent.node.id.name
    fn = fn.getFunctionParent()
  }
  return null
}

// ---------------------------------------------------------------------------
// Component isolation harness (the Framer-like workbench).
//
// Served BY the target's own Vite dev server (so it shares the target module
// graph + HMR), at `<base>__isolate?module=<src/…>&export=<Name>&props=<json>`.
// It mounts ONE component alone on a blank canvas, wrapped in a minimal,
// generic provider shell: a MemoryRouter if react-router-dom is present, plus
// an OPTIONAL per-project providers module (`src/burrow.isolate.tsx`, default
// export a `({children}) => …` wrapper) for app-specific context (Toast, theme,
// query client, …). The target's global stylesheet is imported if found so the
// component inherits base tokens. Editing the component's source → Vite Fast
// Refresh → the isolated preview re-renders. Props update live over postMessage
// (`{__burrowIsoCmd:1,type:'props',props}`); render errors are reported to the
// embedding webview (`{__burrowIso:1,type:'renderError'|'ready'}`).
// ---------------------------------------------------------------------------

const ISOLATE_SUFFIX = '__isolate'

// Confine an isolate `module`/providers path to the target's src/ — mirrors
// server/api.js safe(): no absolutes, no `..` escapes, must live under src/.
function safeSrcRel(rel) {
  if (!rel || typeof rel !== 'string') return null
  const norm = rel.replace(/\\/g, '/')
  if (norm.startsWith('/') || norm.split('/').includes('..')) return null
  if (norm !== 'src' && !norm.startsWith('src/')) return null
  return norm
}

// The first project stylesheet / providers module that exists, as a src-rel
// path the harness can `import(BASE + rel)`. Returns null when none is present.
function firstExisting(frontendDir, candidates) {
  for (const rel of candidates) {
    if (fs.existsSync(path.join(frontendDir, rel))) return rel
  }
  return null
}

// Colocated sample prop-sets for a component: `<Component>.samples.{ts,tsx,js,jsx}`
// beside its module (Framer-mode T4). Strips the module's own extension, then
// tries each samples extension in turn — src-rel paths the harness imports.
function sampleCandidates(moduleRel) {
  const slash = moduleRel.lastIndexOf('/')
  const dot = moduleRel.lastIndexOf('.')
  const stem = dot > slash ? moduleRel.slice(0, dot) : moduleRel
  return ['ts', 'tsx', 'js', 'jsx'].map((ext) => `${stem}.samples.${ext}`)
}

// Whether the target declares a dependency (prod or dev). Read from the target's
// package.json rather than probing node_modules — in the merged docker setup the
// target's deps live at a shared volume, not under <frontendDir>/node_modules, so
// an existsSync probe would miss them.
function targetHasDep(frontendDir, dep) {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(frontendDir, 'package.json'), 'utf8'),
    )
    return !!(
      (pkg.dependencies && pkg.dependencies[dep]) ||
      (pkg.devDependencies && pkg.devDependencies[dep])
    )
  } catch {
    return false
  }
}

function buildIsolateHtml(cfg) {
  // Escape </script> and `<` so the config JSON can't break out of the tag.
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c')
  // Generic Router (FIX 2 / Defect A). When the target ships react-router-dom AND
  // no providers module supplies its own Router (cfg.router, computed
  // server-side), emit a STATIC `react-router-dom` import here. transformIndexHtml
  // runs this doc through Vite, which rewrites that bare specifier to the SAME
  // optimized dep the component imports — so the harness's MemoryRouter and the
  // component share one react-router instance (matching context). A *runtime*
  // `import('react-router-dom')` cannot: with @vite-ignore the bare specifier
  // reaches the browser verbatim and never resolves, which is why useNavigate was
  // left uncontexted. When a providers module IS present it owns the Router, so we
  // stay a passthrough here and never nest two routers.
  const routerImport = cfg.router
    ? `import { MemoryRouter as __BurrowMemoryRouter } from 'react-router-dom'`
    : ''
  const routerSetup = cfg.router
    ? `Router = (props) => h(__BurrowMemoryRouter, { initialEntries: ['/'] }, props.children)`
    : ''
  // The harness is a classic-looking inline module script; Vite's
  // transformIndexHtml rewrites its bare imports (react, react-dom, the router
  // import above, the dynamic component import) into dev URLs and injects the
  // HMR client.
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Burrow — Component Isolation</title>
<style>
  html, body, #burrow-iso-root { margin: 0; min-height: 100%; }
  body { background: #ffffff; color: #111111; font: 13px/1.5 system-ui, sans-serif; }
  #burrow-iso-root { box-sizing: border-box; padding: 16px; }
  .burrow-iso-error {
    margin: 12px; padding: 12px 14px; border-radius: 8px;
    background: #2b0f12; color: #ffd7d7; border: 1px solid #7f1d1d;
    font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    white-space: pre-wrap; word-break: break-word;
  }
</style>
<script>window.__BURROW_ISOLATE__ = ${json};</script>
</head>
<body>
<div id="burrow-iso-root"></div>
<script type="module">
import { createElement as h, Component } from 'react'
import { createRoot } from 'react-dom/client'
${routerImport}

const CFG = window.__BURROW_ISOLATE__
const BASE = import.meta.env.BASE_URL

const report = (type, detail) => { try { parent.postMessage({ __burrowIso: 1, type, detail }, '*') } catch (e) {} }
const loadOptional = async (spec) => { try { return await import(/* @vite-ignore */ spec) } catch (e) { return null } }

class Boundary extends Component {
  constructor(p) { super(p); this.state = { err: null } }
  static getDerivedStateFromError(err) { return { err } }
  componentDidCatch(err) { report('renderError', String((err && err.stack) || err)) }
  render() {
    if (this.state.err) return h('pre', { className: 'burrow-iso-error' }, String((this.state.err && this.state.err.stack) || this.state.err))
    return this.props.children
  }
}

const pickExport = (mod, name) => {
  if (name && typeof mod[name] === 'function') return mod[name]
  if (typeof mod.default === 'function') return mod.default
  for (const k of Object.keys(mod)) { if (/^[A-Z]/.test(k) && typeof mod[k] === 'function') return mod[k] }
  return null
}
const showError = (msg) => {
  const el = document.getElementById('burrow-iso-root')
  el.innerHTML = ''
  const pre = document.createElement('pre')
  pre.className = 'burrow-iso-error'
  pre.textContent = msg
  el.appendChild(pre)
}

;(async () => {
  try {
    // Generic Router — a MemoryRouter when the target ships react-router-dom and
    // no providers module owns one (see routerImport/routerSetup above); a
    // passthrough otherwise.
    let Router = (props) => props.children
    ${routerSetup}

    // Optional per-project providers (Toast, theme, query client, …).
    let Providers = (props) => props.children
    if (CFG.providers) {
      const pm = await loadOptional(BASE + CFG.providers)
      const P = pm && (pm.default || pm.Providers)
      if (P) Providers = (props) => h(P, null, props.children)
    }
    // Base stylesheet so the component inherits the app's design tokens.
    if (CFG.css) await loadOptional(BASE + CFG.css)

    const mod = await import(/* @vite-ignore */ BASE + CFG.module)
    const Comp = pickExport(mod, CFG.export)
    if (!Comp) { report('renderError', 'no component export in ' + CFG.module); showError('No component export found in ' + CFG.module + (CFG.export ? ' (looked for "' + CFG.export + '")' : '')); return }

    // Colocated sample prop-sets (Component.samples -> a name:props map, via a
    // samples named export or the default). Names go up to the native picker;
    // a chosen sample is applied live via {__burrowIsoCmd:1,type:'sample',name}.
    let sampleMap = {}
    if (CFG.samples) {
      const sm = await loadOptional(BASE + CFG.samples)
      const raw = sm && (sm.samples || sm.default)
      if (raw && typeof raw === 'object') sampleMap = raw
    }
    const sampleNames = Object.keys(sampleMap)
    if (sampleNames.length) report('samples', sampleNames)

    // Seeded props win; otherwise the first sample is the default render so a
    // prop-driven component shows something instead of an empty/crashing mount.
    let props = (CFG.props && typeof CFG.props === 'object') ? CFG.props : {}
    const first = sampleNames.length ? sampleMap[sampleNames[0]] : null
    if (!Object.keys(props).length && first && typeof first === 'object') props = first
    const root = createRoot(document.getElementById('burrow-iso-root'))
    const render = () => root.render(h(Boundary, { key: JSON.stringify(props) }, h(Router, null, h(Providers, null, h(Comp, props)))))
    render()
    report('ready', CFG.export || (typeof mod.default === 'function' ? (mod.default.displayName || mod.default.name || 'default') : 'component'))

    window.addEventListener('message', (e) => {
      const d = e.data
      if (!d || d.__burrowIsoCmd !== 1) return
      if (d.type === 'props') { props = (d.props && typeof d.props === 'object') ? d.props : {}; render() }
      else if (d.type === 'sample') { const s = sampleMap[d.name]; if (s && typeof s === 'object') { props = s; render() } }
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

// ---------------------------------------------------------------------------
// Vite plugin injected into the *target* dev server.
//   - transformIndexHtml: inject the in-page inspection agent as the first
//     <head> script so it installs the React DevTools hook before React loads.
//   - transform: run the stamping Babel plugin on the target's .tsx/.jsx.
//   - configureServer: serve the component-isolation harness at `<base>__isolate`.
// ---------------------------------------------------------------------------
export function inspectorPlugin({
  frontendDir,
  agentCode,
  uiOrigin,
  base = '/',
  // Browser model (Framer-mode T2): when the instrumented app is opened in the
  // REAL browser (not the FD SPA iframe), the agent has no parent webview to
  // postMessage — it POSTs picks to this local reveal-bridge instead, so
  // ⌥-clicking a component in the browser opens its source in Burrow. A fixed
  // loopback port (no env injection into the user's command); the extension
  // hosts the bridge on the same port.
  bridgeUrl = 'http://127.0.0.1:6099',
}) {
  const isolatePath = (base.endsWith('/') ? base : base + '/') + ISOLATE_SUFFIX
  return {
    name: 'fedbg-inspector',
    enforce: 'pre',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url || ''
        const [pathname, search] = url.split('?')
        if (pathname !== isolatePath) return next()
        const q = new URLSearchParams(search || '')
        const moduleRel = safeSrcRel(q.get('module'))
        if (!moduleRel) {
          res.statusCode = 400
          res.setHeader('Content-Type', 'text/plain')
          res.end('isolate: module must be a path under src/')
          return
        }
        let props = null
        const rawProps = q.get('props')
        if (rawProps) {
          try {
            const parsed = JSON.parse(rawProps)
            if (parsed && typeof parsed === 'object') props = parsed
          } catch {
            props = null // malformed seed → start with empty props
          }
        }
        const providers = firstExisting(frontendDir, [
          'src/burrow.isolate.tsx',
          'src/burrow.isolate.jsx',
          'src/burrow.isolate.ts',
          'src/burrow.isolate.js',
        ])
        const cfg = {
          base: isolatePath.slice(0, -ISOLATE_SUFFIX.length),
          module: moduleRel,
          export: q.get('export') || '',
          props,
          providers,
          // Emit the harness's own MemoryRouter only for a router app with no
          // providers shell — a shell owns its Router (avoid nesting two).
          router: !providers && targetHasDep(frontendDir, 'react-router-dom'),
          // Colocated `<Component>.samples.*` (Framer-mode T4): named prop-sets
          // the native picker applies, and — with no seeded props — the first
          // one is the default render.
          samples: firstExisting(frontendDir, sampleCandidates(moduleRel)),
          css: firstExisting(frontendDir, [
            'src/index.css',
            'src/main.css',
            'src/styles.css',
            'src/App.css',
            'src/global.css',
          ]),
        }
        try {
          // transformIndexHtml rewrites the harness's bare imports to dev URLs
          // and injects the Vite HMR client (base-aware) — same pipeline as the
          // target's own index.html.
          const html = await server.transformIndexHtml(url, buildIsolateHtml(cfg))
          res.statusCode = 200
          res.setHeader('Content-Type', 'text/html')
          res.setHeader('Cache-Control', 'no-store')
          res.end(html)
        } catch (err) {
          res.statusCode = 500
          res.setHeader('Content-Type', 'text/plain')
          res.end('isolate: ' + String((err && err.message) || err))
        }
      })
    },
    transformIndexHtml: {
      order: 'pre',
      handler() {
        // Inject config + agent as a single classic script prepended into
        // <head>, so it installs the React hook before the deferred module
        // script runs. Use Vite's tag form (children inserted literally) — NOT
        // string .replace(), whose replacement interprets the agent's `$`
        // sequences (e.g. `__reactFiber$`, `$$typeof`) and corrupts the script.
        const children =
          `window.__FEDBG__=${JSON.stringify({ uiOrigin })};\n` +
          `window.__BURROW_BRIDGE__=${JSON.stringify(bridgeUrl)};\n` +
          agentCode
        return [
          {
            tag: 'script',
            attrs: { type: 'text/javascript' },
            injectTo: 'head-prepend',
            children,
          },
        ]
      },
    },
    transform(code, id) {
      const clean = id.split('?')[0]
      if (!/\.[jt]sx$/.test(clean)) return null
      if (clean.includes('node_modules')) return null
      let rel = path.relative(frontendDir, clean).split(path.sep).join('/')
      if (rel.startsWith('..')) rel = clean // file outside frontend root (e.g. @shared)
      try {
        const out = babel.transformSync(code, {
          filename: clean,
          babelrc: false,
          configFile: false,
          ast: false,
          code: true,
          sourceMaps: true,
          parserOpts: {
            plugins: [
              'typescript',
              'jsx',
              'decorators-legacy',
              'importMeta',
              'topLevelAwait',
              'classProperties',
              'classPrivateProperties',
              'dynamicImport',
            ],
          },
          plugins: [stampBabelPlugin({ rel })],
        })
        if (!out || !out.code) return null
        return { code: out.code, map: out.map }
      } catch (err) {
        // Never break the target build over a stamping failure — that file just
        // won't have data-inspect-* attributes.
        return null
      }
    },
  }
}
