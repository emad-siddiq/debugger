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
//
// This class is also the ONE place that knows the mode. The stage's seam bar
// shows it too, and rather than give the seam its own poller against the same
// endpoint — two clocks that disagree for up to ten seconds — this one
// announces every answer it gets through `onMode`.

/** What the target's data mode is right now. `flipping` is its own value rather
 *  than a gap because the flip restarts Vite and can take tens of seconds —
 *  long enough that "unknown" would read as a fault. `null` means the sidecar
 *  did not answer. */
export type DataMode = 'mock' | 'live' | 'flipping' | null;
export type ModeListener = (mode: DataMode) => void;

export class ModeStatus implements vscode.Disposable {

	private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
	private timer: ReturnType<typeof setInterval> | undefined;
	private uiPort = 0;
	private flipping = false;
	private readonly listeners: ModeListener[] = [];

	constructor() {
		this.item.command = 'burrow.frontendDebugger.toggleMode';
		this.item.tooltip = 'Frontend Debugger target data mode — click to flip mock ↔ live';
	}

	/** Be told the target's data mode on every poll and every flip. Fires with
	 *  the CURRENT value immediately, so a late subscriber (the seam bar, which
	 *  only exists once someone enters stage mode) is never blank waiting for
	 *  the next tick. */
	onMode(listener: ModeListener): vscode.Disposable {
		this.listeners.push(listener);
		listener(this.last);
		return new vscode.Disposable(() => {
			const i = this.listeners.indexOf(listener);
			if (i >= 0) { this.listeners.splice(i, 1); }
		});
	}

	private last: DataMode = null;

	private announce(mode: DataMode): void {
		this.last = mode;
		for (const l of this.listeners) {
			try {
				l(mode);
			} catch {
				// a listener that throws must not stop the pill from painting
			}
		}
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
		// The sidecar is gone, so the mode is not "mock" — it is unknown. Saying
		// so lets the seam bar drop to `data: ?` instead of showing the last
		// value it heard as if it were still true.
		this.announce(null);
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
		this.announce('flipping');
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
		this.announce(mode);
	}

	private async mode(): Promise<'mock' | 'live' | null> {
		if (!this.uiPort) {
			return null;
		}
		try {
			const res = await fetch(`http://127.0.0.1:${this.uiPort}/api/mode`, { signal: AbortSignal.timeout(2000) });
			if (!res.ok) {
				return null;
			}
			const body = (await res.json()) as { mode?: string };
			return body.mode === 'live' || body.mode === 'mock' ? body.mode : null;
		} catch {
			return null;
		}
	}
}
