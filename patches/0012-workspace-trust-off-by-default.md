# 0012 — Workspace Trust off by default

- **Layer:** 3 (one default-value change in a config schema the trust service reads early)
- **Task:** — (WO-19 first-run defaults; unblocks WS2/WS4 tools)
- **Upstream files touched:** `src/vs/workbench/contrib/workspace/browser/workspace.contribution.ts`
- **Size:** 1 line (one setting default)
- **Last verified against:** upstream 1.128.0

## Why

Burrow is a purpose-built IDE for developing **one** project the user owns
(`~/Projects/merkle`). Its whole point is that everything works on open — Full
Stack debug, the dlv/js-debug debuggers, the FD sidecar, docker — all of which
**spawn processes** and are therefore gated by VS Code's Workspace Trust. Opening
merkle in Restricted Mode disables exactly those extensions
(`burrow-fullstack`, `burrow-flow`, `burrow-frontend-debugger`, `js-debug` all
declare `untrustedWorkspaces: false`/`limited`), so their rail containers and
debug flows never appear — verified live: a fresh launch opens Restricted and the
Run/API/Components containers are missing until trust is granted.

`security.workspace.trust.enabled` is `ConfigurationScope.APPLICATION` and is read
by the trust service at workspace load — **before** a built-in extension's
`configurationDefaults` are merged (same early-read problem as
`window.titleBarStyle`, patch 0011). Setting it in `burrow-core`'s
`configurationDefaults` only takes effect after a window reload, so the *first*
window still opens untrusted. Flipping the registered default is the only route to
a trusted **cold start**.

## What

In `workspace.contribution.ts`, the `security.workspace.trust.enabled`
configuration property default `true` → **`false`** (tagged `// BURROW patch
0012`). `burrow-core` also carries `"security.workspace.trust.enabled": false` in
`configurationDefaults` (belt-and-braces + intent). Users can re-enable trust with
an explicit `"security.workspace.trust.enabled": true`.

## Rebase notes

- Single-token default change. If upstream restructures this property, re-apply:
  `security.workspace.trust.enabled` default → `false`. Grep `BURROW patch 0012`.
- If a future WO wants trust back on with a one-time per-workspace grant instead,
  this patch retires (and the burrow-core default is removed with it).
