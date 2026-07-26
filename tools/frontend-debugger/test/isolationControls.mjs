/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// End-to-end checks for the isolation harness's PROPS PANEL: the typed controls,
// the resizable panel, and the top bar's fit at a narrow canvas column.
//
// Separate from verify.mjs on purpose. That suite walks the whole app (agent,
// tree, styles, modes) and takes minutes; this one needs only the harness page,
// so it stays fast enough to run after every edit to isolateHarness.js.
//
// Run (needs the app running, per CLAUDE.md):
//   node test/isolationControls.mjs
//   UI_URL=http://localhost:6380 node test/isolationControls.mjs
//
// The schema is supplied EXPLICITLY through the query param rather than parsed
// from a real component, so these assertions describe the controls and do not
// move when merkle's props do. The module only has to mount — but it must be
// one with NO colocated .samples file: a samples file outranks URL-seeded props
// in the harness's precedence, and would quietly replace this fixture's values.

import { chromium } from 'playwright'

const UI = process.env.UI_URL || 'http://localhost:6080'

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
	if (cond) {
		pass++
		console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`)
	} else {
		fail++
		console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`)
	}
}

const SCHEMA = JSON.stringify([
	{ name: 'variant', required: false, kind: 'enum', options: ['primary', 'outline', 'ghost', 'danger'] },
	{ name: 'loading', required: false, kind: 'boolean' },
	{ name: 'radius', required: false, kind: 'number' },
	{ name: 'elevation', required: false, kind: 'number' },
	{ name: 'zIndex', required: false, kind: 'number' },
	{ name: 'opacity', required: false, kind: 'number' },
	{ name: 'accentColor', required: false, kind: 'string' },
	{ name: 'themeColor', required: false, kind: 'string' },
	{ name: 'bio', required: false, kind: 'string' },
	{ name: 'mode', required: false, kind: 'enum', options: ['alpha', 'beta', 'gamma', 'delta', 'epsilon'] },
	{ name: 'rows', required: false, kind: 'array', shape: [1, 2] },
	{ name: 'onPick', required: false, kind: 'function' },
])
const PROPS = JSON.stringify({
	radius: 8, opacity: 0.85, zIndex: 9999, elevation: 3,
	accentColor: '#2f81f7', themeColor: 'var(--nope-undefined)', bio: 'x'.repeat(90),
})

console.log('=== isolation controls ===')

const cfg = await fetch(UI + '/api/config').then((r) => r.json())
const target = new URL(cfg.targetUrl)
const base = target.pathname.endsWith('/') ? target.pathname : target.pathname + '/'
const MODULE = 'src/primitives/button/Button.tsx'
const url = `${target.origin}${base}__isolate?module=${encodeURIComponent(MODULE)}&export=Button`
	+ `&schema=${encodeURIComponent(SCHEMA)}&props=${encodeURIComponent(PROPS)}`

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => {
	const t = m.text()
	// This fixture feeds the component props it does not declare, and it
	// spreads the rest onto its DOM node — React's unknown-attribute warning is
	// the fixture's doing, not the harness's.
	if (m.type() === 'error' && !/does not recognize the .* prop on a DOM element/.test(t)) {
		errors.push(t)
	}
})

await page.goto(url, { waitUntil: 'load' })
await page.waitForSelector('#iso-body .prow[data-prop]', { timeout: 20000 })
await page.waitForTimeout(800)

const row = (n) => page.locator(`.prow[data-prop="${n}"]`)
const q = (n, sel) => page.locator(`.prow[data-prop="${n}"] ${sel}`)

// --- one control per kind ---------------------------------------------------
ok('boolean renders a toggle switch, not a checkbox',
	(await q('loading', '.sw').count()) === 1 && (await page.locator('.prow input[type=checkbox]').count()) === 0)
ok('a short enum renders a segmented control', (await q('variant', '.seg .seg-b').count()) === 4)
ok('a long enum falls back to a dropdown',
	(await q('mode', 'select').count()) === 1 && (await q('mode', '.seg').count()) === 0)
ok('an unset optional enum offers an unset option', (await q('mode', 'select').inputValue()) === '')
ok('a named number gets a slider; an unnamed one does not',
	(await q('radius', 'input[type=range]').count()) === 1 && (await q('elevation', 'input[type=range]').count()) === 0)
ok('opacity infers a 0..1 range',
	(await q('opacity', 'input[type=range]').getAttribute('max')) === '1'
	&& (await q('opacity', 'input[type=range]').getAttribute('step')) === '0.01')
// The rule that keeps a loosely-matched name safe: widen the track, never move
// the value. zIndex matches on '...index' and must not be snapped to 100.
ok('a matched range widens rather than clamping the value',
	Number(await q('zIndex', 'input[type=range]').getAttribute('max')) >= 9999
	&& (await q('zIndex', 'input.numfield').inputValue()) === '9999')
ok('a number label is drag-scrubbable', (await q('radius', '.pname.scrub').count()) === 1)
ok('a hex string gets a colour swatch', (await q('accentColor', 'input[type=color]').count()) === 1)
ok('an unresolvable token leaves the picker inert, text authoritative',
	(await q('themeColor', '.colrow').getAttribute('class') || '').includes('unknown'))
ok('a long string grows into a textarea', (await q('bio', 'textarea.grow').count()) === 1)
ok('object props keep the JSON editor', (await q('rows', 'textarea').count()) === 1)
ok('function props stay a static stub', (await q('onPick', '.stub').count()) === 1)

// --- geometry: presence is not enough ---------------------------------------
// A generic `.prow input[type=number] { width: 100% }` once out-specified the
// field rule and collapsed the slider to zero while every count check passed.
const nf = await q('radius', 'input.numfield').boundingBox()
const sl = await q('radius', 'input[type=range]').boundingBox()
ok('the number field keeps its fixed width', Math.round(nf.width) === 72, `${Math.round(nf.width)}px`)
ok('the slider has real width beside it', sl.width > 60, `${Math.round(sl.width)}px`)

// --- the no-rebuild invariant -----------------------------------------------
// Every control repairs its own row; none calls buildPanel(). If that ever
// regresses, a half-typed JSON edit elsewhere in the panel is silently lost.
await q('rows', 'textarea').fill('[1, 2, 3')
await q('radius', 'input.numfield').fill('16')
await page.waitForTimeout(400)
ok('a half-typed JSON edit survives an edit in another row',
	(await q('rows', 'textarea').inputValue()) === '[1, 2, 3')
ok('invalid JSON is flagged, not applied',
	(await q('rows', 'textarea').getAttribute('class') || '').includes('invalid'))
await q('radius', '.reset').click()
await page.waitForTimeout(300)
ok('the per-prop reset clears only its own row', (await q('radius', 'input.numfield').inputValue()) === '')
ok('and leaves the neighbour mid-edit intact', (await q('rows', 'textarea').inputValue()) === '[1, 2, 3')

// --- filter -----------------------------------------------------------------
ok('the filter appears past the threshold', (await page.locator('#iso-filter').count()) === 1)
await page.locator('#iso-filter').fill('color')
await page.waitForTimeout(200)
const shown = await page.evaluate(() => [...document.querySelectorAll('.prow[data-prop]')]
	.filter((r) => !r.classList.contains('filtered')).map((r) => r.getAttribute('data-prop')))
ok('the filter narrows by prop name', shown.length === 2 && shown.every((s) => /color/i.test(s)), shown.join(','))
await page.locator('#iso-filter').fill('')
await page.waitForTimeout(200)

// --- panel resize -----------------------------------------------------------
const grip = await page.locator('#iso-grip').boundingBox()
const w0 = (await page.locator('#iso-panel').boundingBox()).width
await page.mouse.move(grip.x + 2, grip.y + 120)
await page.mouse.down()
await page.mouse.move(grip.x - 80, grip.y + 120, { steps: 8 })
await page.mouse.up()
await page.waitForTimeout(250)
const w1 = (await page.locator('#iso-panel').boundingBox()).width
ok('the panel is drag-resizable', w1 > w0 + 40, `${Math.round(w0)} → ${Math.round(w1)}`)
ok('the width is persisted', !!(await page.evaluate(() => localStorage.getItem('burrow.iso.panelWidth'))))

// --- narrow column ----------------------------------------------------------
await page.setViewportSize({ width: 430, height: 900 })
await page.waitForTimeout(500)
const pw = (await page.locator('#iso-panel').boundingBox()).width
ok('the panel re-clamps so the canvas is never starved', pw <= 430 - 200 + 1, `${Math.round(pw)}px`)
const truncated = await page.evaluate(() => [...document.querySelectorAll('.prow[data-prop="variant"] .seg-b')]
	.filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => b.textContent))
ok('segments stay readable at the minimum panel width', truncated.length === 0, truncated.join(','))
const topCls = await page.locator('#iso-top').getAttribute('class') || ''
ok('the top bar collapses instead of clipping', /tight/.test(topCls), `class="${topCls}"`)
ok('its actions survive the collapse', await page.locator('#iso-top .rgroup .tbtn').last().isVisible())
ok('and nothing overflows the page', await page.evaluate(
	() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1))
await page.setViewportSize({ width: 1200, height: 900 })
await page.waitForTimeout(500)
ok('the top bar expands again when there is room',
	!/tight/.test(await page.locator('#iso-top').getAttribute('class') || ''))

ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))

await browser.close()
console.log(`\nVERDICT: ${fail ? 'fail' : 'pass'} (${pass}/${pass + fail})`)
process.exit(fail ? 1 : 0)
