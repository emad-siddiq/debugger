# Third-party notices

Burrow bundles or builds upon the following. This file is authoritative for
redistribution; keep it current as bundled tools are added (tasks 03+).

## The editor base

- **Code - OSS** (microsoft/vscode) — MIT License. Burrow is a fork; upstream
  `LICENSE.txt` is retained at the repo root. Microsoft **product** branding,
  icons, and the Visual Studio Marketplace are **not** included and are **not**
  MIT — see below.

## Go tooling (bundled/managed at runtime — task 03)

| Tool | License | Use |
|------|---------|-----|
| gopls (golang.org/x/tools/gopls) | BSD-3-Clause | language server |
| Delve (go-delve/delve) | MIT | debugger backend (`dlv dap`) |
| vscode-go (golang/vscode-go) | MIT | vendored as `extensions/go-base` |
| js-debug (microsoft/vscode-js-debug) | MIT | vendored prebuilt as `extensions/js-debug` (v1.105.0, extracted from an official VS Code 1.108.1 build; `engines.vscode ^1.80.0`); chrome/pwa-chrome debugger for merkle frontend TSX breakpoints. Its own `LICENSE.txt` + `ThirdPartyNotices.txt` travel in the vendored dir. |

## Explicitly NOT included

- Microsoft product icons / "Visual Studio Code" branding (proprietary).
- Visual Studio Marketplace access (ToS-restricted to Microsoft products).
- Open VSX (Burrow ships **no** extension marketplace — all capability is
  built-in).
- Telemetry, experiment (`tas-client`), and voice endpoints (removed in
  task 01).

## Attribution

Retain upstream copyright headers in any upstream source Burrow modifies
(layer-3 patches). New Burrow files (`extensions/burrow-*`, `build/burrow/*`)
carry the Burrow license header.
