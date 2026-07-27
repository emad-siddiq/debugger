// Conditional STATES: the branches a component renders, read out of its own
// source, so the isolation harness can offer each one as a single click.
//
// A React component almost never has one appearance. It has `if (loading)
// return <Skeleton/>`, `{error && <Error/>}`, `items.length === 0 ? <Empty/> :
// <List/>` — and the props panel can only reach those by you knowing which prop
// to flip and to what. This module finds the branches and, where the condition
// is driven by a PROP, works out the props patch that takes you into it.
//
// Honest about its limits, which is the point: a condition on internal
// `useState` or on a value derived inside the component is LISTED with the
// reason it cannot be driven, rather than omitted (so you still learn the branch
// exists) or faked (so you never see a click that does nothing).
//
// Parsed, not regex-matched: @babel/core is already a dependency of this server
// for the inspector's JSX stamping, and conditions are expressions — the one
// place a regex is guaranteed to be wrong eventually.

import babel from '@babel/core'

const PARSER_PLUGINS = [
  'typescript',
  'jsx',
  'decorators-legacy',
  'importMeta',
  'topLevelAwait',
  'classProperties',
  'classPrivateProperties',
  'dynamicImport',
]

const MAX_STATES = 24 // a component with more branches than this has a bigger problem
const MAX_COND = 90 // characters of condition text kept for the chip

/** Prose for a value we are about to invent, per prop kind. Deliberately
 *  boring: the state is there to show a BRANCH, and a clever placeholder
 *  competes with the branch for attention. */
function truthyFor(kind) {
  switch (kind) {
    case 'string': return 'Yes'
    case 'number': return 1
    case 'boolean': return true
    case 'object': case 'json': return {}
    default: return true
  }
}

function falsyFor(kind) {
  switch (kind) {
    case 'string': return ''
    case 'number': return 0
    case 'array': case 'set': return []
    case 'boolean': return false
    default: return false
  }
}

// An error-shaped prop wants a message, not `true` — the component almost
// certainly renders it, and "true" on screen looks like a bug in the harness.
function truthyForName(name, kind) {
  // A handler set to `true` renders fine and then throws the moment anything
  // calls it. The harness materializes the 'ƒ' marker into a no-op stub, which
  // is what a present-but-inert callback has to be. onX is React's own
  // convention, so it stands in for a kind we may not have been given.
  if (kind === 'function' || (!kind && /^on[A-Z]/.test(name))) return 'ƒ'
  if (kind === 'component' || kind === 'element') return 'ƒ'
  if (kind === 'string' || !kind) {
    if (/error|message|reason|warning/i.test(name)) return 'Something went wrong'
    if (/name|title|label|heading/i.test(name)) return 'Example'
  }
  return truthyFor(kind)
}

/** The component's own name for a JSX element, for the "renders" line. */
function jsxName(node) {
  if (!node) return null
  if (node.type === 'JSXFragment') return 'a fragment'
  if (node.type !== 'JSXElement') return null
  const n = node.openingElement && node.openingElement.name
  if (!n) return null
  if (n.type === 'JSXIdentifier') return '<' + n.name + '>'
  if (n.type === 'JSXMemberExpression' && n.property) return '<' + n.property.name + '>'
  return 'an element'
}

/** What the branch puts on screen, in three words. */
function describes(node) {
  if (!node) return 'nothing'
  if (node.type === 'NullLiteral' || (node.type === 'Literal' && node.value === null)) return 'nothing'
  if (node.type === 'Identifier' && node.name === 'null') return 'nothing'
  const name = jsxName(node)
  if (name) return name
  if (node.type === 'BlockStatement' || node.type === 'ReturnStatement') return 'an early return'
  return 'a different tree'
}

function unwrap(node) {
  let n = node
  while (n && (n.type === 'TSAsExpression' || n.type === 'TSNonNullExpression' || n.type === 'ParenthesizedExpression')) {
    n = n.expression
  }
  return n
}

function literalValue(node) {
  const n = unwrap(node)
  if (!n) return undefined
  if (n.type === 'StringLiteral' || n.type === 'NumericLiteral' || n.type === 'BooleanLiteral') return n.value
  if (n.type === 'NullLiteral') return null
  if (n.type === 'UnaryExpression' && n.operator === '-' && n.argument.type === 'NumericLiteral') return -n.argument.value
  return undefined
}

const isLiteral = (node) => literalValue(node) !== undefined || (unwrap(node) || {}).type === 'NullLiteral'

/** `x.length` (or `x?.length`) → 'x'. Anything else → null. */
function lengthOf(node) {
  const n = unwrap(node)
  if (!n) return null
  if (n.type !== 'MemberExpression' && n.type !== 'OptionalMemberExpression') return null
  if (!n.property || n.property.name !== 'length') return null
  const obj = unwrap(n.object)
  return obj && obj.type === 'Identifier' ? obj.name : null
}

/** A prop-rooted path: `liveness.mode` → ['liveness','mode'], `x` → ['x'].
 *  Two segments is the ceiling — deeper and the value we would have to invent
 *  stops resembling anything the component was written for. */
function pathOf(node, world) {
  const n = unwrap(node)
  if (!n) return null
  if (n.type === 'Identifier') return world.props.has(n.name) ? [n.name] : null
  if (n.type !== 'MemberExpression' && n.type !== 'OptionalMemberExpression') return null
  if (n.computed || !n.property || !n.property.name) return null
  const base = unwrap(n.object)
  if (!base || base.type !== 'Identifier') return null
  // `function Card(props) { … props.tone … }` — the parameter was never
  // destructured, so `props` is not a prop NAME. The path is still one deep.
  if (world.propsParam.has(base.name)) return [n.property.name]
  if (!world.props.has(base.name)) return null
  return [base.name, n.property.name]
}

/**
 * A name that is not a prop may still be reachable: a local `const` whose
 * initializer is written in terms of props, or a `useState` seeded from one.
 *
 * This is where most of the "can't set" used to come from. Components rarely
 * branch on a raw prop — they compute `const isEmpty = !rows?.length` first and
 * branch on that, and refusing to look one hop further declared two thirds of
 * every real component undrivable. Resolving the initializer costs one
 * recursion and turns those into ordinary prop patches.
 *
 * `useState(x)` is honest but partial, and the caller labels it as such: setting
 * the prop decides what the component renders with on FIRST paint. Anything the
 * component does to that state afterwards is beyond the harness.
 */
function resolveName(name, world) {
  if (world.resolving.has(name)) return null // `const a = b, b = a` — give up, do not hang
  const init = world.localInit.get(name) || world.stateInit.get(name)
  if (!init) return null
  world.resolving.add(name)
  try {
    const patch = patchFor(init, world)
    return patch.blocked ? null : patch
  } finally {
    world.resolving.delete(name)
  }
}

const op = (path, value) => ({ ops: [{ path, value }], unset: [] })

/**
 * The heart of it: an AST condition → the props patch that makes it true, or a
 * reason it cannot be driven from props. `world` carries what we know about the
 * names in scope (which are props, which are useState, each prop's kind).
 *
 * Returns { ops, unset } | { blocked: '<reason>' }. An op is a path + a value,
 * so `liveness.mode === 'none'` can be driven without flattening the rest of
 * the object the component also reads.
 */
function patchFor(node, world) {
  const n = unwrap(node)
  if (!n) return { blocked: 'unreadable condition' }
  const kindAt = (path) => (path.length === 1 && world.kinds[path[0]] !== undefined ? world.kinds[path[0]] : null)
  const why = (name) => {
    if (world.state.has(name)) {
      return world.stateInit.has(name)
        ? 'useState seeded by something the harness cannot set'
        : 'internal state (useState) — flip it in the component, not from props'
    }
    if (world.locals.has(name)) return 'computed inside the component from values no prop reaches'
    return 'not one of this component\'s props'
  }
  const nameOf = (node2) => {
    const u = unwrap(node2)
    if (!u) return 'this value'
    if (u.type === 'Identifier') return u.name
    if ((u.type === 'MemberExpression' || u.type === 'OptionalMemberExpression') && u.object && unwrap(u.object).name) {
      return unwrap(u.object).name
    }
    return 'this value'
  }

  switch (n.type) {
    case 'Identifier':
    case 'MemberExpression':
    case 'OptionalMemberExpression': {
      const arr = lengthOf(n)
      if (arr) {
        if (!world.props.has(arr)) return { blocked: why(arr) }
        return { blocked: 'a non-empty ' + arr + ' needs realistic items — set it in Props' }
      }
      const path = pathOf(n, world)
      if (!path) {
        const via = n.type === 'Identifier' ? resolveName(n.name, world) : null
        return via || { blocked: why(nameOf(n)) }
      }
      const last = path[path.length - 1]
      return op(path, truthyForName(last, kindAt(path)))
    }
    case 'UnaryExpression': {
      if (n.operator !== '!') return { blocked: 'unsupported operator ' + n.operator }
      return invert(n.argument, world)
    }
    case 'LogicalExpression': {
      // `a && b` needs both; `a || b` needs either, so drive the first one that
      // can be driven rather than inventing a value for both.
      const left = patchFor(n.left, world)
      const right = patchFor(n.right, world)
      if (n.operator === '||') {
        if (!left.blocked) return left
        if (!right.blocked) return right
        return left
      }
      if (left.blocked) return left
      if (right.blocked) return right
      return { ops: [...left.ops, ...right.ops], unset: [...left.unset, ...right.unset] }
    }
    case 'BinaryExpression': {
      const { operator, left, right } = n
      const litRight = isLiteral(right)
      if (!litRight && !isLiteral(left)) {
        return { blocked: 'a comparison between two values, neither of them a literal' }
      }
      const lit = literalValue(litRight ? right : left)
      const other = litRight ? left : right
      // Comparisons read left-to-right; with the literal on the LEFT the
      // inequality flips, or `0 < items.length` would empty the list.
      const flip = { '>': '<', '<': '>', '>=': '<=', '<=': '>=' }
      const cmp = litRight ? operator : (flip[operator] || operator)
      const arr = lengthOf(other)
      if (arr) {
        if (!world.props.has(arr)) return { blocked: why(arr) }
        const empty = op([arr], [])
        const needsItems = { blocked: 'a non-empty ' + arr + ' needs realistic items — set it in Props' }
        if ((cmp === '===' || cmp === '==') && lit === 0) return empty
        if (cmp === '<' && lit === 1) return empty
        if (cmp === '<=' && lit === 0) return empty
        return needsItems
      }
      const path = pathOf(other, world)
      if (!path) {
        // `const status = data?.state` then `status === 'error'`: resolve the
        // name and re-run the comparison against what it actually stands for.
        const u = unwrap(other)
        const init = u && u.type === 'Identifier' && !world.resolving.has(u.name)
          ? (world.localInit.get(u.name) || world.stateInit.get(u.name))
          : null
        if (init) {
          world.resolving.add(u.name)
          try {
            const again = patchFor({ ...n, [litRight ? 'left' : 'right']: init }, world)
            if (!again.blocked) return again
          } finally {
            world.resolving.delete(u.name)
          }
        }
        return { blocked: why(nameOf(other)) }
      }
      const kind = kindAt(path)
      if (cmp === '===' || cmp === '==') {
        if (lit === null) return { ops: [], unset: [path] }
        return op(path, lit)
      }
      if (cmp === '!==' || cmp === '!=') {
        if (lit === null) return op(path, truthyForName(path[path.length - 1], kind))
        if (typeof lit === 'boolean') return op(path, !lit)
        return { blocked: 'anything-but-' + JSON.stringify(lit) + ' — pick a value in Props' }
      }
      // Numeric thresholds: pick the smallest value on the true side, so a
      // "busy" branch shows at its boundary rather than at some invented peak.
      if (typeof lit === 'number') {
        if (cmp === '>') return op(path, lit + 1)
        if (cmp === '>=') return op(path, lit)
        if (cmp === '<') return op(path, lit - 1)
        if (cmp === '<=') return op(path, lit)
      }
      return { blocked: 'unsupported comparison ' + operator }
    }
    default:
      return { blocked: 'a condition the harness cannot invert (' + n.type + ')' }
  }
}

/** The patch that makes `node` FALSE. */
function invert(node, world) {
  const n = unwrap(node)
  const arr = lengthOf(n)
  if (arr) {
    if (!world.props.has(arr)) return patchFor(n, world)
    return op([arr], []) // !items.length — the empty list IS the branch
  }
  const path = pathOf(n, world)
  if (path) {
    const kind = path.length === 1 && world.kinds[path[0]] !== undefined ? world.kinds[path[0]] : null
    // A falsy value that is still the right TYPE beats deleting the prop: a
    // component that reads items.map after the guard crashes on undefined.
    return op(path, kind && kind !== 'boolean' ? falsyFor(kind) : false)
  }
  if (n && n.type === 'BinaryExpression') return { blocked: 'a negated comparison — set the value in Props' }
  if (n && n.type === 'LogicalExpression') {
    // !(a || b) means neither: invert both.
    const left = invert(n.left, world)
    const right = invert(n.right, world)
    if (left.blocked) return left
    if (right.blocked) return right
    return { ops: [...left.ops, ...right.ops], unset: [...left.unset, ...right.unset] }
  }
  // Fall back to the un-negated reason, which is the useful one.
  const inner = patchFor(node, world)
  return inner.blocked ? inner : { blocked: 'a negation the harness cannot invert' }
}

/** Destructured parameter names: `({ a, b: c, ...rest })` → a, c. */
function destructuredNames(param, out) {
  if (!param) return
  if (param.type === 'AssignmentPattern') return destructuredNames(param.left, out)
  if (param.type === 'ObjectPattern') {
    for (const p of param.properties) {
      if (p.type === 'ObjectProperty') {
        const v = p.value.type === 'AssignmentPattern' ? p.value.left : p.value
        if (v.type === 'Identifier') out.add(v.name)
      }
    }
  }
}

const isComponentName = (name) => typeof name === 'string' && /^[A-Z]/.test(name)

/**
 * Scan a component's source for the conditions it renders on.
 *
 * @param {string} source  the component file's text
 * @param {object} opts    { schema?: PropSpec[], component?: string }
 * @returns {{states: Array, parsed: boolean}}
 */
export function scanConditionalStates(source, opts = {}) {
  const schema = Array.isArray(opts.schema) ? opts.schema : []
  const kinds = {}
  for (const spec of schema) {
    if (spec && typeof spec.name === 'string') kinds[spec.name] = spec.kind || null
  }
  const world = {
    props: new Set(Object.keys(kinds)),
    /** Names of undestructured props parameters — `function C(props)`. */
    propsParam: new Set(),
    state: new Set(),
    locals: new Set(),
    /** name → initializer, so a condition on a computed value can be resolved
     *  one hop back to the props it was computed from. */
    localInit: new Map(),
    stateInit: new Map(),
    /** Cycle guard for that resolution. */
    resolving: new Set(),
    kinds,
  }
  const states = []
  const seen = new Set()

  let ast
  try {
    ast = babel.parseSync(source, {
      babelrc: false,
      configFile: false,
      sourceType: 'module',
      parserOpts: { plugins: PARSER_PLUGINS, errorRecovery: true },
    })
  } catch (err) {
    return { states: [], parsed: false }
  }
  if (!ast) return { states: [], parsed: false }

  // Pass 1: learn the names. Props from every component-shaped function's
  // destructured parameter (the schema may be absent — the standalone SPA builds
  // isolate URLs without one), useState bindings, and plain locals.
  walk(ast, (node, parent) => {
    const learnParam = (param) => {
      if (param && param.type === 'Identifier') world.propsParam.add(param.name)
      destructuredNames(param, world.props)
    }
    if (node.type === 'FunctionDeclaration' && isComponentName(node.id && node.id.name)) {
      learnParam(node.params[0])
    }
    if ((node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression')
      && parent && parent.type === 'VariableDeclarator' && isComponentName(parent.id && parent.id.name)) {
      learnParam(node.params[0])
    }
    if (node.type === 'VariableDeclarator' && node.init) {
      const init = unwrap(node.init)
      const callee = init && init.callee
      const calleeName = callee && (callee.name || (callee.property && callee.property.name))
      if (node.id.type === 'ArrayPattern' && /^useState|^useReducer/.test(String(calleeName || ''))) {
        const first = node.id.elements[0]
        if (first && first.type === 'Identifier') {
          world.state.add(first.name)
          // `useState(props.defaultOpen)` — the prop decides the FIRST paint,
          // which is the only paint the harness renders.
          const seed = init.arguments && init.arguments[0]
          if (seed) world.stateInit.set(first.name, seed)
        }
      } else if (node.id.type === 'Identifier' && !world.props.has(node.id.name)) {
        world.locals.add(node.id.name)
        world.localInit.set(node.id.name, node.init)
      }
    }
  })
  // A name cannot be both — the parameter wins, since that is what we can set.
  for (const name of world.props) { world.locals.delete(name); world.state.delete(name) }

  const text = (node) => {
    const raw = source.slice(node.start, node.end).replace(/\s+/g, ' ').trim()
    return raw.length > MAX_COND ? raw.slice(0, MAX_COND - 1) + '…' : raw
  }

  const add = (test, renders, kindLabel) => {
    if (states.length >= MAX_STATES) return
    const cond = text(test)
    if (seen.has(cond)) return
    seen.add(cond)
    const patch = patchFor(test, world)
    states.push({
      cond,
      renders,
      kind: kindLabel,
      line: (test.loc && test.loc.start.line) || 1,
      ops: patch.blocked ? null : patch.ops,
      unset: patch.blocked ? null : patch.unset,
      blocked: patch.blocked || null,
    })
  }

  // Pass 2: the branches themselves — but only inside functions that RENDER.
  // An `if (e.metaKey) return` in a click handler and an early return in a
  // useEffect are control flow, not appearances; listing them buried the real
  // states under noise no click could ever reach.
  walkPrune(ast, (node) => {
    if (isFunction(node) && !containsJsx(node)) return false
    if (node.type === 'IfStatement') {
      const ret = returnedByBranch(node.consequent)
      if (ret !== undefined) add(node.test, describes(ret), 'early return')
      return true
    }
    if (node.type === 'LogicalExpression' && node.operator === '&&' && containsJsx(node.right)) {
      add(node.left, describes(unwrap(node.right)), 'guarded render')
      return true
    }
    if (node.type === 'ConditionalExpression' && (containsJsx(node.consequent) || containsJsx(node.alternate))) {
      add(node.test, describes(unwrap(node.consequent)) + ' instead of ' + describes(unwrap(node.alternate)), 'either/or')
    }
    return true
  })

  // Drivable first: the whole point of the tab is the click, and a component
  // with thirty branches should not make you hunt for the four that work.
  states.sort((a, b) => (a.blocked ? 1 : 0) - (b.blocked ? 1 : 0))
  return { states, parsed: true }
}

/** What an `if` branch returns, or undefined when it returns nothing (so the
 *  branch is control flow, not a rendering decision). */
function returnedByBranch(branch) {
  if (!branch) return undefined
  if (branch.type === 'ReturnStatement') return branch.argument === null ? { type: 'NullLiteral' } : unwrap(branch.argument)
  if (branch.type === 'BlockStatement') {
    for (const stmt of branch.body) {
      if (stmt.type === 'ReturnStatement') return stmt.argument === null ? { type: 'NullLiteral' } : unwrap(stmt.argument)
    }
  }
  return undefined
}

const isFunction = (node) => node.type === 'ArrowFunctionExpression'
  || node.type === 'FunctionExpression'
  || node.type === 'FunctionDeclaration'

// Asked once per function on the way down and again for every branch inside it,
// so it is worth remembering the answer.
const jsxCache = new WeakMap()
function containsJsx(node) {
  if (!node) return false
  const hit = jsxCache.get(node)
  if (hit !== undefined) return hit
  let found = false
  walk(node, (n) => { if (n.type === 'JSXElement' || n.type === 'JSXFragment') found = true })
  jsxCache.set(node, found)
  return found
}

/** Like walk(), but a visitor returning false prunes that node's subtree. */
function walkPrune(node, visit) {
  if (!node || typeof node.type !== 'string') return
  if (visit(node) === false) return
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue
    const value = node[key]
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child.type === 'string') walkPrune(child, visit)
      }
    } else if (value && typeof value.type === 'string') {
      walkPrune(value, visit)
    }
  }
}

/** A depth-first walk over the AST. Small enough to own: @babel/traverse is not
 *  a dependency of this server, and one visitor callback is all this needs. */
function walk(node, visit, parent) {
  if (!node || typeof node.type !== 'string') return
  visit(node, parent)
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue
    const value = node[key]
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child.type === 'string') walk(child, visit, node)
      }
    } else if (value && typeof value.type === 'string') {
      walk(value, visit, node)
    }
  }
}
