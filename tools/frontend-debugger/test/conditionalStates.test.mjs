// The conditional-states scanner: which branches it finds, which it can drive
// from props, and — as importantly — which it refuses to drive and why.
//
// The refusals are the tests that matter. A scanner that quietly offers a click
// which does nothing (internal useState) or that invents `items = [{}]` for a
// non-empty check is worse than no States tab at all.

import test from 'node:test'
import assert from 'node:assert/strict'
import { scanConditionalStates } from '../server/conditionalStates.js'

const SCHEMA = [
  { name: 'loading', kind: 'boolean', required: false },
  { name: 'error', kind: 'string', required: false },
  { name: 'items', kind: 'array', required: true },
  { name: 'variant', kind: 'enum', required: false, options: ['primary', 'ghost'] },
  { name: 'disabled', kind: 'boolean', required: false },
]

const scan = (src, schema = SCHEMA) => scanConditionalStates(src, { schema }).states
const find = (states, needle) => states.find((s) => s.cond.includes(needle))
// An op list is a path plus a value; flatten it for readable assertions.
const setOf = (s) => (s.ops || []).reduce((o, op) => Object.assign(o, { [op.path.join('.')]: op.value }), {})

test('an early return on a boolean prop becomes a one-click state', () => {
  const states = scan(`
    export function Panel({ loading, items }) {
      if (loading) return <Skeleton />
      return <ul>{items.map((i) => <li key={i.id}>{i.name}</li>)}</ul>
    }
  `)
  const s = find(states, 'loading')
  assert.ok(s, 'the loading branch was found')
  assert.equal(s.kind, 'early return')
  assert.equal(s.renders, '<Skeleton>')
  assert.deepEqual(setOf(s), { loading: true })
  assert.equal(s.blocked, null)
})

test('a guarded render on a string prop gets a message, not `true`', () => {
  const states = scan(`
    export function Panel({ error }) {
      return <div>{error && <Alert text={error} />}</div>
    }
  `)
  const s = find(states, 'error')
  assert.equal(s.kind, 'guarded render')
  assert.deepEqual(setOf(s), { error: 'Something went wrong' })
})

test('an empty-list check sets the array empty', () => {
  const states = scan(`
    export function List({ items }) {
      if (items.length === 0) return <Empty />
      return <ul />
    }
  `)
  const s = find(states, 'items.length')
  assert.deepEqual(setOf(s), { items: [] })
})

test('a NON-empty check is refused, with the reason, rather than faked', () => {
  const states = scan(`
    export function List({ items }) {
      return <div>{items.length > 0 && <ul />}</div>
    }
  `)
  const s = find(states, 'items.length')
  assert.equal(s.ops, null)
  assert.match(s.blocked, /realistic items/)
})

test('internal useState is listed but not drivable, and says so', () => {
  const states = scan(`
    export function Menu({ items }) {
      const [open, setOpen] = useState(false)
      return <div>{open && <Dropdown items={items} />}</div>
    }
  `)
  const s = find(states, 'open')
  assert.ok(s, 'the branch is still listed')
  assert.equal(s.ops, null)
  assert.match(s.blocked, /useState/)
})

test('a value computed in the body is listed with a different reason', () => {
  const states = scan(`
    export function Row({ items }) {
      const isEmpty = items.length === 0
      if (isEmpty) return <Empty />
      return <ul />
    }
  `)
  const s = find(states, 'isEmpty')
  assert.equal(s.ops, null)
  assert.match(s.blocked, /computed inside/)
})

test('an enum equality sets the literal it compares against', () => {
  const states = scan(`
    export function Button({ variant }) {
      return <div>{variant === 'ghost' ? <Ghost /> : <Solid />}</div>
    }
  `)
  const s = find(states, 'variant')
  assert.equal(s.kind, 'either/or')
  assert.equal(s.renders, '<Ghost> instead of <Solid>')
  assert.deepEqual(setOf(s), { variant: 'ghost' })
})

test('a negated prop flips to a typed falsy value, not a delete', () => {
  const states = scan(`
    export function Panel({ items }) {
      if (!items) return <Empty />
      return <ul />
    }
  `)
  const s = find(states, '!items')
  // items is kind 'array': undefined would crash the very .map the component
  // returns to after the guard.
  assert.deepEqual(setOf(s), { items: [] })
})

test('an && of two drivable props sets both', () => {
  const states = scan(`
    export function Panel({ loading, disabled }) {
      if (loading && disabled) return <Frozen />
      return <div />
    }
  `)
  const s = find(states, 'loading && disabled')
  assert.deepEqual(setOf(s), { loading: true, disabled: true })
})

test('props are found from the destructured parameter when there is no schema', () => {
  const states = scan(`
    export function Panel({ busy }) {
      if (busy) return <Spinner />
      return <div />
    }
  `, [])
  const s = find(states, 'busy')
  assert.deepEqual(setOf(s), { busy: true })
})

test('control-flow ifs that render nothing are not states', () => {
  const states = scan(`
    export function Panel({ items }) {
      useEffect(() => { if (items.length) { track('seen') } }, [items])
      return <ul />
    }
  `)
  assert.equal(states.length, 0, JSON.stringify(states))
})

test('a component with no branches yields an empty list, not a parse failure', () => {
  const out = scanConditionalStates(`
    export const Badge = ({ label }) => <span className="badge">{label}</span>
  `, { schema: [] })
  assert.equal(out.parsed, true)
  assert.deepEqual(out.states, [])
})

test('a file that does not parse reports parsed:false instead of throwing', () => {
  const out = scanConditionalStates('export function Broken({ = ) {', {})
  assert.equal(out.parsed, false)
  assert.deepEqual(out.states, [])
})

test('every state carries a line, a condition and a rendering description', () => {
  const states = scan(`
    export function Panel({ loading, error, items }) {
      if (loading) return <Skeleton />
      if (error) return <Alert />
      return <div>{items.length === 0 && <Empty />}</div>
    }
  `)
  assert.equal(states.length, 3)
  for (const s of states) {
    assert.ok(s.line > 0, 'line')
    assert.ok(s.cond.length, 'cond')
    assert.ok(s.renders.length, 'renders')
    assert.ok(['early return', 'guarded render', 'either/or'].includes(s.kind), s.kind)
  }
})

test('a handler prop gets the no-op function marker, never `true`', () => {
  const states = scan(`
    export function Toolbar({ onShare, node }) {
      return <div>{onShare && node && <button onClick={onShare}>Share</button>}</div>
    }
  `, [])
  const s = find(states, 'onShare')
  // `true` here renders, then throws the first time the button is clicked.
  assert.equal(setOf(s).onShare, 'ƒ')
})

test('a nested prop path is driven without flattening its object', () => {
  const states = scan(`
    export function Panel({ panel }) {
      return <div>{panel.chart_type === 'logs' ? <Logs /> : <Chart />}</div>
    }
  `, [])
  const s = find(states, 'chart_type')
  assert.deepEqual(s.ops, [{ path: ['panel', 'chart_type'], value: 'logs' }])
})

test('a numeric threshold picks the smallest value on the true side', () => {
  const states = scan(`
    export function Badge({ count }) {
      return <div>{count > 0 && <span>{count}</span>}</div>
    }
  `, [{ name: 'count', kind: 'number', required: false }])
  assert.deepEqual(setOf(find(states, 'count > 0')), { count: 1 })
})

test('a literal on the left flips the comparison instead of inverting it', () => {
  const states = scan(`
    export function Badge({ count }) {
      return <div>{0 < count && <span>{count}</span>}</div>
    }
  `, [{ name: 'count', kind: 'number', required: false }])
  assert.deepEqual(setOf(find(states, 'count')), { count: 1 })
})

test('branches inside an event handler are not states', () => {
  const states = scan(`
    export function Row({ onPick }) {
      const click = (e) => { if (e.metaKey) return; onPick(e) }
      return <div onClick={click} />
    }
  `, [])
  assert.equal(states.length, 0, JSON.stringify(states))
})

test('drivable states sort ahead of blocked ones', () => {
  const states = scan(`
    export function Panel({ loading }) {
      const [open, setOpen] = useState(false)
      if (open) return <Menu />
      if (loading) return <Skeleton />
      return <div />
    }
  `, [])
  assert.equal(states[0].blocked, null)
  assert.ok(states[states.length - 1].blocked)
})
