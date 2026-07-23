import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { CONFIG } from './config.js'
import { startTarget } from './targetServer.js'
import { makeApi } from './api.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

async function main() {
  const {
    frontendDir,
    repoRoot,
    targetNodeModules,
    targetBase,
    targetPort,
    targetPublicPort,
    targetUrl,
    uiPort,
    uiOrigin,
    isProd,
  } = CONFIG

  console.log('[fedbg] config:', {
    frontendDir,
    repoRoot,
    targetUrl,
    uiPort,
    isProd,
  })

  if (!fs.existsSync(frontendDir)) {
    console.error(
      `[fedbg] target frontend not found at ${frontendDir}.\n` +
        `        Set MERKLE_FRONTEND_DIR (or MERKLE_REPO_ROOT) to point at it.`,
    )
  }

  const agentCode = fs.readFileSync(path.join(ROOT, 'agent/agent.js'), 'utf8')

  // Handshake identity for /api/config: the tool version this process was
  // started from. The Burrow extension refuses to ATTACH to a sidecar whose rev
  // doesn't match its on-disk tool (a long-lived pre-upgrade process would
  // otherwise serve stale server code forever) and spawns a fresh one instead.
  const rev = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
  ).version
  const startedAt = Date.now()

  // 1) Start the instrumented target app dev server. Keep the failure message
  //    so the UI can surface it (not just the server log) — see /api/preflight.
  //    The target is RESTARTABLE: a mock↔live mode flip (POST /api/mode) tears
  //    it down and boots it again, because VITE_* env is fixed at server start.
  let targetServer = null
  let targetUp = false
  let targetError = null
  let currentMode = CONFIG.frontendMode

  async function bootTarget(mode) {
    try {
      targetServer = await startTarget({
        frontendDir,
        repoRoot,
        targetNodeModules,
        base: targetBase,
        port: targetPort,
        publicPort: targetPublicPort,
        agentCode,
        uiOrigin,
        mode,
        backendTarget: CONFIG.backendTarget,
      })
      targetUp = true
      targetError = null
      console.log(
        `[fedbg] target app on http://localhost:${targetPublicPort}${targetBase} (mode: ${mode}${
          mode === 'live' ? ` → ${CONFIG.backendTarget}` : ''
        })`,
      )
    } catch (err) {
      targetServer = null
      targetUp = false
      targetError = String((err && err.message) || err)
      console.error('[fedbg] FAILED to start target app:', err)
    }
  }

  await bootTarget(currentMode)

  // Serialize flips: a second POST /api/mode while one is in flight queues
  // behind it instead of racing two Vite servers for the same port.
  let flipChain = Promise.resolve()
  const restartTarget = (mode) => {
    flipChain = flipChain.then(async () => {
      if (targetServer) {
        try {
          await targetServer.close()
        } catch {
          /* already dead */
        }
        targetServer = null
        targetUp = false
      }
      currentMode = mode
      await bootTarget(mode)
      return { up: targetUp, error: targetError }
    })
    return flipChain
  }

  const targetState = () => ({ up: targetUp, error: targetError })
  const modeState = () => ({ mode: currentMode })

  // 2) The debugger UI + write-back API.
  const app = express()
  app.use(express.json({ limit: '8mb' }))
  app.use(
    '/api',
    makeApi({
      frontendDir,
      repoRoot,
      targetUrl,
      targetState,
      modeState,
      restartTarget,
      backendTarget: CONFIG.backendTarget,
      rev,
      startedAt,
    }),
  )
  app.get('/healthz', (_req, res) =>
    res.json({ ok: true, target: targetUp, targetError }),
  )

  if (isProd) {
    const dist = path.join(ROOT, 'ui/dist')
    if (!fs.existsSync(dist)) {
      console.error('[fedbg] ui/dist missing — run `npm run build` first.')
    }
    app.use(express.static(dist))
    app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')))
  } else {
    // Dev: serve the debugger UI through Vite middleware (HMR for the UI itself).
    const { createServer } = await import('vite')
    const viteUi = await createServer({
      root: path.join(ROOT, 'ui'),
      configFile: path.join(ROOT, 'ui/vite.config.ts'),
      server: { middlewareMode: true },
      appType: 'spa',
    })
    app.use(viteUi.middlewares)
  }

  app.listen(uiPort, '0.0.0.0', () => {
    console.log(`\n  ┌─────────────────────────────────────────────┐`)
    console.log(`  │  Frontend Debugger ready                      │`)
    console.log(`  │  → http://localhost:${String(uiPort).padEnd(26)}│`)
    console.log(`  └─────────────────────────────────────────────┘\n`)
  })
}

main().catch((e) => {
  console.error('[fedbg] fatal:', e)
  process.exit(1)
})
