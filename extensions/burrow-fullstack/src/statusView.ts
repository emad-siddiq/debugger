/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import * as net from 'net';
import * as vscode from 'vscode';

// The Run view's **Full Stack** section (docs/plans/02 §3.4): three rows that
// say what is actually up — Postgres, the Go backend under dlv, the frontend
// dev server — and one row that starts all three.
//
// State is OBSERVED, never assumed: the database is a TCP probe of the port the
// connection string names, the backend is the live debug session, the frontend
// is the frontend-debugger extension's own report of its sidecar. A row that
// cannot be determined says `unknown` rather than guessing `stopped`, because a
// status row that lies is worse than no status row.

export type TierState = 'stopped' | 'starting' | 'running' | 'paused' | 'unknown';

export interface Tier {
	readonly id: string;
	readonly label: string;
	readonly state: TierState;
	/** The port it is on, when there is one to show. */
	readonly detail?: string;
	/** The one inline action this row offers. */
	readonly action?: { readonly command: string; readonly title: string; readonly icon: string };
}

const DOT: Record<TierState, { icon: string; color?: string }> = {
	running: { icon: 'circle-filled', color: 'testing.iconPassed' },
	paused: { icon: 'debug-pause', color: 'debugIcon.pauseForeground' },
	starting: { icon: 'loading~spin' },
	stopped: { icon: 'circle-outline' },
	unknown: { icon: 'question' },
};

type Node = { readonly kind: 'tier'; readonly tier: Tier } | { readonly kind: 'action' };

export class FullStackProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {

	public static readonly viewId = 'burrowFullStackStatus';

	private readonly changed = new vscode.EventEmitter<Node | undefined>();
	readonly onDidChangeTreeData = this.changed.event;
	private timer: NodeJS.Timeout | undefined;
	private tiers: Tier[] = [];

	constructor(private readonly read: () => Promise<Tier[]>) { }

	dispose(): void {
		clearInterval(this.timer);
		this.changed.dispose();
	}

	/** Poll only while the view is visible — an IDE that shells out forever in
	 *  the background is exactly what the contract's rule 6 is about. */
	watch(view: vscode.TreeView<Node>): vscode.Disposable {
		const tick = () => void this.refresh();
		const start = () => { if (!this.timer) { this.timer = setInterval(tick, 4000); tick(); } };
		const stop = () => { clearInterval(this.timer); this.timer = undefined; };
		if (view.visible) {
			start();
		}
		return view.onDidChangeVisibility((e) => (e.visible ? start() : stop()));
	}

	async refresh(): Promise<void> {
		this.tiers = await this.read();
		this.changed.fire(undefined);
	}

	getTreeItem(node: Node): vscode.TreeItem {
		if (node.kind === 'action') {
			const item = new vscode.TreeItem('Debug Full Stack', vscode.TreeItemCollapsibleState.None);
			item.iconPath = new vscode.ThemeIcon('rocket');
			item.tooltip = 'Bring up the database, debug the Go backend under dlv, and open the frontend live.';
			item.command = { command: 'burrow.fullstack.debug', title: 'Debug Full Stack' };
			return item;
		}
		const { label, state, detail, action } = node.tier;
		const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
		const dot = DOT[state];
		item.iconPath = new vscode.ThemeIcon(dot.icon, dot.color ? new vscode.ThemeColor(dot.color) : undefined);
		item.description = detail ? `${state} · ${detail}` : state;
		item.contextValue = `burrowTier.${node.tier.id}.${state}`;
		if (action) {
			item.command = { command: action.command, title: action.title };
			item.tooltip = action.title;
		}
		return item;
	}

	getChildren(node?: Node): Node[] {
		if (node) {
			return [];
		}
		return [...this.tiers.map((tier): Node => ({ kind: 'tier', tier })), { kind: 'action' }];
	}
}

/** Is anything listening there? One short connect, no protocol handshake — the
 *  question is "is the tier up", not "is it healthy", and a health check that
 *  runs every four seconds would be its own problem. */
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

/** `postgres://user@host:5432/db` → the host and port to probe. Defaults are
 *  Postgres's own, so a DSN without them still resolves. */
export function hostPortOf(connectionString: string | undefined): { host: string; port: number } | undefined {
	if (!connectionString) {
		return undefined;
	}
	try {
		const url = new URL(connectionString);
		return { host: url.hostname || 'localhost', port: Number(url.port) || 5432 };
	} catch {
		return undefined;
	}
}
