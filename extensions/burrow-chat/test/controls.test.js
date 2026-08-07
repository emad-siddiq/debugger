// Node test for the control surface: argv/env mapping, policy, chips, usage footer.
'use strict';
const {
	DEFAULT_CONTROLS, DEFAULT_APPEND_SYSTEM_PROMPT, buildTurn, splitArgs, policyFor,
	chipGroups, withChipPick, usageOfResult, renderUsage,
} = require('../out/controls.js');

let failed = 0;
const check = (name, ok, extra) => {
	if (ok) { console.log(`  ok  ${name}`); }
	else { failed++; console.error(`FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};
const state = over => ({ ...DEFAULT_CONTROLS, ...over });
const wire = (over, model) => buildTurn(state(over), model);

// 1. defaults: nothing but the Burrow system-prompt append rides
{
	const w = wire({});
	check('defaults produce only --append-system-prompt',
		JSON.stringify(w.args) === JSON.stringify(['--append-system-prompt', DEFAULT_APPEND_SYSTEM_PROMPT]),
		JSON.stringify(w.args));
	check('defaults set no env', Object.keys(w.env).length === 0);
}

// 2. model comes from the picker, not the state, and leads the flags
check('model is passed as --model and comes first',
	wire({}, 'opus').args.slice(0, 2).join(' ') === '--model opus');
check('no model ⇒ no --model (the CLI keeps its own default)',
	!wire({}).args.includes('--model'));

// 3. effort
check('effort default emits nothing', !wire({ effort: 'default' }).args.includes('--effort'));
for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
	const a = wire({ effort: level }).args;
	check(`effort ${level} ⇒ --effort ${level}`, a[a.indexOf('--effort') + 1] === level);
}

// 4. thinking is env-only, never a flag
{
	check('thinking auto sets neither var', Object.keys(wire({ thinking: 'auto' }).env).length === 0);
	const off = wire({ thinking: 'off' }).env;
	check('thinking off ⇒ MAX_THINKING_TOKENS=0 + DISABLE_INTERLEAVED_THINKING=1',
		off.MAX_THINKING_TOKENS === '0' && off.DISABLE_INTERLEAVED_THINKING === '1', JSON.stringify(off));
	check('thinking think ⇒ 4000', wire({ thinking: 'think' }).env.MAX_THINKING_TOKENS === '4000');
	check('thinking megathink ⇒ 10000', wire({ thinking: 'megathink' }).env.MAX_THINKING_TOKENS === '10000');
	check('thinking ultrathink ⇒ 31999', wire({ thinking: 'ultrathink' }).env.MAX_THINKING_TOKENS === '31999');
	check('a thinking budget never leaks into argv', !wire({ thinking: 'ultrathink' }).args.includes('--effort'));
	check('interleaved thinking is only disabled for off',
		wire({ thinking: 'think' }).env.DISABLE_INTERLEAVED_THINKING === undefined);
}

// 5. permission mode → flag and policy
check('approvals passes no --permission-mode', !wire({ permissionMode: 'approvals' }).args.includes('--permission-mode'));
for (const mode of ['manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']) {
	const a = wire({ permissionMode: mode }).args;
	check(`${mode} ⇒ --permission-mode ${mode}`, a[a.indexOf('--permission-mode') + 1] === mode);
}
check('bypassPermissions auto-allows', policyFor('bypassPermissions', undefined) === 'allowAll');
check('dontAsk auto-allows', policyFor('dontAsk', undefined) === 'allowAll');
check('plan still asks (confirmations keep working)', policyFor('plan', undefined) === 'ask');
check('acceptEdits still asks', policyFor('acceptEdits', undefined) === 'ask');
check('approvals + Default follows the chat control (ask)', policyFor('approvals', 'default') === 'ask');
check('approvals + autoApprove ⇒ allowAll', policyFor('approvals', 'autoApprove') === 'allowAll');
check('approvals + autopilot ⇒ allowAll', policyFor('approvals', 'autopilot') === 'allowAll');
check('an explicit mode ignores the chat control', policyFor('plan', 'autopilot') === 'ask');

// 6. the long tail
check('agent ⇒ --agent', wire({ agent: 'reviewer' }).args.join(' ').includes('--agent reviewer'));
check('blank agent is dropped', !wire({ agent: '   ' }).args.includes('--agent'));
check('fallback model ⇒ --fallback-model', wire({ fallbackModel: 'sonnet,haiku' }).args.join(' ').includes('--fallback-model sonnet,haiku'));
check('budget ⇒ --max-budget-usd', wire({ maxBudgetUsd: 2.5 }).args.join(' ').includes('--max-budget-usd 2.5'));
check('zero budget is uncapped', !wire({ maxBudgetUsd: 0 }).args.includes('--max-budget-usd'));
check('name ⇒ --name', wire({ sessionName: 'refactor' }).args.join(' ').includes('--name refactor'));
check('forkNext ⇒ --fork-session', wire({ forkNext: true }).args.includes('--fork-session'));
check('system prompt override ⇒ --system-prompt', wire({ systemPrompt: 'be terse' }).args.join(' ').includes('--system-prompt be terse'));
check('emptied append ⇒ no --append-system-prompt', !wire({ appendSystemPrompt: '' }).args.includes('--append-system-prompt'));
check('debug true ⇒ bare --debug', JSON.stringify(wire({ debug: 'true', appendSystemPrompt: '' }).args) === JSON.stringify(['--debug']));
check('debug filter ⇒ --debug <filter>', wire({ debug: 'api,hooks' }).args.join(' ').includes('--debug api,hooks'));
check('debug off ⇒ no --debug', !wire({ debug: '' }).args.includes('--debug'));
check('debug file ⇒ --debug-file', wire({ debugFile: '/tmp/c.log' }).args.join(' ').includes('--debug-file /tmp/c.log'));

// 7. raw extra args ride last, shell-split
{
	const w = wire({ extraArgs: '--add-dir /a/b --betas "x y"' });
	check('extra args are split and appended last',
		JSON.stringify(w.args.slice(-4)) === JSON.stringify(['--add-dir', '/a/b', '--betas', 'x y']),
		JSON.stringify(w.args));
}
check('splitArgs handles bare words', JSON.stringify(splitArgs('a b  c')) === JSON.stringify(['a', 'b', 'c']));
check('splitArgs keeps quoted spaces', JSON.stringify(splitArgs('--x "a b" \'c d\'')) === JSON.stringify(['--x', 'a b', 'c d']));
check('splitArgs keeps an empty quoted arg', JSON.stringify(splitArgs('--tools ""')) === JSON.stringify(['--tools', '']));
check('splitArgs on blank input is empty', JSON.stringify(splitArgs('   ')) === JSON.stringify([]));
check('splitArgs unescapes \\" inside double quotes', JSON.stringify(splitArgs('"a\\"b"')) === JSON.stringify(['a"b']));

// 8. chips reflect state and round-trip through a pick
{
	const groups = chipGroups(state({ effort: 'high', thinking: 'ultrathink', permissionMode: 'plan' }), ['reviewer']);
	check('four chips, in order', groups.map(g => g.id).join(',') === 'effort,thinking,permissionMode,agent');
	check('chip labels are live', groups[0].label === 'Effort: high' && groups[1].label === 'Thinking: ultra' && groups[2].label === 'Plan mode');
	check('short labels drop the prefix but keep the value',
		groups.map(g => g.shortLabel).join(',') === 'high,ultra,Plan mode,default', groups.map(g => g.shortLabel).join(','));
	check('selected mirrors state', groups[0].selected === 'high' && groups[2].selected === 'plan');
	check('agent chip lists discovered agents plus default',
		groups[3].items.map(i => i.id).join(',') === ',reviewer');

	check('pick updates the right field', withChipPick(DEFAULT_CONTROLS, 'effort', 'max').effort === 'max');
	check('pick leaves other fields alone', withChipPick(DEFAULT_CONTROLS, 'effort', 'max').thinking === 'auto');
	check('unknown value is ignored', withChipPick(DEFAULT_CONTROLS, 'effort', 'turbo').effort === 'default');
	check('unknown group is ignored', withChipPick(DEFAULT_CONTROLS, 'nope', 'x') === DEFAULT_CONTROLS);
	check('agent accepts any name', withChipPick(DEFAULT_CONTROLS, 'agent', 'reviewer').agent === 'reviewer');
}

// 9. usage footer
{
	check('a result with no numbers yields no usage', usageOfResult({ type: 'result' }) === undefined);
	const u = usageOfResult({
		total_cost_usd: 0.0421, duration_ms: 12345,
		usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 20000 },
	});
	check('usage is pulled off the result event',
		u.costUsd === 0.0421 && u.inputTokens === 1200 && u.outputTokens === 340 && u.cacheReadTokens === 20000);
	check('footer renders tokens, cache, cost and time',
		renderUsage(u) === '1.2k in / 340 out · 20.0k cached · $0.04 · 12.3s', renderUsage(u));
	check('sub-cent costs keep four decimals',
		renderUsage(usageOfResult({ total_cost_usd: 0.0009 })) === '$0.0009');
	check('no usage ⇒ empty footer', renderUsage(undefined) === '');
	check('non-numeric fields are dropped', usageOfResult({ total_cost_usd: 'free' }) === undefined);
}

console.log(failed === 0 ? 'all controls cases passed' : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
