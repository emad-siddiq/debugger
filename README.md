# Burrow — a Go-first IDE

A native, Go-first IDE + debugger. A fork of
[Code - OSS](https://github.com/microsoft/vscode) (upstream README preserved as
[`README.upstream.md`](README.upstream.md)) stripped to Go development and
rebuilt around first-class Delve debugging, Go data-structure visualization, an
integrated HTTP workbench, a database explorer, offline Go docs, and an
agent-bootstrapped codebase Oracle.

> Replaces the container-based "backend debugger" (code-server) of the
> `debugger` stack with a host-native app. Lives at `debugger/burrow/` (this dir)
> as an independent git repo. Full 15-task plan:
> [`docs/architecture/`](docs/architecture/00-overview.md) (salvaged from the
> now-deleted `debugger/backend/`).

## Status

**Task 01 — fork bootstrap & branding: done + verified.**

- [x] Fork pinned to upstream `1.128.0` (see [`UPSTREAM.md`](UPSTREAM.md))
- [x] Burrow identity in `product.json`; telemetry/voice endpoints removed
- [x] Governance: patch ledger, `BUILDING.md`, third-party notices, `Makefile`
- [x] First built-in extension `extensions/burrow-core` (+ patch `0001`)
- [x] `npm ci` + build + branded app boots; `burrow-core` activates

**Task 02 — strip to Go-only: bulk done + boot-verified.**

- [x] `tools/inventory.js` → [`STRIP.md`](STRIP.md) keep/remove ledger (32 keep / 64 remove)
- [x] 64 built-in extension dirs deleted (99 → 35): non-Go languages, web,
      notebooks, JS task-runners, accounts/remote, surplus themes, Node debugger
- [x] Build re-wired to match (patches `0002`); js-debug dropped from `product.json`
- [x] Leaf contributions stripped — surveys, issue reporter, remote tunnel (patch `0003`)
- [ ] Non-leaf contributions (marketplace view, sync, remote, notebook core, walkthroughs)
- [ ] Settings/command/menu pruning · terminal defaults · startup-budget numbers
- [ ] **Deferred:** full Copilot/chat excision (`defaultChatAgent` is load-bearing here)

Later tasks (03–14) add the Go toolchain, Delve engine, right-hand debug
inspector, visualizers, docs viewer, Oracle, HTTP workbench, DB explorer, tests,
design system, packaging, and the stack cutover.

## Layout

| Path | What |
|------|------|
| `product.json` | Burrow identity + kill-switches (layer 1: config) |
| `patches/` | numbered core-source patch ledger (layer 3) |
| `extensions/burrow-*` | Burrow's built-in extensions (layer 4 — most new code) |
| `build/burrow/` | Burrow-specific build tooling (e.g. `check-ledger.js`) |
| `UPSTREAM.md` | the upstream pin + rebase procedure |
| `BUILDING.md` | how to build (Node pin, `make deps/dev/dist`) |

Everything else is upstream VS Code, changed only through the four layers
documented in [`UPSTREAM.md`](UPSTREAM.md).

## Launch

Requires Node **24.17.0** (`.nvmrc`). This repo installed it outside Homebrew
(brew was broken) at `~/.local/burrow-node` — put it on `PATH` first:

```sh
cd ~/Projects/debugger/burrow
export PATH="$HOME/.local/burrow-node/current/bin:$PATH"   # or: fnm use
node -v                                                    # must print v24.17.0

make deps    # first time only — npm ci (Electron + native modules, slow)
make dev     # compiles if needed, then launches the branded "Burrow — Go IDE" app
```

`make dev` runs `scripts/code.sh`, which opens the current folder. To open a Go
project, pass it after the flags — or just `File → Open Folder` once it's up:

```sh
./scripts/code.sh /path/to/your/go/project
```

**Run it from a normal Terminal, not from inside VS Code.** VS Code's integrated
terminal exports `ELECTRON_RUN_AS_NODE` + `VSCODE_*`, which make the Electron app
boot as plain Node and crash (`… does not provide an export named 'Menu'`). If
you must launch from within VS Code, scrub those first:

```sh
for v in $(env | grep -oE '^(VSCODE|ELECTRON)[A-Z_]*' | sort -u); do unset "$v"; done
./scripts/code.sh
```

On macOS also keep `--user-data-dir` short (e.g. `/tmp/bw`) — the instance IPC
socket overflows the 103-char unix-socket limit under deep paths.

### Build & install the standalone app

```sh
cd ~/Projects/debugger/burrow
export PATH="$HOME/.local/burrow-node/current/bin:$PATH"   # Node 24.17.0, as above

make dist      # packaged app → ../VSCode-darwin-<arch>/Burrow — Go IDE.app
make install   # copy to ~/Applications/Burrow.app + ad-hoc codesign
```

Notes that have each cost a debugging session:

- The packaged app is a **sibling of the repo** (`../VSCode-darwin-<arch>/`).
  `.build/electron/` looks like the app but is the bare Electron shell — no
  `Resources/app` payload.
- `make dist` also runs `stage-tools`: gulp does not package `tools/`, and
  without it the Components rail has no sidecar and API Flows has no tracer.
  If you re-package by hand, run `make stage-tools` afterwards.
- `make install` ad-hoc signs (`codesign -s -`) so the local, un-notarized build
  launches; a fresh install may need one right-click → Open. If it fails with a
  codesign "Operation not permitted", just re-run it and verify with
  `codesign -v ~/Applications/Burrow.app`.
- Quit any running Burrow first — installing replaces the bundle under it.
- System-wide instead: `sudo make install INSTALL=/Applications/Burrow.app`.

**Iterating on one extension?** Skip the ~10-minute rebuild: `make dist` ships
plain tsc output, so compiling the extension and copying its `out/` into the
bundle is byte-equivalent to a rebuild of that extension:

```sh
npx tsc -p extensions/burrow-chat
cp extensions/burrow-chat/out/*.js \
  "../VSCode-darwin-arm64/Burrow — Go IDE.app/Contents/Resources/app/extensions/burrow-chat/out/"
```

Relaunch to pick it up (a live app holds the old code in memory). Finish with
one clean `make dist && make install` so the shipped app is a real build.

See [`BUILDING.md`](BUILDING.md) for the full toolchain notes.
