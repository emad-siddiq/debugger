// Node test for the pack model: order, dedupe, budget, determinism, emission rule.
'use strict';
const { finalizePack, renderContextPack, shouldEmitPack } = require('../out/packModel.js');

let failed = 0;
const check = (name, ok, extra) => {
	if (ok) { console.log(`  ok  ${name}`); }
	else { failed++; console.error(`FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};

// 1. exact wire format
const p1 = finalizePack('components', ['src/Cart.tsx'], [
	{ relation: 'renders', path: 'src/CartItem.tsx' },
	{ relation: 'styles', path: 'src/Cart.module.css', detail: 'imported at line 3' },
	{ relation: 'used-by', path: 'src/pages/Home.tsx' },
], 2400);
check('relations render in priority order with exact line shapes',
	renderContextPack(p1) ===
	'<context_pack surface="components" primary="src/Cart.tsx">\n' +
	'styles: src/Cart.module.css (imported at line 3)\n' +
	'used-by: src/pages/Home.tsx\n' +
	'renders: src/CartItem.tsx\n' +
	'</context_pack>', renderContextPack(p1));

// 2. within-group sort by path then line
const p2 = finalizePack('routes', ['b/h.go'], [
	{ relation: 'sql', path: 'b/h.go', line: 90, detail: 'SELECT 2' },
	{ relation: 'sql', path: 'b/h.go', line: 12, detail: 'SELECT 1' },
	{ relation: 'sql', path: 'b/a.go', line: 50, detail: 'SELECT 0' },
], 2400);
check('within a relation entries sort by path then line',
	p2.neighbors.map(n => `${n.path}:${n.line}`).join(' ') === 'b/a.go:50 b/h.go:12 b/h.go:90');

// 3. dedupe: bare duplicate of a primary/covered path drops; line/detail keeps it
const p3 = finalizePack('components', ['src/Cart.tsx'], [
	{ relation: 'used-by', path: 'src/Cart.tsx' },                      // bare dup of primary → drop
	{ relation: 'sql', path: 'src/Cart.tsx', line: 4, detail: 'x' },    // adds info → keep
	{ relation: 'used-by', path: 'src/pages/Home.tsx' },                // covered explicitly → drop
], 2400, ['src/pages/Home.tsx']);
check('bare covered duplicates drop, informative ones stay',
	p3.neighbors.length === 1 && p3.neighbors[0].relation === 'sql');

// 4. budget trims from the bottom and flags truncated
const many = [];
for (let i = 0; i < 20; i++) { many.push({ relation: 'renders', path: `src/components/VeryLongComponentName${String(i).padStart(2, '0')}.tsx` }); }
many.push({ relation: 'styles', path: 'src/Cart.css' });
const p4 = finalizePack('components', ['src/Cart.tsx'], many, 300);
check('over budget: truncated=true, styles (top priority) survives, bottom renders dropped',
	p4.truncated === true &&
	p4.neighbors[0].relation === 'styles' &&
	renderContextPack(p4).length <= 300 &&
	renderContextPack(p4).includes('truncated: true'));

// 5. determinism: same input (different array order) → byte-identical render
const a = finalizePack('components', ['p'], [
	{ relation: 'renders', path: 'b.tsx' }, { relation: 'renders', path: 'a.tsx' },
], 2400);
const b = finalizePack('components', ['p'], [
	{ relation: 'renders', path: 'a.tsx' }, { relation: 'renders', path: 'b.tsx' },
], 2400);
check('input order does not change the rendered pack', renderContextPack(a) === renderContextPack(b));

// 6. emission rule
check('no neighbors + primary covered ⇒ not emitted',
	shouldEmitPack({ surface: 's', primary: ['x'], neighbors: [], truncated: false }, ['x']) === false);
check('no neighbors + primary NOT covered ⇒ emitted',
	shouldEmitPack({ surface: 's', primary: ['x'], neighbors: [], truncated: false }, []) === true);
check('neighbors ⇒ emitted',
	shouldEmitPack({ surface: 's', primary: ['x'], neighbors: [{ relation: 'styles', path: 'y' }], truncated: false }, ['x']) === true);

console.log(failed === 0 ? 'all packModel cases passed' : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
