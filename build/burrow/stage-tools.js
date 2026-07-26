// stage-tools.js — put `tools/` inside a packaged Burrow.app (task 15.4, step 2).
//
// Two extensions shell out to a tool that lives in this repo, and both resolve
// it the same way — `<extensionPath>/../../tools/<name>`:
//
//   burrow-frontend-debugger  → tools/frontend-debugger  (the sidecar: Node)
//   burrow-flow               → tools/flowscan           (the route tracer: Go)
//
// In a packaged app that path is `Contents/Resources/app/tools/<name>`, which
// `gulp vscode-darwin-<arch>` does not produce: it packages `out/`, extensions
// and node_modules and nothing else. So an app launched from Launchpad has no
// sidecar (Components shows "tool not found") and no tracer (API Flows' Refresh
// fails) — while `make dev`, running from the repo, has both. That gap is the
// whole reason this script exists.
//
// Deliberately NOT a gulp stream edit: `build/gulpfile.vscode.ts` is core source
// under the layer-3 patch ledger, and this needs no core change at all. It runs
// from the Makefile after `make dist`, against the packaged app.
//
// Runs on Node only, no deps — same house rule as check-ledger.js.

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..', '..')
const FD_STAGE = process.env.BURROW_FD_STAGE_DIR || path.join(REPO, '.build', 'frontend-debugger-tool')
const FLOWSCAN_SRC = path.join(REPO, 'tools', 'flowscan')

// What burrow-flow needs at runtime. The prebuilt binary is what it actually
// runs (see project.ts: a binary beats `go run .`, which would need the module
// cache warm and the network up); the sources ride along so the tool is
// readable and rebuildable from the app, and so `go run .` still works as the
// fallback on a machine with a Go toolchain.
const FLOWSCAN_KEEP = [/\.go$/, /^go\.(mod|sum)$/, /^README\.md$/]

function log(msg) {
  console.log(`stage-tools: ${msg}`)
}

function fail(msg) {
  console.error(`stage-tools: ${msg}`)
  process.exit(1)
}

function arg(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function dirSize(dir) {
  let bytes = 0
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) {
      bytes += fs.statSync(path.join(e.parentPath || e.path, e.name)).size
    }
  }
  return bytes
}

/** Build the flowscan binary for the host, next to its sources. */
function buildFlowscan(outDir) {
  if (!fs.existsSync(path.join(FLOWSCAN_SRC, 'go.mod'))) {
    fail(`no flowscan module at ${FLOWSCAN_SRC}`)
  }
  fs.mkdirSync(outDir, { recursive: true })
  for (const name of fs.readdirSync(FLOWSCAN_SRC)) {
    if (FLOWSCAN_KEEP.some((re) => re.test(name))) {
      fs.cpSync(path.join(FLOWSCAN_SRC, name), path.join(outDir, name))
    }
  }
  log('building flowscan…')
  try {
    // CGO off so the binary has no libc coupling to the build machine.
    execFileSync('go', ['build', '-trimpath', '-o', path.join(outDir, 'flowscan'), '.'], {
      cwd: FLOWSCAN_SRC,
      stdio: 'inherit',
      env: { ...process.env, CGO_ENABLED: '0' },
    })
  } catch (err) {
    fail(`go build failed: ${err.message} — is Go on PATH?`)
  }
  fs.chmodSync(path.join(outDir, 'flowscan'), 0o755)
}

function main() {
  const app = arg('--app')
  if (!app) {
    fail('usage: node build/burrow/stage-tools.js --app "<path to Burrow.app>"')
  }
  if (!fs.existsSync(path.join(app, 'Contents', 'Resources', 'app', 'product.json'))) {
    fail(`'${app}' does not look like a packaged Burrow app (no Contents/Resources/app/product.json)`)
  }
  const toolsDir = path.join(app, 'Contents', 'Resources', 'app', 'tools')

  // 1. The frontend-debugger sidecar — staged by its own script, which owns the
  //    production npm install and the extension's preflight assertions.
  log('staging tools/frontend-debugger…')
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'stage-frontend-tool.js')], { stdio: 'inherit' })
  } catch (err) {
    fail(`staging the frontend-debugger failed: ${err.message}`)
  }
  if (!fs.existsSync(FD_STAGE)) {
    fail(`expected a staged tree at ${FD_STAGE}`)
  }

  // 2. flowscan.
  const flowscanStage = path.join(REPO, '.build', 'flowscan-tool')
  fs.rmSync(flowscanStage, { recursive: true, force: true })
  buildFlowscan(flowscanStage)

  // 3. Install both into the bundle.
  fs.rmSync(toolsDir, { recursive: true, force: true })
  fs.mkdirSync(toolsDir, { recursive: true })
  fs.cpSync(FD_STAGE, path.join(toolsDir, 'frontend-debugger'), { recursive: true })
  fs.cpSync(flowscanStage, path.join(toolsDir, 'flowscan'), { recursive: true })

  // 4. Assert what each extension will look for, here rather than at first
  //    launch of the app — the failure mode this script exists to prevent is
  //    silent and only shows up as a dead rail.
  const required = [
    path.join('frontend-debugger', 'server', 'index.js'),
    path.join('frontend-debugger', 'node_modules'),
    path.join('frontend-debugger', 'ui', 'dist', 'index.html'),
    path.join('flowscan', 'flowscan'),
    path.join('flowscan', 'go.mod'),
  ]
  for (const rel of required) {
    if (!fs.existsSync(path.join(toolsDir, rel))) {
      fail(`installed tree is missing ${rel}`)
    }
  }

  const mb = (dirSize(toolsDir) / (1024 * 1024)).toFixed(1)
  log(`installed tools/ into the bundle (${mb} MB): frontend-debugger, flowscan`)
}

main()
