import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The unified `debugger` launcher writes the picked project to /config/selection.json
// (shared volume). We read it here so the embedded target follows the selection.
// Precedence: explicit env override > launcher selection > the ../../merkle default.
function readSelection() {
  const file = process.env.SELECTION_FILE || '/config/selection.json'
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) || {}
  } catch {
    return {}
  }
}
const selection = readSelection()

// The merkle monorepo is the default testing ground. This tool lives at
// burrow/tools/frontend-debugger — two levels below the debugger checkout — so
// the host fallback climbs five dirs to ~/Projects/merkle. Normally overridden
// via MERKLE_* env (the burrow-frontend-debugger extension sets them).
const repoRoot =
  process.env.MERKLE_REPO_ROOT ||
  selection.projectRoot ||
  // Host fallback: merkle sits beside the debugger repo under ~/Projects.
  path.resolve(__dirname, '../../../../../merkle')
const frontendDir =
  process.env.MERKLE_FRONTEND_DIR || selection.frontendDir || path.join(repoRoot, 'nodewatch/frontend')

// Where the target's (Linux) node_modules live. In the merged docker setup this
// is a container-managed volume at /projects/node_modules — a FIXED path that
// Node/Vite resolution finds by walking up from <project>/nodewatch/frontend, so
// it works for any selected project without shadowing the host's macOS install.
const targetNodeModules =
  process.env.TARGET_NODE_MODULES || path.join(frontendDir, 'node_modules')

const targetPort = Number(process.env.TARGET_PORT || 5173)
// The port the *browser* reaches the target on (for HMR websocket). Same as
// targetPort unless docker remaps it.
const targetPublicPort = Number(process.env.TARGET_PUBLIC_PORT || targetPort)
const uiPort = Number(process.env.UI_PORT || 6080)
// The origin the in-page agent posts results back to. Defaults to '*' so the
// tool works whether you open it via localhost, 127.0.0.1, or a LAN IP. Set
// UI_ORIGIN to lock it down.
const uiOrigin = process.env.UI_ORIGIN || '*'

// Base path the target app is served under (NodeWatch uses /watch/app/).
const targetBase = process.env.TARGET_BASE || selection.targetBase || '/watch/app/'
const targetUrl =
  process.env.TARGET_URL || `http://localhost:${targetPublicPort}${targetBase}`

// Target mode: 'mock' (devMock intercepts /api — today's default) or 'live'
// (VITE_DEV_MOCK=0 + a Vite proxy sends /api/nodewatch to the backend under
// debug, so a click in the embedded app lands on a real dlv breakpoint).
// Precedence: env > launcher-persisted selection > mock. Flips at runtime via
// POST /api/mode (in-process target restart).
const frontendMode =
  process.env.FRONTEND_MODE || selection.frontendMode || 'mock'
// Where 'live' proxies to: the Go backend under debug (F5 in Burrow).
const backendTarget = process.env.NW_BACKEND_TARGET || 'http://localhost:8080'

const isProd = process.env.NODE_ENV === 'production'

export const CONFIG = {
  repoRoot,
  frontendDir,
  targetNodeModules,
  targetPort,
  targetPublicPort,
  targetBase,
  targetUrl,
  uiPort,
  uiOrigin,
  isProd,
  selection,
  frontendMode,
  backendTarget,
}
