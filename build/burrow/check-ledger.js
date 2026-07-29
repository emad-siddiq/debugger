// check-ledger.js — CI guard for the layer-3 patch discipline (see
// ../../patches/README.md). Fails if a core-source change under src/ or build/
// is not described by some patches/NNNN-*.md ledger entry.
//
// This is intentionally coarse: it proves the *discipline* is followed (a core
// change came with a ledger update), not that every hunk maps to an entry. What
// it is not allowed to be is vacuous — see "Three ways this used to rot" below.
// Runs on Node only, no deps — invoked by `make ledger-check` and CI.
//
// Usage: node build/burrow/check-ledger.js [--committed]
//   default      HEAD plus the working tree (what you are about to commit)
//   --committed  HEAD only (what CI would see on a clean checkout)

const { execSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..', '..')
const BASE_FILE = path.join(REPO, 'patches', 'UPSTREAM_BASE')
const COMMITTED_ONLY = process.argv.includes('--committed')

// Paths that count as "core source" (layer 3). Extensions we own and config
// files are excluded — they are layers 1 and 4, not ledgered here.
const CORE = [/^src\//, /^build\/(?!burrow\/)/]
const EXCLUDE = [/^extensions\/burrow-/, /^build\/burrow\//]

// --- Three ways this used to rot, and what stops each now -------------------
//
// 1. THE BASELINE MOVED. `BASE` was the branch name `upstream-v1.128`. That
//    branch was refetched past the fork commit, `git diff BASE...HEAD` began
//    answering `no merge base`, and the gate exited without ever checking
//    anything — for weeks, in CI, silently green-ish. Now the baseline is a SHA
//    recorded in `patches/UPSTREAM_BASE`, which nothing can move, and every
//    candidate is *verified* to be an ancestor of HEAD before it is used.
//
// 2. IT NEVER FAILED ON A REAL VIOLATION. The old check was
//    `entries.length === 0` — "does patches/ contain any file at all". With 14
//    entries on disk, every possible core change passed. Now each changed core
//    file must be named by some entry (§ledgerNames).
//
// 3. IT COULD PASS BY SEEING NOTHING. A wrong-but-resolvable baseline yields an
//    empty diff, and an empty diff printed "no core-source changes — OK". On a
//    fork carrying 14 patches that answer is impossible, so it is now a failure:
//    a gate that reports success because it looked at nothing is worse than a
//    gate that is switched off, because it also reports confidence.

function git(args, { allowFail = false } = {}) {
  try {
    return execSync(`git ${args}`, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    if (allowFail) return undefined
    throw err
  }
}

function fail(lines) {
  for (const line of [].concat(lines)) console.error(line)
  process.exit(1)
}

// --- the baseline -----------------------------------------------------------

/** The SHA in patches/UPSTREAM_BASE — first line that is not blank or a `#`. */
function recordedBase() {
  if (!fs.existsSync(BASE_FILE)) return undefined
  for (const raw of fs.readFileSync(BASE_FILE, 'utf8').split('\n')) {
    const line = raw.trim()
    if (line && !line.startsWith('#')) return line
  }
  return undefined
}

/** The first candidate that exists and is an ancestor of HEAD. */
function resolveBase() {
  const candidates = [
    ['BURROW_UPSTREAM_REF', process.env.BURROW_UPSTREAM_REF],
    ['patches/UPSTREAM_BASE', recordedBase()],
    ['branch upstream-v1.128', 'upstream-v1.128'],
  ].filter(([, ref]) => Boolean(ref))

  const tried = []
  for (const [source, ref] of candidates) {
    if (git(`rev-parse --verify --quiet ${ref}^{commit}`, { allowFail: true }) === undefined) {
      tried.push(`  ${ref} (${source}) — no such commit`)
      continue
    }
    if (git(`merge-base --is-ancestor ${ref} HEAD`, { allowFail: true }) === undefined) {
      tried.push(`  ${ref} (${source}) — not an ancestor of HEAD`)
      continue
    }
    // Say what was skipped. Falling back silently is how the branch-name
    // baseline went bad unnoticed in the first place.
    for (const line of tried) console.error(`check-ledger: skipped${line.slice(1)}`)
    return { ref, source, sha: git(`rev-parse ${ref}`).trim() }
  }
  fail([
    'check-ledger: no usable upstream baseline. Tried:',
    ...tried,
    '',
    'The baseline is the commit this fork branched from. Record its SHA in',
    'patches/UPSTREAM_BASE, or pass BURROW_UPSTREAM_REF=<sha> for a one-off run.',
    'Refusing to report OK without one: an unmeasured diff is not a clean diff.',
  ])
}

// --- what changed -----------------------------------------------------------

function changedFiles(base) {
  const files = new Set()
  const add = (out) => (out || '').split('\n').map((s) => s.trim()).filter(Boolean).forEach((f) => files.add(f))

  const committed = git(`diff --name-only ${base}...HEAD`, { allowFail: true })
  if (committed === undefined) {
    // Cannot happen — resolveBase proved the ancestry — but a gate that guesses
    // when its own assumption breaks is how this file rotted the first time.
    fail(`check-ledger: baseline ${base} verified as an ancestor but would not diff. Repository state is inconsistent.`)
  }
  add(committed)

  if (!COMMITTED_ONLY) {
    // Uncommitted work counts: catching an unledgered core edit before it is
    // committed is the whole point of running this locally.
    for (const line of (git('status --porcelain --untracked-files=all') || '').split('\n')) {
      const name = line.slice(3).trim()
      if (!name) continue
      // Renames read `old -> new`; the new path is the one that exists.
      files.add(name.includes(' -> ') ? name.split(' -> ')[1].trim() : name)
    }
  }
  return [...files]
}

const isCore = (f) => CORE.some((re) => re.test(f)) && !EXCLUDE.some((re) => re.test(f))

// --- what the ledger claims -------------------------------------------------

/** Expand one level of `foo.{a,b}` — 0014 writes `railEditorSets.{contribution.ts,md}`. */
function expandBraces(token) {
  const match = /^(.*)\{([^{}]*)\}(.*)$/.exec(token)
  if (!match) return [token]
  return match[2].split(',').map((part) => `${match[1]}${part.trim()}${match[3]}`)
}

/**
 * Every file-ish name any ledger entry mentions, in three forms: full path,
 * basename, and basename without extension.
 *
 * Deliberately scanned from the whole entry rather than parsed out of the
 * `**Upstream files touched:**` field. That field is prose — backticked in some
 * entries and bare in others, wrapped across lines in 0008 and 0011 — and a
 * parser strict enough to read it is a parser that starts silently matching
 * nothing the first time someone reformats a bullet. Coarse and durable beats
 * precise and brittle for a discipline check.
 */
function ledgerNames() {
  const dir = path.join(REPO, 'patches')
  if (!fs.existsSync(dir)) return { names: new Set(), entries: [] }
  const entries = fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.md$/.test(f))
  const names = new Set()
  for (const entry of entries) {
    const text = fs.readFileSync(path.join(dir, entry), 'utf8')
    for (const raw of text.match(/[\w./{},-]*[\w}]\.[a-z]{2,4}\b|[\w./-]*\/[\w.-]+/g) || []) {
      for (const token of expandBraces(raw.replace(/^[`'"(]+|[`'".,)]+$/g, ''))) {
        names.add(token)
        const base = token.split('/').pop()
        if (!base) continue
        names.add(base)
        names.add(base.replace(/\.[^.]+$/, ''))
      }
    }
  }
  return { names, entries }
}

/** A core file is covered when some entry names it, its basename, or its stem. */
function covered(file, names) {
  const base = file.split('/').pop()
  return names.has(file) || names.has(base) || names.has(base.replace(/\.[^.]+$/, ''))
}

// --- run --------------------------------------------------------------------

const base = resolveBase()
const coreTouched = changedFiles(base.sha).filter(isCore).sort()
const { names, entries } = ledgerNames()

console.log(`check-ledger: baseline ${base.sha.slice(0, 8)} via ${base.source}` +
  `${COMMITTED_ONLY ? ' · HEAD only' : ' · HEAD + working tree'}`)

if (entries.length === 0) {
  fail([
    'check-ledger: patches/ has no ledger entries at all.',
    'Either this is not the Burrow fork, or the ledger has been deleted.',
  ])
}

if (coreTouched.length === 0) {
  fail([
    `check-ledger: ${entries.length} ledger entries exist but the diff against ${base.sha.slice(0, 8)}`,
    'shows no core-source changes. That combination is impossible on this fork —',
    'the baseline is wrong. Fix patches/UPSTREAM_BASE rather than trusting this run.',
  ])
}

const orphans = coreTouched.filter((f) => !covered(f, names))
if (orphans.length > 0) {
  fail([
    `check-ledger: ${orphans.length} core file(s) changed that no ledger entry mentions:`,
    ...orphans.map((f) => `  ${f}`),
    '',
    `Checked all ${entries.length} entries in patches/. Add the file to the entry that owns`,
    'the change, or open a new patches/NNNN-*.md (see patches/README.md).',
  ])
}

console.log(`check-ledger: ${coreTouched.length} core file(s) changed, all named by ${entries.length} ledger entr(y/ies) — OK.`)
