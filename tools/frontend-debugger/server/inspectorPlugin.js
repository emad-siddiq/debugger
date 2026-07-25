import fs from 'node:fs'
import path from 'node:path'
import babel from '@babel/core'
import { buildIsolateHtml } from './isolateHarness.js'
import { locateProdCss } from './prodCss.js'

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
// graph + HMR), at `<base>__isolate?module=<src/…>&export=&props=&schema=`.
// It mounts ONE component alone on an interactive canvas (viewport presets,
// backgrounds, a typed live props panel driven by `schema`), wrapped in a
// minimal generic provider shell: a MemoryRouter if react-router-dom is
// present, plus an OPTIONAL per-project providers module (`src/burrow.isolate.tsx`)
// for app-specific context. The target's global stylesheet is imported if found.
// Editing the component's source → Vite Fast Refresh → live re-render.
// The page itself lives in ./isolateHarness.js (buildIsolateHtml) — envelopes
// up: ready | renderError | samples | props | saveSample | reveal | isolate;
// commands down: props | sample | reload | schema. String values matching
// `ƒ` / `ƒ <name>` are function markers, rendered as no-op stubs at render
// time. `reveal`/`isolate` come from the harness's 🎯 Inspect mode (hover a
// stamped part → click reveals its JSX+CSS; Alt-click enters a child).
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
        // The extension's parsed props schema (typed control specs) — drives
        // the harness's interactive props panel. Optional: the standalone SPA
        // builds isolate URLs without it (raw-JSON editor still works).
        let schema = null
        const rawSchema = q.get('schema')
        if (rawSchema) {
          try {
            const parsed = JSON.parse(rawSchema)
            if (Array.isArray(parsed)) schema = parsed
          } catch {
            schema = null
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
          schema,
          // Where `props` came from, for the harness's provenance chip:
          // 'capture' (lifted off the running app) or 'synth' (the extension
          // synthesized them from the types). Absent → the harness works it
          // out from its own rungs (samples ▸ SAMPLE_PROPS ▸ empty).
          propsSource: ['capture', 'synth'].includes(q.get('propsSource')) ? q.get('propsSource') : null,
          providers,
          // Emit the harness's own MemoryRouter only for a router app with no
          // providers shell — a shell owns its Router (avoid nesting two).
          router: !providers && targetHasDep(frontendDir, 'react-router-dom'),
          // Colocated `<Component>.samples.*` (Framer-mode T4): named prop-sets
          // the native picker applies, and — with no seeded props — the first
          // one is the default render.
          samples: firstExisting(frontendDir, sampleCandidates(moduleRel)),
          // The BUILT stylesheet, for the harness's prod-css toggle. Probed
          // here (server-side) and served by the target's own Vite from the
          // project root, so the harness needs no cross-origin call to the
          // sidecar API. Absent when the target has never been built.
          prodCss: locateProdCss(frontendDir),
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
