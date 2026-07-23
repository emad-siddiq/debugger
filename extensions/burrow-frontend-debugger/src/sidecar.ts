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

/** What an already-running sidecar reports about itself: its tool rev (the
 *  attach handshake — absent on pre-handshake sidecars, which are stale by
 *  definition) and the target port+base its targetUrl embeds. Returns
 *  undefined when the probe fails — attaching blind to an unprobeable
 *  sidecar just reproduces whatever is broken about it. */
async function probeSidecar(uiPort: number): Promise<{ rev?: string; startedAt?: number; port?: number; base?: string } | undefined> {
	try {
		const res = await fetch(`http://127.0.0.1:${uiPort}/api/config`, { signal: AbortSignal.timeout(1500) });
		const body = await res.json() as { targetUrl?: string; rev?: string; startedAt?: number };
		const out: { rev?: string; startedAt?: number; port?: number; base?: string } = { rev: body.rev, startedAt: body.startedAt };
		if (body.targetUrl) {
			const url = new URL(body.targetUrl);
			const port = Number(url.port);
			if (Number.isFinite(port) && port > 0) {
				out.port = port;
			}
			out.base = url.pathname || undefined;
		}
		return out;
	} catch {
		return undefined;
	}
}

/** The tool version on disk — the rev a freshly-spawned sidecar would report.
 *  Attach requires the running sidecar to match it. */
function localToolRev(toolRoot: string): string {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(toolRoot, 'package.json'), 'utf8')) as { version?: string };
		return pkg.version || '';
	} catch {
		return '';
	}
}

function tryListen(port: number, host: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = net.createServer();
		probe.once('error', reject);
		probe.listen({ port, host }, () => {
			const got = (probe.address() as net.AddressInfo).port;
			probe.close(() => resolve(got));
		});
	});
}

/** The preferred port if it's free on BOTH stacks, else an OS-assigned
 *  ephemeral one. Single-family probing is a trap: the sidecar's express
 *  binds IPv4 0.0.0.0 while Vite listens on IPv6 `::` — a default (v6) probe
 *  reports "free" right beside a live IPv4 listener, and the spawn then dies
 *  with EADDRINUSE while a FOREIGN sidecar keeps answering the port. */
async function freePort(preferred: number): Promise<number> {
	try {
		await tryListen(preferred, '0.0.0.0');
		await tryListen(preferred, '::');
		return preferred;
	} catch {
		return tryListen(0, '0.0.0.0');
	}
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
	/** The base path the target app is served under. The RUNNING sidecar is the
	 *  source of truth (an attached sidecar may have been spawned with a
	 *  different base than this window's settings) — set from spawn config, or
	 *  derived from GET /api/config on attach. */
	targetBase = '/';
	private child: cp.ChildProcess | undefined;
	private attached = false;

	get running(): boolean {
		return this.attached || !!this.child;
	}

	async start(cfg: SidecarConfig, opts?: { forceSpawn?: boolean }): Promise<number> {
		if (this.running && this.uiPort) {
			return this.uiPort;
		}
		// Attach only to a sidecar that proves it runs the SAME tool version as
		// this window would spawn (rev handshake). A long-lived pre-upgrade
		// sidecar squatting on the port would otherwise serve stale server code
		// to every new window — the exact failure Restart exists to escape, so
		// Restart force-spawns and never attaches.
		if (!opts?.forceSpawn && await healthz(cfg.uiPort)) {
			const probe = await probeSidecar(cfg.uiPort);
			const wantRev = localToolRev(cfg.toolRoot);
			if (probe?.rev && probe.rev === wantRev) {
				this.attached = true;
				this.uiPort = cfg.uiPort;
				this.targetPort = probe.port ?? cfg.targetPort;
				this.targetBase = probe.base ?? cfg.targetBase;
				this.out.appendLine(`[fedbg] attached to an already-running sidecar on :${cfg.uiPort} (rev ${probe.rev}, target :${this.targetPort}${this.targetBase})`);
				return this.uiPort;
			}
			this.out.appendLine(`[fedbg] sidecar on :${cfg.uiPort} is stale (rev ${probe?.rev || 'none'} ≠ ${wantRev || 'unknown'}) — spawning fresh on fallback ports`);
		}

		this.preflight(cfg);
		this.uiPort = await freePort(cfg.uiPort);
		const targetPort = await freePort(cfg.targetPort);
		this.targetPort = targetPort;
		this.targetBase = cfg.targetBase;

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
		const spawnedAtMs = Date.now();
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
		// Belt over waitHealthy: the port answering is not proof it's OUR child —
		// a foreign sidecar on the same port can 200 the healthz while the spawn
		// is still booting (or already died on it). startedAt is stamped at the
		// server's boot, so an older one answering here is not ours.
		const identity = await probeSidecar(this.uiPort);
		if (identity?.startedAt && identity.startedAt < spawnedAtMs - 2000) {
			const foreignPort = this.uiPort;
			await this.stop();
			throw new Error(`a different sidecar is answering on :${foreignPort} — stop it (or Restart Sidecar) and retry`);
		}
		return this.uiPort;
	}

	/** Resolves once the child has actually exited, so a follow-up start()
	 *  never races the dying process for its ports or attaches to it. An
	 *  ATTACHED (foreign) sidecar can't be signalled — ask it to exit over
	 *  POST /api/shutdown instead (best-effort, bounded; pre-handshake
	 *  sidecars 404 it and simply keep their ports). */
	stop(): Promise<void> {
		const child = this.child;
		const attachedPort = this.attached ? this.uiPort : 0;
		this.child = undefined;
		this.attached = false;
		this.uiPort = 0;
		this.targetPort = 0;
		this.targetBase = '/';
		if (attachedPort) {
			return this.shutdownForeign(attachedPort);
		}
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

	/** Ask a foreign sidecar to exit and wait (≤2s) for its port to actually
	 *  free, so a follow-up spawn can reclaim the canonical ports. */
	private async shutdownForeign(uiPort: number): Promise<void> {
		try {
			await fetch(`http://127.0.0.1:${uiPort}/api/shutdown`, { method: 'POST', signal: AbortSignal.timeout(1500) });
		} catch {
			return; // no shutdown route (pre-handshake sidecar) or already gone
		}
		const deadline = Date.now() + 2000;
		while (Date.now() < deadline) {
			if (!(await healthz(uiPort))) {
				this.out.appendLine(`[fedbg] foreign sidecar on :${uiPort} shut down`);
				return;
			}
			await new Promise((r) => setTimeout(r, 200));
		}
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
