import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import postcss from 'postcss'

const normMedia = (m) => (m == null ? '' : String(m).replace(/\s+/g, ' ').trim())

// Canonicalize a selector so a CSSOM-reported selectorText matches the source
// text in index.css. Browsers normalise selectors (e.g. `*::before` → `::before`,
// `.a>.b` → `.a > .b`), so a naive string compare misses. We collapse
// whitespace, pad combinators, and drop a `*` that directly precedes a pseudo.
const canonSel = (s) =>
  String(s || '')
    .split(',')
    .map((p) =>
      p
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/\s*([>+~])\s*/g, ' $1 ')
        .replace(/\*(::?[a-zA-Z-])/g, '$1'),
    )
    .join(', ')
const normSel = (s) => canonSel(s)

function atomicWrite(abs, content) {
  const tmp = abs + '.fedbg.tmp'
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, abs)
}

// probe: is the backend under debug answering? 2s cap — preflight must stay
// snappy even when the ide container is down entirely.
async function probeBackend(baseUrl) {
  try {
    const res = await fetch(baseUrl + '/healthz', { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

export function makeApi({
  frontendDir,
  repoRoot,
  targetUrl,
  targetState,
  modeState,
  restartTarget,
  backendTarget,
  rev,
  startedAt,
}) {
  const router = express.Router()
  const srcRoot = path.join(frontendDir, 'src')

  // Resolve a caller-supplied relative path and refuse anything outside src/.
  const safe = (rel) => {
    if (!rel || typeof rel !== 'string') throw new Error('missing file')
    const abs = path.resolve(frontendDir, rel)
    if (abs !== srcRoot && !abs.startsWith(srcRoot + path.sep))
      throw new Error('path not allowed: ' + rel)
    return abs
  }

  router.get('/config', (_req, res) => {
    // rev/startedAt are the attach handshake: the extension only attaches to a
    // sidecar whose rev matches its on-disk tool version (staleness guard).
    res.json({ targetUrl, rev: rev || null, startedAt: startedAt || null })
  })

  // Graceful exit, loopback-only. Lets the extension's Restart reclaim the
  // canonical ports from a sidecar it did NOT spawn (it can't signal a foreign
  // process) instead of accumulating fallback-port instances.
  router.post('/shutdown', (req, res) => {
    const addr = req.socket.remoteAddress
    if (addr !== '127.0.0.1' && addr !== '::1' && addr !== '::ffff:127.0.0.1')
      return res.status(403).json({ error: 'loopback only' })
    res.json({ ok: true })
    setTimeout(() => process.exit(0), 50)
  })

  // --- Target mode: mock (devMock) ↔ live (proxy to the debugged backend) ---
  // Flipping restarts the target Vite in-process (VITE_* is fixed at boot).
  // Durable persistence is the LAUNCHER's job (it owns selection.json); this
  // endpoint changes the running process only.
  router.get('/mode', (_req, res) => {
    res.json({ mode: modeState ? modeState().mode : 'mock', backendTarget: backendTarget || null })
  })

  router.post('/mode', async (req, res) => {
    const mode = req.body && req.body.mode
    if (mode !== 'mock' && mode !== 'live')
      return res.status(400).json({ error: "mode must be 'mock' or 'live'" })
    if (!restartTarget) return res.status(500).json({ error: 'mode flip unavailable' })
    if (modeState && modeState().mode === mode)
      return res.json({ mode, restarted: false, target: targetState().up })
    const state = await restartTarget(mode)
    res.json({ mode, restarted: true, target: state.up, targetError: state.error || null })
  })

  // --- Live route catalog (kills the appRoutes.ts hand-mirror drift) --------
  // Parses NAV_DESTINATIONS from the SELECTED target's src/routes.ts — the
  // primary nav is the drift-prone half; the secondary list stays curated in
  // the UI's static fallback (ROUTE_TITLES holds regex matchers, not paths).
  // Pragmatic text-matching, same idiom as the oracles: fields appear in
  // id → path → label order in every entry.
  router.get('/routes', (_req, res) => {
    try {
      const src = fs.readFileSync(path.join(frontendDir, 'src', 'routes.ts'), 'utf8')
      const block = /NAV_DESTINATIONS[^=]*=\s*\[([\s\S]*?)\n\]/.exec(src)
      const routes = []
      if (block) {
        const entry = /id:\s*'([^']+)'[\s\S]*?path:\s*'([^']+)'[\s\S]*?label:\s*'([^']+)'/g
        let m
        while ((m = entry.exec(block[1]))) {
          routes.push({ id: m[1], path: m[2], label: m[3], group: 'Primary' })
        }
      }
      // Fewer than 3 parsed = the shape changed under us → tell the UI to keep
      // its static fallback rather than serving a half-parsed picker.
      if (routes.length < 3) return res.json({ source: 'fallback', routes: [] })
      res.json({ source: 'live', routes })
    } catch (e) {
      res.json({ source: 'fallback', routes: [], error: String(e.message || e) })
    }
  })

  // --- Network log (the agent's captured fetches, keyed by X-Request-Id) ----
  // The UI forwards the agent's `netreq` events here; the ide extension polls
  // GET /netlog to join them with the debugged backend's slog lines.
  const netlog = []
  let netSeq = 1
  router.post('/netlog', (req, res) => {
    const e = req.body || {}
    netlog.push({
      seq: netSeq++,
      ts: Date.now(),
      method: String(e.method || 'GET').toUpperCase(),
      url: String(e.url || ''),
      status: Number(e.status || 0),
      ms: e.ms == null ? null : Number(e.ms),
      requestId: e.requestId ? String(e.requestId) : null,
      clickGap: e.clickGap == null ? null : Number(e.clickGap),
    })
    while (netlog.length > 500) netlog.shift()
    res.json({ ok: true })
  })

  router.get('/netlog', (req, res) => {
    const since = Number(req.query.since || 0)
    res.json({ entries: netlog.filter((entry) => entry.seq >= since) })
  })

  // --- Preflight: why the target isn't up ---------------------------------
  // The UI polls this when the agent never connects, so a boot failure is
  // visible in the overlay instead of just the server log. Each check carries a
  // human remediation string. `repoRoot` may be undefined in older callers.
  router.get('/preflight', async (_req, res) => {
    const state = (targetState && targetState()) || { up: false, error: null }
    const mode = modeState ? modeState().mode : 'mock'
    const nodeModules = path.join(frontendDir, 'node_modules')
    const sharedDir = repoRoot
      ? path.join(repoRoot, 'shared')
      : path.resolve(frontendDir, '../../shared')
    const checks = [
      {
        id: 'frontendDir',
        ok: fs.existsSync(frontendDir),
        detail: frontendDir,
        remedy: `target frontend not found — set MERKLE_FRONTEND_DIR to point at it (looked in ${frontendDir})`,
      },
      {
        id: 'nodeModules',
        ok: fs.existsSync(nodeModules),
        detail: nodeModules,
        remedy: `run: cd ${frontendDir} && npm install`,
      },
      {
        id: 'shared',
        ok: fs.existsSync(sharedDir),
        detail: sharedDir,
        remedy: `merkle shared/ dir not found at ${sharedDir} — set MERKLE_REPO_ROOT to the repo root`,
      },
    ]
    // Mode B needs a live backend behind the proxy — probe it so a dead ide
    // shows a remediation card instead of every click 502ing mysteriously.
    if (mode === 'live' && backendTarget) {
      checks.push({
        id: 'backend',
        ok: await probeBackend(backendTarget),
        detail: backendTarget,
        remedy:
          'Mode B (live) needs the backend running under debug — F5 the Go backend in Burrow, or flip back to mock',
      })
    }
    const failed = checks.filter((c) => !c.ok)
    res.json({
      target: state.up,
      targetError: state.error || null,
      mode,
      ok: state.up && failed.length === 0,
      checks,
      // First failing check's remedy, else the raw target error if the target
      // is down for another reason (port clash, plugin crash, …).
      remediation: failed.length
        ? failed[0].remedy
        : state.up
          ? null
          : state.error || 'the target dev server did not start — check the server logs',
    })
  })

  // --- Source files (JSX/TSX) --------------------------------------------
  router.get('/source', (req, res) => {
    try {
      const abs = safe(req.query.file)
      res.json({ file: req.query.file, content: fs.readFileSync(abs, 'utf8') })
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) })
    }
  })

  router.post('/source', (req, res) => {
    try {
      const abs = safe(req.body.file)
      if (typeof req.body.content !== 'string') throw new Error('missing content')
      atomicWrite(abs, req.body.content)
      res.json({ ok: true })
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) })
    }
  })

  // --- CSS rule lookup + edit -------------------------------------------
  // Newer targets author component-scoped stylesheets, so locate searches the
  // requested file first (default src/index.css) and then every other .css
  // under src/. Edits still write to the file the caller names.
  const cssFilesUnder = (dir, out = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) cssFilesUnder(abs, out)
      else if (entry.name.endsWith('.css')) out.push(abs)
    }
    return out
  }

  const findRule = (root, selector, mediaText) => {
    let found = null
    root.walkRules((rule) => {
      if (found) return
      if (normSel(rule.selector) !== normSel(selector)) return
      const parent = rule.parent
      const ruleMedia =
        parent && parent.type === 'atrule' && parent.name === 'media'
          ? parent.params
          : ''
      if (normMedia(ruleMedia) !== normMedia(mediaText)) return
      found = rule
    })
    return found
  }

  router.get('/css/locate', (req, res) => {
    try {
      const requested = req.query.file || 'src/index.css'
      const candidates = [safe(requested), ...cssFilesUnder(srcRoot)]
      const seen = new Set()
      for (const abs of candidates) {
        if (seen.has(abs)) continue
        seen.add(abs)
        let rule = null
        try {
          rule = findRule(postcss.parse(fs.readFileSync(abs, 'utf8')), req.query.selector, req.query.media)
        } catch {
          continue // unreadable/unparsable stylesheet — keep searching
        }
        if (rule) {
          return res.json({
            found: true,
            file: path.relative(frontendDir, abs),
            line: rule.source && rule.source.start ? rule.source.start.line : null,
          })
        }
      }
      res.json({ found: false, file: requested })
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) })
    }
  })

  router.post('/css/edit', (req, res) => {
    try {
      const file = req.body.file || 'src/index.css'
      const { selector, media, prop, value } = req.body
      if (!selector || !prop) throw new Error('selector and prop required')
      const abs = safe(file)
      const root = postcss.parse(fs.readFileSync(abs, 'utf8'))
      const rule = findRule(root, selector, media)
      if (!rule) throw new Error('rule not found: ' + selector)
      let decl = null
      rule.walkDecls((d) => {
        if (d.prop === prop) decl = d
      })
      if (value === '' || value == null) {
        if (decl) decl.remove()
      } else if (decl) {
        decl.value = value
      } else {
        rule.append({ prop, value })
      }
      atomicWrite(abs, root.toString())
      res.json({
        ok: true,
        line: rule.source && rule.source.start ? rule.source.start.line : null,
      })
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) })
    }
  })

  return router
}
