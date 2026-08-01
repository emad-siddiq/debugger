/*---------------------------------------------------------------------------------------------
 *  Burrow: which surface is the user in — the focus half of the view resolver.
 *
 *  Event-driven: each surface records a timestamp when the user touches it, and
 *  the NEWEST one wins at send time (plan chat/02 step 1). The Burrow rails'
 *  events come from their exported APIs; rails that activate lazily (Components
 *  activates on first view reveal) are re-tried per send, and a selection found
 *  on first hook seeds the surface ONLY when nothing else was ever recorded —
 *  a seed must never outrank a real user action.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export type Surface = 'components' | 'routes' | 'debug' | 'editor';

interface ComponentsApiLite {
	readonly selectedComponent?: () => { file: string; label: string } | undefined;
	readonly onDidChangeComponentSelection?: vscode.Event<unknown>;
	readonly isolation?: () => { file: string; label: string } | undefined;
}
interface FlowApiLite {
	readonly selectedRoute?: () => unknown;
	readonly onDidChangeRouteSelection?: vscode.Event<unknown>;
}

export class FocusTracker implements vscode.Disposable {
	private last: { surface: Surface; at: number } | undefined;
	/** Last DEFINED active text editor — at submit time the chat input holds
	 *  focus and this fork reports activeTextEditor as undefined (phase-1 finding). */
	private lastActiveTextEditorPath: string | undefined;
	private componentsHooked = false;
	private routesHooked = false;
	private readonly disposables: vscode.Disposable[] = [];

	constructor() {
		this.disposables.push(vscode.window.onDidChangeActiveTextEditor(e => {
			if (e) {
				this.lastActiveTextEditorPath = e.document.uri.path;
				this.record('editor');
			}
		}));
		// Stable in this fork's API surface (burrow-go-inspect already consumes it).
		this.disposables.push(vscode.debug.onDidChangeActiveStackItem(item => {
			if (item) { this.record('debug'); }
		}));
		this.ensureSubscriptions();
	}

	record(surface: Surface): void {
		this.last = { surface, at: Date.now() };
	}

	current(): Surface | undefined {
		return this.last?.surface;
	}

	/** The path the user is editing right now, surviving focus moving into the chat input. */
	editingPath(): string | undefined {
		const active = vscode.window.activeTextEditor?.document.uri.path;
		if (active) { return active; }
		const last = this.lastActiveTextEditorPath;
		return last && vscode.window.visibleTextEditors.some(e => e.document.uri.path === last) ? last : undefined;
	}

	/** Hook the rails' selection events; safe to call every send. */
	ensureSubscriptions(): void {
		if (!this.componentsHooked) {
			const api = activeExports<ComponentsApiLite>('burrow.burrow-frontend-debugger');
			if (api?.onDidChangeComponentSelection) {
				this.disposables.push(api.onDidChangeComponentSelection(() => this.record('components')));
				if (!this.last && (api.selectedComponent?.() ?? api.isolation?.())) {
					this.last = { surface: 'components', at: 1 };
				}
				this.componentsHooked = true;
			}
		}
		if (!this.routesHooked) {
			const api = activeExports<FlowApiLite>('burrow.burrow-flow');
			if (api?.onDidChangeRouteSelection) {
				this.disposables.push(api.onDidChangeRouteSelection(() => this.record('routes')));
				if (!this.last && api.selectedRoute?.()) {
					this.last = { surface: 'routes', at: 1 };
				}
				this.routesHooked = true;
			}
		}
	}

	dispose(): void {
		for (const d of this.disposables) { d.dispose(); }
	}
}

/** An extension's exports, only once it has activated on its own terms. */
export function activeExports<T>(id: string): T | undefined {
	try {
		const ext = vscode.extensions.getExtension(id);
		return ext?.isActive ? ext.exports as T : undefined;
	} catch {
		return undefined;
	}
}
