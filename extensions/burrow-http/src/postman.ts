/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// postman.ts — pure Postman → `.http` conversion (architecture task 09 follow-on).
// Repos like merkle document their API as a Postman collection + environment
// (infra/test/*.postman_*.json); this turns that pair into the workbench's native
// `.http` dialect so every request gets a Send codelens. Pure: no 'vscode' import.
// Postman and `.http` share the `{{var}}` placeholder syntax, so URLs, headers and
// bodies convert verbatim; environment values become file-level `@var =` lines.

interface PostmanHeader {
	readonly key?: string;
	readonly value?: string;
	readonly disabled?: boolean;
}

interface PostmanRequest {
	readonly method?: string;
	readonly url?: string | { readonly raw?: string };
	readonly header?: ReadonlyArray<PostmanHeader>;
	readonly body?: { readonly mode?: string; readonly raw?: string };
}

interface PostmanItem {
	readonly name?: string;
	readonly item?: ReadonlyArray<PostmanItem>;
	readonly request?: PostmanRequest;
}

interface PostmanCollection {
	readonly info?: { readonly name?: string };
	readonly item?: ReadonlyArray<PostmanItem>;
}

interface PostmanEnvironment {
	readonly name?: string;
	readonly values?: ReadonlyArray<{ readonly key?: string; readonly value?: string; readonly enabled?: boolean }>;
}

function urlOf(request: PostmanRequest): string | undefined {
	const url = request.url;
	if (typeof url === 'string') {
		return url.trim() || undefined;
	}
	return url?.raw?.trim() || undefined;
}

function emitRequest(out: string[], item: PostmanItem, folder: string): void {
	const request = item.request;
	const url = request && urlOf(request);
	if (!request || !url) {
		return;
	}
	const label = [folder, item.name].filter(Boolean).join(' — ');
	out.push(`### ${label || url}`);
	out.push(`${(request.method || 'GET').toUpperCase()} ${url}`);
	for (const header of request.header ?? []) {
		if (!header?.key || header.disabled) {
			continue;
		}
		out.push(`${header.key}: ${header.value ?? ''}`);
	}
	const body = request.body?.mode === 'raw' ? request.body.raw?.trim() : undefined;
	if (body) {
		out.push('');
		out.push(body);
	}
	out.push('');
}

function walk(out: string[], items: ReadonlyArray<PostmanItem> | undefined, folder: string): void {
	for (const item of items ?? []) {
		if (item.item) {
			walk(out, item.item, [folder, item.name].filter(Boolean).join(' / '));
		} else {
			emitRequest(out, item, folder);
		}
	}
}

/**
 * Convert a parsed Postman collection (+ optional environment) into `.http` text.
 * Environment values become `@key = value` lines (empty values kept, commented as
 * fill-ins); folders flatten into `### Folder — Request` separators. Throws on
 * input that has no `item` array (not a collection).
 */
export function convertPostmanCollection(collection: PostmanCollection, environment?: PostmanEnvironment): string {
	if (!Array.isArray(collection?.item)) {
		throw new Error('Not a Postman collection (no "item" array).');
	}
	const out: string[] = [];
	const name = collection.info?.name;
	out.push(`# ${name || 'Postman collection'} — converted to .http by Burrow`);
	out.push('# Placeholders use {{var}}; edit the @vars below or re-import to refresh.');
	out.push('');
	const values = (environment?.values ?? []).filter(v => v?.key && v.enabled !== false);
	if (values.length) {
		out.push(`# Environment: ${environment?.name || 'imported'}`);
		// Empty values stay as `@key =` (parses to '') — inline comments after a
		// value would become part of the value, so none are emitted.
		for (const v of values) {
			out.push(`@${v.key} = ${v.value ?? ''}`.trimEnd());
		}
		out.push('');
	}
	walk(out, collection.item, '');
	return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
