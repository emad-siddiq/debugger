// Direct unit tests for server/jsxEdit.js — the riskiest write path.
//   node test/jsxEdit.mjs        (exit 0 = pass)
import assert from 'node:assert/strict'
import { applyJsxEdit } from '../server/jsxEdit.js'

const SRC = `import React from 'react'
export function Card() {
  return (
    <div className="card" data-x="1">
      <Badge label="Old" count={3} live />
      <span>Hello world</span>
    </div>
  )
}
`
const line5 = (r) => r.code.split('\n')[4]
const badge = (op) => applyJsxEdit(SRC, 'a.tsx', { component: 'Badge', ...op })

let r = badge({ op: 'setAttribute', name: 'label', value: 'New', kind: 'string' })
assert.equal(line5(r), '      <Badge label="New" count={3} live />', 'string attr update')

r = badge({ op: 'setAttribute', name: 'count', value: 7, kind: 'number' })
assert.equal(line5(r), '      <Badge label="Old" count={7} live />', 'number attr update')

r = badge({ op: 'setAttribute', name: 'tone', value: 'warn', kind: 'string' })
assert.equal(line5(r), '      <Badge label="Old" count={3} live tone="warn" />', 'attr add')

r = badge({ op: 'setAttribute', name: 'live', value: false, kind: 'boolean' })
assert.equal(line5(r), '      <Badge label="Old" count={3} live={false} />', 'boolean shorthand replace')

r = badge({ op: 'removeAttribute', name: 'count' })
assert.equal(line5(r), '      <Badge label="Old" live />', 'attr remove')

// Quoting: value containing both quote kinds goes through a JSX expression.
r = badge({ op: 'setAttribute', name: 'label', value: `a"b'c`, kind: 'string' })
assert.ok(line5(r).includes(`label={"a\\"b'c"}`), 'mixed quotes → expression')

// setText via exact stamped coords (data-inspect-col = column + 1).
const spanCol = SRC.split('\n')[5].indexOf('<span') + 1
r = applyJsxEdit(SRC, 'a.tsx', { op: 'setText', line: 6, col: spanCol, text: 'Goodbye' })
assert.equal(r.code.split('\n')[5], '      <span>Goodbye</span>', 'setText')

// Refusals — structured, never a guessy edit.
r = applyJsxEdit(SRC.replace('<span>', '<Badge label="b" /><span>'), 'a.tsx', {
  op: 'setAttribute', component: 'Badge', name: 'label', value: 'x', kind: 'string',
})
assert.equal(r.ok, false, 'ambiguous call sites refused')
assert.equal(r.candidates.length, 2, 'ambiguity reports candidates')

r = applyJsxEdit(SRC.replace('count={3}', '{...rest}'), 'a.tsx', {
  op: 'setAttribute', component: 'Badge', name: 'tone', value: 'x', kind: 'string',
})
assert.equal(r.ok, false, 'adding under spread refused')

r = applyJsxEdit(SRC.replace('Hello world', '{msg}'), 'a.tsx', {
  op: 'setText', line: 6, col: spanCol, text: 'nope',
})
assert.equal(r.ok, false, 'expression children refused')

r = applyJsxEdit(SRC, 'a.tsx', { op: 'setText', line: 6, col: 999, text: 'x' })
assert.equal(r.ok, false, 'unknown coords refused')

console.log('jsxEdit: all assertions passed')
