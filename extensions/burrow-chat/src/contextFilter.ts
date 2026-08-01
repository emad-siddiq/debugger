/*---------------------------------------------------------------------------------------------
 *  Burrow: the attachment choke point.
 *
 *  Every attachment the user did NOT explicitly place — upstream's auto-attach
 *  machinery (instruction files like CLAUDE.md, the customizations index) and
 *  implicit/suggested editor context — must pass here before it is rendered
 *  into the outgoing prompt. Explicit user attachments always survive.
 *  Phase 2's view-context resolver plugs in at this seam.
 *
 *  Pure by design: the participant maps vscode objects to RefFacts so this
 *  module stays testable without a vscode host.
 *--------------------------------------------------------------------------------------------*/

export interface RefFacts {
	/** The reference id — upstream marks its own attachments by id prefix. */
	readonly id: string;
	/** The referenced file's uri path, when the reference targets a file. */
	readonly path?: string;
	/** The uri path of the focused text editor, if any (vscode.window.activeTextEditor). */
	readonly activeEditorPath?: string;
}

/** Upstream's own attachments; anything with another id came from the user. */
export function isAutoDerived(id: string): boolean {
	return id.startsWith('vscode.implicit') || id.startsWith('vscode.instructions.') || id.startsWith('vscode.customizations.');
}

/** Files the Claude CLI already loads from cwd — re-attaching duplicates tokens. */
export function isCliOwnedContext(p: string): boolean {
	return /\/(CLAUDE\.(md|local\.md)|AGENTS\.md)$/.test(p) || p.includes('/.claude/');
}

export function admitAttachment(f: RefFacts): boolean {
	if (!isAutoDerived(f.id)) { return true; }
	// Rule B: focus is not in a text editor — editor-recency-derived implicit
	// context has no basis, so none of it attaches.
	if (f.id.startsWith('vscode.implicit') && !f.activeEditorPath) { return false; }
	// Rule A: the CLI's own context files never ride again as auto-attachments —
	// unless the user is literally editing one right now (then it is the subject).
	if (f.path && isCliOwnedContext(f.path) && f.path !== f.activeEditorPath) { return false; }
	// The customizations index teaches Copilot tool syntax (#tool:execute/…)
	// that does not exist in the Claude CLI backend.
	if (f.id === 'vscode.customizations.index') { return false; }
	return true;
}
