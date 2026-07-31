/*---------------------------------------------------------------------------------------------
 *  Burrow: Claude models in the Models picker.
 *
 *  The list is static — it is the CLI's alias vocabulary, not a live API
 *  catalogue, so it needs no network and no auth to show. The participant maps
 *  the picked id onto the CLI's --model flag; this provider's own
 *  provideLanguageModelChatResponse serves any other vscode.lm consumer with a
 *  tool-less one-shot CLI run.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import * as os from 'os';
import * as vscode from 'vscode';
import { missingCliMessage, resolveClaudeCli } from './claudeCli';

interface ClaudeModelInfo extends vscode.LanguageModelChatInformation {
	readonly cliAlias: string | undefined;
}

const CAPS: vscode.LanguageModelChatCapabilities = { toolCalling: true, imageInput: true };

const MODELS: ClaudeModelInfo[] = [
	{ id: 'claude-default', name: 'Claude (CLI default)', family: 'claude', version: '1', maxInputTokens: 200000, maxOutputTokens: 64000, capabilities: CAPS, detail: 'Whatever your Claude Code is configured to use', cliAlias: undefined, isDefault: true, isUserSelectable: true } as ClaudeModelInfo,
	{ id: 'claude-fable', name: 'Fable 5', family: 'claude-fable', version: '5', maxInputTokens: 200000, maxOutputTokens: 64000, capabilities: CAPS, cliAlias: 'fable', isUserSelectable: true } as ClaudeModelInfo,
	{ id: 'claude-opus', name: 'Opus 5', family: 'claude-opus', version: '5', maxInputTokens: 200000, maxOutputTokens: 64000, capabilities: CAPS, cliAlias: 'opus', isUserSelectable: true } as ClaudeModelInfo,
	{ id: 'claude-sonnet', name: 'Sonnet 5', family: 'claude-sonnet', version: '5', maxInputTokens: 200000, maxOutputTokens: 64000, capabilities: CAPS, cliAlias: 'sonnet', isUserSelectable: true } as ClaudeModelInfo,
	{ id: 'claude-haiku', name: 'Haiku 4.5', family: 'claude-haiku', version: '4.5', maxInputTokens: 200000, maxOutputTokens: 32000, capabilities: CAPS, cliAlias: 'haiku', isUserSelectable: true } as ClaudeModelInfo,
];

export class ClaudeModelProvider implements vscode.LanguageModelChatProvider<ClaudeModelInfo> {

	provideLanguageModelChatInformation(_options: vscode.PrepareLanguageModelChatModelOptions, _token: vscode.CancellationToken): ClaudeModelInfo[] {
		return MODELS;
	}

	async provideLanguageModelChatResponse(
		model: ClaudeModelInfo,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		_options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const cli = resolveClaudeCli();
		if (!cli.path) {
			throw new Error(missingCliMessage(cli.detail));
		}

		const args = [
			'-p', '--verbose',
			'--output-format', 'stream-json',
			'--include-partial-messages',
			'--no-session-persistence',
			'--tools', '',
		];
		if (model.cliAlias) { args.push('--model', model.cliAlias); }

		const env = { ...process.env };
		delete env['ELECTRON_RUN_AS_NODE'];
		const child = spawn(cli.path, [...args, transcriptOf(messages)], {
			cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir(),
			stdio: ['ignore', 'pipe', 'pipe'],
			env,
		});
		token.onCancellationRequested(() => child.kill());

		let stderrTail = '';
		child.stderr.on('data', d => { stderrTail = (stderrTail + d.toString()).slice(-2000); });

		let buf = '';
		let failed: string | undefined;
		child.stdout.on('data', d => {
			buf += d.toString();
			let nl;
			while ((nl = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (!line.trim()) { continue; }
				let ev: any;
				try { ev = JSON.parse(line); } catch { continue; }
				if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta' && ev.event.delta?.type === 'text_delta' && ev.event.delta.text) {
					progress.report(new vscode.LanguageModelTextPart(ev.event.delta.text));
				} else if (ev.type === 'result' && ev.is_error) {
					failed = String(ev.result ?? 'Claude Code returned an error');
				}
			}
		});

		await new Promise<void>((resolve, reject) => {
			child.on('error', err => reject(new Error(`could not run claude: ${err.message}`)));
			child.on('exit', code => {
				if (failed) { reject(new Error(failed)); }
				else if (code !== 0 && !token.isCancellationRequested) {
					reject(new Error(`claude exited with code ${code}${stderrTail ? ` — ${stderrTail.trim().split('\n').pop()}` : ''}`));
				} else { resolve(); }
			});
		});
	}

	provideTokenCount(_model: ClaudeModelInfo, text: string | vscode.LanguageModelChatRequestMessage, _token: vscode.CancellationToken): Thenable<number> {
		const s = typeof text === 'string' ? text : JSON.stringify(text.content);
		return Promise.resolve(Math.ceil(s.length / 4));
	}
}

function transcriptOf(messages: readonly vscode.LanguageModelChatRequestMessage[]): string {
	const lines: string[] = [];
	for (const m of messages) {
		const text = m.content
			.map(part => part instanceof vscode.LanguageModelTextPart ? part.value : '')
			.filter(Boolean)
			.join('\n');
		if (!text) { continue; }
		lines.push(`${m.role === vscode.LanguageModelChatMessageRole.Assistant ? 'Assistant' : 'User'}: ${text}`);
	}
	lines.push('Assistant:');
	return lines.join('\n\n');
}
