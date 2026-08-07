/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { collect } from './context';
import { Layer, render, withQuestion } from './contextModel';
import { ProposalStore } from './diff';
import { InsightCard, Insights } from './insights';
import { PanelSizer } from './layout';
import { contractReminders } from './memoryModel';
import { Session, SessionStore, Turn } from './sessions';
import { Transport, TransportEvent } from './transport';
import { ViewHost } from './detachableView';

// The panel itself: the transcript, the composer, the vertical session rail
// (docs/plans/03 §8). It owns one Transport per session — created on that
// session's first message, killed when its tab closes — and turns wire events
// into rendered turns.
//
// The webview is deliberately dumb: it renders the state it is given and posts
// back intent (send / switch / new / close / stop / size / escape / chip /
// preview / apply). Every decision, including which session an arriving delta
// belongs to, is made here, because a user who switches tabs mid-answer must
// not see the answer land in the wrong transcript.
//
// Each question carries a context envelope built at the moment it is asked
// (context.ts): what is open, the page bundle, the selection and its symbol,
// the live isolation surface, and the rows of the repo's memory that apply.
// Every layer is a chip the developer can take off before sending, and
// `Burrow: Show Agent Context` prints the envelope verbatim — what you preview
// is exactly what was sent.

interface Inbound {
	readonly type: string;
	readonly text?: string;
	readonly id?: string;
	readonly layer?: string;
}

/** A context layer as the chip row shows it. */
interface Chip {
	readonly id: string;
	readonly label: string;
	readonly on: boolean;
}

/** What the webview renders. Posted whole on every change except deltas, which
 *  are streamed to keep a long answer from re-laying out on every token. */
interface ViewState {
	readonly type: 'state';
	readonly tabs: readonly { readonly id: string; readonly title: string; readonly active: boolean }[];
	readonly turns: readonly Turn[];
	readonly streaming: boolean;
	readonly footer: string;
	readonly notice?: { readonly text: string; readonly action?: string };
	readonly chips: readonly Chip[];
	readonly insight?: InsightCard & { readonly notice?: string };
	readonly insightsOn: boolean;
}

export class AgentPanel implements vscode.WebviewViewProvider, vscode.Disposable {

	public static readonly viewId = 'burrowAgentChat';

	private view: ViewHost | undefined;
	/** Set by extension.ts once the pop-out wrapper exists (patches/0016). */
	public detachable: { resolve(view: vscode.WebviewView): void } | undefined;
	private readonly transports = new Map<string, Transport>();
	/** The turn currently being written into, and whose session it belongs to. */
	private streaming: { readonly sessionId: string; readonly turn: Turn; text: string } | undefined;
	private notice: { text: string; action?: string } | undefined;
	/** The layers offered on the chip row, refreshed whenever a question is
	 *  asked; before the first one it is what a question WOULD carry. */
	private chips: Chip[] = [];
	/** The last envelope actually sent, for `Burrow: Show Agent Context`. */
	private lastEnvelope = '';
	private insight: (InsightCard & { notice?: string }) | undefined;
	private insights: Insights | undefined;
	private readonly proposals = new ProposalStore();
	/** A private conversation for insight cards, so they never interleave with
	 *  the developer's own. */
	private insightTransport: Transport | undefined;
	private proposalCounter = 0;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly sessions: SessionStore,
		private readonly sizer: PanelSizer,
	) {
		this.insights = new Insights(
			context,
			(prompt) => this.runInsight(prompt),
			(card, notice) => { this.insight = card ? { ...card, notice } : (notice ? { file: '', text: '', cached: false, notice } : undefined); this.render(); },
			() => !!this.streaming,
		);
		// The chip row is a picture of the CURRENT screen, so it follows the
		// screen: opening another file changes what a question would carry, and
		// a row that still names the last file would be a lie about what is
		// about to be sent.
		context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => void this.refreshAndRender()));
		void this.refreshAndRender();
	}

	private async refreshAndRender(): Promise<void> {
		await this.refreshChips();
		this.render();
	}

	/**
	 * The secondary-sidebar slot. Delegated to `DetachableView` (patches/0016) so
	 * the chat can move to a floating window; `attach` below is the body this
	 * used to be, and it cannot tell which host it got.
	 */
	resolveWebviewView(view: vscode.WebviewView): void {
		if (this.detachable) {
			this.detachable.resolve(view);
			return;
		}
		this.attach(view);
	}

	/** Wire a host — a sidebar slot or a popped-out panel. */
	attach(view: ViewHost): void {
		this.view = view;
		view.webview.options = { enableScripts: true };
		view.webview.html = html(nonce());
		view.webview.onDidReceiveMessage((msg: Inbound) => void this.onMessage(msg), undefined, this.context.subscriptions);
		view.onDidChangeVisibility(() => { if (view.visible) { void this.refreshAndRender(); } }, undefined, this.context.subscriptions);
		view.onDidDispose(() => { this.view = undefined; }, undefined, this.context.subscriptions);
	}

	dispose(): void {
		for (const transport of this.transports.values()) {
			transport.dispose();
		}
		this.transports.clear();
		this.insightTransport?.dispose();
		this.insights?.dispose();
		this.proposals.dispose();
	}

	/** Reveal the panel, or put it away if it is already the thing on screen —
	 *  the ⌘⌥D behaviour from the plan's acceptance list. */
	async toggle(): Promise<void> {
		if (this.view?.visible) {
			await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
		} else {
			await vscode.commands.executeCommand(`${AgentPanel.viewId}.focus`);
		}
	}

	async newSession(): Promise<void> {
		if (!this.sessions.create()) {
			this.notice = { text: `That is ${this.sessions.all.length} conversations already — close one to start another.` };
		}
		await vscode.commands.executeCommand(`${AgentPanel.viewId}.focus`);
		this.render();
	}

	/** `Burrow: Show Agent Context` from the palette. */
	async showContextCommand(): Promise<void> {
		await this.showContext();
	}

	/** ⌘⌥I — ask about what is selected, without typing the question. The
	 *  selection is already a context layer, so the question can be this short. */
	async explainSelection(): Promise<void> {
		await vscode.commands.executeCommand(`${AgentPanel.viewId}.focus`);
		await this.send('Explain the selected code: what it does, what it touches, one risk.');
	}

	async toggleInsights(): Promise<void> {
		await this.insights?.toggle();
		this.render();
	}

	/** Abandon the answer in flight; the conversation itself survives (the next
	 *  message respawns the CLI with `--resume`). */
	stop(): void {
		if (!this.streaming) {
			return;
		}
		this.transports.get(this.streaming.sessionId)?.cancel();
	}

	private async onMessage(msg: Inbound): Promise<void> {
		switch (msg?.type) {
			case 'ready':
				return this.render();
			case 'send':
				return this.send(String(msg.text ?? ''));
			case 'switch':
				this.sessions.activate(String(msg.id));
				return this.render();
			case 'new':
				return void this.newSession();
			case 'close':
				return this.closeSession(String(msg.id));
			case 'stop':
				return this.stop();
			case 'size':
				await this.sizer.cycle();
				return this.render();
			case 'escape':
				// Esc leaves the biggest state first and only then hands focus
				// back — otherwise a full-screen panel would need two presses to
				// get out of the way, which is the thing Esc is for (plans/01 §4).
				if (!await this.sizer.collapseFromFull()) {
					await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
				}
				return this.render();
			case 'chip':
				this.sessions.toggleLayer(this.sessions.activeId, String(msg.layer));
				await this.refreshChips();
				return this.render();
			case 'showContext':
				return this.showContext();
			case 'preview':
				return void this.proposals.preview(String(msg.id));
			case 'apply': {
				const outcome = await this.proposals.apply(String(msg.id));
				this.notice = { text: `Agent: ${outcome}` };
				return this.render();
			}
			case 'insights':
				await this.insights?.toggle();
				return this.render();
			case 'openSetting':
				return void vscode.commands.executeCommand('workbench.action.openSettings', 'burrow.agent.cliPath');
			default:
				return;
		}
	}

	private closeSession(id: string): void {
		this.transports.get(id)?.dispose();
		this.transports.delete(id);
		if (this.streaming?.sessionId === id) {
			this.streaming = undefined;
		}
		this.sessions.close(id);
		this.render();
	}

	private async send(text: string): Promise<void> {
		const question = text.trim();
		if (!question || this.streaming) {
			return;
		}
		const session = this.sessions.current;
		this.notice = undefined;
		// The envelope is built HERE, at the moment of asking — not cached from
		// when the panel was opened — because "this file" means the one on
		// screen now.
		const layers = await collect(new Set(session.dropped ?? []));
		const envelope = render(layers, budgetTokens());
		this.lastEnvelope = envelope.text;
		this.chips = chipsFor(layers, envelope.included, session.dropped ?? []);
		if (envelope.dropped.length) {
			this.notice = { text: `Context budget reached — ${envelope.dropped.join(', ')} left out of this question.` };
		}
		this.sessions.append(session.id, { role: 'you', text: question });
		// The answer's turn exists before a byte arrives: the panel shows an
		// empty agent bubble immediately so a slow first token reads as thinking
		// rather than as nothing happening.
		const turn: Turn = { role: 'agent', text: '' };
		this.sessions.append(session.id, turn);
		this.streaming = { sessionId: session.id, turn, text: '' };
		this.render();
		this.transportFor(session).send(withQuestion(envelope.text, question));
	}

	/** The chip row before anything has been asked: what a question would carry
	 *  right now. Cheap enough to recompute on demand, and honest — the row is
	 *  never a stale picture of an older screen. */
	private async refreshChips(): Promise<void> {
		const session = this.sessions.current;
		const dropped = session?.dropped ?? [];
		const layers = await collect(new Set());
		this.chips = chipsFor(layers, layers.map((l) => l.id).filter((id) => !dropped.includes(id)), dropped);
	}

	/** `Burrow: Show Agent Context` — the envelope, verbatim, in an editor. What
	 *  the developer reads here is exactly the text the model was given. */
	private async showContext(): Promise<void> {
		const session = this.sessions.current;
		const text = this.lastEnvelope
			|| render(await collect(new Set(session.dropped ?? [])), budgetTokens()).text
			|| '(nothing — no workspace, or every layer switched off)';
		const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: text });
		await vscode.window.showTextDocument(doc, { preview: true });
	}

	/** One insight turn on the private conversation. Returns undefined when the
	 *  CLI is unavailable — a card that cannot be produced is simply absent. */
	private async runInsight(prompt: string): Promise<{ text: string; costUsd?: number } | undefined> {
		const layers = await collect(new Set(['pages', 'memory']));
		const envelope = render(layers, Math.min(budgetTokens(), 6000));
		if (!envelope.text) {
			return undefined;
		}
		const config = vscode.workspace.getConfiguration('burrow.agent');
		this.insightTransport?.dispose();
		return new Promise((resolve) => {
			// Resolve on `result`, NOT on `ended`: the child is kept alive between
			// turns by design, so waiting for it to exit waits forever. One card
			// is one turn, so the transport is disposed as soon as it lands.
			let settled = false;
			const finish = (answer: { text: string; costUsd?: number } | undefined) => {
				if (settled) {
					return;
				}
				settled = true;
				this.insightTransport?.dispose();
				this.insightTransport = undefined;
				resolve(answer);
			};
			const transport = new Transport({
				cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
				cliPath: config.get<string>('cliPath', '').trim(),
				model: config.get<string>('model', '').trim(),
			}, (event) => {
				if (event.kind === 'result') {
					finish(event.text ? { text: event.text, costUsd: event.costUsd } : undefined);
				} else if (event.kind === 'ended' || event.kind === 'failed') {
					finish(undefined);
				}
			});
			this.insightTransport = transport;
			transport.send(withQuestion(envelope.text, prompt));
		});
	}

	private transportFor(session: Session): Transport {
		const existing = this.transports.get(session.id);
		if (existing) {
			return existing;
		}
		const config = vscode.workspace.getConfiguration('burrow.agent');
		const transport = new Transport({
			cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
			cliPath: config.get<string>('cliPath', '').trim(),
			model: config.get<string>('model', '').trim(),
			resume: session.resume,
		}, (event) => this.onTransportEvent(session.id, event));
		this.transports.set(session.id, transport);
		return transport;
	}

	private onTransportEvent(sessionId: string, event: TransportEvent): void {
		const live = this.streaming?.sessionId === sessionId ? this.streaming : undefined;
		switch (event.kind) {
			case 'session':
				this.sessions.setResume(sessionId, event.id);
				return;
			case 'delta':
				if (live) {
					live.text += event.text;
					live.turn.text = live.text;
					// Streamed, not re-rendered: appending is the one thing the
					// webview does on its own.
					void this.view?.webview.postMessage({ type: 'delta', text: event.text });
				}
				return;
			case 'text':
				// Only useful when partial messages are unavailable; `result`
				// carries the same prose and is the authority below.
				if (live && !live.text) {
					live.text = event.text;
					live.turn.text = event.text;
					this.render();
				}
				return;
			case 'result':
				if (live) {
					live.turn.text = event.text || live.text;
					live.turn.costUsd = event.costUsd;
					live.turn.tokens = event.tokens;
					live.turn.durationMs = event.durationMs;
					if (event.isError && !live.turn.text) {
						live.turn.text = 'the CLI ended the turn without an answer';
					}
					this.streaming = undefined;
					this.sessions.flush();
					this.render();
					void this.attachProposal(live.turn);
				}
				return;
			case 'rateLimit':
				// Worth saying out loud: the developer's own weekly budget is
				// what this panel spends.
				if (event.status !== 'allowed' && event.utilization >= 0.75) {
					this.notice = { text: `Claude usage is at ${Math.round(event.utilization * 100)}% of your ${event.status.includes('7') ? 'weekly' : 'current'} limit.` };
					this.render();
				}
				return;
			case 'failed':
				this.fail(sessionId, event.message, event.missingCli);
				return;
			case 'ended':
				if (live) {
					// Cancelled or died mid-answer: keep whatever was said.
					live.turn.text = live.text || 'no answer — the turn was stopped';
					this.streaming = undefined;
					this.sessions.flush();
					this.render();
				}
				return;
		}
	}

	/**
	 * An answer that carries a unified diff becomes a proposal: parsed, patched
	 * in memory, and offered as Preview / Apply. Nothing is written — that is
	 * still one explicit press away (diff.ts) — and the memory contract gets its
	 * say here too, because a change that adds a route also owes `api.yaml` a row.
	 */
	private async attachProposal(turn: Turn): Promise<void> {
		const id = `p${++this.proposalCounter}`;
		const proposal = await this.proposals.prepare(id, turn.text);
		if (!proposal) {
			return;
		}
		turn.proposal = { id, files: proposal.files.map((f) => f.path), refusals: proposal.refusals };
		const reminders = contractReminders(turn.text);
		if (reminders.length) {
			turn.reminders = reminders;
		}
		this.sessions.flush();
		this.render();
	}

	private fail(sessionId: string, text: string, missingCli?: boolean): void {
		if (this.streaming?.sessionId === sessionId) {
			// Drop the empty placeholder; the error takes its place.
			const turns = this.sessions.all.find((s) => s.id === sessionId)?.turns;
			if (turns && turns[turns.length - 1] === this.streaming.turn && !this.streaming.turn.text) {
				turns.pop();
			}
			this.streaming = undefined;
		}
		this.sessions.append(sessionId, { role: 'error', text });
		this.notice = missingCli ? { text: 'The panel needs the Claude Code CLI.', action: 'openSetting' } : undefined;
		this.render();
	}

	private render(): void {
		if (!this.view) {
			return;
		}
		const current = this.sessions.current;
		const state: ViewState = {
			type: 'state',
			tabs: this.sessions.all.map((s) => ({ id: s.id, title: s.title, active: s.id === current.id })),
			turns: current.turns,
			streaming: this.streaming?.sessionId === current.id,
			footer: footer(current, this.sizer.size),
			notice: this.notice,
			chips: this.chips,
			insight: this.insight,
			insightsOn: !!this.insights?.enabled,
		};
		void this.view.webview.postMessage(state);
	}
}

/** The one status line: which conversation, what the last answer cost, and the
 *  standing fact that the agent cannot write anything. */
function footer(session: Session, size: string): string {
	const last = [...session.turns].reverse().find((t) => t.role === 'agent' && t.costUsd !== undefined);
	const parts = [session.resume ? `session ${session.resume.slice(0, 4)}` : 'new session'];
	if (last?.tokens) {
		parts.push(`${last.tokens.toLocaleString()} tok`);
	}
	if (last?.costUsd !== undefined) {
		parts.push(`$${last.costUsd < 0.01 ? last.costUsd.toFixed(4) : last.costUsd.toFixed(2)}`);
	}
	parts.push('plan mode');
	parts.push(size);
	return parts.join(' · ');
}

/** One chip per layer that exists, on unless this conversation dropped it. */
function chipsFor(layers: readonly Layer[], included: readonly string[], dropped: readonly string[]): Chip[] {
	const chips = layers.map((layer) => ({ id: layer.id, label: layer.label, on: included.includes(layer.id) }));
	// A dropped layer is still offered — otherwise it could never be put back.
	for (const id of dropped) {
		if (!chips.some((chip) => chip.id === id)) {
			chips.push({ id, label: id, on: false });
		}
	}
	return chips;
}

function budgetTokens(): number {
	return vscode.workspace.getConfiguration('burrow.agent').get<number>('contextBudgetTokens', 12000);
}

function nonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let out = '';
	for (let i = 0; i < 32; i++) {
		out += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return out;
}

function html(cspNonce: string): string {
	return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${cspNonce}'; script-src 'nonce-${cspNonce}'">
<style nonce="${cspNonce}">
	* { box-sizing: border-box; }
	html, body { height: 100%; margin: 0; }
	body {
		display: flex; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
		color: var(--vscode-foreground); background: var(--vscode-sideBar-background);
	}
	#main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
	#log { flex: 1; overflow-y: auto; padding: 8px 10px; display: flex; flex-direction: column; gap: 10px; }
	.turn { display: flex; flex-direction: column; gap: 3px; }
	.who { font-size: 10px; text-transform: uppercase; letter-spacing: .07em; opacity: .6; }
	.body { white-space: pre-wrap; word-break: break-word; line-height: 1.55; }
	.turn.error .body { color: var(--vscode-errorForeground); white-space: pre-wrap; }
	.body code { font-family: var(--vscode-editor-font-family); font-size: .95em; background: var(--vscode-textCodeBlock-background); padding: 0 3px; border-radius: 3px; }
	.body pre {
		margin: 4px 0; padding: 7px 9px; overflow-x: auto; border-radius: 5px;
		background: var(--vscode-textCodeBlock-background); font-family: var(--vscode-editor-font-family);
		font-size: .95em; line-height: 1.45; white-space: pre;
	}
	.body pre code { background: none; padding: 0; }
	.body strong { font-weight: 600; }
	.body ul { margin: 3px 0; padding-left: 18px; }
	.caret::after {
		content: ''; display: inline-block; width: 6px; height: 1em; vertical-align: text-bottom;
		background: var(--vscode-foreground); opacity: .5; animation: blink 1s steps(2, start) infinite;
	}
	@keyframes blink { to { visibility: hidden; } }
	#empty { margin: auto; text-align: center; opacity: .55; padding: 16px; line-height: 1.6; }
	#chips { flex: none; display: flex; flex-wrap: wrap; gap: 4px; padding: 6px 8px 0; }
	.chip {
		font-size: 10px; padding: 1px 6px; border-radius: 9px; cursor: pointer; white-space: nowrap;
		border: 1px solid var(--vscode-panel-border); color: var(--vscode-foreground);
		background: var(--vscode-badge-background); opacity: .55;
	}
	.chip.on { opacity: 1; }
	.chip.on::after { content: ' ×'; opacity: .6; }
	.chip:not(.on)::after { content: ' +'; opacity: .6; }
	#chipbar { display: flex; align-items: center; gap: 6px; padding: 4px 8px 0; }
	#chipbar .lead { font-size: 10px; text-transform: uppercase; letter-spacing: .07em; opacity: .55; }
	#chipbar a { font-size: 10px; opacity: .7; cursor: pointer; text-decoration: underline; }
	#chipbar a:hover { opacity: 1; }
	#insight {
		margin: 6px 8px 0; padding: 6px 8px; border-radius: 5px; font-size: 11px; line-height: 1.5;
		background: var(--vscode-textBlockQuote-background, rgba(127,127,127,.08));
		border-left: 2px solid var(--vscode-textLink-foreground, #4daafc);
	}
	#insight .head { display: flex; gap: 6px; align-items: baseline; font-size: 10px; opacity: .7; margin-bottom: 2px; }
	#insight .head .spacer { flex: 1; }
	#insight .head span.act { cursor: pointer; text-decoration: underline; }
	.proposal { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-top: 4px; }
	.proposal .files { font-size: 10px; opacity: .7; }
	.reminder { font-size: 10px; margin-top: 3px; opacity: .85; }
	.refusal { font-size: 10px; margin-top: 3px; color: var(--vscode-errorForeground); }
	#notice {
		margin: 6px 8px 0; padding: 6px 8px; border-radius: 5px; font-size: 11px; line-height: 1.45;
		background: var(--vscode-inputValidation-warningBackground, rgba(255,200,0,.12));
		border: 1px solid var(--vscode-inputValidation-warningBorder, transparent);
		display: flex; gap: 8px; align-items: baseline;
	}
	#notice button { flex: none; }
	#composer { flex: none; border-top: 1px solid var(--vscode-panel-border); padding: 6px 8px; display: flex; flex-direction: column; gap: 5px; }
	#ask {
		width: 100%; resize: none; min-height: 46px; max-height: 40vh; padding: 5px 7px; border-radius: 5px;
		font-family: inherit; font-size: inherit; line-height: 1.45;
		color: var(--vscode-input-foreground); background: var(--vscode-input-background);
		border: 1px solid var(--vscode-input-border, transparent);
	}
	#ask:focus { outline: 1px solid var(--vscode-focusBorder); }
	#row { display: flex; align-items: center; gap: 8px; }
	#foot { flex: 1; font-size: 10px; opacity: .6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	button {
		font: inherit; font-size: 11px; padding: 1px 8px; border-radius: 4px; cursor: pointer;
		color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
		background: var(--vscode-button-secondaryBackground, transparent);
		border: 1px solid var(--vscode-contrastBorder, var(--vscode-panel-border));
	}
	button.go { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border-color: transparent; }
	button:hover { filter: brightness(1.15); }
	#rail {
		flex: none; width: 22px; border-left: 1px solid var(--vscode-panel-border);
		display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 8px 0;
	}
	.dot {
		width: 9px; height: 9px; border-radius: 50%; cursor: pointer; flex: none;
		border: 1px solid var(--vscode-foreground); opacity: .45;
	}
	.dot:hover { opacity: .8; }
	.dot.on { background: var(--vscode-foreground); opacity: 1; }
	#add { margin-top: auto; opacity: .6; cursor: pointer; padding: 0 4px; line-height: 1; }
	#add:hover { opacity: 1; }
</style>
</head>
<body>
	<div id="main">
		<div id="chipbar">
			<span class="lead">Context</span>
			<a id="showctx" title="Print the exact text the agent is sent">preview</a>
			<a id="toggleins" title="Automatic insight cards for the file you open">insights: off</a>
		</div>
		<div id="chips"></div>
		<div id="insight" hidden></div>
		<div id="notice" hidden></div>
		<div id="log"></div>
		<div id="composer">
			<textarea id="ask" rows="2" placeholder="Ask about this repo…  ⌘↩ to send"></textarea>
			<div id="row">
				<span id="foot"></span>
				<button id="stop" hidden>Stop</button>
				<button id="size" title="Full screen, and back (Esc also comes back)">⛶</button>
				<button id="send" class="go">Ask ⌘↩</button>
			</div>
		</div>
	</div>
	<div id="rail"><span id="add" title="New session">+</span></div>
<script nonce="${cspNonce}">
	const vscode = acquireVsCodeApi();
	const post = (type, extra) => vscode.postMessage(Object.assign({ type }, extra || {}));
	const $ = (id) => document.getElementById(id);
	const log = $('log'), ask = $('ask'), rail = $('rail'), add = $('add');
	let streaming = false;

	// Markdown-lite: enough for an answer in a narrow column — fenced code,
	// inline code, bold, bullets. Everything is escaped first, so this renders
	// text, never markup.
	const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	function md(src) {
		const blocks = esc(src).split(/\`\`\`/);
		return blocks.map((part, i) => {
			if (i % 2 === 1) {
				return '<pre><code>' + part.replace(/^[a-zA-Z0-9_-]*\\n/, '') + '</code></pre>';
			}
			return part
				.replace(/\`([^\`\\n]+)\`/g, '<code>$1</code>')
				.replace(/\\*\\*([^*\\n]+)\\*\\*/g, '<strong>$1</strong>')
				.replace(/^#{1,6} +(.+)$/gm, '<strong>$1</strong>');
		}).join('');
	}

	function renderTurn(turn) {
		const el = document.createElement('div');
		el.className = 'turn ' + turn.role;
		const who = document.createElement('div');
		who.className = 'who';
		who.textContent = turn.role === 'you' ? 'you' : turn.role === 'error' ? 'burrow' : 'agent';
		const body = document.createElement('div');
		body.className = 'body';
		if (turn.role === 'agent') { body.innerHTML = md(turn.text); }
		else { body.textContent = turn.text; }
		el.append(who, body);
		if (turn.proposal) {
			const row = document.createElement('div');
			row.className = 'proposal';
			const preview = document.createElement('button');
			preview.textContent = 'Preview diff';
			preview.addEventListener('click', () => post('preview', { id: turn.proposal.id }));
			const apply = document.createElement('button');
			apply.className = 'go';
			apply.textContent = 'Apply';
			apply.addEventListener('click', () => post('apply', { id: turn.proposal.id }));
			const files = document.createElement('span');
			files.className = 'files';
			files.textContent = turn.proposal.files.join(', ');
			if (turn.proposal.files.length) { row.append(preview, apply, files); }
			el.append(row);
			for (const refusal of turn.proposal.refusals || []) {
				const r = document.createElement('div');
				r.className = 'refusal';
				r.innerHTML = 'refused: ' + md(refusal);
				el.append(r);
			}
		}
		for (const reminder of turn.reminders || []) {
			const r = document.createElement('div');
			r.className = 'reminder';
			r.innerHTML = '📓 the memory contract wants ' + md(reminder);
			el.append(r);
		}
		return el;
	}

	function renderChips(state) {
		const box = $('chips');
		box.innerHTML = '';
		for (const chip of state.chips) {
			const el = document.createElement('span');
			el.className = 'chip' + (chip.on ? ' on' : '');
			el.textContent = chip.label;
			el.title = chip.on ? 'Sent with your next question — click to leave it out' : 'Left out — click to put it back';
			el.addEventListener('click', () => post('chip', { layer: chip.id }));
			box.append(el);
		}
		$('toggleins').textContent = 'insights: ' + (state.insightsOn ? 'on' : 'off');
		const card = $('insight');
		card.hidden = !state.insight;
		if (state.insight) {
			card.innerHTML = '';
			const head = document.createElement('div');
			head.className = 'head';
			const what = document.createElement('span');
			what.textContent = state.insight.notice ? 'Insight' : (state.insight.file || '').split('/').pop() || 'Insight';
			const spacer = document.createElement('span');
			spacer.className = 'spacer';
			const tag = document.createElement('span');
			tag.textContent = state.insight.cached ? 'cached' : state.insight.text ? '' : 'thinking…';
			const off = document.createElement('span');
			off.className = 'act';
			off.textContent = 'off';
			off.title = 'Stop producing insight cards';
			off.addEventListener('click', () => post('insights'));
			head.append(what, spacer, tag, off);
			const body = document.createElement('div');
			body.innerHTML = md(state.insight.notice || state.insight.text);
			card.append(head, body);
		}
	}

	function render(state) {
		streaming = state.streaming;
		log.innerHTML = '';
		if (!state.turns.length) {
			const empty = document.createElement('div');
			empty.id = 'empty';
			empty.textContent = 'Ask about the code you have open. The agent reads and answers — it never writes.';
			log.append(empty);
		} else {
			for (const turn of state.turns) { log.append(renderTurn(turn)); }
			if (streaming) { log.lastElementChild.querySelector('.body').classList.add('caret'); }
		}
		renderChips(state);
		$('foot').textContent = state.footer;
		$('stop').hidden = !streaming;
		$('send').disabled = streaming;
		const notice = $('notice');
		notice.hidden = !state.notice;
		if (state.notice) {
			notice.innerHTML = '';
			const text = document.createElement('span');
			text.textContent = state.notice.text;
			notice.append(text);
			if (state.notice.action) {
				const button = document.createElement('button');
				button.textContent = 'Open setting';
				button.addEventListener('click', () => post('openSetting'));
				notice.append(button);
			}
		}
		// One dot per session, newest at the bottom; + stays last.
		for (const dot of [...rail.querySelectorAll('.dot')]) { dot.remove(); }
		for (const tab of state.tabs) {
			const dot = document.createElement('span');
			dot.className = 'dot' + (tab.active ? ' on' : '');
			dot.title = tab.title;
			dot.addEventListener('click', () => post('switch', { id: tab.id }));
			dot.addEventListener('auxclick', (e) => { if (e.button === 1) { post('close', { id: tab.id }); } });
			dot.addEventListener('contextmenu', (e) => { e.preventDefault(); post('close', { id: tab.id }); });
			rail.insertBefore(dot, add);
		}
		log.scrollTop = log.scrollHeight;
	}

	window.addEventListener('message', (e) => {
		const d = e.data;
		if (!d) { return; }
		if (d.type === 'state') { render(d); return; }
		if (d.type === 'delta') {
			const body = log.lastElementChild && log.lastElementChild.querySelector('.body');
			if (body) {
				body.dataset.raw = (body.dataset.raw || '') + d.text;
				body.innerHTML = md(body.dataset.raw);
				body.classList.add('caret');
				log.scrollTop = log.scrollHeight;
			}
		}
	});

	function send() {
		const text = ask.value.trim();
		if (!text || streaming) { return; }
		ask.value = '';
		post('send', { text: text });
	}
	$('showctx').addEventListener('click', () => post('showContext'));
	$('toggleins').addEventListener('click', () => post('insights'));
	$('send').addEventListener('click', send);
	$('stop').addEventListener('click', () => post('stop'));
	$('size').addEventListener('click', () => post('size'));
	add.addEventListener('click', () => post('new'));
	ask.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
	});
	// Esc belongs to the workbench, not to this iframe (plans/01 §4): the panel
	// hands it back so one press leaves full-screen or returns focus to the editor.
	window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { post('escape'); } });
	post('ready');
</script>
</body>
</html>`;
}
