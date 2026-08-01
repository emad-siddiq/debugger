// Node test for the pure stylesheet-import scanner (plan chat/02 step 4.2).
'use strict';
const { styleImportsOf } = require('../out/styleImports.js');

const cases = [
	['side-effect import', `import './Cart.css';`, [{ spec: './Cart.css', line: 1 }]],
	['named import from', `import styles from './Cart.module.css';`, [{ spec: './Cart.module.css', line: 1 }]],
	['require call', `const s = require('./x.scss');`, [{ spec: './x.scss', line: 1 }]],
	['line numbers count newlines', `import a from 'b';\n\nimport './deep/one.less';`, [{ spec: './deep/one.less', line: 3 }]],
	['non-style imports ignored', `import x from './x';\nimport y from 'react';`, []],
	['package style import captured (filtered later by caller)', `import 'normalize.css';`, [{ spec: 'normalize.css', line: 1 }]],
	['sass + multiple', `import './a.css';\nimport './b.sass';`, [{ spec: './a.css', line: 1 }, { spec: './b.sass', line: 2 }]],
];

let failed = 0;
for (const [name, text, expected] of cases) {
	const got = styleImportsOf(text);
	const ok = JSON.stringify(got) === JSON.stringify(expected);
	if (ok) { console.log(`  ok  ${name}`); }
	else { failed++; console.error(`FAIL  ${name} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`); }
}
console.log(failed === 0 ? `${cases.length}/${cases.length} passed` : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
