/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// The gopls settings surface — architecture task 03, the slice that was specified
// and never built. Until this module existed, burrow-go-base passed gopls exactly
// one option ('ui.semanticTokens': true) and contributed no `configuration` block
// at all, so gopls' analyzers, code lenses and inlay hints were unreachable from
// the workbench: not by decision, but because nothing carried them across.
//
// This module is pure — it imports nothing from 'vscode' — so out/settings.js is a
// clean CommonJS module the standalone tests can require directly, in the same
// shape as gopls.ts. The caller supplies a `get`; everything here is name mapping
// and tri-state handling.
//
// On gopls setting names: this emits the SHORT form ('semanticTokens', not
// 'ui.semanticTokens'). gopls documents the dotted paths as an alias added for
// VS Code's convenience, notes that only the final segment is significant, and
// says "All clients but VS Code should use the short form" — and a from-scratch
// client is not VS Code's. The one pre-existing option keeps working either way.

/** Reads one Burrow setting by its key relative to the `burrow.go` section. */
export type SettingReader = (key: string) => unknown;

/**
 * gopls' inlay-hint families, in the order they appear in gopls' own
 * inlayHints.md. gopls defaults every one of them to OFF, which is why Go files
 * showed no hints at all before this module: the row was empty for want of a
 * setting, not for want of a feature.
 *
 * Burrow turns on the six that report something the source does not already say
 * out loud, and leaves the two noisiest off — see the defaults in package.json.
 */
export const HINT_FAMILIES = [
	'assignVariableTypes',
	'compositeLiteralFields',
	'compositeLiteralTypes',
	'constantValues',
	'functionTypeParameters',
	'ignoredError',
	'parameterNames',
	'rangeVariableTypes',
] as const;

/**
 * Staticcheck's style/naming family (`ST1xxx`, upstream "stylecheck"). These are
 * conventions — package comment present, receiver named consistently, error
 * strings not capitalised — and every one of them fires across a whole codebase
 * that was not written against them, on code that is otherwise correct.
 *
 * They are therefore split out from the rest of staticcheck: `burrow.go.staticcheck`
 * turns the analysers on, `burrow.go.styleChecks` decides whether the style family
 * comes with them. A reader who wants ST1003 can have it; nobody gets it by
 * accident on day one.
 *
 * This list is a snapshot of gopls' ST1xxx analysers and will drift as gopls is
 * re-pinned. `test/settings.test.js` asserts it against a live `gopls api-json`
 * and fails when it does — the drift is caught by a test rather than by a user
 * wondering why a check they disabled came back.
 */
export const STYLE_CHECKS = [
	'ST1000', 'ST1001', 'ST1003', 'ST1005', 'ST1006', 'ST1008', 'ST1011', 'ST1012',
	'ST1013', 'ST1015', 'ST1016', 'ST1017', 'ST1018', 'ST1019', 'ST1020', 'ST1021',
	'ST1022', 'ST1023',
] as const;

/** `burrow.go.staticcheck` — gopls' `staticcheck` is a tri-state, and a boolean cannot carry three values. */
type StaticcheckMode = 'default' | 'all' | 'off';

/** `burrow.go.linksInHover` — gopls' `linksInHover` is `false | true | "gopls"`. */
type LinksInHoverMode = 'off' | 'web' | 'gopls';

/** Narrows an unknown config value to a plain string→boolean map, dropping anything else. */
function boolMap(value: unknown): Record<string, boolean> | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return undefined;
	}
	const out: Record<string, boolean> = {};
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		if (typeof raw === 'boolean') {
			out[key] = raw;
		}
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/** Narrows an unknown config value to a plain string→string map, dropping anything else. */
function stringMap(value: unknown): Record<string, string> | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return undefined;
	}
	const out: Record<string, string> = {};
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		if (typeof raw === 'string') {
			out[key] = raw;
		}
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/** Narrows an unknown config value to a non-empty array of strings. */
function stringList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const out = value.filter((v): v is string => typeof v === 'string');
	return out.length > 0 ? out : undefined;
}

/**
 * Builds the settings object gopls reads — both as `initializationOptions` at
 * startup and as the reply to its `workspace/configuration` pulls afterwards.
 * The two must agree, which is why there is one builder and not two.
 *
 * Every key is omitted rather than sent empty when the reader has nothing to say,
 * so gopls' own defaults keep applying to anything Burrow has no opinion about —
 * a `codelenses: {}` and an absent `codelenses` mean the same thing to gopls, but
 * only the absent one keeps saying so if gopls' defaults change under a re-pin.
 */
export function buildGoplsSettings(get: SettingReader): Record<string, unknown> {
	const settings: Record<string, unknown> = {};

	// ---- UI -----------------------------------------------------------------
	// gopls ships semantic tokens OFF; the workbench and the themes are already
	// opted in, so without this Go falls back to TextMate-only colouring. This is
	// the one option burrow-go-base passed before this module existed, kept here
	// so there is a single place that decides what gopls is told.
	settings['semanticTokens'] = get('semanticTokens') !== false;

	const lenses = boolMap(get('codeLenses'));
	if (lenses) {
		settings['codelenses'] = lenses;
	}

	// ---- Inlay hints --------------------------------------------------------
	// Assembled from eight individual booleans rather than one object setting, so
	// each family is a toggle in the settings UI with its own description. An
	// object would make turning one hint off mean restating the other seven.
	const hints: Record<string, boolean> = {};
	for (const family of HINT_FAMILIES) {
		hints[family] = get(`inlayHints.${family}`) === true;
	}
	settings['hints'] = hints;

	// ---- Diagnostics --------------------------------------------------------
	const staticcheck = get('staticcheck') as StaticcheckMode | undefined;
	if (staticcheck === 'all') {
		settings['staticcheck'] = true;
	} else if (staticcheck === 'off') {
		settings['staticcheck'] = false;
	}
	// 'default' is deliberately absent from the wire: gopls' three values are
	// false, true and *unset*, and unset is the curated subset. Sending `false`
	// for "default" would silently disable the subset a reader still wants.

	// The style family rides on `analyses` rather than on `staticcheck`, because
	// gopls has no way to say "all of staticcheck except the style checks".
	const analyses: Record<string, boolean> = {};
	if (staticcheck === 'all' && get('styleChecks') !== true) {
		for (const check of STYLE_CHECKS) {
			analyses[check] = false;
		}
	}
	// The user's own `analyses` map wins over the style default — someone who asks
	// for ST1003 by name has said something more specific than `styleChecks: false`.
	Object.assign(analyses, boolMap(get('analyses')) ?? {});
	if (Object.keys(analyses).length > 0) {
		settings['analyses'] = analyses;
	}

	const vulncheck = get('vulncheck');
	if (vulncheck === 'Imports' || vulncheck === 'Off') {
		settings['vulncheck'] = vulncheck;
	}

	// ---- Completion ---------------------------------------------------------
	if (get('usePlaceholders') === true) {
		settings['usePlaceholders'] = true;
	}
	if (get('completeFunctionCalls') === false) {
		settings['completeFunctionCalls'] = false;
	}

	// ---- Formatting ---------------------------------------------------------
	if (get('gofumpt') === true) {
		settings['gofumpt'] = true;
	}
	const local = get('local');
	if (typeof local === 'string' && local.length > 0) {
		settings['local'] = local;
	}

	// ---- Documentation ------------------------------------------------------
	const links = get('linksInHover') as LinksInHoverMode | undefined;
	if (links === 'off') {
		settings['linksInHover'] = false;
	} else if (links === 'web') {
		settings['linksInHover'] = true;
	} else if (links === 'gopls') {
		settings['linksInHover'] = 'gopls';
	}

	const hoverKind = get('hoverKind');
	if (typeof hoverKind === 'string' && hoverKind.length > 0) {
		settings['hoverKind'] = hoverKind;
	}

	// ---- Build --------------------------------------------------------------
	const buildFlags = stringList(get('buildFlags'));
	if (buildFlags) {
		settings['buildFlags'] = buildFlags;
	}
	const directoryFilters = stringList(get('directoryFilters'));
	if (directoryFilters) {
		settings['directoryFilters'] = directoryFilters;
	}
	const env = stringMap(get('env'));
	if (env) {
		settings['env'] = env;
	}
	const standaloneTags = stringList(get('standaloneTags'));
	if (standaloneTags) {
		settings['standaloneTags'] = standaloneTags;
	}

	// ---- The escape hatch ---------------------------------------------------
	// gopls has settings Burrow has no opinion about, and gains more with every
	// re-pin. Rather than let any of them be unreachable — the exact failure this
	// module exists to fix — a raw object is merged last and wins over everything
	// above, so a reader is never blocked waiting for Burrow to expose a key.
	const raw = get('gopls');
	if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
		Object.assign(settings, raw);
	}

	return settings;
}
