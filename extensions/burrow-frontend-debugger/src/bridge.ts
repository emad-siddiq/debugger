/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import * as vscode from 'vscode';

/** The stamped source coordinates a browser ⌥-click POSTs to the reveal bridge. */
export interface RevealPayload {
	readonly file: string;
	readonly line: number;
	readonly col: number;
	readonly name?: string;
}

/**
 * A tiny loopback HTTP server the injected inspector agent POSTs to when the
 * instrumented app runs in the REAL browser (Framer-mode T2). There is no parent
 * webview in that case, so the agent reaches Burrow over this bridge instead:
 * `POST /reveal` with a `{file,line,col}` JSON body invokes the reveal callback
 * (which opens the source in the editor). CORS-open so the app's own origin can
 * reach it; bound to 127.0.0.1 only. Zero npm deps (Node `http`).
 */
export class RevealBridge implements vscode.Disposable {

	private server: http.Server | undefined;
	readonly port: number;

	constructor(port = 6099) {
		this.port = port;
	}

	/**
	 * Start listening and route `POST /reveal` to `onReveal`. Idempotent; resolves
	 * once bound, rejects if the port is already taken (the caller surfaces that —
	 * reveal is best-effort, the rest of the browser flow still works).
	 */
	start(onReveal: (payload: RevealPayload) => void): Promise<void> {
		if (this.server) {
			return Promise.resolve();
		}
		const server = http.createServer((req, res) => {
			res.setHeader('Access-Control-Allow-Origin', '*');
			res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
			res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
			if (req.method === 'OPTIONS') {
				res.statusCode = 204;
				res.end();
				return;
			}
			const route = (req.url || '').split('?')[0];
			if (req.method === 'GET' && route === '/health') {
				res.statusCode = 200;
				res.setHeader('Content-Type', 'application/json');
				res.end('{"ok":true}');
				return;
			}
			if (req.method === 'POST' && route === '/reveal') {
				let body = '';
				req.on('data', (chunk) => {
					body += chunk;
					if (body.length > 64 * 1024) {
						req.destroy(); // never buffer an unbounded body
					}
				});
				req.on('end', () => {
					const payload = parseReveal(body);
					if (payload) {
						onReveal(payload);
						res.statusCode = 200;
						res.end('{"ok":true}');
					} else {
						res.statusCode = 400;
						res.end('{"ok":false}');
					}
				});
				return;
			}
			res.statusCode = 404;
			res.end();
		});
		return new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(this.port, '127.0.0.1', () => {
				server.removeListener('error', reject);
				this.server = server;
				resolve();
			});
		});
	}

	dispose(): void {
		this.server?.close();
		this.server = undefined;
	}
}

/** Parse a reveal body; returns null for malformed input (pure — unit-tested). */
export function parseReveal(body: string): RevealPayload | undefined {
	try {
		const parsed = JSON.parse(body) as Partial<RevealPayload>;
		if (parsed && typeof parsed.file === 'string' && parsed.file.length > 0) {
			return {
				file: parsed.file,
				line: typeof parsed.line === 'number' ? parsed.line : 1,
				col: typeof parsed.col === 'number' ? parsed.col : 1,
				name: typeof parsed.name === 'string' ? parsed.name : undefined,
			};
		}
	} catch {
		// malformed JSON → undefined
	}
	return undefined;
}
