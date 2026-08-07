import babel from '@babel/core'

// ---------------------------------------------------------------------------
// Surgical JSX edits. Parse with babel (already a dependency, used by the
// stamping plugin), locate ONE JSXOpeningElement, and apply the edit by string
// slicing on the original source — never reprinting the file, so formatting
// everywhere else is untouched. Anything ambiguous or dynamic returns
// { ok:false, reason } so the UI can degrade to "open in source" instead of
// guessing.
//
// Locators:
//   { line, col }   exact — the stamped data-inspect-line/col of a host element
//                   (col is 1-based, i.e. loc.start.column + 1, see
//                   inspectorPlugin.js stampBabelPlugin)
//   { component }   by name — for editing the <Component …> call site in its
//                   owner's file; refuses when more than one usage matches.
// ---------------------------------------------------------------------------

function parse(code, filename) {
  return babel.parseSync(code, {
    filename,
    configFile: false,
    babelrc: false,
    parserOpts: { sourceType: 'module', plugins: ['jsx', 'typescript'] },
  })
}

// Minimal AST walker (no @babel/traverse): visit every node with its parent.
function walk(node, parent, visit) {
  if (!node || typeof node.type !== 'string') return
  visit(node, parent)
  for (const key of Object.keys(node)) {
    if (key === 'loc') continue
    const v = node[key]
    if (Array.isArray(v)) {
      for (const c of v) if (c && typeof c.type === 'string') walk(c, node, visit)
    } else if (v && typeof v.type === 'string') {
      walk(v, node, visit)
    }
  }
}

function findOpenings(ast, locator) {
  const hits = []
  walk(ast.program, null, (node, parent) => {
    if (node.type !== 'JSXOpeningElement') return
    if (locator.line != null) {
      const loc = node.loc
      if (loc && loc.start.line === locator.line && loc.start.column === locator.col - 1)
        hits.push({ open: node, parent })
    } else if (
      locator.component &&
      node.name &&
      node.name.type === 'JSXIdentifier' &&
      node.name.name === locator.component
    ) {
      hits.push({ open: node, parent })
    }
  })
  return hits
}

// Render `name=<value>` picking the safest syntax for the value kind.
function attrText(name, value, kind) {
  if (kind === 'expression') return `${name}={${value}}`
  if (kind === 'number' || kind === 'boolean') return `${name}={${value}}`
  const s = String(value)
  if (s.includes('"') && s.includes("'")) return `${name}={${JSON.stringify(s)}}`
  const q = s.includes('"') ? "'" : '"'
  return `${name}=${q}${s}${q}`
}

export function applyJsxEdit(code, filename, op) {
  let ast
  try {
    ast = parse(code, filename)
  } catch (e) {
    return { ok: false, reason: 'parse failed: ' + (e.message || e) }
  }
  const hits = findOpenings(ast, op)
  if (!hits.length)
    return {
      ok: false,
      reason: op.component
        ? `no <${op.component}> call site found in this file`
        : `no JSX element at ${op.line}:${op.col}`,
    }
  if (hits.length > 1)
    return {
      ok: false,
      reason: `ambiguous: ${hits.length} <${op.component}> call sites — edit the source directly`,
      candidates: hits.map((h) => ({
        line: h.open.loc.start.line,
        col: h.open.loc.start.column + 1,
      })),
    }
  const { open, parent } = hits[0]

  if (op.op === 'setAttribute' || op.op === 'removeAttribute') {
    const attrs = open.attributes
    const idx = attrs.findIndex(
      (a) => a.type === 'JSXAttribute' && a.name && a.name.name === op.name,
    )
    const attr = idx >= 0 ? attrs[idx] : null

    if (op.op === 'removeAttribute') {
      if (!attr) return { ok: false, reason: 'attribute not present: ' + op.name }
      const prevEnd = idx > 0 ? attrs[idx - 1].end : open.name.end
      return { ok: true, code: code.slice(0, prevEnd) + code.slice(attr.end) }
    }

    const text = attrText(op.name, op.value, op.kind || 'string')
    if (attr) {
      // Replace the whole attribute (covers boolean shorthand + any value form).
      return { ok: true, code: code.slice(0, attr.start) + text + code.slice(attr.end) }
    }
    // Adding a new attribute under a spread is unsafe — the spread may override
    // it (or be overridden) in a way the author didn't intend. Refuse politely.
    if (attrs.some((a) => a.type === 'JSXSpreadAttribute'))
      return { ok: false, reason: 'element spreads props ({...}) — edit the source directly' }
    const insertAt = attrs.length ? attrs[attrs.length - 1].end : open.name.end
    return { ok: true, code: code.slice(0, insertAt) + ' ' + text + code.slice(insertAt) }
  }

  if (op.op === 'setText') {
    const el = parent && parent.type === 'JSXElement' ? parent : null
    if (!el || !el.closingElement)
      return { ok: false, reason: 'not a text-bearing element (self-closing)' }
    const meaningful = el.children.filter(
      (k) => !(k.type === 'JSXText' && !k.value.trim()),
    )
    const plainText =
      meaningful.length === 0 || (meaningful.length === 1 && meaningful[0].type === 'JSXText')
    if (!plainText)
      return { ok: false, reason: 'children are not plain text — edit the source directly' }
    if (/[<>{}]/.test(op.text))
      return { ok: false, reason: 'text contains JSX-significant characters — edit the source directly' }
    return {
      ok: true,
      code: code.slice(0, el.openingElement.end) + op.text + code.slice(el.closingElement.start),
    }
  }

  return { ok: false, reason: 'unknown op: ' + op.op }
}
