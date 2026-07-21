/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { SidecarConfig } from './config';

export async function healthz(port: number): Promise<boolean> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
		return res.ok;
	} catch {
		return false;
	}
}

/** When attaching to an already-running sidecar we don't know the target port it
 *  chose, so read it back from GET /api/config (targetUrl embeds it). Falls back
 *  to the configured default if the probe fails. */
async function detectTargetPort(uiPort: number, fallback: number): Promise<number> {
	try {
		const res = await fetch(`http://127.0.0.1:${uiPort}/api/config`, { signal: AbortSignal.timeout(1500) });
		const body = await res.json() as { targetUrl?: string };
		const port = body.targetUrl ? Number(new URL(body.targetUrl).port) : NaN;
		return Number.isFinite(port) && port > 0 ? port : fallback;
	} catch {
		return fallback;
	}
}

/** The preferred port if it's free, else an OS-assigned ephemeral one.
 *  Probes the wildcard interface — the sidecar binds 0.0.0.0, and a loopback
 *  probe with SO_REUSEADDR reports "free" alongside a wildcard listener. */
function freePort(preferred: number): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = net.createServer();
		probe.once('error', () => {
			const fallback = net.createServer();
			fallback.once('error', reject);
			fallback.listen(0, () => {
				const port = (fallback.address() as net.AddressInfo).port;
				fallback.close(() => resolve(port));
			});
		});
		probe.listen(preferred, () => {
			probe.close(() => resolve(preferred));
		});
	});
}

/**
 * The tools/frontend-debugger Node process: one per window, owned by the
 * extension (NOT the panel — it survives panel close so the status bar and
 * mode toggle stay live). If something already answers on the configured UI
 * port it attaches instead of spawning — that is also the tool-dev workflow
 * (`npm run dev` in a terminal, then open the panel).
 */
export class Sidecar implements vscode.Disposable {

	readonly out = vscode.window.createOutputChannel('Frontend Debugger');

	uiPort = 0;
	/** The port the *target* Vite dev server listens on — the isolation preview
	 *  (isolation.ts) iframes it directly. Set on spawn; derived from
	 *  GET /api/config when attaching to an already-running sidecar. */
	targetPort = 0;
	private child: cp.ChildProcess | undefined;
	private attached = false;

	get running(): boolean {
		return this.attached || !!this.child;
	}

	async start(cfg: SidecarConfig): Promise<number> {
		if (this.running && this.uiPort) {
			return this.uiPort;
		}
		if (await healthz(cfg.uiPort)) {
			this.attached = true;
			this.uiPort = cfg.uiPort;
			this.targetPort = await detectTargetPort(cfg.uiPort, cfg.targetPort);
			this.out.appendLine(`[fedbg] attached to an already-running sidecar on :${cfg.uiPort} (target :${this.targetPort})`);
			return this.uiPort;
		}

		this.preflight(cfg);
		this.uiPort = await freePort(cfg.uiPort);
		const targetPort = await freePort(cfg.targetPort);
		this.targetPort = targetPort;

		const env: NodeJS.ProcessEnv = {
			...process.env,
			ELECTRON_RUN_AS_NODE: '1',
			NODE_ENV: 'production', // serve the built ui/dist — no UI HMR inside the webview
			MERKLE_FRONTEND_DIR: cfg.targetDir,
			MERKLE_REPO_ROOT: cfg.repoRoot,
			UI_PORT: String(this.uiPort),
			TARGET_PORT: String(targetPort),
			TARGET_PUBLIC_PORT: String(targetPort),
			TARGET_BASE: cfg.targetBase,
			FRONTEND_MODE: cfg.mode,
			NW_BACKEND_TARGET: cfg.backendTarget,
			// Keep the tool's legacy launcher-selection read inert on the host.
			SELECTION_FILE: path.join(os.tmpdir(), 'burrow-fedbg-no-selection.json'),
		};

		this.out.appendLine(`[fedbg] config: targetDir=${cfg.targetDir} repoRoot=${cfg.repoRoot} ui=:${this.uiPort} target=:${targetPort} mode=${cfg.mode} backend=${cfg.backendTarget}`);
		this.child = cp.spawn(process.execPath, [path.join(cfg.toolRoot, 'server', 'index.js')], {
			cwd: cfg.toolRoot,
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		this.child.stdout?.on('data', (d: Buffer) => this.out.append(d.toString()));
		this.child.stderr?.on('data', (d: Buffer) => this.out.append(d.toString()));
		const spawned = this.child;
		this.child.on('exit', (code) => {
			if (this.child !== spawned) {
				return; // stop()/restart already moved past this child — stale exit
			}
			this.child = undefined;
			this.uiPort = 0;
			void vscode.window
				.showWarningMessage(`Frontend Debugger sidecar exited unexpectedly (code ${code ?? '?'}).`, 'Restart', 'Show Logs')
				.then((choice) => {
					if (choice === 'Restart') {
						void vscode.commands.executeCommand('burrow.frontendDebugger.restart');
					} else if (choice === 'Show Logs') {
						this.out.show(true);
					}
				});
		});

		await this.waitHealthy(60_000);
		return this.uiPort;
	}

	/** Resolves once the child has actually exited, so a follow-up start()
	 *  never races the dying process for its ports or attaches to it. */
	stop(): Promise<void> {
		const child = this.child;
		this.child = undefined;
		this.attached = false;
		this.uiPort = 0;
		this.targetPort = 0;
		if (!child || child.exitCode !== null) {
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				child.kill('SIGKILL');
				resolve();
			}, 3000);
			child.once('exit', () => {
				clearTimeout(timer);
				resolve();
			});
			child.kill();
		});
	}

	dispose(): void {
		void this.stop();
		this.out.dispose();
	}

	/** No auto-npm-install (zero non-user-initiated network) — name the exact bootstrap command instead. */
	private preflight(cfg: SidecarConfig): void {
		const bootstrap = `cd ${cfg.toolRoot} && npm install && npm run build`;
		if (!fs.existsSync(path.join(cfg.toolRoot, 'server', 'index.js'))) {
			throw new Error(`sidecar not found at ${cfg.toolRoot} — set burrow.frontendDebugger.toolPath`);
		}
		if (!fs.existsSync(path.join(cfg.toolRoot, 'node_modules'))) {
			throw new Error(`sidecar dependencies missing — run: ${bootstrap}`);
		}
		if (!fs.existsSync(path.join(cfg.toolRoot, 'ui', 'dist', 'index.html'))) {
			throw new Error(`sidecar UI not built (ui/dist is untracked) — run: ${bootstrap}`);
		}
		if (!cfg.targetDir || !fs.existsSync(cfg.targetDir)) {
			throw new Error(`target frontend not found (${cfg.targetDir || 'no workspace folder open'}) — set burrow.frontendDebugger.targetDir`);
		}
	}

	// NOTE: /healthz answers ok:true even when the *target* Vite failed to boot —
	// the SPA's preflight overlay explains that case inside the panel.
	private async waitHealthy(timeoutMs: number): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (!this.child) {
				throw new Error('sidecar exited during startup — see the Frontend Debugger output channel');
			}
			if (await healthz(this.uiPort)) {
				return;
			}
			await new Promise((r) => setTimeout(r, 500));
		}
		throw new Error(`sidecar did not become healthy on :${this.uiPort} within ${timeoutMs / 1000}s — see the Frontend Debugger output channel`);
	}
}
