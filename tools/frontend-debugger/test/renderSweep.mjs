// renderSweep.mjs — WO-13 (docs/plans 04 §1): the render triage sweep + permanent gate.
//
// Isolates EVERY component the tool can discover and records how it renders, so
// the "several components don't render at all" problem becomes an exact fix list
// instead of an anecdote. Playwright drives the running FD sidecar; each
// component is opened in the real isolation harness (`…/__isolate?module=…`) and
// classified from the rendered DOM + console:
//
//   ok        — the harness root has real height, no error box, no page error
//   blank     — rendered but ~zero height / empty (CSS-only or needs sizing)
//   throws    — the harness error boundary caught, or a pageerror/console.error
//   no-export — the module has no component export (a hook/util/barrel .tsx) — informational, not a gate failure
//   appOnly   — listed in test/sweep.appOnly.json (page-scale, "open in app") — excluded from the gate
//
// Output: docs/render-sweep.md (the fix list, clustered by suspected cause) +
// a screenshot per non-ok component under docs/render-sweep/.
//
// Gate: `npm run sweep` exits non-zero unless the sweep is "0 blank, 0 throws"
// (appOnly + no-export excluded). Re-run in 05 Pass 2 (P2-3).
//
// Usage:
//   npm run sweep                         # sidecar must be up + chromium installed
//   UI_URL=http://localhost:6081 npm run sweep
//   MERKLE_FRONTEND_DIR=~/src/merkle/frontend npm run sweep
//   SWEEP_LIMIT=20 npm run sweep          # first N components (smoke)
//   SWEEP_SHOTS=all npm run sweep         # screenshot every component, not just non-ok
//   SWEEP_ONLY=Badge,DataTable npm run sweep   # substring filter on module path
//
// Preconditions: an instance is up (Burrow spawns it, or `npm run serve`/`dev`)
// and `npx playwright install chromium` has been run. Discovery is a static scan
// of the target frontend's src/ for PascalCase-exporting .tsx (mirroring the
// server's own isAppSource/srcFilesUnder) — there is no single "list components"
// endpoint, and the gallery ultimately resolves to these source modules.
import { chromium } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const UI = process.env.UI_URL || 'http://localhost:6080'
const FRONTEND_DIR =
  process.env.MERKLE_FRONTEND_DIR ||
  (process.env.MERKLE_REPO_ROOT && path.join(process.env.MERKLE_REPO_ROOT, 'frontend')) ||
  path.join(os.homedir(), 'Projects/merkle/frontend')
const LIMIT = Number(process.env.SWEEP_LIMIT || 0) || Infinity
const SHOTS = process.env.SWEEP_SHOTS || 'nonok' // 'nonok' | 'all' | 'none'
const ONLY = (process.env.SWEEP_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean)
const OUT_MD = process.env.SWEEP_OUT || path.join(ROOT, 'docs/render-sweep.md')
const SHOT_DIR = path.join(ROOT, 'docs/render-sweep')
const APPONLY_FILE = path.join(ROOT, 'test/sweep.appOnly.json')
const PER_PAGE_MS = Number(process.env.SWEEP_PAGE_MS || 12000)
const SETTLE_MS = Number(process.env.SWEEP_SETTLE_MS || 900)

const die = (msg, code = 2) => { console.error(msg); process.exit(code) }

// ── discover components (static scan, mirrors server/api.js isAppSource) ──────
const SKIP_DIRS = new Set(['node_modules', 'test', 'tests', '__tests__', '__mocks__', '__snapshots__'])
const isComponentFile = (name) =>
  name.endsWith('.tsx') &&
  /^[A-Z]/.test(name) && // PascalCase basename ⇒ a component, not a hook/util
  !/\.(test|spec|stories|samples)\.tsx$/.test(name)

function discover(dir, srcRoot, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) discover(abs, srcRoot, out)
    else if (isComponentFile(entry.name)) out.push('src/' + path.relative(srcRoot, abs).split(path.sep).join('/'))
  }
  return out
}

const srcDir = path.join(FRONTEND_DIR, 'src')
if (!fs.existsSync(srcDir)) die(`BLOCKED — target frontend src not found at ${srcDir} (set MERKLE_FRONTEND_DIR).`)

let modules = discover(srcDir, srcDir).sort()
if (ONLY.length) modules = modules.filter((m) => ONLY.some((o) => m.includes(o)))
modules = modules.slice(0, LIMIT)
if (!modules.length) die('BLOCKED — no component modules discovered.')

const appOnly = new Set(
  fs.existsSync(APPONLY_FILE) ? JSON.parse(fs.readFileSync(APPONLY_FILE, 'utf8')) : [],
)

// ── connect to the sidecar ────────────────────────────────────────────────────
let cfg
try {
  cfg = await fetch(UI + '/api/config').then((r) => r.json())
} catch {
  die(`BLOCKED — no sidecar at ${UI} (start it: npm run serve, or Burrow spawns it).`)
}
const target = new URL(cfg.targetUrl)
const base = target.pathname.endsWith('/') ? target.pathname : target.pathname + '/'
// The IDE does not open a bare isolate URL — it parses the component's props
// type and seeds the URL with a synthesized skeleton + the typed schema
// (isolation.ts). Sweeping without that measures a surface no user ever sees,
// and would report every prop-driven component as broken. Load the extension's
// OWN compiled parser so the sweep exercises the same code path; if the
// extension has not been compiled, fall back to bare URLs and say so.
let parsePropsSchema, makeTypeResolver
try {
  const ext = new URL('../../../extensions/burrow-frontend-debugger/out/', import.meta.url)
  ;({ parsePropsSchema } = await import(new URL('propsSkeleton.js', ext).href))
  ;({ makeTypeResolver } = await import(new URL('typeResolver.js', ext).href))
} catch {
  console.log('  note: burrow-frontend-debugger is not compiled — sweeping WITHOUT prop synthesis')
}

const SAMPLE_EXTS = ['ts', 'tsx', 'js', 'jsx']
const hasSamples = (abs) => {
  const stem = abs.replace(/\.[jt]sx?$/, '')
  return SAMPLE_EXTS.some((e) => fs.existsSync(`${stem}.samples.${e}`))
}

/** The isolate URL the IDE would open for this module. */
function isoUrl(mod) {
  const q = new URLSearchParams({ module: mod })
  if (parsePropsSchema) {
    const abs = path.join(FRONTEND_DIR, mod)
    let source = null
    try { source = fs.readFileSync(abs, 'utf8') } catch { /* unreadable → bare URL */ }
    const stem = path.basename(mod).replace(/\.[jt]sx?$/, '')
    const schema = source ? parsePropsSchema(source, stem, makeTypeResolver(abs, FRONTEND_DIR)) : undefined
    if (schema) {
      if (schema.specs.length) q.set('schema', JSON.stringify(schema.specs))
      // Samples outrank synthesis, exactly as the extension decides it.
      if (schema.required.length && !hasSamples(abs)) {
        q.set('props', JSON.stringify(schema.skeleton))
        q.set('propsSource', 'synth')
      }
    }
  }
  return `${target.origin}${base}__isolate?${q.toString()}`
}

let browser
try {
  browser = await chromium.launch()
} catch {
  die('BLOCKED — could not launch Chromium. Run: npx playwright install chromium')
}

fs.mkdirSync(SHOT_DIR, { recursive: true })

// ── suspected-cause heuristic (maps a failure to the plan's fix clusters) ─────
function suspectedCause(status, errText, height) {
  const e = (errText || '').toLowerCase()
  if (status === 'throws') {
    // A null-React-internal hook (useContext/useRef/useState/useMemo landing in
    // node_modules/.vite/deps/react-*) means a bundled lib pulled a SECOND React
    // copy — a harness dedupe problem, not a prop problem. Check this first.
    if (/invalid hook call|reading '(usecontext|useref|usestate|usememo|useeffect|usereducer|usecallback)'/.test(e))
      return 'duplicate React in isolate harness → dedupe react/react-dom (harness/tooling)'
    if (/useparams|match\.params|route param|:id/.test(e)) return 'needs router params → harness `sampleRoute` (§2.4)'
    if (/element type is invalid|forgot to export/.test(e)) return 'bad/missing export or undefined child component'
    if (/cannot read propert.*of undefined|reading '(map|length|rows|data|series|items|filter|forEach|find|reduce|slice|split|id)'/.test(e))
      return 'required data prop missing → type-driven synthesis (§2)'
    if (/usecontext|provider|context.*undefined|store/.test(e)) return 'missing provider/store → add to burrow.isolate.tsx Providers (merkle)'
    if (/fetch|network|failed to load|usequery|swr/.test(e)) return 'needs query/fetch on mount → devMock fixture (merkle)'
    return 'runtime throw — inspect stack'
  }
  if (status === 'blank') {
    if (height === 0) return 'CSS-only/zero-height → default stage min-height + checker bg (harness)'
    return 'renders empty → likely required data prop (§2)'
  }
  return ''
}

// ── the sweep ─────────────────────────────────────────────────────────────────
const rows = []
const safe = (m) => m.replace(/[^\w.-]+/g, '_')
const t0 = Date.now()

for (let i = 0; i < modules.length; i++) {
  const mod = modules[i]
  if (appOnly.has(mod)) { rows.push({ mod, status: 'appOnly', height: null, err: '' }); continue }

  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e.message || e)))
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()) })

  let status = 'ok', height = 0, err = ''
  try {
    await page.goto(isoUrl(mod), { waitUntil: 'load', timeout: PER_PAGE_MS })
    await page.waitForTimeout(SETTLE_MS)

    const errBox = await page.locator('.burrow-iso-error').first()
    const hasErrBox = (await errBox.count()) > 0
    const errBoxText = hasErrBox ? ((await errBox.textContent()) || '').trim() : ''

    if (hasErrBox && /no component export found/i.test(errBoxText)) {
      status = 'no-export'; err = 'no component export'
    } else if (hasErrBox || errs.length) {
      status = 'throws'; err = (errBoxText || errs[0] || 'error').split('\n').slice(0, 3).join(' ').slice(0, 240)
    } else {
      const box = await page.locator('#burrow-iso-root').first().boundingBox().catch(() => null)
      height = box ? Math.round(box.height) : 0
      const text = ((await page.locator('#burrow-iso-root').first().textContent().catch(() => '')) || '').trim()
      const kids = await page.locator('#burrow-iso-root > *').count().catch(() => 0)
      status = (height <= 3 && !text && kids === 0) ? 'blank' : 'ok'
    }

    const shoot = SHOTS === 'all' || (SHOTS === 'nonok' && status !== 'ok' && status !== 'no-export')
    if (shoot) await page.screenshot({ path: path.join(SHOT_DIR, safe(mod) + '.png') }).catch(() => {})
  } catch (e) {
    status = 'throws'; err = ('load timeout/nav: ' + (e.message || e)).slice(0, 200)
  } finally {
    await page.close().catch(() => {})
  }

  rows.push({ mod, status, height, err })
  const mark = { ok: 'ok  ', blank: 'BLANK', throws: 'THROW', 'no-export': 'skip', appOnly: 'app ' }[status]
  process.stdout.write(`  ${mark}  ${mod}${status === 'throws' || status === 'blank' ? '  — ' + suspectedCause(status, err, height) : ''}\n`)
}

await browser.close()

// ── write the report ──────────────────────────────────────────────────────────
const count = (s) => rows.filter((r) => r.status === s).length
const nOk = count('ok'), nBlank = count('blank'), nThrow = count('throws'), nSkip = count('no-export'), nApp = count('appOnly')
const secs = ((Date.now() - t0) / 1000).toFixed(0)

const esc = (s) => String(s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
let md = `# Render sweep — merkle components in isolation\n\n`
md += `Generated by \`test/renderSweep.mjs\` (WO-13, docs/plans/04 §1) against \`${cfg.targetUrl}\`.\n`
md += `Discovery: static scan of \`${path.relative(os.homedir(), srcDir)}\` (PascalCase \`.tsx\`, excl. test/spec/stories/samples).\n\n`
md += `**${modules.length} components · ${nOk} ok · ${nBlank} blank · ${nThrow} throws · ${nSkip} no-export · ${nApp} appOnly · ${secs}s**\n\n`
md += `**Gate:** ${nBlank + nThrow === 0 ? '✅ 0 blank, 0 throws' : `❌ ${nBlank} blank, ${nThrow} throws`}\n\n`

const failing = rows.filter((r) => r.status === 'blank' || r.status === 'throws')
if (failing.length) {
  md += `## To fix (${failing.length})\n\n| Component | Status | H | Suspected cause | Error |\n|---|---|---|---|---|\n`
  for (const r of failing) {
    const name = r.mod.split('/').pop().replace(/\.tsx$/, '')
    md += `| \`${name}\`<br>\`${r.mod}\` | ${r.status} | ${r.height ?? ''} | ${esc(suspectedCause(r.status, r.err, r.height))} | ${esc(r.err)} |\n`
  }
  md += `\n`
}
md += `## All components\n\n| Component | Status | Height | Note |\n|---|---|---|---|\n`
for (const r of rows) {
  const name = r.mod.split('/').pop().replace(/\.tsx$/, '')
  md += `| \`${name}\` | ${r.status} | ${r.height ?? ''} | ${esc(r.err)} |\n`
}
md += `\n> \`appOnly\` components are page-scale (listed in \`test/sweep.appOnly.json\`) and open in the app, not isolation. \`no-export\` modules aren't components (hooks/utils/barrels) and don't count against the gate.\n`

fs.writeFileSync(OUT_MD, md)
console.log(`\n=== render sweep ===`)
console.log(`  ${modules.length} components · ${nOk} ok · ${nBlank} blank · ${nThrow} throws · ${nSkip} no-export · ${nApp} appOnly`)
console.log(`  report: ${path.relative(process.cwd(), OUT_MD)}`)
console.log(`\nVERDICT: ${nBlank + nThrow === 0 ? 'pass (0 blank, 0 throws)' : `fail (${nBlank} blank, ${nThrow} throws)`}`)
process.exit(nBlank + nThrow === 0 ? 0 : 1)
