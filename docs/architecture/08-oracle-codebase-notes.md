# 08 — Codebase Oracle: agent-bootstrapped notes on highlight

> Part of the [Go IDE overhaul](00-overview.md). Depends on: 03. Effort: ~2 wk.

## Goal

The first time a codebase opens in Burrow, an **external agent** does a full
walk of it and writes structured notes — what each package/symbol is for, how
the pieces connect, the traps. Afterwards, **highlighting any code shows the
notes** the agent took about it. Modeled on the merkle repo's memory pattern
(`~/Projects/merkle/.claude/memory` — terse YAML rows, an index, a freshness
discipline). Bootstrap-only agent involvement: **no integrated AI analysis**;
after the walk, the IDE only ever reads files.

## Design

### Storage: in-repo, merkle-memory compatible in spirit

```
<repo>/.oracle/
  MEMORY.md          # human/agent-readable index — what's here, key dictionary
  repo.yaml          # meta, apps/module facts, decisions[], traps[]
  notes.yaml         # THE core artifact: per-symbol notes (schema below)
  packages.yaml      # per-package: purpose, key types, relations
  ORACLE.md          # provenance: agent, date, model, commit walked, coverage stats
```

`notes.yaml` rows are terse inline-flow (merkle-style), **symbol-anchored,
never line-anchored** (stack invariant):

```yaml
# sym: package-relative symbol path · f: file · h: content hash of the symbol's
# source at walk time (staleness) · n: the note · links: related syms
notes:
  - {sym: ingest.HandleIngest,        f: ingest/handler.go,  h: 9f3c21ab, links: [ingest.validateBatch, models.Metric],
     n: "Entry point for POST /api/v1/ingest. Decodes a metric batch, validates
         per-org quota, writes via the batched inserter — backpressure comes from
         the inserter's channel, not HTTP. Auth is org-scoped API key middleware."}
  - {sym: ingest.(*Inserter).loop,    f: ingest/inserter.go, h: 71bd0e44, links: [ingest.HandleIngest],
     n: "Single goroutine draining the insert channel into COPY batches every
         200ms or 5k rows. TRAP: blocking here stalls all ingest HTTP handlers."}
```

- `h` = short hash of the symbol's normalized source text at walk time. Cheap,
  local staleness: hash matches → note is fresh; differs → shown with a
  **stale** badge (still useful, honestly labeled). No AI re-analysis — a
  stale note stays stale until a human or a re-run refreshes it.
- Package-level notes in `packages.yaml` catch "what is this directory"
  questions; symbol notes catch "what does this function really do".

### Bootstrap: agent instructions, external execution

- `extensions/burrow-oracle/` ships **`oracle-instructions.md`** — the complete
  prompt contract for the walk: read order (go.mod → entrypoints → routers →
  packages by dependency order), what to note (purpose, connections,
  invariants, traps — *why*, not what the code already says), the exact YAML
  schemas, hash computation, coverage expectations (every exported symbol +
  any unexported symbol with non-obvious behavior), and MEMORY.md/ORACLE.md
  requirements.
- On opening a repo with no `.oracle/`: one non-modal card — **"Bootstrap the
  Oracle"**. It runs the user's own agent CLI (default `claude -p`, command
  template configurable) in the integrated terminal with the instructions
  file. The IDE supplies the instructions and watches for `.oracle/` to
  appear; it does **not** embed an agent, hold API keys, or parse model
  output. Progress = the agent's own terminal output. Declining hides the
  card for the repo (`.oracle/DECLINED` marker, gitignored-optional).
- Re-runs: palette commands `Oracle: Re-walk package…` / `Re-walk repository`
  (same mechanism, scoped instructions). Suggested when > N% of notes go stale.

### Read path: highlight → notes

- Selection (or cursor) → enclosing symbol chain via DocumentSymbolProvider
  (`ingest.(*Inserter).loop` → `ingest.(*Inserter)` → package) → look up
  notes for the innermost match, falling back outward to the package note.
- Surfaces:
  - **Oracle strip** in the right bar (below Watch when debugging, standalone
    otherwise): note text, links (click → jump to symbol), fresh/stale badge,
    provenance line.
  - Same note appended (dim, `— Oracle`) to the gopls hover, so knowledge
    shows up where your eyes already are. Setting-gated.
- Lookup is an in-memory index of `notes.yaml` (rebuilt on file change);
  YAML is the on-disk truth — hand-editable, git-diffable, reviewable in PRs.

## Tasks

1. **Schemas + parser.** `notes.yaml`/`packages.yaml`/`repo.yaml` schemas,
   validating parser, symbol-path grammar (matching gopls symbol identity),
   normalized-source hasher (Go AST-based: whitespace/comment-insensitive).
2. **Instructions contract.** Write `oracle-instructions.md` (+ the scoped
   re-walk variant); validate by bootstrapping the NodeWatch backend with it
   and reviewing note quality; iterate until the merkle-memory bar is met.
3. **Bootstrap flow.** No-oracle detection, card UI, agent CLI launch template
   (`burrow.oracle.agentCommand`), `.oracle/` watcher, DECLINED marker,
   post-run validation report (schema errors, coverage %, orphan links).
4. **Note index + resolver.** In-memory index; selection → symbol chain →
   note resolution with outward fallback; staleness check via hasher.
5. **Surfaces.** Oracle strip view (notes, links, badges, "open notes.yaml at
   row" action) + hover append; both setting-gated.
6. **Re-walk commands + stale accounting.** Scoped re-run plumbing; status-bar
   stale-percentage indicator with re-walk suggestion threshold.

## Acceptance criteria

- Fresh clone of the NodeWatch backend + one bootstrap run ⇒ highlighting
  `HandleIngest` shows a correct, useful note in < 50 ms, with working links.
- Editing a noted function flips its note to **stale** on save; the note
  remains visible and labeled.
- The IDE makes zero model/API calls at any point; deleting `.oracle/` and
  the agent CLI leaves a fully functional IDE (feature simply dormant).
- `notes.yaml` survives a hand edit + git round-trip (stable formatting).

## Out of scope

- Integrated AI analysis, on-the-fly note generation, auto-refresh of stale
  notes (explicitly deferred by product decision).
- Cross-repo oracle federation; non-Go targets.
