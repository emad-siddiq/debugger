/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Several conversations at once, shown as the vertical rail on the panel's
// right edge (docs/plans/03 §8). Each session is its own CLI conversation: its
// own transcript, its own resume token, its own child process. This file owns
// the *state* — creation, switching, closing, the cap — and nothing else, so it
// stays testable without a workbench (test/sessions.test.js). Child processes
// hang off it by id in panel.ts.
//
// Persistence is `workspaceState`: reopen the window and the tabs come back,
// each resuming lazily on its next message rather than eagerly spawning eight
// CLIs at startup.

/** One exchange in a transcript. Failures are turns too — an error the panel
 *  forgets is an error the developer has to reproduce to read. */
export interface Turn {
	readonly role: 'you' | 'agent' | 'error';
	text: string;
	costUsd?: number;
	tokens?: number;
	durationMs?: number;
	/** Set when the answer carried a unified diff: what Preview and Apply act
	 *  on, and what the memory contract says the change also obliges. */
	proposal?: { readonly id: string; readonly files: readonly string[]; readonly refusals: readonly string[] };
	reminders?: readonly string[];
}

export interface Session {
	readonly id: string;
	title: string;
	/** The CLI's session id, once it has announced one; `--resume` uses it. */
	resume?: string;
	turns: Turn[];
	/** Context layers the user has taken off THIS conversation's chip row. */
	dropped?: string[];
}

/** The `workspaceState` shape (vscode.Memento, structurally). */
export interface Store {
	get<T>(key: string, fallback: T): T;
	update(key: string, value: unknown): Thenable<void>;
}

const KEY = 'burrow.agent.sessions';
/** Cap from the plan: eight conversations is already more than anyone tracks. */
export const MAX_SESSIONS = 8;
const TITLE_MAX = 48;

interface Persisted {
	readonly sessions: Session[];
	readonly activeId: string;
}

export class SessionStore {

	private sessions: Session[] = [];
	private active = '';
	private counter = 0;

	constructor(private readonly store: Store) {
		const saved = store.get<Persisted | undefined>(KEY, undefined);
		this.sessions = (saved?.sessions ?? []).filter(isSession).slice(0, MAX_SESSIONS);
		this.active = this.sessions.some((s) => s.id === saved?.activeId) ? saved!.activeId : (this.sessions[0]?.id ?? '');
		if (!this.sessions.length) {
			this.create();
		}
	}

	get all(): readonly Session[] {
		return this.sessions;
	}

	get activeId(): string {
		return this.active;
	}

	get current(): Session {
		return this.sessions.find((s) => s.id === this.active) ?? this.sessions[0];
	}

	/** A new conversation, made active. Returns undefined at the cap — the
	 *  caller asks the user which one to close rather than evicting work. */
	create(): Session | undefined {
		if (this.sessions.length >= MAX_SESSIONS) {
			return undefined;
		}
		this.counter++;
		const session: Session = { id: `s${Date.now().toString(36)}${this.counter}`, title: 'New session', turns: [] };
		this.sessions.push(session);
		this.active = session.id;
		void this.persist();
		return session;
	}

	activate(id: string): void {
		if (this.sessions.some((s) => s.id === id)) {
			this.active = id;
			void this.persist();
		}
	}

	/** Close one tab. The last one is never closed — it is emptied instead, so
	 *  the panel always has somewhere to type. */
	close(id: string): void {
		const at = this.sessions.findIndex((s) => s.id === id);
		if (at < 0) {
			return;
		}
		if (this.sessions.length === 1) {
			this.sessions = [];
			this.create();
			return;
		}
		this.sessions.splice(at, 1);
		if (this.active === id) {
			this.active = this.sessions[Math.min(at, this.sessions.length - 1)].id;
		}
		void this.persist();
	}

	/** Append a turn to a session by id (not to "the active one": the user may
	 *  have switched tabs while an answer was still streaming). */
	append(id: string, turn: Turn): Turn | undefined {
		const session = this.sessions.find((s) => s.id === id);
		if (!session) {
			return undefined;
		}
		session.turns.push(turn);
		if (turn.role === 'you' && session.turns.filter((t) => t.role === 'you').length === 1) {
			session.title = titleFrom(turn.text);
		}
		void this.persist();
		return turn;
	}

	/** Add or restore a context layer for this conversation only. */
	toggleLayer(id: string, layer: string): void {
		const session = this.sessions.find((s) => s.id === id);
		if (!session) {
			return;
		}
		const dropped = new Set(session.dropped ?? []);
		if (dropped.has(layer)) {
			dropped.delete(layer);
		} else {
			dropped.add(layer);
		}
		session.dropped = [...dropped];
		void this.persist();
	}

	setResume(id: string, resume: string): void {
		const session = this.sessions.find((s) => s.id === id);
		if (session && session.resume !== resume) {
			session.resume = resume;
			void this.persist();
		}
	}

	/** Call after mutating a turn in place (streaming appends to the last one). */
	flush(): void {
		void this.persist();
	}

	private persist(): Thenable<void> {
		return this.store.update(KEY, { sessions: this.sessions, activeId: this.active } satisfies Persisted);
	}
}

/** The tab label: the first question, one line, elided. */
export function titleFrom(question: string): string {
	const line = question.replace(/\s+/g, ' ').trim();
	if (!line) {
		return 'New session';
	}
	return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

function isSession(value: unknown): value is Session {
	const s = value as Session | undefined;
	return !!s && typeof s.id === 'string' && typeof s.title === 'string' && Array.isArray(s.turns);
}
