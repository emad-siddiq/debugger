/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import { Event, EventEmitter, ThemeColor, ThemeIcon, TreeDataProvider, TreeItem, TreeItemCollapsibleState } from 'vscode';
import { LabRun, LabSuite } from './labModel';

// The Run view's **Tests** section (docs/plans/02 §3.4): Go packages with their
// pass/fail counts, one line each, click to run. It is deliberately an INDEX —
// the result surface is the Test Lab, so this tree never grows a third level of
// output to scroll through.
//
// Before the first run it lists the packages discovery found, with no verdict
// against them; a tree that shows green before anything ran is a lie.

export interface Discovered {
	readonly packagePath: string;
	readonly label: string;
}

type Node = { readonly kind: 'suite'; readonly suite: LabSuite } | { readonly kind: 'package'; readonly pkg: Discovered };

export class TestsProvider implements TreeDataProvider<Node> {

	public static readonly viewId = 'burrowTests';

	private readonly changed = new EventEmitter<Node | undefined>();
	readonly onDidChangeTreeData: Event<Node | undefined> = this.changed.event;
	private run: LabRun | undefined;
	private packages: readonly Discovered[] = [];

	/** Replace the discovered package list (from the controller's discovery). */
	setPackages(packages: readonly Discovered[]): void {
		this.packages = packages;
		this.changed.fire(undefined);
	}

	/** Show the verdicts from a finished run. */
	setRun(run: LabRun): void {
		this.run = run;
		this.changed.fire(undefined);
	}

	getTreeItem(node: Node): TreeItem {
		if (node.kind === 'package') {
			const item = new TreeItem(node.pkg.label, TreeItemCollapsibleState.None);
			item.iconPath = new ThemeIcon('beaker');
			item.description = 'not run';
			item.contextValue = 'burrowTestPackage';
			item.command = { command: 'burrow.test.runAll', title: 'Run the Go tests' };
			return item;
		}
		const { suite } = node;
		const item = new TreeItem(suite.label, TreeItemCollapsibleState.None);
		const failed = suite.failed > 0;
		item.iconPath = new ThemeIcon(
			failed ? 'error' : 'pass',
			new ThemeColor(failed ? 'testing.iconFailed' : 'testing.iconPassed'),
		);
		item.description = `${failed ? `${suite.failed} failed · ` : ''}${suite.passed} passed${suite.skipped ? ` · ${suite.skipped} skipped` : ''} · ${(suite.durationMs / 1000).toFixed(2)}s`;
		item.contextValue = 'burrowTestSuite';
		item.tooltip = 'Open the Test Lab for this run';
		item.command = { command: 'burrow.test.openLab', title: 'Open the Test Lab' };
		return item;
	}

	getChildren(node?: Node): Node[] {
		if (node) {
			return [];
		}
		if (this.run) {
			return this.run.suites.map((suite): Node => ({ kind: 'suite', suite }));
		}
		return this.packages.map((pkg): Node => ({ kind: 'package', pkg }));
	}
}
