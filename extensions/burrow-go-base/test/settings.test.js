/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Standalone unit tests for the gopls settings mapper. settings.ts imports nothing
// from 'vscode', so out/settings.js is a clean CommonJS module we can require
// directly — same shape as gopls.test.js. Run: `npm test` (after a compile) or
// `node test/settings.test.js`.
//
// Every case here is a pair: the shape a setting is meant to produce, and a
// specific way of getting it wrong that must not pass. The whole file is also a
// negative test against the previous build — out/settings.js does not exist
// there, so it cannot even be loaded.

'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { buildGoplsSettings, HINT_FAMILIES, STYLE_CHECKS } = require('../out/settings');
// The drift test below must look for gopls exactly where the extension looks for
// it — GOBIN, GOPATH/bin, then PATH — or it skips on a machine where the running
// IDE resolves gopls fine, which is the least useful moment to go quiet.
const { resolveGopls } = require('../out/gopls');

/**
 * A reader backed by a plain object, standing in for
 * `workspace.getConfiguration('burrow.go')`. Anything not named reads as
 * `undefined`, which is what the workbench does for a key with no default.
 */
function readerFrom(values) {
	return key => values[key];
}

/** The defaults declared in package.json, so the tests assert what actually ships. */
function packageDefaults() {
	const manifest = JSON.parse(
		fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
	);
	const props = manifest.contributes.configuration.properties;
	const values = {};
	for (const [name, schema] of Object.entries(props)) {
		assert.ok(
			name.startsWith('burrow.go.'),
			`every contributed setting must sit under burrow.go, but found ${name}`,
		);
		values[name.slice('burrow.go.'.length)] = schema.default;
	}
	return values;
}

const cases = {
	// -- semantic tokens: the one option that already shipped ------------------
	'semantic tokens stay on unless explicitly turned off': () => {
		assert.strictEqual(buildGoplsSettings(readerFrom({}))['semanticTokens'], true);
		assert.strictEqual(
			buildGoplsSettings(readerFrom({ semanticTokens: false }))['semanticTokens'],
			false,
		);
	},

	// -- inlay hints: the row that was empty for want of a setting -------------
	'every hint family is sent explicitly, on or off': () => {
		const hints = buildGoplsSettings(
			readerFrom({ 'inlayHints.parameterNames': true, 'inlayHints.constantValues': false }),
		)['hints'];
		assert.deepStrictEqual(
			Object.keys(hints).sort(),
			[...HINT_FAMILIES].sort(),
			'gopls must be told about every family, so a default it changes cannot change Burrow',
		);
		assert.strictEqual(hints.parameterNames, true);
		assert.strictEqual(hints.constantValues, false);
		// The failure this guards: reading an unset key as truthy would turn on the
		// two families Burrow deliberately leaves off.
		assert.strictEqual(hints.rangeVariableTypes, false);
	},

	'the shipped defaults turn on six hint families and leave two off': () => {
		const hints = buildGoplsSettings(readerFrom(packageDefaults()))['hints'];
		const on = Object.entries(hints).filter(([, v]) => v).map(([k]) => k).sort();
		assert.deepStrictEqual(on, [
			'assignVariableTypes',
			'compositeLiteralFields',
			'constantValues',
			'functionTypeParameters',
			'ignoredError',
			'parameterNames',
		]);
	},

	// -- staticcheck: a tri-state a boolean cannot carry -----------------------
	'staticcheck "default" sends nothing, because gopls\' third value is absence': () => {
		const settings = buildGoplsSettings(readerFrom({ staticcheck: 'default' }));
		assert.ok(
			!('staticcheck' in settings),
			'sending false for "default" would disable the curated subset a reader still wants',
		);
	},

	'staticcheck "all" and "off" map to true and false': () => {
		assert.strictEqual(buildGoplsSettings(readerFrom({ staticcheck: 'all' }))['staticcheck'], true);
		assert.strictEqual(buildGoplsSettings(readerFrom({ staticcheck: 'off' }))['staticcheck'], false);
	},

	// -- the style family ------------------------------------------------------
	'"all" without styleChecks disables the ST1xxx family by name': () => {
		const analyses = buildGoplsSettings(readerFrom({ staticcheck: 'all' }))['analyses'];
		for (const check of STYLE_CHECKS) {
			assert.strictEqual(analyses[check], false, `${check} must be off when styleChecks is off`);
		}
	},

	'styleChecks lets the ST1xxx family through': () => {
		const settings = buildGoplsSettings(
			readerFrom({ staticcheck: 'all', styleChecks: true }),
		);
		assert.ok(
			!('analyses' in settings),
			'with nothing to disable and nothing named, no analyses map should be sent at all',
		);
	},

	'the style family is not disabled when staticcheck is not "all"': () => {
		// It is not on in the first place; sending falses would be a lie about what
		// this setting does, and would survive a later change to gopls\' defaults.
		const settings = buildGoplsSettings(readerFrom({ staticcheck: 'default' }));
		assert.ok(!('analyses' in settings));
	},

	'an analyser named by hand wins over the style default': () => {
		const analyses = buildGoplsSettings(
			readerFrom({ staticcheck: 'all', analyses: { ST1003: true, shadow: true } }),
		)['analyses'];
		assert.strictEqual(analyses.ST1003, true, 'naming a check is more specific than a family');
		assert.strictEqual(analyses.shadow, true);
		assert.strictEqual(analyses.ST1000, false, 'the rest of the family stays off');
	},

	// -- omission is meaningful ------------------------------------------------
	'settings Burrow has no opinion about are omitted, not sent empty': () => {
		const settings = buildGoplsSettings(readerFrom({}));
		for (const key of ['codelenses', 'analyses', 'env', 'buildFlags', 'directoryFilters', 'local']) {
			assert.ok(!(key in settings), `${key} must be absent so gopls' own default keeps applying`);
		}
	},

	'empty arrays and objects are treated as "no opinion"': () => {
		const settings = buildGoplsSettings(
			readerFrom({ buildFlags: [], env: {}, analyses: {}, local: '' }),
		);
		assert.ok(!('buildFlags' in settings));
		assert.ok(!('env' in settings));
		assert.ok(!('analyses' in settings));
		assert.ok(!('local' in settings));
	},

	'malformed values are dropped rather than passed to gopls': () => {
		const settings = buildGoplsSettings(
			readerFrom({ buildFlags: 'not-an-array', env: ['not', 'a', 'map'], analyses: null }),
		);
		assert.ok(!('buildFlags' in settings));
		assert.ok(!('env' in settings));
		assert.ok(!('analyses' in settings));
	},

	// -- linksInHover: false | true | "gopls" ----------------------------------
	'linksInHover carries all three of gopls\' values': () => {
		assert.strictEqual(buildGoplsSettings(readerFrom({ linksInHover: 'off' }))['linksInHover'], false);
		assert.strictEqual(buildGoplsSettings(readerFrom({ linksInHover: 'web' }))['linksInHover'], true);
		assert.strictEqual(
			buildGoplsSettings(readerFrom({ linksInHover: 'gopls' }))['linksInHover'],
			'gopls',
			'"gopls" is a string on the wire, not a boolean — collapsing it loses the doc viewer',
		);
	},

	// -- the escape hatch ------------------------------------------------------
	'the raw gopls object is merged last and wins': () => {
		const settings = buildGoplsSettings(
			readerFrom({
				staticcheck: 'all',
				gopls: { staticcheck: false, diagnosticsDelay: '500ms' },
			}),
		);
		assert.strictEqual(settings['staticcheck'], false, 'the escape hatch must win, or it is not one');
		assert.strictEqual(settings['diagnosticsDelay'], '500ms');
	},

	'a malformed escape hatch does not destroy the rest of the settings': () => {
		const settings = buildGoplsSettings(readerFrom({ gopls: 'nonsense' }));
		assert.strictEqual(settings['semanticTokens'], true);
	},

	// -- names, not aliases ----------------------------------------------------
	'settings go on the wire under gopls\' short names': () => {
		const settings = buildGoplsSettings(readerFrom(packageDefaults()));
		for (const key of Object.keys(settings)) {
			assert.ok(
				!key.includes('.'),
				`${key} is a dotted alias; gopls documents the short form for every client but VS Code`,
			);
		}
		assert.ok('hints' in settings, 'the inlay-hint map is called "hints", not "inlayHints"');
		assert.ok('codelenses' in settings === false || 'codeLenses' in settings === false);
	},

	// -- the shipped defaults, end to end --------------------------------------
	'the defaults that ship produce a settings object gopls can read': () => {
		const settings = buildGoplsSettings(readerFrom(packageDefaults()));
		assert.strictEqual(settings['semanticTokens'], true);
		assert.strictEqual(settings['staticcheck'], true);
		assert.strictEqual(settings['usePlaceholders'], true);
		assert.strictEqual(settings['hoverKind'], 'FullDocumentation');
		assert.strictEqual(settings['linksInHover'], true);
		assert.ok(!('vulncheck' in settings) || settings['vulncheck'] === 'Off');
		assert.strictEqual(Object.keys(settings['analyses']).length, STYLE_CHECKS.length);
	},

	// -- drift: the one list here that is a fact about gopls, not about Burrow --
	'STYLE_CHECKS is exactly gopls\' ST1xxx analyser set': () => {
		const goplsPath = resolveGopls(process.env);
		if (!goplsPath) {
			// Say so out loud rather than passing quietly: a skipped assertion that
			// reads as a green tick is the defect this whole line of work is about.
			console.log(
				'  ⚠ SKIPPED — gopls not found in GOBIN, GOPATH/bin or PATH.\n' +
				'    STYLE_CHECKS is a fact about gopls, not about Burrow; install gopls to assert it.',
			);
			return;
		}
		const apiJson = execFileSync(goplsPath, ['api-json'], {
			encoding: 'utf8',
			maxBuffer: 64 * 1024 * 1024,
			stdio: ['ignore', 'pipe', 'ignore'],
		});
		const live = JSON.parse(apiJson).Analyzers
			.map(a => a.Name)
			.filter(name => /^ST1\d+$/.test(name))
			.sort();
		assert.deepStrictEqual(
			[...STYLE_CHECKS].sort(),
			live,
			'gopls\' style family has moved under a re-pin; update STYLE_CHECKS in src/settings.ts',
		);
	},
};

let failed = 0;
for (const [name, run] of Object.entries(cases)) {
	try {
		run();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failed++;
		console.error(`  ✗ ${name}\n    ${err.message}`);
	}
}
const total = Object.keys(cases).length;
console.log(`${total - failed}/${total} passed`);
process.exit(failed === 0 ? 0 : 1);
