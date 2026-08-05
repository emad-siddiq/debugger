/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// The design document's numbers, held against a live run of the planner.
//
// WHY A TEST AND NOT A GENERATOR. `08-scratch-mode.md` is an argument written by
// a person, with figures in it; generating the file would mean generating the
// prose, and generating only a fragment would put a build step between an editor
// and a paragraph. So the numbers live in ONE table, the prose points at that
// table rather than repeating it, and this fails when the table and the planner
// disagree. `--write` rewrites the table, which is the generator half without
// the build step.
//
// It needs the reference project, because every figure is a fact ABOUT that
// project. Absent, it SKIPS OUT LOUD rather than passing quietly — a test that
// silently does nothing is how a table goes stale in the first place.
//
// Run: `npm test`, or `node test/docCounts.test.js --write` after a real change.

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DOC = path.resolve(__dirname, '../../../../.claude/docs/plans/08-scratch-mode.md');
const REFERENCE = process.env.BURROW_SCRATCH_REFERENCE || path.join(os.homedir(), 'Projects', 'merkle');
const WRITE = process.argv.includes('--write');

/** Rows of the `<!-- measured -->` table, in the order they are rendered. */
function measure() {
	const { scanProject } = require('../out/scan');
	const { buildPlan, orderViolations } = require('../out/planModel');
	const { files, skipped } = scanProject(REFERENCE);
	const plan = buildPlan(files, { name: 'merkle', reference: REFERENCE });
	const order = plan.stages.flatMap((s) => s.steps);
	const all = Object.values(plan.steps);
	const at = (id) => order.indexOf(id) + 1;
	const stageOf = (id) => plan.stages.findIndex((s) => s.id === plan.steps[id].stage) + 1;
	const cls = (c) => plan.stages.filter((s) => s.cls === c).reduce((n, s) => n + s.steps.length, 0);
	const mode = (m) => all.filter((s) => s.mode === m).length;
	const content = (s) => s.checks.some((c) => c.kind !== 'exists');
	const write = all.filter((s) => s.mode === 'write');
	const violations = orderViolations(plan);
	// WO-86's figures: the shape of the journey, measured the same way.
	const modules = new Set(order.map((id) => (id.includes('/') ? id.slice(0, id.indexOf('/')) : '(root)')));
	const runs = [];
	let run = 0;
	for (const id of order) {
		if (plan.steps[id].mode === 'copy') { run++; } else { if (run) { runs.push(run); } run = 0; }
	}
	if (run) { runs.push(run); }
	const bigRuns = runs.filter((r) => r >= 50);
	const allCopyStages = plan.stages.filter((s) => s.steps.length && s.steps.every((id) => plan.steps[id].mode === 'copy'));
	const claudeSteps = order.filter((id) => id.startsWith('.claude/'));
	const longest = all.reduce((a, b) => (b.lines > a.lines ? b : a), all[0]);
	const longestTyped = write.reduce((a, b) => (b.lines > a.lines ? b : a), write[0]);
	const tenth = Math.round(order.length * 0.1);
	let tenthLines = 0;
	for (let i = 0; i < tenth; i++) {
		tenthLines += plan.steps[order[i]].lines;
	}
	return [
		['source files scanned', files.length],
		['binary or oversized, skipped by the scan', skipped],
		['stages', plan.counts.stages],
		['steps', plan.counts.steps],
		['lines in the reference', plan.counts.lines],
		['steps — Foundations', cls('foundations')],
		['steps — schema', cls('schema')],
		['steps — Go packages', cls('go')],
		['steps — web', cls('web')],
		['steps — supporting', cls('rest')],
		['steps you write', mode('write')],
		['steps you copy', mode('copy')],
		['steps a command writes', mode('generate')],
		['forward-dependency edges', violations.length],
		['of those, genuine cycles', violations.filter((v) => v.cyclic).length],
		['of those, avoidable ordering defects', violations.filter((v) => !v.cyclic).length],
		['distinct steps naming a later dependency', new Set(violations.filter((v) => !v.cyclic).map((v) => v.step)).size],
		['write steps carrying a check that can fail on wrong content', write.filter(content).length],
		['steps whose only check is that the file exists', all.filter((s) => !content(s)).length],
		['stages carrying a runtime dependency install', plan.stages.filter((s) => s.setup.length).length],
		['step index — backend/go.mod', at('backend/go.mod')],
		['step index — frontend/package.json', at('frontend/package.json')],
		['step index — frontend/package-lock.json', at('frontend/package-lock.json')],
		['step index — the first file importing a runtime dependency', at('frontend/src/primitives/chain-icon/ChainIcon.tsx')],
		['stage index — backend/router.go', stageOf('backend/router.go')],
		['stage index — frontend/src/main.tsx', stageOf('frontend/src/main.tsx')],
		['first tenth of the plan — files', tenth],
		['first tenth of the plan — lines', tenthLines],
		['modules', modules.size],
		['stages that are entirely copy steps', allCopyStages.length],
		['unbroken runs of copy steps', runs.length],
		['longest unbroken run of copy steps', Math.max(...runs)],
		['copy steps inside runs of 50 or more', bigRuns.reduce((n, r) => n + r, 0)],
		['.claude — steps', claudeSteps.length],
		['.claude — copy steps', claudeSteps.filter((id) => plan.steps[id].mode === 'copy').length],
		['the longest single file — lines', longest.lines],
		['the longest file you type — lines', longestTyped.lines],
	];
}

const BEGIN = '<!-- measured: `node extensions/burrow-scratch/test/docCounts.test.js --write` -->';
const END = '<!-- /measured -->';
const fmt = (n) => n.toLocaleString('en-US');

function render(rows) {
	return [BEGIN, '', '| | |', '|---|---|', ...rows.map(([k, v]) => `| ${k} | **${fmt(v)}** |`), '', END].join('\n');
}

if (!fs.existsSync(REFERENCE)) {
	console.log(`  ⚠ SKIPPED — no reference project at ${REFERENCE}.`);
	console.log('    These figures are facts about that project; set BURROW_SCRATCH_REFERENCE to assert them.');
	console.log('0/0 passed (skipped)');
	process.exit(0);
}

const doc = fs.readFileSync(DOC, 'utf8');
const rows = measure();
const start = doc.indexOf(BEGIN);
const end = doc.indexOf(END);

if (WRITE) {
	assert.ok(start >= 0 && end > start, 'the measured block is not in the document');
	fs.writeFileSync(DOC, doc.slice(0, start) + render(rows) + doc.slice(end + END.length));
	console.log(`  ✓ rewrote ${rows.length} rows in ${path.basename(DOC)}`);
	process.exit(0);
}

let failed = 0;
let CHECKS = 0;
const check = (name, run) => {
	CHECKS++;
	try {
		run();
		console.log(`  ✓ ${name}`);
	} catch (error) {
		failed++;
		console.error(`  ✗ ${name}\n    ${error.message}`);
	}
};

check('the design document carries the measured block', () => {
	assert.ok(start >= 0 && end > start, `08-scratch-mode.md has no measured block — run with --write`);
});

check('every figure in the block is what the planner produces today', () => {
	const block = doc.slice(start, end);
	const missing = [];
	for (const [key, value] of rows) {
		const line = block.split('\n').find((l) => l.startsWith(`| ${key} |`));
		if (!line) {
			missing.push(`${key}: no row`);
		} else if (!line.includes(`**${fmt(value)}**`)) {
			missing.push(`${key}: document says ${line.split('|')[2].trim()}, planner says **${fmt(value)}**`);
		}
	}
	assert.deepStrictEqual(missing, [], `run \`node test/docCounts.test.js --write\`:\n  ${missing.join('\n  ')}`);
});

/**
 * Figures the prose is allowed to state that the planner cannot produce.
 *
 * One entry, and it earns its place: `1,680` is how many steps had nothing but
 * `exists` between them and a green tick BEFORE this was fixed. It is history —
 * re-measuring it is impossible, and dropping it would leave §3 explaining a fix
 * without the size of what it fixed. Everything else with a thousands separator
 * has to come from the table.
 */
const HISTORICAL = ['1,680'];

check('no plan figure appears in the prose except from the table', () => {
	// The authoring rule this enforces: big numbers live in ONE place. A figure
	// written into a paragraph is a figure that stops being true without anything
	// failing, which is how this document came to describe a plan it no longer had.
	const body = doc.slice(0, start) + doc.slice(end + END.length);
	const allowed = new Set([...rows.map(([, v]) => fmt(v)), ...HISTORICAL]);
	const loose = [...body.matchAll(/\d{1,3}(?:,\d{3})+/g)].map((m) => m[0]).filter((n) => !allowed.has(n));
	assert.deepStrictEqual([...new Set(loose)], [], 'figures in the prose that are not in the measured table');
});

check('the journey section describes the surfaces that exist', () => {
	// §8's claims, held against the code rather than against a memory of it.
	// Every one of these is a sentence in the document that would otherwise stop
	// being true without anything failing.
	const journey = require('../out/journey');
	const pages = require('../out/journeyPages');
	const { scanProject } = require('../out/scan');
	const { buildPlan } = require('../out/planModel');
	const { emptyProgress } = require('../out/progressModel');
	const plan = buildPlan(scanProject(REFERENCE).files, { name: 'merkle', reference: REFERENCE });
	const blank = emptyProgress('2026-08-05T00:00:00.000Z');

	// "three levels — module, stage, file"
	const groups = journey.modulesOf(plan);
	assert.ok(groups.length > 1 && groups.every((g) => g.stages.length), 'stages group into modules');
	assert.strictEqual(groups.reduce((n, g) => n + g.stages.length, 0), plan.stages.length);

	// "progress is lines, not files"
	const order = plan.stages.flatMap((s) => [...s.steps]);
	assert.strictEqual(journey.lineProgress(plan, blank, order).lines, plan.counts.lines);

	// "next in this stage, else the first file of the next stage whose needs are met"
	const first = plan.stages[0];
	assert.strictEqual(journey.nextActionable(plan, blank, first.steps[0]), first.steps[1],
		'the offer is the next file in the stage you are standing in');

	// "one action per stage brings its copy steps in"
	const allCopy = plan.stages.find((s) => s.steps.length > 1 && s.steps.every((id) => plan.steps[id].mode === 'copy'));
	assert.ok(allCopy, 'the plan has a stage that is entirely copy steps');
	assert.strictEqual(journey.copySteps(plan, allCopy.id).length, allCopy.steps.length);
	assert.ok(/data-act="materialize"/.test(pages.stagePageHtml(plan, blank, allCopy.id, '')),
		'and its page offers the one action');

	// "the front door states the size before the location is asked for"
	const door = pages.frontDoorHtml(plan, '');
	assert.ok(door.includes(plan.counts.lines.toLocaleString('en-US')), 'the front door carries the line total');
	assert.ok(door.includes(`${plan.stages.length} stages`), 'and the stage count');
});

check('the kinds and modes the prose names are the kinds the plan emits', () => {
	const { scanProject } = require('../out/scan');
	const { buildPlan } = require('../out/planModel');
	const plan = buildPlan(scanProject(REFERENCE).files, { name: 'merkle', reference: REFERENCE });
	// Every claim §7 makes about a specific step, checked against the plan rather
	// than against the last time somebody looked.
	assert.strictEqual(plan.steps['backend/go.mod'].mode, 'generate');
	assert.strictEqual(plan.steps['frontend/package.json'].mode, 'write');
	assert.ok(plan.steps['frontend/package.json'].derived?.length, 'the manifest step carries a derived install');
	assert.strictEqual(plan.steps['frontend/package-lock.json'].mode, 'generate');
	assert.strictEqual(plan.steps['frontend/package-lock.json'].stage, 'frontend/src/primitives/chain-icon');
	assert.strictEqual(plan.steps['backend/go.sum'], undefined, 'go.sum is not a step');
	assert.strictEqual(plan.steps['package-lock.json'], undefined, 'the orphan lockfile is not a step');
	assert.deepStrictEqual(plan.stages[0].setup, [], 'Foundations installs nothing');
	assert.strictEqual(plan.stages[1].id, 'backend/migrations');
	assert.strictEqual(plan.stages[2].id, 'test/oracle');
});

console.log(`${CHECKS - failed}/${CHECKS} passed`);
process.exit(failed ? 1 : 0);
