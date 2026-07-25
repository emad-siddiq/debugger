/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Pure-logic tests for the tool-surface close decision (docs/plans/02 §6).
// Run: node --test extensions/burrow-core/test/tools.test.js
// (requires a prior compile: out/tools.js — `npm run compile` in the extension).

const { test } = require('node:test');
const assert = require('node:assert');
const { selectTabsToClose } = require('../out/toolsLogic.js');

const claims = (obj) => new Map(Object.entries(obj).map(([tool, keys]) => [tool, new Set(keys)]));
const tab = (key, opts = {}) => ({ key, isDirty: !!opts.dirty, isPinned: !!opts.pinned });

test('closes another tool\'s claimed tabs, leaves the active tool\'s and unclaimed ones', () => {
	const c = claims({
		data: ['webview:burrow.db.grid', 'webview:burrow.db.pgadmin'],
		components: ['webview:burrow.fedbg.preview'],
	});
	const tabs = [
		tab('webview:burrow.db.grid'), // data → close
		tab('webview:burrow.db.pgadmin'), // data → close
		tab('webview:burrow.fedbg.preview'), // active tool → keep
		tab('text:file:///merkle/backend/router.go'), // unclaimed user file → keep
		tab(undefined), // tab kind we never touch → keep
	];
	assert.deepStrictEqual(selectTabsToClose(c, 'components', tabs), [0, 1]);
});

test('dirty and pinned tabs survive even when claimed by an inactive tool', () => {
	const c = claims({ data: ['webview:burrow.db.grid', 'text:untitled:query-1'] });
	const tabs = [
		tab('webview:burrow.db.grid', { pinned: true }),
		tab('text:untitled:query-1', { dirty: true }),
	];
	assert.deepStrictEqual(selectTabsToClose(c, 'components', tabs), []);
});

test('a key claimed by BOTH the active and an inactive tool stays open', () => {
	const c = claims({
		data: ['webview:burrow.shared.docs'],
		components: ['webview:burrow.shared.docs'],
	});
	assert.deepStrictEqual(selectTabsToClose(c, 'components', [tab('webview:burrow.shared.docs')]), []);
});

test('activating a tool with no claims sweeps every other tool; empty registry closes nothing', () => {
	const c = claims({ data: ['webview:burrow.db.grid'] });
	assert.deepStrictEqual(selectTabsToClose(c, 'run', [tab('webview:burrow.db.grid')]), [0]);
	assert.deepStrictEqual(selectTabsToClose(new Map(), 'run', [tab('webview:burrow.db.grid')]), []);
});
