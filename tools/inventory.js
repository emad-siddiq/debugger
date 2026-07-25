#!/usr/bin/env node
// tools/inventory.js — Task 02 (strip to Go-only) ledger generator.
//
// Walks every built-in extension manifest in extensions/*, joins it against an
// explicit keep/remove DECISIONS map, and writes STRIP.md — the reviewable
// ledger that drives the strip sequence. Any extension present on disk but
// missing from DECISIONS is emitted as UNCLASSIFIED so gaps are impossible to
// miss. Product-level removals (builtInExtensions in product.json, e.g.
// js-debug) are listed too, since they don't have a dir under extensions/.
//
// Usage: node tools/inventory.js   (writes ./STRIP.md, prints a summary)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EXT_DIR = path.join(ROOT, 'extensions');

// --- The decision map (the source of truth; STRIP.md is generated from it) ---
// action: 'keep' | 'remove'
// via:    'core'    our own extension
//         'lang'    language grammar/service we keep for config files
//         'd'       delete the built-in extension dir (layer 2)
//         'p'       patch/product-level (workbench contribution no-op)  — kept for symmetry
//         'interim' keep for now, task 12 replaces (themes)
//         'devtest' dev/test fixture, already excluded from the product build
//         'vendor'  third-party prebuilt extension vendored into extensions/ (pinned, offline)
const DECISIONS = {
  // ---- KEEP: the Go IDE core surface --------------------------------------
  'burrow-core': { action: 'keep', via: 'core', why: 'our own extension (task 01)' },
  'burrow-db': { action: 'keep', via: 'core', why: 'our own extension (DB explorer)' },
  'burrow-docker': { action: 'keep', via: 'core', why: 'our own extension (docker panel)' },
  'burrow-flow': { action: 'keep', via: 'core', why: 'our own extension (flow view)' },
  'burrow-frontend-debugger': { action: 'keep', via: 'core', why: 'our own extension (frontend debugger host)' },
  'burrow-fullstack': { action: 'keep', via: 'core', why: 'our own extension (fullstack glue)' },
  'burrow-go-base': { action: 'keep', via: 'core', why: 'our own extension (gopls bootstrap)' },
  'burrow-go-debug': { action: 'keep', via: 'core', why: 'our own extension (Delve debug)' },
  'burrow-go-docs': { action: 'keep', via: 'core', why: 'our own extension (Go docs viewer)' },
  'burrow-go-inspect': { action: 'keep', via: 'core', why: 'our own extension (runtime inspect)' },
  'burrow-go-nav': { action: 'keep', via: 'core', why: 'our own extension (Go navigation)' },
  'burrow-go-test': { action: 'keep', via: 'core', why: 'our own extension (Go test runner)' },
  'burrow-go-viz': { action: 'keep', via: 'core', why: 'our own extension (Go visualizations)' },
  'burrow-http': { action: 'keep', via: 'core', why: 'our own extension (HTTP workbench, task 09)' },
  'burrow-oracle': { action: 'keep', via: 'core', why: 'our own extension (oracle digest)' },
  'burrow-theme-xcode': { action: 'keep', via: 'core', why: 'our own themes (task 12)' },
  'burrow-ts-base': { action: 'keep', via: 'core', why: 'our own extension (typescript-language-server bootstrap, M4)' },
  'go': { action: 'keep', via: 'lang', why: 'the point — Go language + grammar' },
  'git': { action: 'keep', via: 'lang', why: 'SCM daily driver' },
  'git-base': { action: 'keep', via: 'lang', why: 'git extension dependency (repo picker/API)' },
  'merge-conflict': { action: 'keep', via: 'lang', why: 'in-editor conflict resolution — part of git flow' },
  'configuration-editing': { action: 'keep', via: 'lang', why: 'IntelliSense for settings/launch/tasks JSON' },
  'extension-editing': { action: 'keep', via: 'lang', why: 'lints our burrow-* package.json authoring' },
  'references-view': { action: 'keep', via: 'lang', why: 'find-all-references / call hierarchy tree (gopls)' },
  'search-result': { action: 'keep', via: 'lang', why: 'search-results editor highlighting' },
  'terminal-suggest': { action: 'keep', via: 'lang', why: 'completion in the integrated bash terminal' },
  'debug-server-ready': { action: 'keep', via: 'lang', why: 'adapter-agnostic auto-open on server-ready (backend dev)' },
  'media-preview': { action: 'keep', via: 'lang', why: 'view images/diagrams in the repo (cheap, non-language)' },
  'diff': { action: 'keep', via: 'lang', why: 'diff/patch grammar — cheap, git artifacts' },

  // config-file languages a Go repo actually contains
  'json': { action: 'keep', via: 'lang', why: 'JSON grammar — configs everywhere' },
  'json-language-features': { action: 'keep', via: 'lang', why: 'JSON schema validation for configs' },
  'yaml': { action: 'keep', via: 'lang', why: 'compose / k8s / CI configs' },
  'sql': { action: 'keep', via: 'lang', why: 'migrations (ledger: keep SQL)' },
  'docker': { action: 'keep', via: 'lang', why: 'Dockerfile + compose (ledger: keep Dockerfile)' },
  'shellscript': { action: 'keep', via: 'lang', why: 'bash scripts (ledger: keep shell)' },
  'make': { action: 'keep', via: 'lang', why: 'Makefiles — common in Go repos' },
  'ini': { action: 'keep', via: 'lang', why: '.ini/.gitconfig/.editorconfig-adjacent configs' },
  'dotenv': { action: 'keep', via: 'lang', why: '.env files — Go backends read them' },
  'log': { action: 'keep', via: 'lang', why: 'log-file colorizer — we read logs' },
  'javascript': { action: 'keep', via: 'lang', why: 'bare JS grammar for the odd .js config (ledger)' },
  'markdown-basics': { action: 'keep', via: 'lang', why: 'READMEs + these docs (ledger: keep markdown)' },
  'markdown-language-features': { action: 'keep', via: 'lang', why: 'markdown preview (ledger: keep preview)' },

  // interim themes until task 12 ships ours (need a color + icon theme aboard)
  'theme-defaults': { action: 'keep', via: 'interim', why: 'default color + icon theme — task 12 replaces' },
  'theme-seti': { action: 'keep', via: 'interim', why: 'default file-icon theme — task 12 replaces' },

  // ---- REMOVE: non-Go languages (delete dir) ------------------------------
  'bat': { action: 'remove', via: 'd', why: 'non-Go language (Windows batch)' },
  'clojure': { action: 'remove', via: 'd', why: 'non-Go language' },
  'coffeescript': { action: 'remove', via: 'd', why: 'non-Go language' },
  'cpp': { action: 'remove', via: 'd', why: 'non-Go language' },
  'csharp': { action: 'remove', via: 'd', why: 'non-Go language' },
  'css': { action: 'remove', via: 'd', why: 'non-Go language (web)' },
  'css-language-features': { action: 'remove', via: 'd', why: 'CSS language service (web)' },
  'dart': { action: 'remove', via: 'd', why: 'non-Go language' },
  'fsharp': { action: 'remove', via: 'd', why: 'non-Go language' },
  'groovy': { action: 'remove', via: 'd', why: 'non-Go language' },
  'handlebars': { action: 'remove', via: 'd', why: 'templating (web)' },
  'hlsl': { action: 'remove', via: 'd', why: 'shader language' },
  'html': { action: 'remove', via: 'd', why: 'non-Go language (web)' },
  'html-language-features': { action: 'remove', via: 'd', why: 'HTML language service (web)' },
  'java': { action: 'remove', via: 'd', why: 'non-Go language' },
  'julia': { action: 'remove', via: 'd', why: 'non-Go language' },
  'latex': { action: 'remove', via: 'd', why: 'non-Go language' },
  'less': { action: 'remove', via: 'd', why: 'CSS preprocessor (web)' },
  'lua': { action: 'remove', via: 'd', why: 'non-Go language' },
  'objective-c': { action: 'remove', via: 'd', why: 'non-Go language' },
  'perl': { action: 'remove', via: 'd', why: 'non-Go language' },
  'php': { action: 'remove', via: 'd', why: 'non-Go language' },
  'php-language-features': { action: 'remove', via: 'd', why: 'PHP language service' },
  'powershell': { action: 'remove', via: 'd', why: 'non-Go language' },
  'pug': { action: 'remove', via: 'd', why: 'templating (web)' },
  'python': { action: 'keep', via: 'lang', why: 'restored — markdown fenced-code fidelity (Go-adjacent scripts, docs)' },
  'r': { action: 'remove', via: 'd', why: 'non-Go language' },
  'razor': { action: 'remove', via: 'd', why: 'templating (web/.NET)' },
  'restructuredtext': { action: 'remove', via: 'd', why: 'non-Go markup (Python docs)' },
  'ruby': { action: 'remove', via: 'd', why: 'non-Go language' },
  'rust': { action: 'keep', via: 'lang', why: 'restored — markdown fenced-code fidelity' },
  'scss': { action: 'remove', via: 'd', why: 'CSS preprocessor (web)' },
  'shaderlab': { action: 'remove', via: 'd', why: 'shader language' },
  'swift': { action: 'remove', via: 'd', why: 'non-Go language' },
  'typescript-basics': { action: 'keep', via: 'lang', why: 'restored by M4 (N3) — TS/TSX grammar for the frontend + md fences' },
  'js-debug': { action: 'keep', via: 'vendor', why: 'restored (WO-16) — vendored ms-vscode.js-debug 1.105.0 (MIT, engines ^1.80.0), the chrome/pwa-chrome debugger for merkle frontend TSX breakpoints' },
  'typescript-language-features': { action: 'remove', via: 'd', why: 'heavy TS/JS language service (ledger: drop language services)' },
  'vb': { action: 'remove', via: 'd', why: 'non-Go language' },
  'xml': { action: 'remove', via: 'd', why: 'rare in Go repos — minimalism' },
  'markdown-math': { action: 'remove', via: 'd', why: 'KaTeX in preview — not needed for Go docs' },
  'prompt-basics': { action: 'remove', via: 'd', why: 'chat .prompt.md grammar — chat is stripped' },

  // ---- REMOVE: web/notebook/task-runner subsystems ------------------------
  'emmet': { action: 'remove', via: 'd', why: 'HTML/CSS abbreviation (web)' },
  'ipynb': { action: 'remove', via: 'd', why: 'Jupyter notebooks' },
  'notebook-renderers': { action: 'remove', via: 'd', why: 'notebook output renderers' },
  'mermaid-markdown-features': { action: 'remove', via: 'd', why: 'diagram preview — now entangled with chat contribs' },
  'simple-browser': { action: 'remove', via: 'd', why: 'embedded web browser — task 09 HTTP workbench supersedes' },
  'grunt': { action: 'remove', via: 'd', why: 'JS task runner' },
  'gulp': { action: 'remove', via: 'd', why: 'JS task runner' },
  'jake': { action: 'remove', via: 'd', why: 'JS task runner' },
  'npm': { action: 'remove', via: 'd', why: 'npm-scripts view + JS task provider (ledger)' },

  // ---- REMOVE: accounts / remote / AI ------------------------------------
  'github': { action: 'remove', via: 'd', why: 'GitHub PR/publish integration (ledger)' },
  'github-authentication': { action: 'remove', via: 'd', why: 'GitHub auth (ledger)' },
  'microsoft-authentication': { action: 'remove', via: 'd', why: 'MSA auth for sync/marketplace' },
  'copilot': { action: 'remove', via: 'd', why: 'Copilot/chat hooks (ledger: no integrated AI yet)' },
  'tunnel-forwarding': { action: 'remove', via: 'd', why: 'remote tunnels / port forwarding (code-server-era)' },
  'debug-auto-launch': { action: 'remove', via: 'd', why: 'Node auto-attach debugger' },

  // ---- REMOVE: surplus stock themes (task 12 ships ours) -------------------
  'theme-abyss': { action: 'remove', via: 'd', why: 'surplus stock theme — task 12 ships ours' },
  'theme-kimbie-dark': { action: 'remove', via: 'd', why: 'surplus stock theme — task 12 ships ours' },
  'theme-monokai': { action: 'remove', via: 'd', why: 'surplus stock theme — task 12 ships ours' },
  'theme-monokai-dimmed': { action: 'remove', via: 'd', why: 'surplus stock theme — task 12 ships ours' },
  'theme-quietlight': { action: 'remove', via: 'd', why: 'surplus stock theme — task 12 ships ours' },
  'theme-red': { action: 'remove', via: 'd', why: 'surplus stock theme — task 12 ships ours' },
  'theme-solarized-dark': { action: 'remove', via: 'd', why: 'surplus stock theme — task 12 ships ours' },
  'theme-solarized-light': { action: 'remove', via: 'd', why: 'surplus stock theme — task 12 ships ours' },
  'theme-tomorrow-night-blue': { action: 'remove', via: 'd', why: 'surplus stock theme — task 12 ships ours' },

  // ---- dev/test fixtures: already excluded from the product build ----------
  'vscode-api-tests': { action: 'keep', via: 'devtest', why: 'VS Code API test suite — not shipped; keep to not break tests' },
  'vscode-colorize-tests': { action: 'keep', via: 'devtest', why: 'colorizer test suite — not shipped' },
  'vscode-colorize-perf-tests': { action: 'keep', via: 'devtest', why: 'colorizer perf suite — not shipped' },
  'vscode-test-resolver': { action: 'keep', via: 'devtest', why: 'remote test resolver fixture — not shipped' },
};

// Product-level removals (no dir under extensions/): edit product.json.
// DONE now: the three js-debug builtInExtensions. DEFERRED: the Copilot
// defaultChatAgent — it is load-bearing for core services in this chat-centric
// fork (removing it crashes accounts/onboarding/sessions at startup), so its
// excision is a dedicated follow-on (see Commit plan → Deferred).
const PRODUCT_REMOVALS = [
  { name: 'ms-vscode.js-debug', why: 'RESTORED (WO-16) — vendored prebuilt into extensions/js-debug; chrome/pwa-chrome for merkle frontend TSX breakpoints. Delve still owns Go.', where: 'vendored dir (was product.json builtInExtensions)', status: 'restored' },
  { name: 'ms-vscode.js-debug-companion', why: 'js-debug browser companion', where: 'product.json builtInExtensions', status: 'done' },
  { name: 'ms-vscode.vscode-js-profile-table', why: 'js-debug profile viewer', where: 'product.json builtInExtensions', status: 'done' },
  { name: 'GitHub.copilot / copilot-chat (defaultChatAgent)', why: 'integrated AI — not yet (ledger); load-bearing config, excise separately', where: 'product.json defaultChatAgent', status: 'DEFERRED' },
];

// --- Manifest scan -----------------------------------------------------------
// Iterate the UNION of what's on disk and what's in DECISIONS, so STRIP.md stays
// a stable ledger after the strip runs: a removed extension that's no longer on
// disk still appears (marked ✓ removed), and a kept extension that went missing
// is flagged loudly. Run before the strip to plan it, after to verify it.
function readExtensions() {
  const onDisk = new Set(
    fs.readdirSync(EXT_DIR).filter((name) => {
      const manifest = path.join(EXT_DIR, name, 'package.json');
      if (!fs.existsSync(manifest)) return false;
      try {
        const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        return !!(pkg.engines && pkg.engines.vscode); // skip stray package.json dirs
      } catch { return false; }
    }),
  );
  const names = new Set([...onDisk, ...Object.keys(DECISIONS)]);
  const rows = [];
  for (const name of [...names].sort()) {
    const present = onDisk.has(name);
    let c = {};
    if (present) {
      c = JSON.parse(fs.readFileSync(path.join(EXT_DIR, name, 'package.json'), 'utf8')).contributes || {};
    }
    rows.push({
      name,
      present,
      langs: (c.languages || []).map((l) => l.id).filter(Boolean),
      grammars: (c.grammars || []).length,
      debuggers: (c.debuggers || []).map((d) => d.type),
      themes: (c.themes || []).length + (c.iconThemes || []).length,
      hasChat: !!(c.chatParticipants || c.chatAgents || c.languageModelTools || c.chatOutputRenderers),
      hasAuth: !!c.authentication,
      hasNotebook: !!(c.notebooks || c.notebookRenderer),
      decision: DECISIONS[name] || { action: 'UNCLASSIFIED', via: '?', why: 'NOT IN DECISIONS MAP — classify me' },
    });
  }
  return rows;
}

// --- STRIP.md rendering ------------------------------------------------------
function tags(r) {
  const t = [];
  if (r.langs.length) t.push(`lang:${r.langs.join('/')}`);
  else if (r.grammars) t.push(`${r.grammars} grammar`);
  if (r.debuggers.length) t.push(`dbg:${r.debuggers.join('/')}`);
  if (r.themes) t.push(`${r.themes} theme`);
  if (r.hasChat) t.push('chat');
  if (r.hasAuth) t.push('auth');
  if (r.hasNotebook) t.push('notebook');
  return t.join(', ') || '—';
}

function table(rows, showStatus) {
  const head = showStatus
    ? '| Extension | Contributes | Status | Why |\n|---|---|---|---|'
    : '| Extension | Contributes | Why |\n|---|---|---|';
  const body = rows
    .map((r) => showStatus
      ? `| \`${r.name}\` | ${tags(r)} | ${r.present ? 'pending' : '✓ removed'} | ${r.decision.why} |`
      : `| \`${r.name}\` | ${tags(r)} | ${r.decision.why} |`)
    .join('\n');
  return `${head}\n${body}`;
}

function render(rows) {
  const keeps = rows.filter((r) => r.decision.action === 'keep' && r.decision.via !== 'devtest');
  const devtest = rows.filter((r) => r.decision.via === 'devtest');
  const removes = rows.filter((r) => r.decision.action === 'remove');
  const unclassified = rows.filter((r) => r.decision.action === 'UNCLASSIFIED');
  const missingKeeps = keeps.concat(devtest).filter((r) => !r.present);
  const removedDone = removes.filter((r) => !r.present).length;

  const lines = [];
  lines.push('# STRIP.md — Task 02 keep/remove ledger');
  lines.push('');
  lines.push('> Generated by `node tools/inventory.js` over the UNION of on-disk');
  lines.push('> extensions and the `DECISIONS` map, so it is stable across the strip:');
  lines.push('> run it to plan (all removes `pending`), and again to verify (removes');
  lines.push('> flip to `✓ removed`, a vanished keeper is flagged). Do not hand-edit the');
  lines.push('> tables — edit `DECISIONS` in the script and regenerate. The commit plan');
  lines.push('> and Startup budget prose are filled in by hand.');
  lines.push('');
  lines.push(`Upstream pin: **1.128.0**. Classified: **${rows.length}** ` +
    `(keep ${keeps.length}, remove ${removes.length} [${removedDone} done], dev/test ${devtest.length}` +
    (unclassified.length ? `, **UNCLASSIFIED ${unclassified.length}**` : '') + ').');
  lines.push('');

  if (missingKeeps.length) {
    lines.push('## ⛔ REGRESSION — a keeper is missing from disk');
    lines.push('');
    lines.push(table(missingKeeps));
    lines.push('');
  }

  if (unclassified.length) {
    lines.push('## ⚠️ UNCLASSIFIED — fix before executing');
    lines.push('');
    lines.push(table(unclassified));
    lines.push('');
  }

  lines.push('## Keep');
  lines.push('');
  lines.push(table(keeps));
  lines.push('');
  lines.push('## Remove (delete extension dir — layer 2)');
  lines.push('');
  lines.push('Grouped into cohesive `strip:` commits below (see Commit plan). Status');
  lines.push('`pending` = still on disk, `✓ removed` = deleted.');
  lines.push('');
  lines.push(table(removes, true));
  lines.push('');
  lines.push('## Remove (product-level — edit product.json)');
  lines.push('');
  lines.push('| Entry | Where | Status | Why |\n|---|---|---|---|');
  for (const p of PRODUCT_REMOVALS) {
    lines.push(`| \`${p.name}\` | ${p.where} | ${p.status === 'done' ? '✓ done' : p.status} | ${p.why} |`);
  }
  lines.push('');
  lines.push('## Dev/test fixtures (left in place)');
  lines.push('');
  lines.push('Not shipped in the product build (excluded by `build/lib/extensions.ts`).');
  lines.push('Deleting them buys no runtime win and risks breaking `npm test`, so they stay.');
  lines.push('');
  lines.push(table(devtest));
  lines.push('');
  lines.push('## Commit plan (bisectable `strip:` sequence)');
  lines.push('');
  lines.push('The 64 dir deletions land as cohesive category commits (not 64 micro-commits);');
  lines.push('each leaves the app booting, so the sequence stays bisectable by subsystem.');
  lines.push('');
  lines.push('1. `build: burrow-curated extension compilations list` — prune stripped TS');
  lines.push('   extensions from `build/gulpfile.extensions.ts` (patch 0001).');
  lines.push('2. `strip: remove non-Go language extensions` — bat, clojure, coffeescript,');
  lines.push('   cpp, csharp, css(+lang), dart, fsharp, groovy, handlebars, hlsl, html(+lang),');
  lines.push('   java, julia, latex, less, lua, objective-c, perl, php(+lang), powershell,');
  lines.push('   pug, python, r, razor, restructuredtext, ruby, rust, scss, shaderlab,');
  lines.push('   swift, typescript-basics, typescript-language-features, vb, xml, markdown-math.');
  lines.push('3. `strip: remove notebook + web-preview subsystems` — ipynb, notebook-renderers,');
  lines.push('   mermaid-markdown-features, simple-browser, emmet.');
  lines.push('4. `strip: remove JS task runners + npm scripts` — grunt, gulp, jake, npm.');
  lines.push('5. `strip: remove accounts / remote / AI` — github, github-authentication,');
  lines.push('   microsoft-authentication, copilot, prompt-basics, tunnel-forwarding,');
  lines.push('   debug-auto-launch.');
  lines.push('6. `strip: remove surplus stock themes` — abyss, kimbie-dark, monokai,');
  lines.push('   monokai-dimmed, quietlight, red, solarized-dark, solarized-light,');
  lines.push('   tomorrow-night-blue (keep theme-defaults + theme-seti until task 12).');
  lines.push('7. `strip: product.json — drop js-debug builtInExtensions` — remove the three');
  lines.push('   js-debug entries. Delve is the only debugger aboard.');
  lines.push('8. `build: unwire removed extensions from the build` — prune esbuildMediaScripts');
  lines.push('   (`build/lib/extensions.ts`), the copilot npm scripts (`package.json`), and');
  lines.push('   guard the copilot hygiene check (`build/hygiene.ts`).');
  lines.push('');
  lines.push('**Deferred — Copilot/chat excision (its own task).** This upstream is a');
  lines.push('chat-centric fork: `product.defaultChatAgent` is load-bearing — core services');
  lines.push('(accounts, welcomeOnboarding, sessions) read it synchronously at startup and');
  lines.push('crash if it is absent. The copilot *extension dir* is deleted and js-debug is');
  lines.push('gone, but the `defaultChatAgent` config is kept so the app boots. Fully');
  lines.push('excising chat (product.json config + `src/vs/workbench/contrib/chat`, sessions,');
  lines.push('the chat npm deps) is a substantial follow-on tracked separately.');
  lines.push('');
  lines.push('Other layer-3 workbench-contribution patches (marketplace/sync/remote/notebook/');
  lines.push('issue-reporter UI), settings/command/menu pruning, and terminal defaults are');
  lines.push('their own follow-on `strip:` commits (task 02 sub-tasks 3–7).');
  lines.push('');
  lines.push('## Startup budget (fill in by hand)');
  lines.push('');
  lines.push('| Metric | Stock 1.128 | Burrow (post-strip) | Δ |');
  lines.push('|---|---|---|---|');
  lines.push('| Activated built-ins (onStartupFinished) | TBD | TBD | TBD |');
  lines.push('| Cold start to window (ms) | TBD | TBD | TBD |');
  lines.push('| Main-process RSS at idle (MB) | TBD | TBD | TBD |');
  lines.push('');
  return lines.join('\n') + '\n';
}

// --- main --------------------------------------------------------------------
const rows = readExtensions();
const out = render(rows);
fs.writeFileSync(path.join(ROOT, 'STRIP.md'), out);

const n = (a) => rows.filter(a).length;
const unclassified = rows.filter((r) => r.decision.action === 'UNCLASSIFIED');
const missingKeeps = rows.filter((r) => r.decision.action === 'keep' && !r.present);
const removedDone = n((r) => r.decision.action === 'remove' && !r.present);
console.log(`STRIP.md written: ${rows.length} classified ` +
  `(keep ${n((r) => r.decision.action === 'keep')}, ` +
  `remove ${n((r) => r.decision.action === 'remove')} [${removedDone} done]).`);
if (missingKeeps.length) {
  console.error(`\n⛔ REGRESSION — ${missingKeeps.length} keeper(s) missing from disk:`);
  for (const r of missingKeeps) console.error(`   - ${r.name}`);
  process.exit(2);
}
if (unclassified.length) {
  console.error(`\n⚠️  ${unclassified.length} UNCLASSIFIED — add to DECISIONS:`);
  for (const r of unclassified) console.error(`   - ${r.name}`);
  process.exit(1);
}
