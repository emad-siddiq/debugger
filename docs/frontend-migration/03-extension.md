# 03 — The `burrow-frontend-debugger` extension

> Part of the [frontend migration](00-overview.md). New dir:
> `burrow/extensions/burrow-frontend-debugger/`. House style: tabs + the Burrow copyright
> header (copy from `extensions/burrow-core/src/extension.ts`). Zero npm dependencies (vscode
> API + node builtins only) — do NOT touch `build/npm/dirs.ts` (it still lists deleted
> extensions and survives only via `isUpToDate()`).

## `package.json`

```json
{
  "name": "burrow-frontend-debugger",
  "displayName": "Burrow Frontend Debugger",
  "description": "Visual React component debugger as an editor panel: embeds the target app via the tools/frontend-debugger sidecar, bridges component/CSS reveals into the editor.",
  "version": "0.1.0",
  "publisher": "burrow",
  "license": "MIT",
  "engines": { "vscode": "^1.128.0" },
  "main": "./out/extension.js",
  "activationEvents": [],
  "capabilities": { "untrustedWorkspaces": { "supported": false } },
  "scripts": {
    "compile": "gulp compile-extension:burrow-frontend-debugger",
    "watch": "gulp watch-extension:burrow-frontend-debugger"
  },
  "contributes": {
    "commands": [
      { "command": "burrow.frontendDebugger.open",       "title": "Open Frontend Debugger", "category": "Burrow" },
      { "command": "burrow.frontendDebugger.toggleMode", "title": "Frontend Debugger: Toggle Mock/Live", "category": "Burrow" },
      { "command": "burrow.frontendDebugger.restart",    "title": "Frontend Debugger: Restart Sidecar", "category": "Burrow" },
      { "command": "burrow.frontendDebugger.stop",       "title": "Frontend Debugger: Stop Sidecar", "category": "Burrow" },
      { "command": "burrow.frontendDebugger.showLogs",   "title": "Frontend Debugger: Show Logs", "category": "Burrow" }
    ],
    "configuration": {
      "title": "Frontend Debugger",
      "properties": {
        "burrow.frontendDebugger.targetDir":     { "type": "string", "default": "", "description": "Absolute path to the target Vite frontend. Empty = auto-detect (<workspace>/nodewatch/frontend, else the workspace folder)." },
        "burrow.frontendDebugger.repoRoot":      { "type": "string", "default": "", "description": "Target repo root (for @shared). Empty = first workspace folder." },
        "burrow.frontendDebugger.backendTarget": { "type": "string", "default": "http://localhost:8080", "description": "Live-mode proxy target (the Go backend under debug)." },
        "burrow.frontendDebugger.mode":          { "type": "string", "enum": ["mock", "live"], "default": "mock", "description": "Data mode at sidecar boot. Runtime flips are ephemeral." },
        "burrow.frontendDebugger.uiPort":        { "type": "number", "default": 6080, "description": "Debugger UI/API port. Falls back to a free port if taken." },
        "burrow.frontendDebugger.targetPort":    { "type": "number", "default": 5180, "description": "Embedded target dev-server port. Falls back to a free port if taken." },
        "burrow.frontendDebugger.targetBase":    { "type": "string", "default": "/watch/app/", "description": "Base path the target app is served under." },
        "burrow.frontendDebugger.toolPath":      { "type": "string", "default": "", "description": "Override the sidecar location. Empty = <repo>/tools/frontend-debugger." }
      }
    }
  }
}
```

`tsconfig.json` = copy of burrow-core's (extends `../tsconfig.base.json`, rootDir `src`,
outDir `out`, types node, include `src/**/*` + `../../src/vscode-dts/vscode.d.ts`).

## `src/config.ts` — settings → SidecarConfig

```ts
export interface SidecarConfig {
	toolRoot: string; targetDir: string; repoRoot: string; backendTarget: string;
	mode: 'mock' | 'live'; uiPort: number; targetPort: number; targetBase: string;
}
export function resolveConfig(context: vscode.ExtensionContext): SidecarConfig {
	const cfg = vscode.workspace.getConfiguration('burrow.frontendDebugger');
	const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const repoRoot = cfg.get<string>('repoRoot') || ws || '';
	let targetDir = cfg.get<string>('targetDir') || '';
	if (!targetDir && repoRoot) {
		const nested = path.join(repoRoot, 'nodewatch', 'frontend');
		targetDir = fs.existsSync(nested) ? nested : repoRoot;
	}
	const toolRoot = cfg.get<string>('toolPath')
		|| path.resolve(context.extensionPath, '..', '..', 'tools', 'frontend-debugger');
	return { toolRoot, targetDir, repoRoot,
		backendTarget: cfg.get('backendTarget', 'http://localhost:8080'),
		mode: cfg.get('mode', 'mock'), uiPort: cfg.get('uiPort', 6080),
		targetPort: cfg.get('targetPort', 5180), targetBase: cfg.get('targetBase', '/watch/app/') };
}
```

## `src/sidecar.ts` — spawn / attach / health / teardown

One `Sidecar` per window, owned by the extension (NOT the panel — it survives panel close so
the status bar + mode toggle stay live).

- `start(cfg)`:
  1. If `GET http://127.0.0.1:<cfg.uiPort>/healthz` already answers → **attach** (`attached =
     true`, no child). This is also the tool-dev workflow: `npm run dev` in a terminal, then
     open the panel.
  2. Preflight: `toolRoot/server/index.js`, `toolRoot/ui/dist/index.html`, and
     `toolRoot/node_modules` must exist; else throw with the exact bootstrap command
     (`cd tools/frontend-debugger && npm install && npm run build`). No auto-install — zero
     non-user-initiated network.
  3. Ports: probe with `net` on 127.0.0.1; if the configured port is taken, fall back to an
     ephemeral free port. Same for `targetPort`.
  4. Spawn:
     ```ts
     this.child = cp.spawn(process.execPath, [path.join(cfg.toolRoot, 'server', 'index.js')], {
     	cwd: cfg.toolRoot,
     	env: { ...process.env,
     		ELECTRON_RUN_AS_NODE: '1', NODE_ENV: 'production',
     		MERKLE_FRONTEND_DIR: cfg.targetDir, MERKLE_REPO_ROOT: cfg.repoRoot,
     		UI_PORT: String(uiPort), TARGET_PORT: String(targetPort),
     		TARGET_PUBLIC_PORT: String(targetPort), TARGET_BASE: cfg.targetBase,
     		FRONTEND_MODE: cfg.mode, NW_BACKEND_TARGET: cfg.backendTarget,
     		SELECTION_FILE: path.join(os.tmpdir(), 'burrow-fedbg-no-selection.json'), // inert
     	},
     	stdio: ['ignore', 'pipe', 'pipe'],
     });
     ```
     stdout/stderr pipe to the "Frontend Debugger" OutputChannel.
  5. Health-wait: poll `/healthz` every 500 ms, 60 s cap. Note `/healthz` is `ok:true` even
     when the *target* Vite failed — the SPA's preflight overlay explains that case.
- `exit` handler: if not `stopping`, `showWarningMessage` with a "Restart" action (no
  auto-restart loop).
- `dispose()` kills the child (skip when `attached`); `deactivate()` disposes.

## `src/panel.ts` — WebviewPanel + shim + bridge

Singleton panel: `createWebviewPanel('burrow.frontendDebugger', 'Frontend Debugger',
ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true })`.

HTML (build iframe src and CSP from ONE `origin` variable = `http://127.0.0.1:<uiPort>`):

```html
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'">
<style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}</style>
<iframe src="${origin}/?embed=burrow" allow="clipboard-read; clipboard-write; fullscreen"></iframe>
<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	window.addEventListener('message', (e) => {
		if (e.origin !== '${origin}') { return; }
		const d = e.data;
		if (!d || d.__fedbgHost !== 1 || typeof d.type !== 'string') { return; }
		vscode.postMessage(d);
	});
</script>
```

`onDidReceiveMessage` → `handleHostMessage(msg, targetDir)`:

- `openSource`: resolve `msg.file` against `targetDir`; reject absolute paths and escapes
  (mirror `server/api.js` `safe()`: resolved path must equal `targetDir` or start with
  `targetDir + path.sep`); then `openTextDocument` + `showTextDocument(doc, { viewColumn:
  ViewColumn.Beside, selection: new Range(pos, pos) })` with `pos = (line-1, col-1)` clamped
  to ≥0.
- `setFullScreen`: track maximized state; when `on !== current`, run
  `workbench.action.toggleMaximizeEditorGroup` (confirm the id exists in the 1.128 fork;
  fallback pair: `workbench.action.maximizeEditorHideSidebar` on enter +
  `workbench.action.evenEditorWidths` on exit). Reset tracked state on panel dispose.

Panel dispose does NOT stop the sidecar.

## `src/status.ts` — mode pill

Port of the old code-server extension's `toggleFrontendMode`
(`debugger/extension/src/status.ts:59-82`) minus launcher persistence:

- Status bar item `$(beaker) FE: MOCK|LIVE`, shown while the sidecar is up; polls
  `GET /api/mode` every 10 s.
- Click → `burrow.frontendDebugger.toggleMode`: `POST /api/mode` with the flipped mode, 60 s
  timeout (the live flip restarts the target Vite in-process). On failure, point at the
  Frontend Debugger logs. Durable default = the `burrow.frontendDebugger.mode` setting;
  runtime flips are ephemeral by design.

## `src/extension.ts`

`activate`: construct Sidecar + status; register the five commands.
`open` = `resolveConfig` → `sidecar.start` → `openPanel(uiPort, targetDir)` → status show.
`restart` = kill + start + reassign the panel HTML (port may have changed).
`stop` = dispose sidecar + hide status. `showLogs` = reveal the OutputChannel.
`deactivate` = dispose sidecar.
