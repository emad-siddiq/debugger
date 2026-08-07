/*---------------------------------------------------------------------------------------------
 *  Burrow: per-chat-tab control state, and the bridge that renders it as chat-input chips.
 *
 *  State lives here, not in core: the extension owns every Claude semantic, and the core
 *  patch is a generic chip host. The bridge is two commands —
 *    burrow.chat.controls.publish   (core ← extension) the whole chip map, on every change
 *    burrow.chat.controls.pick      (core → extension) the user clicked an item
 *  — so a chip label can be rendered synchronously by core without an ext-host round trip.
 *
 *  Keying follows the session-id map in participant.ts: sessionResource.toString(), with
 *  the same "adopt the newest mapping" fallback, because the chat view mints a NEW
 *  sessionResource when it restores a conversation after an IDE restart.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	ControlChipGroup, ControlState, DEFAULT_APPEND_SYSTEM_PROMPT, DEFAULT_CONTROLS, EffortLevel,
	PermissionMode, ThinkingLevel, chipGroups, withChipPick,
} from './controls';

const STORAGE_KEY = 'burrow.chat.controls';
const PUBLISH_COMMAND = 'burrow.chat.controls.publish';
const AGENT_CACHE_MS = 10_000;

type Stored = Record<string, Partial<ControlState>>;

export class ControlsStore {

	private overrides: Stored;
	private agents: string[] = [];
	private agentsAt = 0;
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.overrides = context.workspaceState.get<Stored>(STORAGE_KEY, {});
	}

	register(): vscode.Disposable[] {
		return [
			this.changed,
			vscode.commands.registerCommand('burrow.chat.controls.pick', (groupId: string, itemId: string, sessionResource?: string) => {
				this.update(sessionResource, s => withChipPick(s, groupId, itemId));
			}),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('burrow.chat')) { void this.publish(); }
			}),
		];
	}

	/** Settings supply the defaults every new chat tab starts from. */
	defaults(): ControlState {
		const cfg = vscode.workspace.getConfiguration('burrow.chat');
		return {
			effort: cfg.get<EffortLevel>('effort', DEFAULT_CONTROLS.effort),
			thinking: cfg.get<ThinkingLevel>('thinking', DEFAULT_CONTROLS.thinking),
			permissionMode: cfg.get<PermissionMode>('permissionMode', DEFAULT_CONTROLS.permissionMode),
			agent: cfg.get<string>('agent', ''),
			fallbackModel: cfg.get<string>('fallbackModel', ''),
			maxBudgetUsd: cfg.get<number>('maxBudgetUsd', 0),
			sessionName: '',
			forkNext: false,
			systemPrompt: cfg.get<string>('systemPrompt', ''),
			appendSystemPrompt: cfg.get<string>('appendSystemPrompt', DEFAULT_APPEND_SYSTEM_PROMPT),
			debug: cfg.get<string>('debug', ''),
			debugFile: cfg.get<string>('debugFile', ''),
			extraArgs: cfg.get<string>('extraArgs', ''),
		};
	}

	/** Defaults overlaid with this tab's own picks. */
	resolve(sessionKey: string | undefined): ControlState {
		return { ...this.defaults(), ...(sessionKey ? this.overrides[sessionKey] : undefined) };
	}

	update(sessionKey: string | undefined, mutate: (state: ControlState) => ControlState): ControlState {
		const key = sessionKey || 'workspace';
		const next = mutate(this.resolve(key));
		const defaults = this.defaults();
		// Store only what actually differs from the settings, so a settings change still
		// moves tabs the user never touched.
		const diff: Partial<ControlState> = {};
		for (const k of Object.keys(defaults) as (keyof ControlState)[]) {
			if (next[k] !== defaults[k]) { (diff as any)[k] = next[k]; }
		}
		if (Object.keys(diff).length) { this.overrides[key] = diff; }
		else { delete this.overrides[key]; }
		void this.context.workspaceState.update(STORAGE_KEY, this.overrides);
		this.changed.fire();
		void this.publish();
		return next;
	}

	reset(sessionKey: string | undefined): void {
		delete this.overrides[sessionKey || 'workspace'];
		void this.context.workspaceState.update(STORAGE_KEY, this.overrides);
		this.changed.fire();
		void this.publish();
	}

	/** `--fork-session` is one-shot: it rides exactly one turn. */
	consumeForkNext(sessionKey: string | undefined): void {
		const key = sessionKey || 'workspace';
		if (!this.overrides[key]?.forkNext) { return; }
		this.update(key, s => ({ ...s, forkNext: false }));
	}

	/**
	 * Push the whole chip map to core. `default` covers tabs with no overrides yet —
	 * including a brand-new tab whose sessionResource core knows before we do.
	 */
	async publish(): Promise<void> {
		const agents = this.discoverAgents();
		const sessions: Record<string, ControlChipGroup[]> = {};
		for (const key of Object.keys(this.overrides)) {
			sessions[key] = chipGroups(this.resolve(key), agents);
		}
		try {
			await vscode.commands.executeCommand(PUBLISH_COMMAND, {
				default: chipGroups(this.defaults(), agents),
				sessions,
			});
		} catch {
			// The chip host is a core patch; without it the gear quick-pick still works.
		}
	}

	/** Agent definitions available to `--agent`: workspace `.claude/agents` then `~/.claude/agents`. */
	discoverAgents(): string[] {
		const now = Date.now();
		if (now - this.agentsAt < AGENT_CACHE_MS) { return this.agents; }
		const dirs = [
			...(vscode.workspace.workspaceFolders ?? []).map(f => path.join(f.uri.fsPath, '.claude', 'agents')),
			path.join(os.homedir(), '.claude', 'agents'),
		];
		const names = new Set<string>();
		for (const dir of dirs) {
			let entries: string[];
			try { entries = fs.readdirSync(dir); } catch { continue; }
			for (const entry of entries) {
				if (!entry.endsWith('.md')) { continue; }
				names.add(agentNameOf(path.join(dir, entry)));
			}
		}
		this.agents = [...names].sort();
		this.agentsAt = now;
		return this.agents;
	}
}

/** An agent file's frontmatter `name:`, falling back to its basename. */
function agentNameOf(file: string): string {
	try {
		const head = fs.readFileSync(file, 'utf8').slice(0, 2000);
		const match = /^---\r?\n(?:[\s\S]*?\r?\n)??name:\s*([^\r\n]+)/.exec(head);
		if (match) { return match[1].trim().replace(/^["']|["']$/g, ''); }
	} catch {
		// unreadable file ⇒ basename is still a usable agent id
	}
	return path.basename(file, '.md');
}
