/*---------------------------------------------------------------------------------------------
 *  Burrow: locating the user's Claude Code CLI.
 *
 *  Burrow never touches credentials — spawning the user's own `claude` inherits
 *  their auth (OAuth keychain or API key), CLAUDE.md and MCP config. The price
 *  is that the CLI must exist, and an app launched from Finder has a minimal
 *  PATH, so PATH alone cannot be trusted.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export interface CliResolution {
	readonly path: string | undefined;
	/** Where the winning path came from, or what was tried when undefined. */
	readonly detail: string;
}

export function resolveClaudeCli(): CliResolution {
	const configured = vscode.workspace.getConfiguration('burrow.chat').get<string>('cliPath', '').trim();
	if (configured) {
		return fs.existsSync(configured)
			? { path: configured, detail: 'burrow.chat.cliPath' }
			: { path: undefined, detail: `burrow.chat.cliPath points at "${configured}", which does not exist` };
	}

	const home = os.homedir();
	const candidates = [
		...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, 'claude')),
		path.join(home, '.local', 'bin', 'claude'),
		path.join(home, '.claude', 'local', 'claude'),
		'/opt/homebrew/bin/claude',
		'/usr/local/bin/claude',
	];
	for (const candidate of candidates) {
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return { path: candidate, detail: candidate };
		} catch {
			// keep looking
		}
	}
	return { path: undefined, detail: 'not on PATH, and not in ~/.local/bin, ~/.claude/local, /opt/homebrew/bin or /usr/local/bin' };
}

export function missingCliMessage(detail: string): string {
	return [
		`**Claude Code CLI not found** — ${detail}.`,
		'',
		'Burrow\'s chat is backed by your own Claude Code install, so it uses your existing login and settings.',
		'',
		'Install it with `npm install -g @anthropic-ai/claude-code` (or see the [install guide](https://docs.anthropic.com/en/docs/claude-code/setup)), sign in once by running `claude` in a terminal, then send your message again.',
		'',
		'If it is installed somewhere unusual, set `burrow.chat.cliPath` in Settings.',
	].join('\n');
}
