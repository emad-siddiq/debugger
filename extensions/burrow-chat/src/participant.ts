/*---------------------------------------------------------------------------------------------
 *  Burrow: the default chat participant, backed by Claude Code.
 *
 *  One ClaudeSession per chat session (per-chat-tab granularity); the CLI's
 *  on-disk session store carries context across turns and IDE restarts.
 *
 *  Approvals: a can_use_tool request parks the turn and surfaces as a chat
 *  confirmation. The Accept/Deny click arrives as the next chat request
 *  (acceptedConfirmationData / rejectedConfirmationData) and resumes the same
 *  CLI process. The chat input's Approvals control (permissionLevel) decides
 *  whether we ask at all.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as os from 'os';
import * as vscode from 'vscode';
import { missingCliMessage, resolveClaudeCli } from './claudeCli';
import { ClaudeSession, ParkedPermission, PermissionPolicy, TurnDelegate, TurnOutcome } from './session';
import { collectWorkbenchContext } from './workbenchContext';

const PERMISSION_DATA_KIND = 'burrow.claude.permission';
const SESSION_MAP_STORAGE_KEY = 'burrow.chat.claudeSessionIds';

interface PermissionData {
	kind: typeof PERMISSION_DATA_KIND;
	sessionKey: string;
	controlRequestId: string;
	toolName: string;
}

const COMMAND_PROMPTS: Record<string, string> = {
	explain: 'Explain the attached code clearly: its intent, how it flows, and anything surprising or easy to misread. Ground the explanation in the actual source — read the attached files first.',
	fix: 'Investigate the problem in the attached code (use the diagnostics below if present). Find the root cause, then apply the minimal fix with your editing tools.',
	review: 'Review the attached code the way a careful colleague would: correctness first, then edge cases, then clarity. Read the files before judging. Report findings ranked by severity, each anchored to file and line.',
	tests: 'Write tests for the attached code. Match the project\'s existing test layout, framework and naming; read neighbouring tests first to learn the conventions. Create or extend the test files with your editing tools.',
	doc: 'Write documentation for the attached code: doc comments in the project\'s own style, plus README additions only if the project clearly keeps docs there.',
};

export class BurrowChatParticipant {
	private readonly sessions = new Map<string, ClaudeSession>();
	/** Digest of the workbench block last sent per chat session — with --resume
	 *  the model keeps history, so an unchanged block never rides twice. */
	private readonly sentContext = new Map<string, string>();

	constructor(private readonly context: vscode.ExtensionContext) { }

	register(): vscode.Disposable {
		const participant = vscode.chat.createChatParticipant('burrow.chat', this.handle.bind(this));
		participant.iconPath = new vscode.ThemeIcon('sparkle');
		return participant;
	}

	private async handle(
		request: vscode.ChatRequest,
		_context: vscode.ChatContext,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken,
	): Promise<vscode.ChatResult> {
		const cli = resolveClaudeCli();
		if (!cli.path) {
			stream.markdown(missingCliMessage(cli.detail));
			return { errorDetails: { message: 'Claude Code CLI not found' } };
		}

		const sessionKey = this.sessionKeyOf(request);
		const session = this.sessionFor(sessionKey, _context.history.length > 0);
		token.onCancellationRequested(() => session.cancel());

		// A confirmation click comes back as its own request.
		const decision = this.permissionDecisionOf(request, sessionKey);
		if (decision) {
			if (!session.parked || session.parked.controlRequestId !== decision.data.controlRequestId) {
				stream.markdown('That approval has expired — the Claude Code turn it belonged to is no longer waiting. Send your request again.');
				return {};
			}
			const outcome = await session.answerParked(
				decision.allow,
				'The user denied this tool use in the Burrow chat.',
				this.delegateFor(stream, session),
			);
			return this.settle(outcome, stream, sessionKey, token);
		}

		const prompt = this.composePrompt(request) + this.workbenchBlock(sessionKey);
		const outcome = await session.startTurn(prompt, {
			cliPath: cli.path,
			cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir(),
			model: this.cliModelOf(request),
			...this.permissionsOf(request),
			appendSystemPrompt: 'You are the assistant inside Burrow, a Go-focused IDE. Chat attachments arrive as workspace-relative paths (with 1-based line ranges for selections); read them with your tools before answering.',
		}, this.delegateFor(stream, session));
		return this.settle(outcome, stream, sessionKey, token);
	}

	// --- outcome → chat result ---------------------------------------------------------------

	private settle(
		outcome: TurnOutcome,
		stream: vscode.ChatResponseStream,
		sessionKey: string,
		token: vscode.CancellationToken,
	): vscode.ChatResult {
		switch (outcome.kind) {
			case 'result':
				if (outcome.isError) {
					const friendly = /not logged in/i.test(outcome.text)
						? 'Claude Code is installed but not signed in. Run `claude` once in a terminal and log in, then try again.'
						: outcome.text || `Claude Code ended the turn with "${outcome.subtype}".`;
					stream.warning(friendly);
					return { errorDetails: { message: friendly } };
				}
				return {};

			case 'parked': {
				this.pushConfirmation(stream, outcome.permission, sessionKey);
				return {};
			}

			case 'died':
				if (token.isCancellationRequested) {
					return {};
				}
				stream.warning(outcome.error);
				return { errorDetails: { message: outcome.error } };
		}
	}

	private pushConfirmation(stream: vscode.ChatResponseStream, permission: ParkedPermission, sessionKey: string): void {
		const data: PermissionData = {
			kind: PERMISSION_DATA_KIND,
			sessionKey,
			controlRequestId: permission.controlRequestId,
			toolName: permission.toolName,
		};
		const detail = renderToolInput(permission.toolName, permission.input);
		const message = new vscode.MarkdownString();
		message.appendMarkdown(permission.description ? `${permission.description}\n\n` : '');
		if (detail) {
			message.appendMarkdown(detail);
		}
		stream.confirmation(
			`Allow ${permission.displayName}?`,
			message,
			data,
			['Allow', 'Deny'],
		);
	}

	// --- request decoding ---------------------------------------------------------------------

	private permissionDecisionOf(request: vscode.ChatRequest, sessionKey: string): { allow: boolean; data: PermissionData } | undefined {
		const pick = (list: any[] | undefined): PermissionData | undefined =>
			list?.find(d => d && d.kind === PERMISSION_DATA_KIND && d.sessionKey === sessionKey);
		const accepted = pick(request.acceptedConfirmationData);
		if (accepted) { return { allow: true, data: accepted }; }
		const rejected = pick(request.rejectedConfirmationData);
		if (rejected) { return { allow: false, data: rejected }; }
		return undefined;
	}

	private composePrompt(request: vscode.ChatRequest): string {
		const parts: string[] = [];
		if (request.command === 'init') {
			// The empty state's "Generate Agent Instructions" submits /init; Claude
			// Code's own /init skill is exactly that — CLAUDE.md for this workspace.
			parts.push('/init');
		} else if (request.command && COMMAND_PROMPTS[request.command]) {
			parts.push(COMMAND_PROMPTS[request.command]);
		}
		if (request.prompt.trim()) {
			parts.push(request.prompt.trim());
		}

		const attachments: string[] = [];
		const diagnosticTargets: { uri: vscode.Uri; range?: vscode.Range }[] = [];
		for (const ref of request.references ?? []) {
			// CLAUDE.md and .claude/** are loaded by the CLI itself from cwd —
			// re-attaching them (the implicit-context chip does, whenever one is
			// the active editor) sends the model a file it already has.
			const target = uriOfReference(ref);
			if (target && isCliOwnedContext(target.uri)) { continue; }
			const line = renderReference(ref);
			if (line) { attachments.push(line); }
			if (target) { diagnosticTargets.push(target); }
		}
		if (attachments.length) {
			parts.push('Attachments:\n' + attachments.map(a => `- ${a}`).join('\n'));
		}

		// /fix grounds itself in the live diagnostics of the attached files.
		if (request.command === 'fix' && diagnosticTargets.length) {
			const diags: string[] = [];
			for (const { uri, range } of diagnosticTargets) {
				for (const d of vscode.languages.getDiagnostics(uri)) {
					if (range && !range.intersection(d.range)) { continue; }
					diags.push(`- ${vscode.workspace.asRelativePath(uri)}:${d.range.start.line + 1} [${severityLabel(d.severity)}] ${d.message}`);
				}
			}
			if (diags.length) {
				parts.push('Current diagnostics:\n' + diags.slice(0, 40).join('\n'));
			}
		}

		return parts.join('\n\n') || 'Continue.';
	}

	private cliModelOf(request: vscode.ChatRequest): string | undefined {
		const model = request.model;
		if (!model) { return undefined; }
		switch (model.id) {
			case 'claude-fable': return 'fable';
			case 'claude-opus': return 'opus';
			case 'claude-sonnet': return 'sonnet';
			case 'claude-haiku': return 'haiku';
			default: return undefined; // claude-default: the CLI's own configured model
		}
	}

	private permissionsOf(request: vscode.ChatRequest): { policy: PermissionPolicy; cliPermissionMode?: string } {
		const configured = vscode.workspace.getConfiguration('burrow.chat').get<string>('permissionMode', 'approvals');
		switch (configured) {
			case 'plan': return { policy: 'ask', cliPermissionMode: 'plan' };
			case 'acceptEdits': return { policy: 'ask', cliPermissionMode: 'acceptEdits' };
			case 'bypassPermissions': return { policy: 'allowAll', cliPermissionMode: 'bypassPermissions' };
			default: {
				// Follow the chat input's Approvals control.
				const level = (request as any).permissionLevel as string | undefined;
				const allowAll = level === 'autoApprove' || level === 'autopilot';
				return { policy: allowAll ? 'allowAll' : 'ask' };
			}
		}
	}

	/**
	 * The workbench-state block for this turn, or '' when nothing is live or
	 * nothing changed since the block last rode this session.
	 */
	private workbenchBlock(sessionKey: string): string {
		if (!vscode.workspace.getConfiguration('burrow.chat').get<boolean>('workbenchContext', true)) {
			return '';
		}
		const block = collectWorkbenchContext();
		if (!block) { return ''; }
		const digest = crypto.createHash('sha256').update(block).digest('hex');
		if (this.sentContext.get(sessionKey) === digest) { return ''; }
		this.sentContext.set(sessionKey, digest);
		return '\n\n' + block;
	}

	// --- session registry ---------------------------------------------------------------------

	private sessionKeyOf(request: vscode.ChatRequest): string {
		const resource = (request as any).sessionResource as vscode.Uri | undefined;
		return resource ? resource.toString() : 'workspace';
	}

	private sessionFor(key: string, hasHistory: boolean): ClaudeSession {
		let session = this.sessions.get(key);
		if (!session) {
			session = new ClaudeSession(id => this.persistSessionId(key, id));
			session.sessionId = this.lookupSessionId(key, hasHistory);
			this.sessions.set(key, session);
		}
		return session;
	}

	/**
	 * The chat view mints a NEW sessionResource when it restores a conversation
	 * after an IDE restart, so an exact key match cannot survive one. A key miss
	 * on a request that carries history is exactly that case: adopt the most
	 * recently used mapping and move it to the new key. A fresh tab has no
	 * history and never adopts.
	 */
	private lookupSessionId(key: string, hasHistory: boolean): string | undefined {
		const map = this.persistedSessionIds();
		if (map[key]) { return map[key].id; }
		if (!hasHistory) { return undefined; }
		const newest = Object.entries(map).sort((a, b) => b[1].at - a[1].at)[0];
		if (!newest) { return undefined; }
		delete map[newest[0]];
		map[key] = newest[1];
		void this.context.workspaceState.update(SESSION_MAP_STORAGE_KEY, map);
		return newest[1].id;
	}

	private persistedSessionIds(): Record<string, { id: string; at: number }> {
		const raw = this.context.workspaceState.get<Record<string, { id: string; at: number } | string>>(SESSION_MAP_STORAGE_KEY, {});
		const map: Record<string, { id: string; at: number }> = {};
		for (const [k, v] of Object.entries(raw)) {
			map[k] = typeof v === 'string' ? { id: v, at: 0 } : v;
		}
		return map;
	}

	private persistSessionId(key: string, id: string): void {
		const map = { ...this.persistedSessionIds(), [key]: { id, at: Date.now() } };
		void this.context.workspaceState.update(SESSION_MAP_STORAGE_KEY, map);
	}

	// --- streaming ------------------------------------------------------------------------------

	private delegateFor(stream: vscode.ChatResponseStream, session: ClaudeSession): TurnDelegate {
		return {
			onInit: () => { /* session id is persisted by the registry callback */ },
			onTextDelta: text => stream.markdown(text),
			onThinkingDelta: (text, blockId) => {
				try {
					stream.thinkingProgress({ text, id: `think-${blockId}` });
				} catch {
					// thinking display is decoration; never let it break the turn
				}
			},
			onToolStart: (id, name, input) => {
				const part = new vscode.ChatToolInvocationPart(name, id);
				part.invocationMessage = toolInvocationLabel(name, input);
				part.isComplete = false;
				part.enablePartialUpdate = true;
				stream.push(part);
			},
			onToolEnd: (id, ok, summary) => {
				const meta = session.tool(id);
				const part = new vscode.ChatToolInvocationPart(meta?.name ?? 'tool', id);
				part.invocationMessage = toolInvocationLabel(meta?.name ?? 'tool', meta?.input);
				part.pastTenseMessage = ok
					? toolPastLabel(meta?.name ?? 'tool', meta?.input)
					: `${meta?.name ?? 'tool'} failed`;
				part.isError = !ok;
				part.isComplete = true;
				part.enablePartialUpdate = true;
				part.toolSpecificData = {
					input: stringifyToolInput(meta?.input),
					output: (summary || '(no output)').slice(0, 2000),
				} as any;
				stream.push(part);
			},
		};
	}
}

// --- rendering helpers -------------------------------------------------------------------------

function renderReference(ref: vscode.ChatPromptReference): string | undefined {
	const v: any = ref.value;
	if (v instanceof vscode.Uri) {
		return vscode.workspace.asRelativePath(v);
	}
	if (v instanceof vscode.Location) {
		const start = v.range.start.line + 1;
		const end = v.range.end.line + 1;
		return `${vscode.workspace.asRelativePath(v.uri)} lines ${start}-${end}`;
	}
	if (typeof v === 'string') {
		return v.length > 400 ? v.slice(0, 400) + '…' : v;
	}
	if (v && v.uri instanceof vscode.Uri) {
		return vscode.workspace.asRelativePath(v.uri);
	}
	return undefined;
}

function isCliOwnedContext(uri: vscode.Uri): boolean {
	const p = uri.path;
	return /\/CLAUDE\.(md|local\.md)$/.test(p) || p.includes('/.claude/');
}

function uriOfReference(ref: vscode.ChatPromptReference): { uri: vscode.Uri; range?: vscode.Range } | undefined {
	const v: any = ref.value;
	if (v instanceof vscode.Uri) { return { uri: v }; }
	if (v instanceof vscode.Location) { return { uri: v.uri, range: v.range }; }
	if (v && v.uri instanceof vscode.Uri) { return { uri: v.uri }; }
	return undefined;
}

function severityLabel(s: vscode.DiagnosticSeverity): string {
	switch (s) {
		case vscode.DiagnosticSeverity.Error: return 'error';
		case vscode.DiagnosticSeverity.Warning: return 'warning';
		case vscode.DiagnosticSeverity.Information: return 'info';
		default: return 'hint';
	}
}

function toolInvocationLabel(name: string, input: unknown): string {
	const target = toolTarget(name, input);
	return target ? `${name}: ${target}` : `Running ${name}`;
}

function toolPastLabel(name: string, input: unknown): string {
	const target = toolTarget(name, input);
	return target ? `${name}: ${target}` : `Ran ${name}`;
}

function toolTarget(_name: string, input: unknown): string | undefined {
	if (!input || typeof input !== 'object') { return undefined; }
	const i = input as Record<string, unknown>;
	const candidate = i['file_path'] ?? i['path'] ?? i['command'] ?? i['pattern'] ?? i['url'] ?? i['query'];
	if (typeof candidate !== 'string') { return undefined; }
	return candidate.length > 80 ? candidate.slice(0, 80) + '…' : candidate;
}

function stringifyToolInput(input: unknown): string {
	if (input === undefined) { return ''; }
	try {
		const s = JSON.stringify(input, undefined, 2) ?? '';
		return s.length > 2000 ? s.slice(0, 2000) + '…' : s;
	} catch {
		return String(input);
	}
}

function renderToolInput(toolName: string, input: unknown): string {
	if (!input || typeof input !== 'object') { return ''; }
	const i = input as Record<string, unknown>;
	if (toolName === 'Bash' && typeof i['command'] === 'string') {
		return '```sh\n' + String(i['command']).slice(0, 600) + '\n```';
	}
	const s = stringifyToolInput(input);
	return s ? '```json\n' + s.slice(0, 600) + '\n```' : '';
}
