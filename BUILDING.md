# Building Burrow

Fork of Code - OSS (see [`UPSTREAM.md`](UPSTREAM.md)). macOS arm64 first.

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node | **24.17.0** | pinned in `.nvmrc`; use `fnm`/`nvm` — do **not** rely on a system Node |
| npm | bundled with Node 24 | the repo uses npm (not yarn/pnpm) |
| Python | 3.x | `node-gyp` for native modules (node-pty, etc.) |
| Xcode CLT | current | native toolchain + code signing |

Match the pinned Node exactly; VS Code's build uses
`--experimental-strip-types` and native modules built against Node 24's ABI.

```sh
fnm install     # reads .nvmrc → 24.17.0
fnm use         # activate it in this shell
```

## First build

```sh
make deps       # npm ci  (Electron download + native module compile; slow)
make dev        # ./scripts/code.sh — run the branded app from source (watch)
make dist       # packaged .app → ../VSCode-darwin-arm64/  (gulp)
```

Under the hood (`Makefile` targets wrap these):

- `npm ci` — install + compile native modules, download Electron.
- `./scripts/code.sh` — dev run against a background `npm run watch`.
- `npm run gulp vscode-darwin-arm64` — packaged app.

## Verify the fork identity

After `make dev` the window title reads **Burrow — Go IDE**, the app data dir is
`~/Library/Application Support/Burrow` (from `dataFolderName: .burrow`), and
there is no marketplace, telemetry consent, or Copilot UI (the last two land
fully in task 02; task 01 removes the identity + network endpoints).

## Notes / gotchas

- **Node mismatch is the #1 build failure.** Symptoms: `node-gyp` ABI errors,
  `NODE_MODULE_VERSION` mismatch on launch. Fix: `fnm use` before every build
  shell, or `corepack`/`fnm exec`.
- Disk: a full dev tree (source + node_modules + Electron + build output) is
  ~3–4 GB. Keep an eye on free space.
- The build downloads Electron and npm packages — expected. It must **not**
  contact any telemetry/marketplace/experiment endpoint at *run* time (task 01
  criterion); build-time package fetches are fine.
