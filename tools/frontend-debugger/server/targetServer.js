import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { inspectorPlugin } from './inspectorPlugin.js'

// Start the *target* app's Vite dev server in-process, using the target's OWN
// installed Vite + @vitejs/plugin-react (resolved from its node_modules) so the
// version matrix matches exactly what the project ships. We replicate the
// merkle vite.config inline (configFile: false) and add our inspector plugin.
export async function startTarget({
  frontendDir,
  repoRoot,
  targetNodeModules,
  base,
  port,
  publicPort,
  agentCode,
  uiOrigin,
  mode = 'mock',
  backendTarget,
}) {
  // Where the target's Linux deps live. In the merged docker setup this is a
  // container-managed volume at /projects/node_modules (a FIXED path found by
  // Node/Vite walk-up from any <project>/nodewatch/frontend); locally it falls
  // back to the target's OWN node_modules.
  const nodeModules = targetNodeModules || path.join(frontendDir, 'node_modules')
  // Skip the Auth0 wall (the backend under debug runs NODEWATCH_DEV_NO_AUTH=1).
  process.env.VITE_SKIP_AUTH = '1'
  // Mode decides whether devMock intercepts /api. VITE_* is baked in at server
  // start, so a mode flip = a target restart (see the /api/mode handler). This
  // process restarts the target in-place — set BOTH branches explicitly, the
  // env survives from the previous boot.
  if (mode === 'live') {
    // main.tsx: VITE_DEV_MOCK=0 disables the mock while still skipping auth.
    process.env.VITE_DEV_MOCK = '0'
  } else {
    delete process.env.VITE_DEV_MOCK // skip-auth default: devMock ON
  }

  // Force the target into development mode. In Docker the process runs with
  // NODE_ENV=production (so the debugger serves its built UI statically), but
  // the target is a *dev server* — under NODE_ENV=production plugin-react skips
  // the React Refresh preamble while still emitting $RefreshSig$ references,
  // which crashes the app ("$RefreshSig$ is not defined"). The debugger's own
  // prod/dev choice was already captured in CONFIG at import time, so flipping
  // this now only affects the target Vite.
  process.env.NODE_ENV = 'development'

  // Resolve the target's OWN vite + plugin-react from its (Linux) node_modules.
  // Anchor createRequire one level ABOVE node_modules so require.resolve walks
  // into <nodeModules>/vite (works whether node_modules is beside the frontend
  // or at the shared /projects/node_modules volume).
  const require = createRequire(path.join(path.dirname(nodeModules), '_resolve.js'))
  const viteMod = await import(pathToFileURL(require.resolve('vite')).href)
  const reactMod = await import(
    pathToFileURL(require.resolve('@vitejs/plugin-react')).href
  )
  const react = reactMod.default || reactMod

  // merkle's @shared package lives at <repoRoot>/shared regardless of where the
  // frontend sits (nodewatch/frontend in the old nested layout, <repoRoot>/frontend
  // after the 2026-07 de-nest). Anchor to repoRoot, not a fixed `../../` from the
  // frontend — the latter pointed above the repo once the frontend de-nested.
  const sharedDir = path.join(repoRoot, 'shared')

  const server = await viteMod.createServer({
    root: frontendDir,
    base,
    mode: 'development',
    configFile: false,
    clearScreen: false,
    // node_modules may be the shared volume, not <root>/node_modules; keep Vite's
    // dep-optimizer cache in a writable container path instead of under root.
    cacheDir: process.env.VITE_CACHE_DIR || path.join(nodeModules, '.vite'),
    plugins: [inspectorPlugin({ frontendDir, agentCode, uiOrigin, base }), react()],
    resolve: {
      alias: {
        '@': path.join(frontendDir, 'src'),
        '@shared': sharedDir,
        '@auth0/auth0-react': path.join(nodeModules, '@auth0/auth0-react'),
        react: path.join(nodeModules, 'react'),
        'react-dom': path.join(nodeModules, 'react-dom'),
      },
    },
    server: {
      host: true,
      port,
      strictPort: true,
      // Allow serving files from the repo root (the @shared package lives one
      // level above the frontend root) and from the shared node_modules volume.
      fs: { allow: [repoRoot, frontendDir, sharedDir, nodeModules] },
      // The browser reaches HMR on the published port.
      hmr: { clientPort: publicPort },
      // We're embedded in an iframe from a different origin (the debugger UI).
      cors: true,
      allowedHosts: true,
      // Mode B: the same proxy merkle's own vite.config.ts ships — the React
      // client funnels through BASE '/api/nodewatch', the backend serves /api.
      // Only wired when live; in mock mode devMock answers before fetch leaves
      // the page, so no proxy is involved at all.
      ...(mode === 'live' && backendTarget
        ? {
            proxy: {
              '/api/nodewatch': {
                target: backendTarget,
                changeOrigin: true,
                rewrite: (p) => p.replace(/^\/api\/nodewatch/, '/api'),
              },
              '/healthz': { target: backendTarget, changeOrigin: true },
            },
          }
        : {}),
    },
  })

  await server.listen()
  return server
}
