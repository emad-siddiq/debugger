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
// Vite plugin injected into the *target* dev server.
//   - transformIndexHtml: inject the in-page inspection agent as the first
//     <head> script so it installs the React DevTools hook before React loads.
//   - transform: run the stamping Babel plugin on the target's .tsx/.jsx.
// ---------------------------------------------------------------------------
export function inspectorPlugin({ frontendDir, agentCode, uiOrigin }) {
  return {
    name: 'fedbg-inspector',
    enforce: 'pre',
    transformIndexHtml: {
      order: 'pre',
      handler() {
        // Inject config + agent as a single classic script prepended into
        // <head>, so it installs the React hook before the deferred module
        // script runs. Use Vite's tag form (children inserted literally) — NOT
        // string .replace(), whose replacement interprets the agent's `$`
        // sequences (e.g. `__reactFiber$`, `$$typeof`) and corrupts the script.
        const children =
          `window.__FEDBG__=${JSON.stringify({ uiOrigin })};\n` + agentCode
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
