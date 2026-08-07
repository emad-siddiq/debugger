/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import {
	DebugSession,
	ExtensionContext,
	commands,
	debug,
	window,
	workspace,
} from 'vscode';
import { DetachableView } from './detachableView';
import { VizModel } from './model';
import { VizViewProvider } from './vizview';
import { bestVisualizer, hasVisualizer } from './registry';

// burrow-go-viz — Go value visualizers for the inspector's value pane (architecture
// task 06). FIRST SLICE (06.1 registry seam + 06.3 byte viewer): a webview that
// renders a `[]byte` / `[]uint8` value as a hex/ASCII dump — with auto-detected
// text/JSON and a base64 toggle — registered against a priority-ordered
// type-matcher registry (registry.ts) so the value pane can pick and mount it.
// It REUSES the task 05 DAP/summary model concepts (VizModel is a narrow
// customRequest reader with the windowed indexed fetch) and never owns a DAP
// connection. The one real command, `burrow.viz.hexdump`, resolves an expression
// in the stopped frame, confirms a visualizer matches its type, pages its bytes,
// and paints them — a genuine query → match → render path, not a stub.

const GO_DEBUG_TYPE = 'go';

/** The `[]byte` fetch window (bytes), configurable; the head shown for a large body. */
function maxBytes(): number {
	const n = workspace.getConfiguration('burrow.viz').get<number>('maxBytes', 4096);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : 4096;
}

export function activate(context: ExtensionContext): void {
	const models = new Map<string, VizModel>();
	const pane = new VizViewProvider();
	// Pop out / dock (patches/0016). A hex dump is a reference surface — the whole
	// point is to read it while stepping, which is exactly what a 300px-wide slot
	// under Run and Debug is worst at. The provider does not change: it renders
	// into whichever host this hands it.
	const detachable = new DetachableView({
		viewId: VizViewProvider.viewId,
		viewType: 'burrow.detached.vizPane',
		title: 'Value Visualizer',
		placeholderLabel: 'The value visualizer',
		attach: (host) => pane.attach(host),
	}, context.workspaceState);
	pane.detachable = detachable;

	/**
	 * The slice's one real action: prompt for an expression, evaluate it in the
	 * stopped frame, consult the registry, page its bytes off DAP, and visualize.
	 */
	const visualize = async (): Promise<void> => {
		const session = debug.activeDebugSession;
		if (!session || session.type !== GO_DEBUG_TYPE) {
			void window.showInformationMessage('Burrow: start a Go debug session and stop at a breakpoint first.');
			return;
		}
		const model = models.get(session.id);
		if (!model) {
			void window.showInformationMessage('Burrow: no inspector model for the active session.');
			return;
		}
		const frameId = await model.activeFrameId();
		if (frameId === undefined) {
			void window.showInformationMessage('Burrow: the session is not stopped at a frame.');
			return;
		}
		const expression = await window.showInputBox({
			title: 'Visualize Value as Hex / ASCII',
			prompt: 'A []byte expression in the current frame (e.g. req.Body, payload, buf[:n])',
			placeHolder: 'req.Body',
			ignoreFocusOut: true,
		});
		if (!expression) {
			return;
		}
		const variable = await model.evaluate(expression, frameId);
		if (!variable) {
			void window.showWarningMessage(`Burrow: could not evaluate “${expression}” in this frame.`);
			return;
		}
		// The registry decides whether any visualizer applies; the byte viewer matches
		// []byte / []uint8 by type. Anything else falls through to a helpful message.
		if (!hasVisualizer({ type: variable.type })) {
			void window.showInformationMessage(`Burrow: no visualizer for ${variable.type ?? 'that value'} yet — the byte viewer handles []byte / []uint8.`);
			return;
		}
		const payload = await model.bytesFromVariable(variable, maxBytes());
		if (!payload) {
			void window.showWarningMessage(`Burrow: “${expression}” resolved to no readable bytes.`);
			return;
		}
		const chosen = bestVisualizer({ type: payload.type });
		pane.show(`${expression}  ·  ${chosen ? chosen.label : 'Bytes'}`, payload);
		await commands.executeCommand(`${VizViewProvider.viewId}.focus`);
	};

	context.subscriptions.push(
		pane,
		detachable,
		window.registerWebviewViewProvider(VizViewProvider.viewId, pane),
		detachable.register(),
		commands.registerCommand('burrow.viz.hexdump', () => visualize()),
		commands.registerCommand('burrow.viz.popOut', () => detachable.popOut()),
		commands.registerCommand('burrow.viz.dock', () => detachable.dock()),
		debug.onDidStartDebugSession((session: DebugSession) => {
			if (session.type === GO_DEBUG_TYPE) {
				models.set(session.id, new VizModel(session));
			}
		}),
		debug.onDidTerminateDebugSession((session: DebugSession) => {
			models.delete(session.id);
			// The container view's `when` hides it when the session ends; a floating
			// window has no such rule and would sit there showing a dead session's
			// bytes as if they were live. Dock it back instead of lying.
			if (models.size === 0) {
				void detachable.dock();
			}
		}),
	);
}

export function deactivate(): void {
	// Models are dropped on session terminate; the webview view and command are
	// disposed via context.subscriptions.
}
