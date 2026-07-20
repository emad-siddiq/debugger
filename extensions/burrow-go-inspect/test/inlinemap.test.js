/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Standalone unit test for the inline-decoration line scanner (WO-8). inlinemap.ts
// imports nothing, so out/inlinemap.js is a clean CommonJS module.
// Run: `npm test` or `node test/inlinemap.test.js`.

'use strict';

const assert = require('node:assert');
const { declaredNamesOnLine } = require('../out/inlinemap');

const cases = {
	'short variable declaration': () => {
		assert.deepStrictEqual(declaredNamesOnLine('\tsum := a + b'), ['sum']);
	},
	'multi-assign short declaration': () => {
		assert.deepStrictEqual(declaredNamesOnLine('v, ok := m[k]'), ['v', 'ok']);
	},
	'range loop drops the blank identifier': () => {
		assert.deepStrictEqual(declaredNamesOnLine('\tfor _, n := range nums {'), ['n']);
	},
	'if-statement initializer': () => {
		assert.deepStrictEqual(declaredNamesOnLine('if v, err := f(); err != nil {'), ['v', 'err']);
	},
	'func params with a shared type': () => {
		assert.deepStrictEqual(declaredNamesOnLine('func add(a, b int) int {'), ['a', 'b']);
	},
	'method receiver and params': () => {
		assert.deepStrictEqual(declaredNamesOnLine('func (s *Server) handle(w http.ResponseWriter) {'), ['s', 'w']);
	},
	'func with no params yields nothing': () => {
		assert.deepStrictEqual(declaredNamesOnLine('func main() {'), []);
	},
	'var declaration with a type': () => {
		assert.deepStrictEqual(declaredNamesOnLine('var total int'), ['total']);
	},
	'var declaration with an initializer': () => {
		assert.deepStrictEqual(declaredNamesOnLine('var x, y = 1, 2'), ['x', 'y']);
	},
	'plain reassignment is deliberately not a declaration': () => {
		assert.deepStrictEqual(declaredNamesOnLine('\t\ttotal = add(total, n)'), []);
	},
	'comparison is not an assignment': () => {
		assert.deepStrictEqual(declaredNamesOnLine('if os.Getenv("X") != "" {'), []);
	},
	'a commented-out declaration is ignored': () => {
		assert.deepStrictEqual(declaredNamesOnLine('\t// sum := a + b'), []);
	},
	'a trailing comment does not leak names': () => {
		assert.deepStrictEqual(declaredNamesOnLine('nums := []int{2, 3} // xs := nope'), ['nums']);
	},
	'names are deduped': () => {
		assert.deepStrictEqual(declaredNamesOnLine('func f(a int) { a := 1'), ['a']);
	},
	'a blank line yields nothing': () => {
		assert.deepStrictEqual(declaredNamesOnLine('   '), []);
	},
};

let failed = 0;
for (const [name, fn] of Object.entries(cases)) {
	try {
		fn();
		console.log(`  PASS  ${name}`);
	} catch (err) {
		failed++;
		console.error(`  FAIL  ${name}\n        ${err.message}`);
	}
}
const total = Object.keys(cases).length;
console.log(`\ninlinemap: ${total - failed}/${total} passed`);
process.exit(failed === 0 ? 0 : 1);
