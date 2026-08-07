/*---------------------------------------------------------------------------------------------
 *  Burrow: one Claude Code session per chat session.
 *
 *  Wire, verified against claude 2.1.216:
 *    spawn  claude -p --verbose --input-format stream-json --output-format stream-json
 *           --include-partial-messages --permission-prompt-tool stdio [--resume <id>] [--model <m>]
 *    in  →  {type:"user", message:{role:"user", content:[{type:"text",text}]}}
 *    in  →  {type:"control_response", response:{subtype:"success", request_id,
 *            response:{behavior:"allow"|"deny", message?, updatedInput?}}}
 *    out ←  {type:"system", subtype:"init", session_id, model, ...}
 *    out ←  {type:"stream_event", event:{type:"content_block_delta",
 *            delta:{type:"text_delta"|"thinking_delta", ...}}}
 *    out ←  {type:"assistant", message:{content:[{type:"tool_use", id, name, input} | ...]}}
 *    out ←  {type:"user", message:{content:[{type:"tool_result", tool_use_id, content, is_error}]}}
 *    out ←  {type:"control_request", request_id, request:{subtype:"can_use_tool",
 *            tool_name, input, description, ...}}
 *    out ←  {type:"result", subtype, is_error, result, session_id}
 *
 *  A turn is one spawned process. Session continuity across turns (and across
 *  IDE restarts) is the CLI's own on-disk session store, via --resume.
 *
 *  A permission request PARKS the turn: the process stays alive, blocked on the
 *  control response; the chat handler returns after pushing a confirmation. The
 *  user's Accept/Reject arrives as the next chat request and un-parks it.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { PermissionPolicy, TurnUsage, usageOfResult } from './controls';

export type { PermissionPolicy };

/** Outgoing-prompt tracing (plan chat/01 step 1). Off in shipped builds; Phase 4's
 *  E2E matrix flips it on to assert byte-identical packs and message contents. */
export const TRACE_PROMPT = false;
let traceChannel: vscode.OutputChannel | undefined;
export function tracePrompt(tag: string, text: string): void {
	if (!TRACE_PROMPT) { return; }
	traceChannel ??= vscode.window.createOutputChannel('Burrow Chat Trace');
	const entry = `--- ${tag} ${new Date().toISOString()} ---\n${text}\n--- end ${tag} ---`;
	traceChannel.appendLine(entry);
	try { fs.appendFileSync('/tmp/burrow-chat-trace.log', entry + '\n'); } catch { /* capture is best-effort */ }
}

/** `burrow.chat.logArgs`: echo the composed command line so a control can be proven on the wire. */
let spawnChannel: vscode.OutputChannel | undefined;
function logSpawn(cliPath: string, args: readonly string[], env: Readonly<Record<string, string>>): void {
	if (!vscode.workspace.getConfiguration('burrow.chat').get<boolean>('logArgs', false)) { return; }
	spawnChannel ??= vscode.window.createOutputChannel('Burrow Chat');
	const quoted = args.map(a => /\s/.test(a) ? JSON.stringify(a) : a).join(' ');
	const envBits = Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ');
	spawnChannel.appendLine(`${new Date().toISOString()}  ${envBits ? envBits + ' ' : ''}${cliPath} ${quoted}`);
}

export interface ParkedPermission {
	readonly controlRequestId: string;
	readonly toolName: string;
	readonly displayName: string;
	readonly input: unknown;
	readonly description: string;
}

export type TurnOutcome =
	| { kind: 'result'; subtype: string; isError: boolean; text: string; usage?: TurnUsage }
	| { kind: 'parked'; permission: ParkedPermission }
	| { kind: 'died'; error: string };

export interface TurnDelegate {
	onInit(sessionId: string, model: string): void;
	onTextDelta(text: string): void;
	onThinkingDelta(text: string, blockId: string): void;
	onToolStart(id: string, name: string, input: unknown): void;
	onToolEnd(id: string, ok: boolean, summary: string): void;
}

export interface TurnOptions {
	readonly cliPath: string;
	readonly cwd: string;
	/** Control-derived argv (model, effort, permission mode, …) — see controls.buildTurn. */
	readonly extraArgs: readonly string[];
	/** Control-derived environment overlay, applied after the inherited env is scrubbed. */
	readonly env: Readonly<Record<string, string>>;
	readonly policy: PermissionPolicy;
}

export class ClaudeSession {
	/** The CLI's session id — the --resume key. Survives process and IDE restarts via the store. */
	sessionId: string | undefined;

	private child: ChildProcessWithoutNullStreams | undefined;
	private delegate: TurnDelegate | undefined;
	private settle: ((o: TurnOutcome) => void) | undefined;
	private parkedQueue: ParkedPermission[] = [];
	private policy: PermissionPolicy = 'ask';
	private stdoutBuf = '';
	private stderrTail = '';
	private toolMeta = new Map<string, { name: string; input: unknown }>();

	constructor(onSessionId: (id: string) => void) {
		this.onSessionId = onSessionId;
	}
	private readonly onSessionId: (id: string) => void;

	get parked(): ParkedPermission | undefined { return this.parkedQueue[0]; }
	get busy(): boolean { return !!this.child; }

	/** Start a new turn. Any parked turn is denied and its process killed first. */
	startTurn(userText: string, opts: TurnOptions, delegate: TurnDelegate): Promise<TurnOutcome> {
		this.abandon('Superseded by a new message from the user');
		this.policy = opts.policy;

		const args = [
			'-p', '--verbose',
			'--input-format', 'stream-json',
			'--output-format', 'stream-json',
			'--include-partial-messages',
			'--permission-prompt-tool', 'stdio',
		];
		if (this.sessionId) { args.push('--resume', this.sessionId); }
		args.push(...opts.extraArgs);

		const env: NodeJS.ProcessEnv = { ...process.env };
		delete env['ELECTRON_RUN_AS_NODE'];
		// An ANTHROPIC_* var inherited from whatever shell launched the IDE would
		// silently switch the CLI from the user's login to API-key billing.
		for (const key of Object.keys(env)) {
			if (key.startsWith('ANTHROPIC_')) { delete env[key]; }
		}
		// The controls overlay lands after the scrub, so the scrub can never undo it.
		Object.assign(env, opts.env);
		logSpawn(opts.cliPath, args, opts.env);

		const child = spawn(opts.cliPath, args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'], env });
		this.child = child;
		this.stdoutBuf = '';
		this.stderrTail = '';
		this.toolMeta.clear();

		child.stderr.on('data', d => { this.stderrTail = (this.stderrTail + d.toString()).slice(-4000); });
		child.stdout.on('data', d => this.onStdout(d.toString()));
		child.on('error', err => this.die(`could not run "${opts.cliPath}": ${err.message}`));
		child.on('exit', code => {
			if (this.child === child && this.settle) {
				const lastErr = this.stderrTail.trim().split('\n').filter(Boolean).pop() ?? '';
				this.die(`claude exited with code ${code}${lastErr ? ` — ${lastErr}` : ''}`);
			}
			if (this.child === child) { this.child = undefined; }
		});

		tracePrompt('outgoing user message', userText);
		child.stdin.write(JSON.stringify({
			type: 'user',
			message: { role: 'user', content: [{ type: 'text', text: userText }] },
		}) + '\n');

		return this.bind(delegate);
	}

	/**
	 * Answer the oldest parked permission and continue the turn under a new
	 * delegate (the confirmation click arrived as a fresh chat request).
	 */
	answerParked(allow: boolean, denyMessage: string, delegate: TurnDelegate): Promise<TurnOutcome> {
		const parked = this.parkedQueue.shift();
		if (!parked || !this.child) {
			return Promise.resolve({ kind: 'died', error: 'The approval expired — its Claude Code turn is no longer running.' });
		}
		const settled = this.bind(delegate);
		this.respondPermission(parked.controlRequestId, allow, denyMessage);
		// Anything parked behind the first one re-parks immediately.
		if (this.parkedQueue.length > 0 && this.settle) {
			const next = this.parkedQueue[0];
			const s = this.settle;
			this.settle = undefined; this.delegate = undefined;
			s({ kind: 'parked', permission: next });
		}
		return settled;
	}

	/** Cancel the running turn (chat stop button). The session id survives for --resume. */
	cancel(): void {
		this.abandon('Cancelled by the user');
	}

	private bind(delegate: TurnDelegate): Promise<TurnOutcome> {
		this.delegate = delegate;
		return new Promise<TurnOutcome>(resolve => { this.settle = resolve; });
	}

	private abandon(reason: string): void {
		for (const parked of this.parkedQueue.splice(0)) {
			this.respondPermission(parked.controlRequestId, false, reason);
		}
		if (this.settle) {
			const s = this.settle;
			this.settle = undefined; this.delegate = undefined;
			s({ kind: 'died', error: reason });
		}
		if (this.child && !this.child.killed) { this.child.kill(); }
		this.child = undefined;
	}

	private die(error: string): void {
		this.parkedQueue.length = 0;
		if (this.settle) {
			const s = this.settle;
			this.settle = undefined; this.delegate = undefined;
			s({ kind: 'died', error });
		}
		this.child = undefined;
	}

	private respondPermission(requestId: string, allow: boolean, denyMessage: string): void {
		this.child?.stdin.write(JSON.stringify({
			type: 'control_response',
			response: {
				subtype: 'success',
				request_id: requestId,
				response: allow ? { behavior: 'allow' } : { behavior: 'deny', message: denyMessage, interrupt: false },
			},
		}) + '\n');
	}

	private onStdout(chunk: string): void {
		this.stdoutBuf += chunk;
		let nl;
		while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
			const line = this.stdoutBuf.slice(0, nl);
			this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
			if (!line.trim()) { continue; }
			let ev: any;
			try { ev = JSON.parse(line); } catch { continue; }
			try { this.onEvent(ev); } catch { /* a rendering error must not kill the pump */ }
		}
	}

	private onEvent(ev: any): void {
		switch (ev.type) {
			case 'system':
				if (ev.subtype === 'init' && ev.session_id) {
					this.sessionId = ev.session_id;
					this.onSessionId(ev.session_id);
					if (ev.model) { this.delegate?.onInit(ev.session_id, ev.model); }
				}
				break;

			case 'stream_event': {
				const se = ev.event;
				if (se?.type === 'content_block_delta') {
					if (se.delta?.type === 'text_delta' && se.delta.text) {
						this.delegate?.onTextDelta(se.delta.text);
					} else if (se.delta?.type === 'thinking_delta' && se.delta.thinking) {
						this.delegate?.onThinkingDelta(se.delta.thinking, String(se.index ?? 0));
					}
				}
				break;
			}

			case 'assistant':
				for (const block of ev.message?.content ?? []) {
					if (block.type === 'tool_use') {
						this.toolMeta.set(block.id, { name: block.name, input: block.input });
						this.delegate?.onToolStart(block.id, block.name, block.input);
					}
				}
				break;

			case 'user':
				for (const block of ev.message?.content ?? []) {
					if (block.type === 'tool_result') {
						const summary = typeof block.content === 'string'
							? block.content
							: (Array.isArray(block.content) ? block.content.map((c: any) => c?.text ?? '').join('') : '');
						this.delegate?.onToolEnd(block.tool_use_id, !block.is_error, summary);
					}
				}
				break;

			case 'control_request':
				if (ev.request?.subtype === 'can_use_tool') {
					if (this.policy === 'allowAll') {
						this.respondPermission(ev.request_id, true, '');
						break;
					}
					const permission: ParkedPermission = {
						controlRequestId: ev.request_id,
						toolName: ev.request.tool_name ?? 'tool',
						displayName: ev.request.display_name ?? ev.request.tool_name ?? 'tool',
						input: ev.request.input,
						description: ev.request.description ?? '',
					};
					this.parkedQueue.push(permission);
					// Only the first parks the turn; later ones queue behind it.
					if (this.parkedQueue.length === 1 && this.settle) {
						const s = this.settle;
						this.settle = undefined; this.delegate = undefined;
						s({ kind: 'parked', permission });
					}
				}
				break;

			case 'result': {
				const s = this.settle;
				this.settle = undefined; this.delegate = undefined;
				if (ev.session_id) { this.sessionId = ev.session_id; this.onSessionId(ev.session_id); }
				const child = this.child;
				this.child = undefined;
				child?.kill();
				s?.({
					kind: 'result',
					subtype: ev.subtype ?? 'success',
					isError: !!ev.is_error,
					text: String(ev.result ?? ''),
					usage: usageOfResult(ev),
				});
				break;
			}
		}
	}

	tool(toolCallId: string): { name: string; input: unknown } | undefined {
		return this.toolMeta.get(toolCallId);
	}
}
