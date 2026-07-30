/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// goTemplate.ts — the files a new Go project is made of (WO-71 §3).
//
// ┌───────────────────────────────────────────────────────────────────────────┐
// │  HOUSE RULE: WRITE THE FILE, DON'T OWN IT.                                │
// │                                                                           │
// │  Everything here is what that language's own community would write, in the │
// │  form they would write it. Burrow's state lives in `.burrow/`, which is    │
// │  additive and removable. `rm -rf .burrow && go build ./...` must work, and │
// │  P2-14 asserts it on every run — not as a courtesy, as the gate.           │
// │                                                                           │
// │  COROLLARY, and it is a unit test: no generated file may mention Burrow,   │
// │  `.burrow/`, or any Burrow command. If a template needs one, the template  │
// │  is wrong. `.gitignore` is the single exception and only to IGNORE the      │
// │  directory, which is what makes `.burrow/` gitignorable as §1 requires.    │
// └───────────────────────────────────────────────────────────────────────────┘
//
// Pure: path → content. No `vscode`, no `fs`. The scaffolder writes what this
// returns, so the whole template is readable in one file by anyone wondering
// what they are about to get.

export interface GoScaffoldOptions {
	/** Directory name, and the Go module's last path segment. */
	readonly name: string;
	/** Module path. `example.com/<name>` is a deliberate non-resolving default:
	 *  it builds offline and nobody accidentally publishes to a real domain. */
	readonly module?: string;
	/** Include compose.yaml + .env for a Postgres. Both paths exist (§3): at
	 *  create time via the quick-pick, or afterwards via `addPostgres`. */
	readonly postgres: boolean;
	/**
	 * Version for the `go` directive — the INSTALLED toolchain's, resolved by the
	 * caller from `go version`.
	 *
	 * It is a parameter and not a constant because the template originally
	 * hard-coded `go 1.25` on a machine with go1.24.1. A directive NEWER than the
	 * installed toolchain turns Go's toolchain mechanism on: the first build wants
	 * to download the named version, so the offline-first-build promise this
	 * template makes (`GOPROXY=off`, no `require` block) is broken by its own
	 * go.mod. A scaffold must write the version the user actually has.
	 *
	 * Honest note on provenance: this was first *suspected* of being why F5 did not
	 * stop, and it was not — `dlv debug` starts fine in a `go 1.25` project on this
	 * machine, because the toolchain was already cached. The fix is right for the
	 * reason above, not for that one.
	 */
	readonly goVersion?: string;
}

/** Port the generated service listens on. Written into `main.go`'s default and
 *  into `.env` — one number, one place to change it. */
export const DEFAULT_PORT = 8080;
/**
 * Used when the installed toolchain could not be read. See `goVersion`.
 *
 * 1.22 and not older: `main.go` registers routes as `"GET /api/hello"`, and
 * method patterns in `http.ServeMux` landed in 1.22. On 1.21 that string is a
 * literal path containing a space, which never matches any request and reports
 * nothing — a scaffold that silently does not route is worse than one that
 * refuses to be written.
 */
export const FALLBACK_GO_VERSION = '1.22';
/** Below this the template's route patterns do not work. */
export const MIN_GO_VERSION = '1.22';
export const DEFAULT_DB_PORT = 5432;

export interface GeneratedFile {
	readonly path: string;
	readonly content: string;
	/** Marks the file the debugger should stop in, so the scaffold can put a
	 *  breakpoint on the right line without the caller guessing. */
	readonly breakpointLine?: number;
}

/**
 * Every file, in the order a person would meet them.
 *
 * `breakpointLine` on `main.go` is 1-based and points at the first executable
 * line of the route handler — the line a person would pick, and the one §3's
 * done-state requires F5 to stop on.
 */
export function goScaffold(options: GoScaffoldOptions): GeneratedFile[] {
	const name = options.name;
	const module = options.module || `example.com/${name}`;
	const goVersion = options.goVersion || FALLBACK_GO_VERSION;

	const files: GeneratedFile[] = [
		{ path: 'go.mod', content: goMod(module, goVersion) },
		mainGo(options.postgres),
		{ path: '.gitignore', content: gitignore(name) },
		{ path: 'README.md', content: readme(name, options.postgres) },
	];
	if (options.postgres) {
		files.push({ path: 'compose.yaml', content: compose(name) });
		files.push({ path: '.env', content: env(name) });
		files.push({ path: '.env.example', content: env(name) });
	}
	return files;
}

/** The compose + env pair on their own, for adding Postgres to a project that
 *  already exists — the more common gesture of the two (§3). */
export function postgresAddition(name: string): GeneratedFile[] {
	return [
		{ path: 'compose.yaml', content: compose(name) },
		{ path: '.env', content: env(name) },
		{ path: '.env.example', content: env(name) },
	];
}

function goMod(module: string, goVersion: string): string {
	// No `require` block: the template is stdlib-only ON PURPOSE, so
	// `go build ./...` succeeds with no network at all. Adding a dependency is
	// the user's first `go get`, and it is their decision to make, not ours to
	// make for them at create time.
	return `module ${module}\n\ngo ${goVersion}\n`;
}

function mainGo(postgres: boolean): GeneratedFile {
	const head = `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
`;
	const body = `)

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", healthz)
	mux.HandleFunc("GET /api/hello", hello)

	addr := ":" + port()
	log.Printf("listening on http://localhost%s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}

// hello is the one real route. Put a breakpoint on the first line of the body
// and call it: curl localhost:${DEFAULT_PORT}/api/hello
func hello(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	if name == "" {
		name = "world"
	}
	respond(w, map[string]string{"hello": name})
}

func healthz(w http.ResponseWriter, r *http.Request) {
	respond(w, map[string]string{"status": "ok"})
}

func respond(w http.ResponseWriter, body any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(body); err != nil {
		log.Printf("encode: %v", err)
	}
}

func port() string {
	if p := os.Getenv("PORT"); p != "" {
		return p
	}
	return "${DEFAULT_PORT}"
}
`;
	const dsnFunc = postgres
		? `
// databaseURL is read but not yet dialled — the service starts and answers with
// or without a database, so a first run never depends on docker being up. Wire
// your driver here when you add one.
func databaseURL() string {
	return os.Getenv("DATABASE_URL")
}
`
		: '';

	const content = head + body + dsnFunc;
	// The line `name := r.URL.Query().Get("name")` — first executable line of the
	// one real handler. Computed, not counted by hand, so editing the template
	// above cannot silently move it.
	const lines = content.split('\n');
	const breakpointLine = lines.findIndex((l) => l.includes('name := r.URL.Query().Get')) + 1;
	return { path: 'main.go', content, breakpointLine };
}

function gitignore(name: string): string {
	// `.burrow/` is listed here and this is the ONE place any generated file may
	// name it. §1 requires `.burrow/` to be gitignorable without breaking the
	// project; a .gitignore that does not mention it would leave every user to
	// discover that themselves.
	return `# Build output
/${name}
/dist/
*.test

# Local environment — .env.example is the committed template
.env
.env.local

# Editor and tool state (safe to delete; the project builds without it)
.burrow/
.DS_Store
`;
}

function compose(name: string): string {
	return `# Local Postgres for ${name}.
#   docker compose up -d          start it
#   docker compose down           stop it
#   docker compose down -v        stop it and delete the data
#
# The host port comes from POSTGRES_PORT in .env. 5432 is the default because it
# is what every tutorial and client assumes — but a developer very often already
# has something on it, and then "up" fails with "port is already allocated".
# Change the one line in .env and DATABASE_URL follows it.
services:
  db:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: ${name}
      POSTGRES_PASSWORD: ${name}
      POSTGRES_DB: ${name}
    ports:
      - "\${POSTGRES_PORT:-${DEFAULT_DB_PORT}}:${DEFAULT_DB_PORT}"
    volumes:
      - db-data:/var/lib/postgresql/data
      # Anything in here runs once, in filename order, on an empty volume.
      - ./db/init:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${name} -d ${name}"]
      interval: 2s
      timeout: 3s
      retries: 30

volumes:
  db-data:
`;
}

function env(name: string): string {
	return `# Local development. Committed as .env.example; copy to .env and edit.

# Host port for the Postgres in compose.yaml. Change BOTH this and the port in
# DATABASE_URL if 5432 is already taken on your machine.
POSTGRES_PORT=${DEFAULT_DB_PORT}
DATABASE_URL=postgres://${name}:${name}@localhost:${DEFAULT_DB_PORT}/${name}?sslmode=disable

PORT=${DEFAULT_PORT}
`;
}

/** A first table, so the Data rail has a schema to show rather than an empty
 *  database. Runs from compose's initdb mount on first `up`. Takes no name: the
 *  table belongs to the project, not to its directory. */
export function seedSql(): GeneratedFile {
	return {
		path: 'db/init/001_init.sql',
		content: `-- Runs once, on an empty volume, in filename order.
create table if not exists greetings (
	id         bigserial primary key,
	name       text        not null,
	created_at timestamptz not null default now()
);

insert into greetings (name) values ('world')
	on conflict do nothing;
`,
	};
}

function readme(name: string, postgres: boolean): string {
	const db = postgres
		? `
## Database

\`\`\`sh
docker compose up -d          # Postgres on localhost:${DEFAULT_DB_PORT}
\`\`\`

\`DATABASE_URL\` is in \`.env\`. \`db/init/\` runs once on an empty volume.
`
		: '';
	return `# ${name}

A small Go HTTP service.

## Run

\`\`\`sh
go run .
curl localhost:${DEFAULT_PORT}/api/hello
curl localhost:${DEFAULT_PORT}/healthz
\`\`\`

## Test

\`\`\`sh
go build ./...
go test ./...
\`\`\`
${db}`;
}
