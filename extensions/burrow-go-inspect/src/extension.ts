/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import {
	DebugAdapterTracker,
	DebugAdapterTrackerFactory,
	DebugSession,
	ExtensionContext,
	ProviderResult,
	debug,
	window,
} from 'vscode';
import { InspectorModel } from './model';
import { MillerInspectorProvider } from './miller';

// burrow-go-inspect — the IX inspector (architecture task 05). The slices:
//   WO-3  path-addressed DAP value model + per-Go-type summary renderer (model.ts, summary.ts)
//   WO-4  a constant-depth breadcrumb drill navigator (an anti-tree TreeView)
//   WO-5  the Miller-column + value-pane WEBVIEW prototype (miller.ts)
//   WO-6  PICK the webview and retire the WO-4 tree — one Burrow inspector.
// The Miller webview is the chosen presentation: only a webview (or a future core
// workbench view) can render the side-by-side columns + value pane the design
// mandates — a TreeView structurally cannot, so the WO-4 tree was always a
// stepping stone. Retiring the *stock* VS Code Variables view is the separate
// core patch 0006 (layer 3); this file owns only the Burrow webview inspector.

const GO_DEBUG_TYPE = 'go';

export function activate(context: ExtensionContext): void {
	const models = new Map<string, InspectorModel>();
	const miller = new MillerInspectorProvider(models);

	const trackerFactory: DebugAdapterTrackerFactory = {
		createDebugAdapterTracker(session: DebugSession): ProviderResult<DebugAdapterTracker> {
			return {
				onDidSendMessage(message): void {
					// A `stopped` event is a new inspection point: roll the model's change-diff
					// snapshot (via onStopped) and return the inspector to the scopes. The model
					// is looked up per-message — the tracker can be created before
					// onDidStartDebugSession has registered it.
					const event = message as { type?: string; event?: string };
					if (event.type === 'event' && event.event === 'stopped') {
						const model = models.get(session.id);
						if (model) {
							model.onStopped();
							miller.reset();
						}
					}
				},
			};
		},
	};

	context.subscriptions.push(
		miller,
		window.registerWebviewViewProvider(MillerInspectorProvider.viewId, miller),
		debug.onDidStartDebugSession(session => {
			if (session.type === GO_DEBUG_TYPE) {
				models.set(session.id, new InspectorModel(session));
			}
		}),
		debug.onDidTerminateDebugSession(session => {
			models.delete(session.id);
			miller.reset();
		}),
		// A frame switch invalidates the current drill path (refs are frame-scoped),
		// so re-root the inspector on the newly focused frame.
		debug.onDidChangeActiveStackItem(() => miller.reset()),
		debug.registerDebugAdapterTrackerFactory(GO_DEBUG_TYPE, trackerFactory),
	);
}

export function deactivate(): void {
	// Models are dropped on session terminate; the webview view and its listeners
	// are disposed via context.subscriptions.
}
