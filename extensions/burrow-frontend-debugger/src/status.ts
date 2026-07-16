/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

// MOCK ↔ LIVE pill for the embedded target, shown while the sidecar runs.
// Mode flips go straight to the sidecar's POST /api/mode (the flip restarts
// the target Vite in-process, hence the long timeout). Runtime flips are
// ephemeral by design — the durable boot default is the
// burrow.frontendDebugger.mode setting.

export class ModeStatus implements vscode.Disposable {

	private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
	private timer: ReturnType<typeof setInterval> | undefined;
	private uiPort = 0;
	private flipping = false;

	constructor() {
		this.item.command = 'burrow.frontendDebugger.toggleMode';
		this.item.tooltip = 'Frontend Debugger target data mode — click to flip mock ↔ live';
	}

	show(uiPort: number): void {
		this.uiPort = uiPort;
		this.item.text = '$(beaker) FE: …';
		this.item.show();
		void this.poll();
		clearInterval(this.timer);
		this.timer = setInterval(() => void this.poll(), 10_000);
	}

	hide(): void {
		clearInterval(this.timer);
		this.timer = undefined;
		this.item.hide();
	}

	dispose(): void {
		this.hide();
		this.item.dispose();
	}

	async toggle(): Promise<void> {
		if (this.flipping) {
			return;
		}
		const mode = await this.mode();
		if (!mode) {
			void vscode.window.showWarningMessage('Frontend Debugger: sidecar not reachable — open it first (Burrow: Open Frontend Debugger).');
			return;
		}
		const next = mode === 'live' ? 'mock' : 'live';
		this.flipping = true;
		this.item.text = '$(sync~spin) FE: flipping…';
		try {
			const res = await fetch(`http://127.0.0.1:${this.uiPort}/api/mode`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ mode: next }),
				signal: AbortSignal.timeout(60_000), // the flip restarts the target Vite in-process
			});
			if (!res.ok) {
				throw new Error(`HTTP ${res.status}`);
			}
			void vscode.window.setStatusBarMessage(
				next === 'live'
					? 'FE LIVE — clicks now hit the debugged backend'
					: 'FE MOCK — devMock intercepts /api again',
				5000,
			);
		} catch (err) {
			void vscode.window.showWarningMessage(`Frontend Debugger: mode flip failed (${err instanceof Error ? err.message : String(err)}) — see the Frontend Debugger logs.`);
		} finally {
			this.flipping = false;
			void this.poll();
		}
	}

	private async poll(): Promise<void> {
		if (this.flipping) {
			return;
		}
		const mode = await this.mode();
		this.item.text = `$(beaker) FE: ${mode ? mode.toUpperCase() : '—'}`;
	}

	private async mode(): Promise<string | null> {
		if (!this.uiPort) {
			return null;
		}
		try {
			const res = await fetch(`http://127.0.0.1:${this.uiPort}/api/mode`, { signal: AbortSignal.timeout(2000) });
			if (!res.ok) {
				return null;
			}
			const body = (await res.json()) as { mode?: string };
			return body.mode ?? null;
		} catch {
			return null;
		}
	}
}
