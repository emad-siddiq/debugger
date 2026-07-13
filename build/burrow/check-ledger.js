// check-ledger.js — CI guard for the layer-3 patch discipline (see
// ../../patches/README.md). Fails if the working diff (vs. the pristine
// upstream branch) touches core source under src/ or build/ without a
// corresponding patches/NNNN-*.md ledger entry existing.
//
// This is intentionally coarse: it proves the *discipline* is followed (a core
// change came with a ledger update), not that every hunk maps to an entry.
// Runs on Node only, no deps — invoked by `make ledger-check` and CI.

const { execSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..', '..')
const BASE = process.env.BURROW_UPSTREAM_REF || 'upstream-v1.128'
// Paths that count as "core source" (layer 3). Extensions we own and config
// files are excluded — they are layers 1 and 4, not ledgered here.
const CORE = [/^src\//, /^build\/(?!burrow\/)/]
const EXCLUDE = [/^extensions\/burrow-/, /^build\/burrow\//]

function changedFiles() {
  try {
    const out = execSync(`git diff --name-only ${BASE}...HEAD`, { cwd: REPO, encoding: 'utf8' })
    return out.split('\n').map((s) => s.trim()).filter(Boolean)
  } catch (err) {
    console.error(`check-ledger: cannot diff against ${BASE} (${err.message}).`)
    console.error('Set BURROW_UPSTREAM_REF or create the pristine branch.')
    process.exit(2)
  }
}

function ledgerEntries() {
  const dir = path.join(REPO, 'patches')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.md$/.test(f))
}

const files = changedFiles()
const coreTouched = files.filter(
  (f) => CORE.some((re) => re.test(f)) && !EXCLUDE.some((re) => re.test(f)),
)
const entries = ledgerEntries()

if (coreTouched.length === 0) {
  console.log('check-ledger: no core-source changes — OK.')
  process.exit(0)
}
if (entries.length === 0) {
  console.error('check-ledger: core source changed but patches/ has no ledger entries:')
  coreTouched.forEach((f) => console.error('  ' + f))
  console.error('Add a patches/NNNN-*.md entry (see patches/README.md).')
  process.exit(1)
}
console.log(`check-ledger: ${coreTouched.length} core file(s) changed, ${entries.length} ledger entr(y/ies) present — OK.`)
console.log('Reminder: ensure each core change is described by a ledger entry.')
