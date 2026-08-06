/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// refactorKinds.ts — which code actions the Refactor list offers, and how they
// group. Pure: LSP code-action kinds are dotted strings, so none of this needs
// `vscode` and out/refactorKinds.js is unit-tested standalone.
//
// The kinds themselves are gopls': refactor.extract{,.toNewFile},
// refactor.inline.{call,variable}, refactor.rewrite.{removeUnusedParam,
// moveParamLeft,moveParamRight,invertIf,splitLines,joinLines,fillStruct,
// fillSwitch,changeQuote,addTags,removeTags,eliminateDotImport},
// source.addTest, and the quick fixes that declare missing methods and
// declarations.

/** A group heading in the Refactor list, and the kind prefix that feeds it. */
export interface KindGroup {
	/** The LSP code-action kind prefix, e.g. `refactor.extract`. */
	readonly prefix: string;
	/** The heading shown against each row. */
	readonly group: string;
}

/**
 * The kinds worth offering, in the order a reader thinks about them.
 *
 * `quickfix` is last and is deliberately included: gopls delivers "declare
 * missing method T.f", "create missing declaration" and "stub missing interface
 * methods" as quick fixes rather than as refactorings, and those are three of the
 * code-generation rows IntelliJ is measured on. Excluding them to keep the
 * taxonomy tidy would leave the tidy list missing what people came for.
 *
 * `source.organizeImports` is excluded on purpose: it already runs on save, and a
 * list of everything is a list nobody reads.
 */
export const OFFERED_KINDS: readonly KindGroup[] = [
	{ prefix: 'refactor.extract', group: 'Extract' },
	{ prefix: 'refactor.inline', group: 'Inline' },
	{ prefix: 'refactor.rewrite', group: 'Rewrite' },
	{ prefix: 'refactor', group: 'Refactor' },
	{ prefix: 'source.addTest', group: 'Generate' },
	{ prefix: 'quickfix', group: 'Fix' },
];

/** The order groups appear in the list. */
export const GROUP_ORDER: readonly string[] = ['Extract', 'Inline', 'Rewrite', 'Refactor', 'Generate', 'Fix'];

/**
 * The group a code-action kind belongs to, or `undefined` when it is not one this
 * surface offers.
 *
 * Longest matching prefix wins, so `refactor.extract.function` groups under
 * Extract rather than under the plain `refactor` bucket that also contains it.
 * Matching is on whole dotted segments — `refactor.extractSomething` is not a
 * member of `refactor.extract`, and a plain `startsWith` would say it was.
 */
export function groupFor(kindValue: string | undefined): string | undefined {
	if (!kindValue) {
		return undefined;
	}
	let best: KindGroup | undefined;
	for (const candidate of OFFERED_KINDS) {
		const isMatch = kindValue === candidate.prefix || kindValue.startsWith(candidate.prefix + '.');
		if (isMatch && (!best || candidate.prefix.length > best.prefix.length)) {
			best = candidate;
		}
	}
	return best?.group;
}
