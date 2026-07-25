import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import postcss from 'postcss'
import { applyJsxEdit } from './jsxEdit.js'
import { locateProdCss, prodCssPath } from './prodCss.js'

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

  // The target's BUILT stylesheet — what production actually serves. The
  // isolation harness offers it as a "prod-css" toggle so a component can be
  // checked against the shipped CSS, not just the dev module graph; the mtime
  // lets a caller say "built 3 days ago — rebuild?" instead of presenting a
  // stale bundle as current. Path derives from the configured target.
  router.get('/prod-css', (_req, res) => {
    res.json(locateProdCss(frontendDir))
  })

  // Serve that stylesheet. Split from the probe so a caller can <link> it;
  // prodCssPath is basename + .css only, so it cannot escape dist/assets.
  router.get('/prod-css/file', (req, res) => {
    const abs = prodCssPath(frontendDir, req.query.name)
    if (!abs) return res.status(404).type('text/plain').send('not found')
    res.type('text/css').send(fs.readFileSync(abs, 'utf8'))
  })

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
        const wasEmpty = !rule.nodes || rule.nodes.length === 0
        rule.append({ prop, value })
        if (wasEmpty) {
          // postcss's default raws on a childless rule render `sel {decl}` on
          // one line with no closing newline — give it conventional formatting
          // (one extra indent level inside @media).
          const nested = rule.parent && rule.parent.type === 'atrule'
          rule.last.raws.before = nested ? '\n    ' : '\n  '
          rule.raws.after = nested ? '\n  ' : '\n'
          rule.raws.semicolon = true
        }
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

  // --- CSS provenance (batch) --------------------------------------------
  // The Inspector calls this on every selection: for each matched rule, which
  // file:line defines it and which origin stratum it belongs to. Parsed ASTs
  // are cached by mtime — re-selection must stay cheap.
  const cssAstCache = new Map() // abs -> { mtime, root }
  const parsedCss = (abs) => {
    const mtime = fs.statSync(abs).mtimeMs
    const hit = cssAstCache.get(abs)
    if (hit && hit.mtime === mtime) return hit.root
    const root = postcss.parse(fs.readFileSync(abs, 'utf8'))
    cssAstCache.set(abs, { mtime, root })
    return root
  }

  // Origin strata for the editor panel: the component's own colocated css,
  // theme/token files, or app-global stylesheets.
  const classifyOrigin = (cssRel, componentFile) => {
    const base = path.basename(cssRel)
    if (/^theme-|^tokens\.css$/.test(base) || cssRel.includes('/styles/')) return 'theme'
    if (componentFile) {
      const stem = componentFile.replace(/\.[jt]sx?$/, '')
      if (cssRel.replace(/\.css$/, '') === stem) return 'component'
      if (path.dirname(cssRel) === path.dirname(componentFile) && !/^(index|app)\.css$/.test(base))
        return 'component'
    }
    return 'global'
  }

  router.post('/css/provenance', (req, res) => {
    try {
      const componentFile = typeof req.body.componentFile === 'string' ? req.body.componentFile : null
      const rules = Array.isArray(req.body.rules) ? req.body.rules : []
      const files = cssFilesUnder(srcRoot)
      const results = rules.map((r) => {
        for (const abs of files) {
          let rule = null
          try {
            rule = findRule(parsedCss(abs), r.selector, r.media)
          } catch {
            continue
          }
          if (rule) {
            const rel = path.relative(frontendDir, abs)
            return {
              selector: r.selector,
              media: r.media || null,
              found: true,
              file: rel,
              line: rule.source && rule.source.start ? rule.source.start.line : null,
              origin: classifyOrigin(rel, componentFile),
            }
          }
        }
        return { selector: r.selector, media: r.media || null, found: false, file: null, line: null, origin: 'unknown' }
      })
      res.json({ results })
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) })
    }
  })

  // --- Ensure a component-scoped rule exists ------------------------------
  // Scaffolds <Component>.css beside the component source (adding the import)
  // and appends an empty rule, so "override in component" / new properties on
  // rule-less components have somewhere real to land. Returns the file+line
  // the caller should then /css/edit into.
  router.post('/css/ensure', (req, res) => {
    try {
      const { componentFile, selector, media } = req.body
      if (!componentFile || !selector) throw new Error('componentFile and selector required')
      const compAbs = safe(componentFile)
      const stem = componentFile.replace(/\.[jt]sx?$/, '')
      if (stem === componentFile) throw new Error('componentFile is not a source module: ' + componentFile)
      const cssRel = stem + '.css'
      const cssAbs = safe(cssRel)
      const base = path.basename(cssRel)
      let created = false
      if (!fs.existsSync(cssAbs)) {
        atomicWrite(cssAbs, '')
        created = true
      }
      // Keep the import in the component module so the rule actually loads.
      const compSrc = fs.readFileSync(compAbs, 'utf8')
      const importLine = `import './${base}'`
      if (!compSrc.includes(base)) {
        const lines = compSrc.split('\n')
        let lastImport = -1
        for (let i = 0; i < lines.length; i++) if (/^import\b/.test(lines[i])) lastImport = i
        lines.splice(lastImport + 1, 0, importLine)
        atomicWrite(compAbs, lines.join('\n'))
      }
      const root = postcss.parse(fs.readFileSync(cssAbs, 'utf8'))
      let rule = findRule(root, selector, media)
      if (!rule) {
        rule = postcss.rule({ selector, raws: { after: '\n' } })
        if (media) {
          const at = postcss.atRule({ name: 'media', params: media, raws: { after: '\n' } })
          rule.raws.before = '\n  '
          at.append(rule)
          root.append(at)
        } else {
          root.append(rule)
        }
        atomicWrite(cssAbs, root.toString())
        cssAstCache.delete(cssAbs)
      }
      res.json({
        ok: true,
        file: cssRel,
        created,
        line: rule.source && rule.source.start ? rule.source.start.line : null,
      })
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) })
    }
  })

  // --- Theme catalog -------------------------------------------------------
  // The target's themes are plain CSS keyed off `[data-theme="…"]` on <html>
  // (theme-*.css files). Scan the stylesheets for the attribute values; the
  // agent's setTheme command flips the attribute live.
  router.get('/themes', (_req, res) => {
    try {
      const names = new Set()
      for (const abs of cssFilesUnder(srcRoot)) {
        let text
        try {
          text = fs.readFileSync(abs, 'utf8')
        } catch {
          continue
        }
        for (const m of text.matchAll(/\[data-theme=["']?([\w-]+)["']?\]/g)) names.add(m[1])
      }
      res.json({ mechanism: 'data-theme', themes: [...names].sort() })
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) })
    }
  })

  // --- Component usage discovery (Show in App) -----------------------------
  // Where is this component rendered? Text-scans src/ (same parser-free
  // pragmatism as /routes and the oracles): builds a reverse-import map, then
  // returns (a) direct JSX usage sites of the module's components and (b) every
  // transitive importer with its exported PascalCase components. The client
  // intersects those names with the live route catalog (agent `routes` entries
  // now carry the page component's `name`) to pick the route to navigate to.
  const SRC_EXTS = ['.tsx', '.ts', '.jsx', '.js']
  const SKIP_DIRS = new Set(['node_modules', 'test', 'tests', '__tests__', '__mocks__', '__snapshots__'])
  // Tests/stories/samples import components without being app usage — a
  // "where is this rendered" answer pointing at a .test file is noise.
  const isAppSource = (name) =>
    SRC_EXTS.includes(path.extname(name)) && !/\.(test|spec|stories|samples)\.[jt]sx?$/.test(name)
  const srcFilesUnder = (dir, out = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) srcFilesUnder(abs, out)
      else if (isAppSource(entry.name)) out.push(abs)
    }
    return out
  }

  // Resolve an import specifier from `fromAbs` to a real file under src/, or
  // null for bare/external specifiers. Mirrors the extension's typeResolver:
  // relative + `@/` (→ src/) prefixes, probing extensions and /index files.
  const resolveSpecifier = (fromAbs, spec) => {
    let base = null
    if (spec.startsWith('./') || spec.startsWith('../')) base = path.resolve(path.dirname(fromAbs), spec)
    else if (spec.startsWith('@/')) base = path.join(srcRoot, spec.slice(2))
    if (!base || (!base.startsWith(srcRoot + path.sep) && base !== srcRoot)) return null
    for (const ext of ['', ...SRC_EXTS]) {
      const cand = base + ext
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand
    }
    for (const ext of SRC_EXTS) {
      const cand = path.join(base, 'index' + ext)
      if (fs.existsSync(cand)) return cand
    }
    return null
  }

  // Per-file import/export facts, cached by mtime (cheap re-requests, same
  // idiom as the postcss AST cache above).
  const importCache = new Map() // abs -> { mtime, imports: [{spec, names}], exports: [names] }
  const parsedImports = (abs) => {
    const mtime = fs.statSync(abs).mtimeMs
    const hit = importCache.get(abs)
    if (hit && hit.mtime === mtime) return hit
    const text = fs.readFileSync(abs, 'utf8')
    const imports = []
    // `import Default, { A, B as C } from 'spec'` — clause optional (side-effect
    // imports carry no names) — plus `export … from 'spec'` re-exports.
    for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\s+([^'";]*?from\s+)?['"]([^'"]+)['"]/g)) {
      const clause = m[1] || ''
      const names = []
      const def = clause.match(/^\s*(\*\s+as\s+)?([A-Za-z_$][\w$]*)/)
      if (def && def[2] !== 'type') names.push(def[2])
      const braces = clause.match(/\{([^}]*)\}/)
      if (braces)
        for (const part of braces[1].split(',')) {
          const alias = part.trim().split(/\s+as\s+/)
          const name = (alias[1] || alias[0]).trim()
          if (/^[A-Za-z_$][\w$]*$/.test(name)) names.push(name)
        }
      imports.push({ spec: m[2], names })
    }
    const exports = new Set()
    for (const m of text.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:function|const|class|let|var)\s+([A-Z]\w*)/g))
      exports.add(m[1])
    for (const m of text.matchAll(/export\s+default\s+(?:memo\(|forwardRef\()?\s*([A-Z]\w*)/g)) exports.add(m[1])
    for (const m of text.matchAll(/export\s*\{([^}]*)\}/g))
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop().trim()
        if (/^[A-Z]\w*$/.test(name)) exports.add(name)
      }
    const entry = { mtime, text, imports, exports: [...exports] }
    importCache.set(abs, entry)
    return entry
  }

  router.get('/usages', (req, res) => {
    try {
      const targetAbs = safe(req.query.file)
      const files = srcFilesUnder(srcRoot)
      // Reverse import map for the whole graph: resolvedAbs -> importers.
      const importersOf = new Map()
      for (const abs of files) {
        for (const imp of parsedImports(abs).imports) {
          const resolved = resolveSpecifier(abs, imp.spec)
          if (!resolved) continue
          if (!importersOf.has(resolved)) importersOf.set(resolved, [])
          importersOf.get(resolved).push({ abs, names: imp.names })
        }
      }
      // Direct JSX usage sites: importers of the module that render one of the
      // names they import from it (`<Name` on some line).
      const usages = []
      for (const imp of importersOf.get(targetAbs) || []) {
        const lines = parsedImports(imp.abs).text.split('\n')
        for (const name of imp.names.filter((n) => /^[A-Z]/.test(n))) {
          const tag = new RegExp('<' + name + '(?![\\w$])')
          for (let i = 0; i < lines.length; i++)
            if (tag.test(lines[i])) usages.push({ file: path.relative(frontendDir, imp.abs), line: i + 1, name })
        }
      }
      // Transitive importers (BFS, depth-capped): each with its exported
      // PascalCase components — candidate page components for route matching.
      const reachable = []
      const seen = new Set([targetAbs])
      let frontier = [targetAbs]
      for (let depth = 1; depth <= 8 && frontier.length; depth++) {
        const next = []
        for (const abs of frontier) {
          for (const imp of importersOf.get(abs) || []) {
            if (seen.has(imp.abs)) continue
            seen.add(imp.abs)
            next.push(imp.abs)
            reachable.push({
              file: path.relative(frontendDir, imp.abs),
              names: parsedImports(imp.abs).exports,
              depth,
            })
          }
        }
        frontier = next
      }
      res.json({ file: req.query.file, usages, reachable })
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) })
    }
  })

  // --- JSX write-back ------------------------------------------------------
  // Surgical attribute/text edits at a stamped call site (see jsxEdit.js).
  // Structured refusals ({ ok:false, reason }) are 200s — the UI degrades to
  // "open in source" instead of treating them as transport errors.
  router.post('/jsx/edit', (req, res) => {
    try {
      const abs = safe(req.body.file)
      const code = fs.readFileSync(abs, 'utf8')
      const result = applyJsxEdit(code, abs, req.body)
      if (!result.ok) return res.json(result)
      atomicWrite(abs, result.code)
      res.json({ ok: true })
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) })
    }
  })

  return router
}
