# 16 — Qualified-symbol navigation (Search Everywhere)

> Part of the [Go IDE overhaul](00-overview.md). Depends on: 03. Effort: ~1.5 wk.

## Goal

Type a Go name — qualified or not — in one palette and land on its definition.
`urduwhisper.collator` jumps straight to where `collator` is declared in package
`urduwhisper`; `urduwhisper` alone jumps to the package itself; a bare `collator`
fuzzy-matches symbols across the workspace. This is IntelliJ's *Search Everywhere*
/ *Go to Symbol* muscle memory, made Go-native — you think in `package.Symbol`,
so you should be able to *navigate* in `package.Symbol`.

## Why

VS Code ships "Go to Symbol in Workspace" (⌘T), but it matches on the **bare
symbol name only** — there is no way to say "the `collator` in `urduwhisper`, not
the three others," and no way to jump to a **package** as a target at all. For a
Go codebase where the same identifier (`New`, `Handler`, `Config`, `collator`)
recurs in dozens of packages, the qualifier is exactly the disambiguator you
already know. IntelliJ/GoLand users reach for this constantly; its absence is one
of the most-missed navigation affordances when moving to VS Code for Go.

This is pure gopls + `go list` on top of the stable extension API — no core
patch, high value, low rebase cost. It belongs to the toolchain layer (03) as a
navigation feature, not the debugger.

## Design

### The one command

`extensions/burrow-go-nav/` (layer 4) contributes **`burrow.nav.goToSymbol`** —
a QuickPick prompt "Go to Symbol…" (default keybinding **⌥⌘O**, alongside VS
Code's ⌘T which stays as-is; ⌥⌘O echoes GoLand's *Go to Symbol*). As you type it
resolves candidates live and, on accept, opens the definition location
(`showTextDocument` at the symbol's range, `revealIfOpened`).

The extension owns **no LSP client** — it drives gopls through the built-in
command bridge (`vscode.executeWorkspaceSymbolProvider`,
`vscode.executeDefinitionProvider`) and shells `go list -json` for the package
index. Insulated from upstream churn, cheap to re-pin with go-base (03).

### Query grammar

The input is split on the last `.` into an optional **package qualifier** and a
**symbol path**:

| Input | Interpreted as |
|-------|----------------|
| `collator` | bare symbol — fuzzy across the workspace (superset of ⌘T) |
| `urduwhisper.collator` | symbol `collator` whose package name **or** import-path suffix is `urduwhisper` |
| `urduwhisper.Collator.Reset` | method/field `Reset` on type `Collator` in `urduwhisper` |
| `urduwhisper` | the **package** `urduwhisper` → its `package` clause |
| `text/collate.Collator` | import-path-qualified (wins when short names collide) |

Matching is case-insensitive with prefix/substring on the qualifier and gopls
fuzzy on the symbol; exact and case-matching hits rank first.

### Resolution pipeline

1. **Parse** the query into `{ pkgQualifier?, symbolPath[] }` (split on the last
   dot; a trailing/lone token with no symbol ⇒ *package target*).
2. **Bare symbol** (no qualifier) → `executeWorkspaceSymbolProvider(symbol)` →
   rank → QuickPick. (This is the existing ⌘T behavior, kept as the fallback.)
3. **`pkg.Symbol`** → `executeWorkspaceSymbolProvider(lastSymbol)` for the
   candidate set, then **filter by package**: for each hit, derive its package
   from `location.uri`'s dir via the package index and keep those whose `Name`
   **or** import-path suffix matches `pkgQualifier`. `A.B.C` narrows further by
   walking `containerName`. Rank exact-package over suffix, exact-symbol over
   fuzzy.
4. **`pkg` alone** → the **package index** resolves `pkg` → its `Dir`; open the
   `package X` clause of `doc.go` if present, else the first non-`_test.go`
   `GoFile`. This is the "jump to where the package is defined" case VS Code
   can't do.
5. **One hit ⇒ jump.** **Many ⇒ QuickPick** with `pkg.Symbol` label, kind icon,
   and `import/path · file:line` detail. Zero ⇒ a "no match" item that offers to
   re-run as a bare fuzzy search.

### Package index

`go list -json ./... all` builds `{ importPath → { name, dir, goFiles } }`
(workspace + deps + stdlib), cached in memory and invalidated on `go.mod` /
`go.work` change (reuse task 03's module watch). Stdlib/dep packages resolve
on-demand via `go list -json <importPath>` when not preloaded. gopls gives
symbols; `go list` gives the package↔location mapping gopls doesn't expose
directly.

### Relationship to existing navigation

Additive, never a replacement: ⌘T (bare workspace symbols), ⌘P (files), F12
(definition under cursor) all stay. `burrow.nav.goToSymbol` layers **qualified
parsing + package targets + a single Search-Everywhere entry** on top. A later
increment can widen the same palette to files, recent locations, and the
structure view (the full *Search Everywhere*), but the qualified-symbol jump is
the shippable core of this task.

## Tasks

1. **Query parser + package index.** Grammar (`pkg`, `pkg.Sym`, `pkg.T.M`,
   `path/pkg.Sym`), `go list -json` index with module-watch invalidation.
2. **Resolver.** gopls `workspace/symbol` + definition bridge, package-filter and
   ranking, package-clause resolution for lone-package targets.
3. **QuickPick UI + command.** Live results, kind icons, `import/path · file:line`
   detail, single-hit fast path, `burrow.nav.goToSymbol` + ⌥⌘O keybinding + `Go:`
   palette entry.
4. **Correctness pass.** Name collisions across packages, vendored/`internal`
   packages, methods vs functions, generics receivers, stdlib targets; degrade
   gracefully when gopls is still indexing (spinner, not error).

## Acceptance criteria

- In `merkle/nodewatch/backend`, `<pkg>.<Symbol>` for a symbol that exists in
  several packages opens the **one** in `<pkg>`, no other; a lone `<pkg>` opens
  that package's declaration; a bare `<Symbol>` still fuzzy-lists all.
- Method form (`pkg.Type.Method`) lands on the method, not the type.
- Resolution is interactive (< ~150 ms perceived on a warm gopls) and never
  blocks the UI while the package index warms.
- No regression to ⌘T / ⌘P / F12.

## Out of scope

- Widening the palette to files/actions/recent (the full Search-Everywhere) —
  natural follow-on once the symbol core ships.
- Editing/refactoring from the palette (rename, move) — task for gopls code
  actions, not navigation.
- Non-Go symbol sources (this is Go-first, like everything else).
