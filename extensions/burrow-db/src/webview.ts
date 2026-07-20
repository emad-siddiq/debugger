/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// webview.ts — the one shared webview bit for the explorer: a CSP nonce. Kept in
// its own module (matching burrow-go-inspect) so the strict inline-script/style
// policy is generated the same way wherever a panel is added.

const NONCE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** A 32-char random nonce for the strict inline-script/style CSP. */
export function nonce(): string {
	let out = '';
	for (let i = 0; i < 32; i++) {
		out += NONCE_CHARS.charAt(Math.floor(Math.random() * NONCE_CHARS.length));
	}
	return out;
}
