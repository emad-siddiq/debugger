/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Standalone unit tests for the toolchain doctor's parsers and pin table.
// toolchain.ts imports no 'vscode'. Run: `node test/toolchain.test.js`.
//
// Every banner below was captured from the tools installed on this machine, by
// running them, before the parsers were written.

'use strict';

const assert = require('node:assert');
const {
	TOOLS,
	goMinor,
	installPlan,
	isInstallable,
	parseDlvVersion,
	parseGoVersion,
	parseGoplsVersion,
	parseStaticcheckVersion,
	parseVersion,
	pinsFor,
	summarise,
	versionArgs,
} = require('../out/toolchain');

// --- what the tools really printed -----------------------------------------

const GO = 'go version go1.24.1 darwin/arm64\n';
const GO_OLDER = 'go version go1.23.4 darwin/arm64\n';
const GOPLS = 'golang.org/x/tools/gopls v0.20.0\n';
// dlv's version is on the SECOND line. This is the whole banner.
const DLV = `Delve Debugger
Version: 1.25.2
Build: $Id: af3df277866d7175e816eab14e56611053d4cdea $
`;
const STATICCHECK = 'staticcheck 2025.1.1 (0.6.1)\n';

const cases = {
	'go version': () => {
		assert.deepStrictEqual(parseGoVersion(GO), { version: 'go1.24.1', platform: 'darwin/arm64' });
		assert.deepStrictEqual(parseGoVersion(GO_OLDER), { version: 'go1.23.4', platform: 'darwin/arm64' });
		assert.strictEqual(parseGoVersion('zsh: command not found: go'), undefined);
	},

	'gopls version': () => {
		assert.strictEqual(parseGoplsVersion(GOPLS), 'v0.20.0');
		// gopls sometimes appends a build-info block; the first line still decides.
		assert.strictEqual(parseGoplsVersion(`${GOPLS}    golang.org/x/tools/gopls@v0.20.0 h1:abc=\n`), 'v0.20.0');
		assert.strictEqual(parseGoplsVersion(''), undefined);
	},

	'dlv puts its version on the SECOND line': () => {
		// The failure this catches: every other tool here answers on line one, so a
		// parser that reads the first line works three times out of four and reports
		// Delve — the one required tool with no fallback — as absent while it is
		// installed and working. The status bar would then read "dlv missing" on a
		// machine that debugs fine.
		assert.strictEqual(parseDlvVersion(DLV), 'v1.25.2');
		assert.strictEqual(parseDlvVersion(DLV.split('\n')[0]), undefined,
			'the first line alone genuinely carries no version — this is why the parser is multiline');
	},

	'staticcheck version': () => {
		assert.strictEqual(parseStaticcheckVersion(STATICCHECK), '2025.1.1');
	},

	'parseVersion dispatches to the right one': () => {
		assert.strictEqual(parseVersion('go', GO), 'go1.24.1');
		assert.strictEqual(parseVersion('gopls', GOPLS), 'v0.20.0');
		assert.strictEqual(parseVersion('dlv', DLV), 'v1.25.2');
		assert.strictEqual(parseVersion('staticcheck', STATICCHECK), '2025.1.1');
		// A tool's banner read by the wrong parser must not produce a version.
		assert.strictEqual(parseVersion('gopls', DLV), undefined);
		assert.strictEqual(parseVersion('go', GOPLS), undefined);
	},

	'staticcheck is the only one asked with --version': () => {
		assert.deepStrictEqual(versionArgs('staticcheck'), ['--version']);
		for (const id of ['go', 'gopls', 'dlv']) {
			assert.deepStrictEqual(versionArgs(id), ['version']);
		}
	},

	'the Go minor is the pin key': () => {
		assert.strictEqual(goMinor('go1.24.1'), '1.24');
		assert.strictEqual(goMinor('go1.25'), '1.25');
		assert.strictEqual(goMinor('go1.24rc1'), '1.24');
		assert.strictEqual(goMinor(undefined), undefined);
		assert.strictEqual(goMinor('v0.20.0'), undefined, 'a tool version is not a Go version');
	},

	'no install command is ever @latest for gopls or dlv': () => {
		// The trap this exists for, recorded in the repo's own invariant: a gopls
		// whose go.mod outruns the host toolchain fails INSIDE `go install`, with an
		// error about a module the reader never mentioned. gopls v0.22.0 needs Go
		// 1.26; installing it on 1.24 is that failure exactly.
		for (const version of ['go1.24.1', 'go1.25.0', 'go1.26.0']) {
			for (const id of ['gopls', 'dlv']) {
				const plan = installPlan(id, version);
				if (isInstallable(plan)) {
					assert.ok(!plan.command.includes('@latest'), `${id} on ${version} offered @latest`);
					assert.match(plan.command, /@v\d/, `${id} on ${version} must name a version`);
				}
			}
		}
	},

	'every install runs with GOTOOLCHAIN=local': () => {
		// Without it, `go install` reads the tool's own go.mod, decides the host Go
		// is too old, and silently downloads a different toolchain to build it —
		// which is how a machine ends up with a gopls built against a Go the IDE
		// is not using.
		for (const id of ['gopls', 'dlv', 'staticcheck']) {
			const plan = installPlan(id, 'go1.24.1');
			assert.ok(isInstallable(plan), `${id} should be installable on 1.24`);
			assert.strictEqual(plan.env.GOTOOLCHAIN, 'local');
		}
	},

	'the pins are the recorded ones': () => {
		assert.deepStrictEqual(pinsFor('1.25'), { gopls: 'v0.21.1', dlv: 'v1.27.0' });
		assert.strictEqual(pinsFor('1.24').gopls, 'v0.20.0');
		assert.strictEqual(pinsFor('1.26').gopls, 'v0.22.0');
		assert.deepStrictEqual(pinsFor('1.19'), {}, 'an unrecorded minor has no pins');
		assert.deepStrictEqual(pinsFor(undefined), {});
	},

	'an unknown Go minor gets a reason, not a guess': () => {
		const plan = installPlan('gopls', 'go1.19.0');
		assert.ok(!isInstallable(plan));
		assert.match(plan.reason, /no recorded gopls pin for Go 1\.19/);
		assert.match(plan.reason, /outruns this toolchain/, 'the reason must say what would go wrong');

		const noGo = installPlan('dlv', undefined);
		assert.ok(!isInstallable(noGo));
		assert.match(noGo.reason, /no Go minor/);
	},

	'Go itself is not installed by Go': () => {
		const plan = installPlan('go', 'go1.24.1');
		assert.ok(!isInstallable(plan));
		assert.match(plan.reason, /go\.dev\/dl/);
	},

	'staticcheck says @latest is the honest answer': () => {
		// It is optional, it has no recorded pin, and its release policy tracks the
		// two most recent Go releases — so it is the one place the table does not
		// pretend to cover.
		const plan = installPlan('staticcheck', 'go1.19.0');
		assert.ok(isInstallable(plan));
		assert.match(plan.command, /honnef\.co\/go\/tools\/cmd\/staticcheck@latest/);
	},

	'the status line names what is missing rather than claiming ok': () => {
		// A bar reading "go 1.24 · gopls ok · dlv ok" while dlv is absent is not a
		// summary, it is a claim — and the reader debugs for ten minutes before
		// finding out.
		const missingDlv = summarise([
			{ id: 'go', version: 'go1.24.1' }, { id: 'gopls', version: 'v0.20.0' }, { id: 'dlv' },
		]);
		assert.strictEqual(missingDlv.healthy, false);
		assert.deepStrictEqual([...missingDlv.missing], ['dlv']);
		assert.strictEqual(missingDlv.text, 'dlv missing');

		const missingBoth = summarise([{ id: 'go', version: 'go1.24.1' }]);
		assert.strictEqual(missingBoth.text, 'gopls + dlv missing');
	},

	'a healthy toolchain reads as the Go minor': () => {
		const ok = summarise([
			{ id: 'go', version: 'go1.24.1' }, { id: 'gopls', version: 'v0.20.0' }, { id: 'dlv', version: 'v1.25.2' },
		]);
		assert.strictEqual(ok.healthy, true);
		assert.strictEqual(ok.text, 'go 1.24 · gopls ok · dlv ok');
		assert.deepStrictEqual([...ok.missing], []);
	},

	'staticcheck missing is not unhealthy': () => {
		// Optional tools must not turn the bar orange. The lint task degrades to
		// `go vet` and says so; nothing else notices.
		const ok = summarise([
			{ id: 'go', version: 'go1.24.1' }, { id: 'gopls', version: 'v0.20.0' }, { id: 'dlv', version: 'v1.25.2' },
		]);
		assert.strictEqual(ok.healthy, true);
		assert.strictEqual(TOOLS.find((t) => t.id === 'staticcheck').required, false);
	},

	'every tool says what it provides': () => {
		for (const tool of TOOLS) {
			assert.ok(tool.label && tool.provides, `${tool.id} is missing a field`);
		}
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
