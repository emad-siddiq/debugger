// End-to-end verification for the frontend_debugger. Drives the real UI + the
// embedded target with Playwright's Chromium and asserts the core behaviors.
//
//   npm run verify                 (needs a running instance + chromium)
//   UI_URL=http://host:6080 npm run verify
//
// Preconditions: an instance is up (docker compose up -d, or npm run dev) and
// `npx playwright install chromium` has been run. Exits non-zero on any failure.
import { chromium } from '@playwright/test'

const UI = process.env.UI_URL || 'http://localhost:6080'
const results = []
const ok = (n, c, x = '') => results.push({ pass: !!c, line: `${c ? 'PASS' : 'FAIL'}  ${n}${x ? ' — ' + x : ''}` })

let browser
try {
  browser = await chromium.launch()
} catch (e) {
  console.error('BLOCKED — could not launch Chromium. Run: npx playwright install chromium')
  process.exit(2)
}
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
const errs = []
page.on('pageerror', (e) => errs.push('TOP: ' + e.message))

try {
  const r = await page.goto(UI, { waitUntil: 'load' }).catch(() => null)
  if (!r) {
    console.error(`BLOCKED — no instance at ${UI} (docker compose up -d, or npm run dev)`)
    process.exit(2)
  }
  await page.waitForSelector('iframe.target-frame', { timeout: 15000 })
  await page.waitForSelector('.dot.on', { timeout: 25000 })
  await page.waitForTimeout(1200)
  ok('agent connects to target', true)

  const frame = page.frameLocator('iframe.target-frame')
  const tf = () => page.frames().find((f) => f.url().includes('/watch/app'))

  // --- agent-rpc checks (no toolbar needed) ---
  const data = await page.evaluate(async () => {
    const iframe = document.querySelector('iframe.target-frame')
    const rpc = (cmd, extra, type) =>
      new Promise((res, rej) => {
        const to = setTimeout(() => rej(new Error('t ' + cmd)), 6000)
        function h(e) {
          const d = e.data
          if (d && d.__fedbg === 1 && d.type === type) {
            clearTimeout(to)
            window.removeEventListener('message', h)
            res(d)
          }
        }
        window.addEventListener('message', h)
        iframe.contentWindow.postMessage(Object.assign({ __fedbg: 1, cmd }, extra), '*')
      })
    let tree = null
    for (let i = 0; i < 30 && !tree; i++) {
      try {
        const t = await rpc('getTree', { max: 5000 }, 'tree')
        if (t.nodes && t.nodes.length) tree = t
      } catch {}
      if (!tree) await new Promise((r) => setTimeout(r, 400))
    }
    if (!tree) return { ok: false }
    const flat = []
    ;(function w(ns) {
      for (const n of ns) {
        flat.push(n.name)
        w(n.children || [])
      }
    })(tree.nodes)
    const find = (ns, n) => {
      for (const x of ns) {
        if (x.name === n) return x
        const f = find(x.children || [], n)
        if (f) return f
      }
      return null
    }
    const leaf = find(tree.nodes, 'SidebarNavItem')
    const parent = find(tree.nodes, 'Sidebar')
    const ld = leaf ? (await rpc('select', { id: leaf.id }, 'selected')).detail : null
    const pd = parent ? (await rpc('select', { id: parent.id }, 'selected')).detail : null
    return {
      ok: true,
      treeCount: flat.length,
      hasApp: flat.includes('App'),
      leafSource: ld && ld.source ? ld.source.file : null,
      leafCss: ld ? ld.css.length : 0,
      leafInherited: ld ? (ld.inherited || []).length : 0,
      parentBox: pd ? pd.box : null,
    }
  })
  ok('component tree built from root', data.ok && data.hasApp && data.treeCount > 50, `${data.treeCount} components`)
  ok('select leaf → source + matched CSS', !!data.leafSource && data.leafCss > 0, `${data.leafSource} css=${data.leafCss}`)
  ok('inherited styles resolved', data.leafInherited > 0, `${data.leafInherited} groups`)
  ok('parent component has a preview box', !!data.parentBox && data.parentBox.width > 0)

  // --- UI checks (reveal + pin toolbar) ---
  await page.locator('.top-grip').hover()
  await page.waitForTimeout(450)
  await page.getByRole('button', { name: /pin/i }).click()
  await page.waitForTimeout(150)

  await page.getByRole('button', { name: /Pick/ }).click()
  await page.waitForTimeout(200)
  await frame.getByText('Overview', { exact: false }).first().click({ timeout: 5000 })
  await page.waitForTimeout(500)
  const picked = (await page.locator('.comp-name').textContent().catch(() => '')) || ''
  ok('pick: click selects a component', picked.trim().length > 0, picked)

  const s1 = await page.locator('.comp-name').textContent()
  await page.locator('.navbtn[title^="Parent"]').click()
  await page.waitForTimeout(400)
  const s2 = await page.locator('.comp-name').textContent()
  ok('nav: ↑ parent changes selection', s1 !== s2, `${s1} → ${s2}`)

  // hover resets on scroll
  await frame.getByText('Validators', { exact: false }).first().hover()
  await page.waitForTimeout(350)
  const hoverBefore = await page.locator('.ov-box.hover').count()
  await tf().evaluate(() => window.dispatchEvent(new Event('scroll')))
  await page.waitForTimeout(300)
  const hoverAfter = await page.locator('.ov-box.hover').count()
  ok('hover box resets on scroll', hoverBefore === 1 && hoverAfter === 0, `${hoverBefore}→${hoverAfter}`)

  // Monaco JSX
  await frame.getByText('Overview', { exact: false }).first().click({ timeout: 5000 })
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: 'Source', exact: true }).click()
  await page.waitForTimeout(2800)
  const jsxErr = await page.evaluate(() => {
    const m = window.monaco
    if (!m) return -1
    return m.editor.getModelMarkers({}).filter((k) => k.severity === 8 && (k.code === '17004' || /JSX/i.test(k.message))).length
  })
  ok('source: no JSX/17004 markers', jsxErr === 0 || jsxErr === -1, `markers=${jsxErr}`)

  // pager + swipe
  const surfTx = async () => {
    const tr = await page.locator('.surface').evaluate((el) => getComputedStyle(el).transform)
    const m = tr.match(/matrix\(1, 0, 0, 1, (-?\d+(?:\.\d+)?)/)
    return m ? Number(m[1]) : 0
  }
  await page.locator('.inspector.floating .insp-btn[title^="Full screen"]').click()
  await page.waitForTimeout(500)
  ok('pager: enters full-screen styles window', (await surfTx()) < -100 && (await page.locator('.inspector.fullscreen').count()) === 1)
  await page.locator('.pgbtn[title^="Preview"]').click()
  await page.waitForTimeout(450)
  await tf().evaluate(() => window.dispatchEvent(new WheelEvent('wheel', { deltaX: 200, deltaY: 0, bubbles: true, cancelable: true })))
  await page.waitForTimeout(450)
  ok('swipe: two-finger over preview pages to styles', (await surfTx()) < -100)

  // --- Mode B: flip live → preflight probes the backend → restore ---------
  // Server-level (node fetch, not the page): each flip restarts the target
  // Vite, so this runs LAST and puts the starting mode back when done.
  const jfetch = (p, init) => fetch(UI + p, init).then((r) => r.json())
  const post = (body) =>
    jfetch('/api/mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const startMode = (await jfetch('/api/mode')).mode
  ok('mode: reports mock|live', startMode === 'mock' || startMode === 'live', startMode)
  const flip = await post({ mode: 'live' })
  ok('mode: flip to live lands', flip.mode === 'live', `restarted=${flip.restarted}`)
  const pf = await jfetch('/api/preflight')
  const backend = (pf.checks || []).find((c) => c.id === 'backend')
  ok('preflight: live mode probes the backend', pf.mode === 'live' && !!backend, backend && `ok=${backend.ok}`)
  ok('preflight: backend-down carries the F5 remedy', !backend || backend.ok || /Backend IDE/.test(backend.remedy || ''))
  const rejected = await fetch(UI + '/api/mode', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'chaos' }),
  })
  ok('mode: rejects unknown modes', rejected.status === 400)
  const restored = await post({ mode: startMode })
  ok('mode: restored to starting mode', restored.mode === startMode)

  ok('no top-page errors', errs.length === 0, errs.slice(0, 2).join(' | '))
} catch (e) {
  results.push({ pass: false, line: 'FAIL  harness threw — ' + (e.message || e) })
} finally {
  const failed = results.filter((r) => !r.pass)
  console.log('\n=== verify ===')
  results.forEach((r) => console.log('  ' + r.line))
  console.log(`\nVERDICT: ${failed.length ? 'fail' : 'pass'} (${results.length - failed.length}/${results.length})`)
  await browser.close()
  process.exit(failed.length ? 1 : 0)
}
