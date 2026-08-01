// Node test for the attachment choke point (no vscode host needed).
// Run: npm test  (from extensions/burrow-chat, after compile)
'use strict';
const assert = require('assert');
const { admitAttachment } = require('../out/contextFilter.js');

const CLAUDE = '/ws/CLAUDE.md';
const CART = '/ws/frontend/src/Cart.tsx';

const cases = [
	// [name, facts, expected]
	['explicit CLAUDE.md attachment survives (user placed it)',
		{ id: 'vscode.file', path: CLAUDE }, true],
	['auto instructions CLAUDE.md rejected (Rule A — the live bug)',
		{ id: 'vscode.instructions.file.root__file:///ws/CLAUDE.md', path: CLAUDE }, false],
	['auto instructions CLAUDE.md allowed while user edits it (acceptance #4)',
		{ id: 'vscode.instructions.file.root__file:///ws/CLAUDE.md', path: CLAUDE, activeEditorPath: CLAUDE }, true],
	['auto CLAUDE.local.md rejected',
		{ id: 'vscode.instructions.file.x', path: '/ws/CLAUDE.local.md' }, false],
	['auto AGENTS.md rejected (Rule A)',
		{ id: 'vscode.instructions.file.x', path: '/ws/AGENTS.md' }, false],
	['auto .claude/** rejected (Rule A)',
		{ id: 'vscode.instructions.file.x', path: '/ws/.claude/memory/api.yaml' }, false],
	['customizations index rejected (Copilot tool syntax, wrong backend)',
		{ id: 'vscode.customizations.index' }, false],
	['implicit file with no text editor focused rejected (Rule B)',
		{ id: 'vscode.implicit.file', path: CART }, false],
	['implicit file of the focused editor survives',
		{ id: 'vscode.implicit.file', path: CART, activeEditorPath: CART }, true],
	['implicit selection with a focused editor survives',
		{ id: 'vscode.implicit.selection', path: CART, activeEditorPath: CART }, true],
	['auto instruction file outside the denylist survives (verbatim Rule A)',
		{ id: 'vscode.instructions.file.x', path: '/ws/.github/copilot-instructions.md', activeEditorPath: CART }, true],
	['ordinary explicit file untouched by every rule',
		{ id: 'vscode.file', path: CART }, true],
];

let failed = 0;
for (const [name, facts, expected] of cases) {
	const got = admitAttachment(facts);
	if (got === expected) {
		console.log(`  ok  ${name}`);
	} else {
		failed++;
		console.error(`FAIL  ${name} — expected ${expected}, got ${got}`);
	}
}
console.log(failed === 0 ? `${cases.length}/${cases.length} passed` : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
