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
	commands,
	debug,
	languages,
	window,
} from 'vscode';
import { BurrowInlineValuesProvider } from './inline';
import { InspectorModel } from './model';
import { MillerInspectorProvider } from './miller';
import { WatchProvider } from './watch';
import { FramesProvider } from './frames';
import { registerBreakpointsCommand } from './breakpoints';

// burrow-go-inspect — the IX inspector (architecture task 05). The slices:
//   WO-3  path-addressed DAP value model + per-Go-type summary renderer (model.ts, summary.ts)
//   WO-4  a constant-depth breadcrumb drill navigator (an anti-tree TreeView)
//   WO-5  the Miller-column + value-pane WEBVIEW prototype (miller.ts)
//   WO-6  PICK the webview and retire the WO-4 tree — one Burrow inspector.
//   WO-7  the Watch view (watch.ts) — a flat list reusing the summary renderer +
//         value pane; the inspector's "Watch" button feeds it. Retiring the *stock*
//         Watch view is core patch 0007 (Variables was 0006).
//   WO-8  inline value decorations (inline.ts, inlinemap.ts) — active-frame ghost
//         values via the workbench's InlineValuesProvider, same summary renderer,
//         gated by `burrow.inspector.inlineValues`. No core patch needed.
// The Miller webview is the chosen presentation: only a webview (or a future core
// workbench view) can render the side-by-side columns + value pane the design
// mandates — a TreeView structurally cannot, so the WO-4 tree was always a
// stepping stone. This file wires the two Burrow webview views (inspector + Watch).

const GO_DEBUG_TYPE = 'go';

export function activate(context: ExtensionContext): void {
	const models = new Map<string, InspectorModel>();
	const miller = new MillerInspectorProvider(models);
	const watch = new WatchProvider(models, context.workspaceState);
	const frames = new FramesProvider(models);

	// The inspector's value-pane "Watch" button routes the selected value's
	// re-evaluable expression into the Watch view (WO-7).
	miller.onWatch = expression => {
		watch.addExpression(expression);
		void commands.executeCommand(`${WatchProvider.viewId}.focus`);
	};

	const trackerFactory: DebugAdapterTrackerFactory = {
		createDebugAdapterTracker(session: DebugSession): ProviderResult<DebugAdapterTracker> {
			return {
				onDidSendMessage(message): void {
					// A `stopped` event is a new inspection point: roll the model's change-diff
					// snapshot (via onStopped) and refresh both views. The model is looked up
					// per-message — the tracker can be created before onDidStartDebugSession
					// has registered it.
					const event = message as { type?: string; event?: string };
					if (event.type === 'event' && event.event === 'stopped') {
						const model = models.get(session.id);
						if (model) {
							model.onStopped();
							miller.reset();
							watch.refresh();
						}
					}
				},
			};
		},
	};

	context.subscriptions.push(
		miller,
		watch,
		frames,
		registerBreakpointsCommand(),
		window.registerWebviewViewProvider(FramesProvider.viewId, frames),
		window.registerWebviewViewProvider(MillerInspectorProvider.viewId, miller),
		window.registerWebviewViewProvider(WatchProvider.viewId, watch),
		// Ghost values in the editor (WO-8) — core drives the lifecycle; we only answer
		// "what does the active frame hold?" with the inspector's own summaries.
		languages.registerInlineValuesProvider({ language: 'go' }, new BurrowInlineValuesProvider(models)),
		debug.onDidStartDebugSession(session => {
			if (session.type === GO_DEBUG_TYPE) {
				models.set(session.id, new InspectorModel(session));
			}
		}),
		debug.onDidTerminateDebugSession(session => {
			models.delete(session.id);
			miller.reset();
			watch.refresh();
			frames.refresh();
		}),
		// A frame switch invalidates the current drill path (refs are frame-scoped),
		// so re-root the inspector and re-evaluate watches on the newly focused frame.
		// Frames re-renders too, to move the selection tint to the newly focused frame.
		debug.onDidChangeActiveStackItem(() => {
			miller.reset();
			watch.refresh();
			frames.refresh();
		}),
		debug.registerDebugAdapterTrackerFactory(GO_DEBUG_TYPE, trackerFactory),
	);
}

export function deactivate(): void {
	// Models are dropped on session terminate; the webview views and their listeners
	// are disposed via context.subscriptions.
}
