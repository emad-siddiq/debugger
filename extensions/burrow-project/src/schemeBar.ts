/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// schemeBar.ts — the PURE half of the scheme bar: what each item says, what it
// runs, and when it is there at all.
//
// Task 03 specified this as a TITLE-BAR toolbar. Patch 0011 then removed the
// title bar entirely, and the core-patch budget is spent, so the surface here is
// a right-hand STATUS-BAR group instead: items take icons, commands, tooltips and
// a colour, cost zero patches, and survive a rail switch. That is the 80% of the
// specified surface that does not need the sixteenth patch slot.
//
// No 'vscode' import, so out/schemeBar.js is a clean CommonJS module.

import { EntryPoint } from './descriptor';
import { ToolchainSummary } from './toolchain';

/** Everything the bar renders from. */
export interface BarState {
	/** The chosen entry point, if there is one. */
	readonly target?: EntryPoint;
	/** How many the project has — 0, 1 and many read differently. */
	readonly targetCount: number;
	readonly race: boolean;
	readonly running: boolean;
	readonly toolchain: ToolchainSummary;
}

export type BarItemId = 'run' | 'debug' | 'stop' | 'target' | 'race' | 'toolchain';

export interface BarItem {
	readonly id: BarItemId;
	/** Codicon markup included, exactly as the status bar renders it. */
	readonly text: string;
	readonly tooltip: string;
	readonly command?: string;
	/** Hidden items are not dimmed — they are absent. */
	readonly visible: boolean;
	/** Set when the item should draw attention: a missing tool, a stopped run. */
	readonly warning?: boolean;
}

export const RUN_COMMAND = 'burrow.run.start';
export const DEBUG_COMMAND = 'burrow.run.debug';
export const STOP_COMMAND = 'burrow.run.stop';
export const PICK_COMMAND = 'burrow.run.pick';
export const RACE_COMMAND = 'burrow.run.toggleRace';
export const DOCTOR_COMMAND = 'burrow.toolchain.doctor';

/** What the target segment says. Zero, one and many are three different sentences. */
export function targetText(state: BarState): string {
	if (state.targetCount === 0) {
		return '$(circle-slash) no program';
	}
	if (!state.target) {
		return '$(target) choose a program';
	}
	return `$(target) ${state.target.label}`;
}

function targetTooltip(state: BarState): string {
	if (state.targetCount === 0) {
		return 'This module has no `package main` at its root or under cmd/, so there is nothing to run. '
			+ 'That is what a library looks like, not a broken project.';
	}
	if (!state.target) {
		return `${state.targetCount} programs to choose from. The choice is remembered in .burrow/project.json.`;
	}
	return `Running ${state.target.label} (${state.target.path ?? state.target.command}). Click to choose another.`;
}

/**
 * The bar, left to right.
 *
 * Run and Debug are HIDDEN rather than disabled when there is nothing to run: a
 * greyed play button on a library invites a click that can only fail, where an
 * absent one and a "no program" segment that explains itself do not. The
 * toolchain segment is the opposite — it is always present, because its whole
 * job is to be there when something is wrong.
 */
export function barItems(state: BarState): BarItem[] {
	const runnable = state.targetCount > 0 && state.toolchain.healthy;
	const race = state.race ? '$(check) race' : 'race';
	return [
		{
			id: 'run', text: '$(play) Run', command: RUN_COMMAND, visible: runnable && !state.running,
			tooltip: state.target
				? `go run ${state.race ? '-race ' : ''}${state.target.path ?? state.target.command}`
				: 'Run this project — you will be asked which program once',
		},
		{
			id: 'debug', text: '$(debug-alt) Debug', command: DEBUG_COMMAND, visible: runnable && !state.running,
			tooltip: 'Start a Delve session on this program, stopping at breakpoints',
		},
		{
			id: 'stop', text: '$(primitive-square) Stop', command: STOP_COMMAND, visible: state.running,
			tooltip: 'Stop the running program',
		},
		{
			id: 'target', text: targetText(state), command: state.targetCount > 0 ? PICK_COMMAND : undefined,
			visible: true, tooltip: targetTooltip(state), warning: state.targetCount === 0,
		},
		{
			id: 'race', text: race, command: RACE_COMMAND, visible: state.targetCount > 0,
			tooltip: state.race
				? 'The race detector is ON: runs and debug sessions build with -race. Slower, and finds data races.'
				: 'The race detector is off. Click to build runs and debug sessions with -race.',
		},
		{
			id: 'toolchain', text: state.toolchain.healthy ? state.toolchain.text : `$(warning) ${state.toolchain.text}`,
			command: DOCTOR_COMMAND, visible: true, warning: !state.toolchain.healthy,
			tooltip: state.toolchain.healthy
				? 'Go, gopls and Delve all answered. Click for versions and paths.'
				: `Click to see what is missing and how to install it. Without ${state.toolchain.missing.join(' and ')}, `
				+ 'parts of Burrow are inert.',
		},
	];
}

/**
 * `go run` argv for an entry point.
 *
 * The entry's PATH, never the module root: a module root is not a program
 * (WO-72, measured on alertmanager, where the go.mod is at the root and the
 * binaries are cmd/alertmanager and cmd/amtool). `go run .` at the root of such
 * a module builds nothing and says so in a way nobody connects to the button
 * they pressed.
 */
export function runArgs(entry: EntryPoint, race: boolean): string[] {
	const target = entry.path ?? '.';
	// A path relative to the module root has to be spelled `./x`, or `go run`
	// reads it as an import path and looks for it in the module cache.
	const spec = target === '.' || target.startsWith('./') || target.startsWith('/') ? target : `./${target}`;
	return ['run', ...(race ? ['-race'] : []), spec];
}

/** The launch configuration for the Debug button — the same `go` type burrow-go-debug owns. */
export function debugConfiguration(entry: EntryPoint, race: boolean, absoluteProgram: string, cwd: string): Record<string, unknown> {
	return {
		name: `Debug ${entry.label}`,
		type: 'go',
		request: 'launch',
		mode: 'debug',
		program: absoluteProgram,
		cwd,
		...(race ? { buildFlags: '-race' } : {}),
	};
}
