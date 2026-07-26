// stage-frontend-tool.js — stage tools/frontend-debugger into a shippable tree
// (task 15.4, first slice; see ../../docs/architecture/plans/task-15-4-plan.md).
//
// The frontend-debugger sidecar is spawned by the extension as
//   cp.spawn(process.execPath, [toolRoot + '/server/index.js'],
//            { env: { ELECTRON_RUN_AS_NODE: '1', NODE_ENV: 'production', … } })
// and `toolRoot` resolves to <extensionPath>/../../tools/frontend-debugger. In
// a packaged .app that is resources/app/tools/frontend-debugger — so if we put
// a working tree there, the extension finds it with NO code change. This script
// builds that tree; wiring it into the gulp stream is a separate (ledgered)
// step, and nothing here ships on its own.
//
// What lands: server/, agent/, ui/dist/, package.json, node_modules (production
// only). What does not: ui/src, test/, docs/, .claude/, the lockfile — source
// and tooling that a shipped sidecar never reads.
//
// Runs on Node only, no deps — same house rule as check-ledger.js.

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..', '..')
const SRC = path.join(REPO, 'tools', 'frontend-debugger')
const OUT = process.env.BURROW_FD_STAGE_DIR || path.join(REPO, '.build', 'frontend-debugger-tool')

// Copied verbatim. `ui` is handled separately — only its built output ships.
const COPY = ['server', 'agent', 'package.json']

// preflight() in the extension (sidecar.ts) asserts exactly these before it
// will spawn. Staging is only "done" when all three are present, so assert the
// same things here rather than discovering it at first launch of the .app.
const PREFLIGHT = [
  path.join('server', 'index.js'),
  'node_modules',
  path.join('ui', 'dist', 'index.html'),
]

function log(msg) {
  console.log(`stage-frontend-tool: ${msg}`)
}

function fail(msg) {
  console.error(`stage-frontend-tool: ${msg}`)
  process.exit(1)
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

function main() {
  if (!fs.existsSync(SRC)) {
    fail(`no tool at ${SRC}`)
  }
  // ui/dist is built by the tool's own `npm run build`. Staging deliberately
  // does NOT build it: a packaging step that silently rebuilds the UI hides
  // which commit's UI you are shipping.
  if (!fs.existsSync(path.join(SRC, 'ui', 'dist', 'index.html'))) {
    fail(`ui/dist is not built — run \`npm run build\` in tools/frontend-debugger first`)
  }

  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(OUT, { recursive: true })

  for (const entry of COPY) {
    const from = path.join(SRC, entry)
    if (!fs.existsSync(from)) {
      fail(`expected ${entry} in the tool tree`)
    }
    fs.cpSync(from, path.join(OUT, entry), { recursive: true })
  }
  fs.cpSync(path.join(SRC, 'ui', 'dist'), path.join(OUT, 'ui', 'dist'), { recursive: true })
  log(`copied ${COPY.join(', ')}, ui/dist`)

  // The plan says "no lockfile in the staged tree", but `npm ci` REQUIRES one.
  // Both are satisfiable: install from the lockfile so the staged dep set is
  // reproducible, then drop it — it is an input to staging, not a shipped file.
  const lock = path.join(SRC, 'package-lock.json')
  if (!fs.existsSync(lock)) {
    fail('no package-lock.json — cannot stage a reproducible dependency set')
  }
  fs.cpSync(lock, path.join(OUT, 'package-lock.json'))
  log('installing production dependencies (npm ci --omit=dev)…')
  try {
    execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: OUT,
      stdio: 'inherit',
    })
  } catch (err) {
    fail(`npm ci failed: ${err.message}`)
  }
  fs.rmSync(path.join(OUT, 'package-lock.json'), { force: true })

  for (const rel of PREFLIGHT) {
    if (!fs.existsSync(path.join(OUT, rel))) {
      fail(`staged tree fails the extension's own preflight: ${rel} is missing`)
    }
  }

  const mb = (dirSize(OUT) / (1024 * 1024)).toFixed(1)
  log(`staged ${OUT} (${mb} MB) — passes preflight`)
}

main()
