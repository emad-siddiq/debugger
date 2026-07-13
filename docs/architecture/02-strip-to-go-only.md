# 02 — Strip to Go-only

> Part of the [Go IDE overhaul](00-overview.md). Depends on: 01. Effort: ~2 wk.

## Goal

Remove everything that doesn't serve Go backend development. What remains is a
minimal shell: editor, search, git, integrated terminal (bash), debugging
plumbing, and the surface our built-in extensions attach to.

## Why

Minimalism is a stated product goal, and every removed subsystem is rebase
surface and startup cost we never pay again. Deletion is layer 2 of the fork
strategy — cheap to carry, so we do it aggressively and early.

## The keep / remove ledger

**Keep** (with the reason):

| Subsystem | Why it stays |
|-----------|--------------|
| Editor core, multi-cursor, minimap-off-by-default | the point |
| Search / replace across files | daily driver |
| Git (built-in `git` extension + SCM view) | daily driver |
| Integrated terminal, default profile **bash** | explicit requirement |
| Debug core (DAP client, breakpoints service) | tasks 04–06 build on it |
| Tasks runner | `go generate`, migrations (task 03 wires it) |
| Extension *host* | our built-in extensions run in it |
| Settings UI (pruned), keybindings, command palette | usability |
| Markdown language basics + preview | READMEs, these docs |
| JSON/YAML/TOML/SQL/Dockerfile/shell **syntax** highlighting | configs a Go repo actually contains (`go.mod`, compose, migrations) |
| Themes: our two (task 12) | design system |

**Remove** (mechanism in parentheses — *d* = delete built-in extension dir,
*p* = patch ledger entry):

- All other language built-ins: PHP, Python-basics, Ruby, C#, C/C++, Java,
  Swift, Rust-basics, F#, VB, Perl, Lua, R, Julia, Groovy, Clojure, LaTeX,
  Razor, Handlebars, Pug, Less/SCSS, CoffeeScript, HTML/CSS/JS/TS language
  *services* (keep bare JS/JSON grammar for config files) (d)
- Emmet (d) · Notebooks/Jupyter workbench contrib (p) · Interactive window (p)
- Extension marketplace views, install/search UI, `.vsix` sideload command (p)
- Settings Sync, account/auth UI, GitHub auth built-ins (d/p)
- Remote development stubs (SSH/WSL/tunnels/dev-container UI), code-server-era
  web bits we'll never serve (p)
- Walkthroughs/Getting-started for removed features, release-notes viewer,
  issue reporter, feedback/survey surfaces (p)
- Node/JS debugger (`ms-vscode.js-debug` built-in) and every non-Go debug
  adapter (d) — Delve is the only debugger aboard
- Snippet-language built-ins for removed languages, TypeScript build tasks,
  npm-scripts view (d)
- Profiles UI, Copilot/chat hooks and `chat` contribution points (p)

Each removal lands as its own commit tagged `strip:` with the app still
booting — a bisectable strip sequence.

## Tasks

1. **Inventory.** Script `tools/inventory.js`: dump every built-in extension +
   workbench contribution in the pinned upstream into `STRIP.md` with a
   keep/remove/why column. Review that table once, then execute it.
2. **Delete built-in extensions** per ledger (the easy 60%). Verify
   `npm run gulp vscode-darwin-arm64` excludes them from the bundle.
3. **Patch out workbench contributions** per ledger (marketplace UI, sync,
   remote, notebooks, chat, issue reporter…), one ledger entry each. Prefer
   the upstream-supported switches (`product.json` quality gates,
   contribution-point no-ops) over surgical deletes where they exist.
4. **Prune the settings surface.** Hide settings of removed subsystems from the
   Settings UI (they'd be dead controls). Curate a `burrow` settings category
   as the front page.
5. **Prune commands & menus.** Command-palette audit: every command referencing
   a removed feature is gone. Menu bar shrinks to: App, File, Edit, Selection,
   View, Go(to), Run, Terminal, Help.
6. **Startup budget.** Record cold-start and memory baselines before/after in
   `STRIP.md`. Target: measurably leaner than stock (numbers, not vibes —
   expect ~30–40% fewer activated built-ins).
7. **Terminal defaults.** Default profile bash (zsh/fish selectable), sane
   PATH inheritance from the login shell on macOS (`chsh`-agnostic), cwd =
   workspace root.

## Acceptance criteria

- App boots and edits/searches/commits a Go repo with **no** marketplace, sync,
  remote, notebook, or non-Go-language UI reachable from any menu, palette
  entry, or setting.
- `STRIP.md` ledger complete; every removal is one bisectable commit.
- Cold start ≤ stock VS Code on the same machine (should beat it comfortably).
- Terminal opens bash in the workspace root out of the box.

## Out of scope

- Adding anything Go (task 03). This task only ever deletes.
- Theme/visual work (task 12) beyond not shipping removed-feature icons.
