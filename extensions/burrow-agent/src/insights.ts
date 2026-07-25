/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as vscode from 'vscode';
import { HourlyBudget, insightKey, insightPrompt, Lru } from './insightsModel';

// Auto-insights (docs/plans/03 §5): open a file, get three bullets about it.
//
// The card runs on its OWN CLI conversation, so an insight never lands in the
// middle of a question the developer is asking, and it never runs while a real
// turn is streaming. Every card is cached by file+content+selection, so
// reopening a file you have already looked at costs nothing and appears
// instantly.
//
// It is OFF by default, which departs from the plan on purpose: each card is a
// real turn against the developer's own account, and on a repo the size of
// merkle a turn costs about thirty cents — a background feature must not spend
// that without being asked. The setting says so, and turning it on is one click.

const DEBOUNCE_MS = 800;
const CACHE_SIZE = 200;
const CACHE_KEY = 'burrow.agent.insights';

export interface InsightCard {
	readonly file: string;
	readonly text: string;
	readonly cached: boolean;
	readonly costUsd?: number;
}

export type InsightRunner = (prompt: string) => Promise<{ text: string; costUsd?: number } | undefined>;

export class Insights implements vscode.Disposable {

	private readonly cache: Lru<string>;
	private readonly budget: HourlyBudget;
	private readonly disposables: vscode.Disposable[] = [];
	private timer: NodeJS.Timeout | undefined;
	private generation = 0;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly run: InsightRunner,
		private readonly onCard: (card: InsightCard | undefined, notice?: string) => void,
		private readonly isBusy: () => boolean,
	) {
		this.cache = new Lru<string>(CACHE_SIZE);
		for (const [key, value] of context.workspaceState.get<[string, string][]>(CACHE_KEY, [])) {
			this.cache.set(key, value);
		}
		this.budget = new HourlyBudget(this.config().get<number>('insights.maxPerHour', 60));
		this.disposables.push(
			vscode.window.onDidChangeActiveTextEditor(() => this.schedule()),
			vscode.window.onDidChangeTextEditorSelection((e) => {
				// Only a real selection is worth a card; a moving caret is not.
				if (e.selections[0] && !e.selections[0].isEmpty && e.selections[0].end.line - e.selections[0].start.line >= 2) {
					this.schedule();
				}
			}),
			vscode.workspace.onDidSaveTextDocument(() => this.schedule()),
		);
	}

	dispose(): void {
		clearTimeout(this.timer);
		this.generation++;
		for (const d of this.disposables) {
			d.dispose();
		}
	}

	get enabled(): boolean {
		return this.config().get<boolean>('insights.enabled', false);
	}

	/** The panel's kill switch: flips the setting, which is also where the user
	 *  would look for it later. */
	async toggle(): Promise<boolean> {
		const next = !this.enabled;
		await this.config().update('insights.enabled', next, vscode.ConfigurationTarget.Global);
		if (next) {
			this.schedule(0);
		} else {
			clearTimeout(this.timer);
			this.generation++;
			this.onCard(undefined);
		}
		return next;
	}

	/** Ask for a card now — the panel's refresh, and the first card after the
	 *  feature is switched on. */
	schedule(delay = DEBOUNCE_MS): void {
		clearTimeout(this.timer);
		if (!this.enabled) {
			return;
		}
		this.timer = setTimeout(() => void this.fire(), delay);
	}

	private async fire(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor || this.isBusy()) {
			return;
		}
		const languages = this.config().get<string[]>('insights.languages', ['typescriptreact', 'typescript', 'go', 'css']);
		if (!languages.includes(editor.document.languageId)) {
			return;
		}
		const file = editor.document.uri.fsPath;
		const selection = editor.selection.isEmpty ? '' : `${editor.selection.start.line}-${editor.selection.end.line}`;
		const key = insightKey(file, editor.document.getText(), selection);

		const hit = this.cache.get(key);
		if (hit) {
			this.onCard({ file, text: hit, cached: true });
			return;
		}
		const now = Date.now();
		if (!this.budget.take(now)) {
			this.onCard(undefined, `Insights paused — ${this.budget.spent(now)} this hour is the limit.`);
			return;
		}
		const generation = ++this.generation;
		this.onCard({ file, text: '', cached: false });

		const kind = selection ? 'selection' : hasStylesheet(file) ? 'bundle' : 'file';
		const answer = await this.run(insightPrompt(kind));
		if (generation !== this.generation) {
			return; // a newer trigger won; this card is stale before it is shown
		}
		if (!answer?.text) {
			this.onCard(undefined);
			return;
		}
		this.cache.set(key, answer.text);
		void this.context.workspaceState.update(CACHE_KEY, this.cache.entries());
		this.onCard({ file, text: answer.text, cached: false, costUsd: answer.costUsd });
	}

	private config(): vscode.WorkspaceConfiguration {
		return vscode.workspace.getConfiguration('burrow.agent');
	}
}

/** A component with a colocated stylesheet gets the markup↔styles prompt. */
function hasStylesheet(file: string): boolean {
	if (!/\.[jt]sx$/.test(file)) {
		return false;
	}
	try {
		return fs.existsSync(file.replace(/\.[jt]sx$/, '.css'));
	} catch {
		return false;
	}
}
