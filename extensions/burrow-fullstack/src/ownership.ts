/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Port OWNERSHIP for the Full Stack compound (WO-61 §1).
//
// The compound used to report a tier up when its health URL answered. A health
// check answers *is something there*. The question the compound has to answer is
// *is the thing I started there* — and on the machine this was written for, the
// two differ most mornings, because merkle's own `./infra/merkle --start` leaves
// a backend on :8080. P2-7 measured the consequence: `every tier came up` while
// the dlv-debugged backend was not running at all, its port taken, its
// breakpoints therefore unreachable. A false green is worse than a red, because
// it sends you to debug the wrong thing.
//
// **How ownership is established: by transition, not by identity.**
//
//   closed before we started · open after we started  →  ours
//   open before we started                            →  someone else's, and we say whose
//   anything else                                     →  unknown, said out loud
//
// The obvious alternative — plant a token in the process's environment and read
// it back through the health endpoint — is better, and is not available: it needs
// the target app to echo the token, and merkle is out of scope for this fork to
// change. Transition needs nothing from the target. Its blind spot is a third
// party grabbing the port in the window between our pre-flight and our listener,
// which is why `unknown` exists rather than being rounded up to `owned`.
//
// `lsof` turns "someone else's" into "someone else's, and here is its pid and
// command", which is the difference between a message you can act on and one you
// have to investigate. It is best-effort: absent or unhelpful, the claim is still
// correct, just less specific.

// Imports `net` and `child_process` and nothing from `vscode`, deliberately:
// the decision table below is the part worth unit-testing, and a module that
// reaches for `vscode` cannot be required from a plain node test.
import * as cp from 'child_process';
import * as net from 'net';

/** What is listening on a port, as far as we can tell. */
export interface Listener {
	readonly open: boolean;
	readonly pid?: number;
	readonly command?: string;
}

export type Ownership = 'ours' | 'foreign' | 'unknown';

/** Is anything accepting connections here? The portable half of the answer. */
export function portOpen(host: string, port: number, timeoutMs = 400): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = new net.Socket();
		const done = (open: boolean) => {
			socket.destroy();
			resolve(open);
		};
		socket.setTimeout(timeoutMs);
		socket.once('connect', () => done(true));
		socket.once('timeout', () => done(false));
		socket.once('error', () => done(false));
		socket.connect(port, host);
	});
}

/**
 * Who holds the port. `open` is the portable answer (a TCP connect); `pid` and
 * `command` are a bonus from `lsof` where it exists, and their absence is never
 * an error — a listener we cannot name is still a listener.
 */
export async function listenerOn(host: string, port: number): Promise<Listener> {
	const open = await portOpen(host, port);
	if (!open) {
		return { open: false };
	}
	const pid = firstPid(spawnText('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']));
	if (pid === undefined) {
		return { open: true };
	}
	const command = spawnText('ps', ['-p', String(pid), '-o', 'comm=']).trim() || undefined;
	return { open: true, pid, command };
}

/** A listener in the form a person can act on: `pid 38596 (nodewatch-api)`. */
export function describeListener(listener: Listener): string {
	if (!listener.open) {
		return 'nothing';
	}
	if (listener.pid === undefined) {
		return 'a process this tool could not identify';
	}
	const name = listener.command ? ` (${basename(listener.command)})` : '';
	return `pid ${listener.pid}${name}`;
}

/**
 * The verdict, from the two observations. Deliberately total: every combination
 * of before/after has an answer, and the one that cannot be established is
 * `unknown` rather than a guess in either direction.
 */
export function ownershipOf(before: Listener, after: Listener): Ownership {
	if (before.open) {
		// Someone was already there. Even if our process later replaced them, we
		// did not establish that, and the interesting case — they are still there
		// and we never bound at all — is indistinguishable from here.
		return 'foreign';
	}
	if (!after.open) {
		return 'unknown';   // we started something; nothing is listening. Not ours.
	}
	// Closed, then we started a process, then open. Ours by construction — unless
	// a third party won the race, which nothing short of a pid can rule out.
	return 'ours';
}

/**
 * The message for a port that was already taken when the compound went to launch
 * its own backend. Says what is there, why that is fatal *for a launch* rather
 * than merely untidy, and the two ways out.
 */
export function foreignPortMessage(url: string, port: number, listener: Listener): string {
	return `${url} is already served by ${describeListener(listener)} — and this compound ` +
		`LAUNCHES the backend, so it cannot also own :${port}. Whatever is there now would ` +
		`answer every request the app makes, the debugged process would never bind, and its ` +
		`breakpoints would never be hit — while the tier read "up". Stop the other backend ` +
		`(\`./infra/merkle --down\`, or \`kill ${listener.pid ?? '<pid>'}\`), or point ` +
		`burrow.fullstack.backendConfig at an attach configuration if attaching is what you meant.`;
}

/** The message for "we started it and nothing is listening". */
export function noListenerMessage(url: string, seconds: number): string {
	return `the debug session started but ${url} never answered within ${seconds}s — the program ` +
		`is most likely halted at a breakpoint that runs before it listens (or set ` +
		`burrow.fullstack.backendHealthUrl to '' to skip this check).`;
}

/**
 * Do two URLs point at the same server? Origin only — a launch config whose path
 * is `/watch/app/` against a dev server rooted at `/` is not a disagreement worth
 * overriding, but a different PORT is, and that is the one that broke the join
 * (WO-61 §2).
 *
 * `localhost` and `127.0.0.1` count as the same host. They are, and treating
 * them as different would make the compound rewrite a URL that was already right
 * — a cosmetic override that shows up in the session name and makes the log lie
 * about having corrected something.
 */
export function sameOrigin(a: string | undefined, b: string | undefined): boolean {
	if (!a || !b) {
		return false;
	}
	try {
		const left = new URL(a);
		const right = new URL(b);
		const host = (url: URL) => (url.hostname === '127.0.0.1' || url.hostname === '[::1]' ? 'localhost' : url.hostname);
		const port = (url: URL) => url.port || (url.protocol === 'https:' ? '443' : '80');
		return left.protocol === right.protocol && host(left) === host(right) && port(left) === port(right);
	} catch {
		return false;
	}
}

/** `http://127.0.0.1:8080/healthz` → host + port. Undefined when unparseable. */
export function hostPortOfUrl(url: string | undefined): { host: string; port: number } | undefined {
	if (!url) {
		return undefined;
	}
	try {
		const parsed = new URL(url);
		const port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
		return { host: parsed.hostname || '127.0.0.1', port };
	} catch {
		return undefined;
	}
}

// --- helpers ---------------------------------------------------------------

/** Run a command for its stdout. Never throws — every caller treats silence as
 *  "could not tell", which is a legitimate answer here. */
function spawnText(command: string, args: string[]): string {
	try {
		const result = cp.spawnSync(command, args, { encoding: 'utf8', timeout: 2000 });
		return result.status === 0 ? (result.stdout || '') : '';
	} catch {
		return '';
	}
}

/** `lsof -t` can list several pids (a parent and its forks); the first will do. */
function firstPid(text: string): number | undefined {
	for (const line of text.split('\n')) {
		const pid = Number(line.trim());
		if (Number.isInteger(pid) && pid > 0) {
			return pid;
		}
	}
	return undefined;
}

function basename(command: string): string {
	return command.trim().split('/').pop() || command.trim();
}
