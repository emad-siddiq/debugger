/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// webview.ts — tiny shared bits for the inspector's webviews (Miller inspector +
// Watch): a CSP nonce and the value-pane CSS both panes render, kept in one place so
// the value pane looks identical in each (task 05: "same value pane on select").

const NONCE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** A 32-char random nonce for the strict inline-script/style CSP. */
export function nonce(): string {
	let out = '';
	for (let i = 0; i < 32; i++) {
		out += NONCE_CHARS.charAt(Math.floor(Math.random() * NONCE_CHARS.length));
	}
	return out;
}

/** The value-pane styles (the `#value` block) shared by both inspector webviews. */
export function valuePaneCss(): string {
	return `
		#value { border-top: 1px solid var(--vscode-panel-border); padding: 6px 8px; }
		#value .head { font-size: 12px; margin-bottom: 4px; }
		#value .type { opacity: .7; }
		#value pre { margin: 0 0 6px; padding: 4px 6px; background: var(--vscode-textCodeBlock-background); border-radius: 3px; white-space: pre-wrap; word-break: break-all; max-height: 8em; overflow: auto; }
		#value .actions { display: flex; gap: 6px; flex-wrap: wrap; }
		#value button { font: inherit; padding: 2px 8px; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border-radius: 2px; cursor: pointer; }
		#value button:hover { background: var(--vscode-button-secondaryHoverBackground); }
		[hidden] { display: none !important; }`;
}
