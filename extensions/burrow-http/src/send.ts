/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// send.ts — the send engine (architecture task 09, task 2: the "send engine"). It
// executes a ResolvedRequest against a real URL using Node's built-in global `fetch`
// (Burrow runs Node 24, where fetch is native — no node_modules dependency). `fetch`
// is injected through a tiny `FetchLike` interface so the engine unit-tests against a
// fake with no network. This module has no 'vscode' import, so out/send.js is a clean
// CommonJS module the standalone tests require directly.

import { ResolvedRequest } from './httpFile';

/** The narrow slice of the Fetch `Response` this engine reads. */
export interface FetchResponseLike {
	readonly status: number;
	readonly statusText: string;
	readonly headers: { forEach(callback: (value: string, key: string) => void): void };
	text(): Promise<string>;
}

/** The `fetch(url, init)` shape — satisfied by Node's global `fetch` and by test fakes. */
export type FetchLike = (url: string, init: {
	method: string;
	headers: Record<string, string>;
	body?: string;
	signal?: AbortSignal;
}) => Promise<FetchResponseLike>;

/** Options for a send: a timeout and the injectable fetch (defaults to global fetch). */
export interface SendOptions {
	/** Abort the request after this many ms; `0`/omitted means no timeout. */
	readonly timeoutMs?: number;
	/** Fetch implementation; defaults to the global `fetch`. */
	readonly fetchImpl?: FetchLike;
}

/** The captured response — enough to render status, headers, timing, and body. */
export interface SendResult {
	readonly status: number;
	readonly statusText: string;
	readonly headers: ReadonlyArray<readonly [string, string]>;
	readonly body: string;
	/** Wall-clock duration of the round-trip, in milliseconds. */
	readonly durationMs: number;
}

/** Turn a header pair list into the plain object `fetch` wants, dropping empty keys. */
function toHeaderObject(headers: ReadonlyArray<readonly [string, string]>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of headers) {
		if (key) {
			out[key] = value;
		}
	}
	return out;
}

/**
 * Send a resolved request and capture the response. GET/HEAD carry no body; any other
 * method sends the (possibly empty) body verbatim. A `timeoutMs` arms an AbortController
 * so a hung server can't wedge the workbench. Returns status, headers, body and the
 * measured round-trip duration.
 */
export async function sendRequest(request: ResolvedRequest, options: SendOptions = {}): Promise<SendResult> {
	const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
	if (typeof fetchImpl !== 'function') {
		throw new Error('No fetch implementation available (expected Node global fetch).');
	}

	const hasBody = request.body !== '' && request.method !== 'GET' && request.method !== 'HEAD';
	const controller = options.timeoutMs && options.timeoutMs > 0 ? new AbortController() : undefined;
	const timer = controller ? setTimeout(() => controller.abort(), options.timeoutMs) : undefined;

	const start = Date.now();
	try {
		const response = await fetchImpl(request.url, {
			method: request.method,
			headers: toHeaderObject(request.headers),
			...(hasBody ? { body: request.body } : {}),
			...(controller ? { signal: controller.signal } : {}),
		});
		const body = await response.text();
		const headers: [string, string][] = [];
		response.headers.forEach((value, key) => headers.push([key, value]));
		return {
			status: response.status,
			statusText: response.statusText,
			headers,
			body,
			durationMs: Date.now() - start,
		};
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}
