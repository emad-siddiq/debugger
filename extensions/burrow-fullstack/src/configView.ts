/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// configView.ts — the Debug Config webview view: one checkbox per manifest
// toggle, plus the rocket. Presentation only — state changes round-trip
// through the callback the extension wires in, which owns settings + effects.

import {
	CancellationToken,
	WebviewView,
	WebviewViewProvider,
	WebviewViewResolveContext,
} from 'vscode';
import { Toggle, ToggleManifest } from './toggles';
import { ViewHost } from './detachableView';

function nonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let out = '';
	for (let i = 0; i < 32; i++) {
		out += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return out;
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, ch => (
		ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;'
	));
}

interface ViewMessage {
	readonly type: 'toggle' | 'rocket' | 'stop';
	readonly id?: string;
	readonly enabled?: boolean;
}

export class DebugConfigProvider implements WebviewViewProvider {
	static readonly viewId = 'burrowDebugConfig';

	private view?: ViewHost;
	/** Set by extension.ts once the pop-out wrapper exists (patches/0016). */
	public detachable: { resolve(view: WebviewView): void } | undefined;
	private manifest: ToggleManifest = { toggles: [] };
	private state: Record<string, boolean> = {};
	private sessionActive = false;
	private seedNames: string[] = [];

	constructor(
		private readonly onToggle: (id: string, enabled: boolean) => void,
		private readonly onRocket: () => void,
		private readonly onStop: () => void,
	) { }

	/**
	 * The rail slot. Delegated to `DetachableView` (patches/0016) when a pop-out
	 * wrapper is wired, so the same content can live here or in a floating
	 * window; `attach` below is the body this used to be.
	 */
	resolveWebviewView(view: WebviewView, _context: WebviewViewResolveContext, _token: CancellationToken): void {
		if (this.detachable) {
			this.detachable.resolve(view);
			return;
		}
		this.attach(view);
	}

	/** Wire a host — a rail slot or a popped-out panel; this cannot tell which. */
	attach(view: ViewHost): void {
		this.view = view;
		view.webview.options = { enableScripts: true };
		view.webview.onDidReceiveMessage((message: ViewMessage) => {
			if (message.type === 'toggle' && message.id) {
				this.onToggle(message.id, !!message.enabled);
			} else if (message.type === 'rocket') {
				this.onRocket();
			} else if (message.type === 'stop') {
				this.onStop();
			}
		});
		this.render();
	}

	update(manifest: ToggleManifest, state: Record<string, boolean>, sessionActive: boolean, seedNames: string[]): void {
		this.manifest = manifest;
		this.state = state;
		this.sessionActive = sessionActive;
		this.seedNames = seedNames;
		this.render();
	}

	private toggleRow(toggle: Toggle): string {
		const on = this.state[toggle.id] ? 'checked' : '';
		const envList = Object.keys(toggle.env ?? {}).join(', ');
		const detail = toggle.description ? `${escapeHtml(toggle.description)}` : escapeHtml(envList);
		return `<label class="row" title="${escapeHtml(envList)}">
	<input type="checkbox" data-id="${escapeHtml(toggle.id)}" ${on}>
	<span class="name">${escapeHtml(toggle.label)}</span>
	<span class="detail">${detail}</span>
</label>`;
	}

	private render(): void {
		if (!this.view) {
			return;
		}
		const n = nonce();
		const rows = this.manifest.toggles.map(toggle => this.toggleRow(toggle)).join('\n');
		const session = this.sessionActive
			? `<div class="session on">backend session active${this.seedNames.length ? ` · seeding: ${escapeHtml(this.seedNames.join(', '))}` : ''} — changes prompt a restart</div>`
			: '<div class="session">no backend session — toggles apply on the next launch</div>';
		this.view.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${n}'; script-src 'nonce-${n}';">
	<style nonce="${n}">
		body { font: 13px var(--vscode-font-family); color: var(--vscode-foreground); padding: 6px 10px; }
		.row { display: grid; grid-template-columns: auto auto 1fr; gap: 6px; align-items: baseline; padding: 4px 0; cursor: pointer; }
		.name { font-weight: 600; }
		.detail { opacity: .6; font-size: 11px; }
		.session { margin: 8px 0; padding: 4px 8px; border-radius: 4px; font-size: 11px; opacity: .75; background: var(--vscode-editorWidget-background); }
		.session.on { border-left: 3px solid var(--vscode-charts-green, #89d185); }
		.buttons { display: flex; gap: 6px; margin-top: 8px; }
		button { padding: 4px 10px; border: none; border-radius: 3px; cursor: pointer;
			background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
		button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
	</style>
</head>
<body>
	${rows || '<div class="detail">No toggles — add .vscode/debug-toggles.json to the project.</div>'}
	${session}
	<div class="buttons">
		<button data-act="rocket">🚀 Debug Full Stack</button>
		<button class="secondary" data-act="stop">Stop</button>
	</div>
	<script nonce="${n}">
		const vscode = acquireVsCodeApi();
		document.addEventListener('change', e => {
			const box = e.target.closest('input[type=checkbox]');
			if (box) {
				vscode.postMessage({ type: 'toggle', id: box.dataset.id, enabled: box.checked });
			}
		});
		document.addEventListener('click', e => {
			const btn = e.target.closest('button[data-act]');
			if (btn) {
				vscode.postMessage({ type: btn.dataset.act });
			}
		});
	</script>
</body>
</html>`;
	}
}
