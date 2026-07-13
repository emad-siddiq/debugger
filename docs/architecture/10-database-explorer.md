# 10 — Database explorer (pgAdmin-class, pandas-feel)

> Part of the [Go IDE overhaul](00-overview.md). Depends on: 03. Effort: ~3 wk.

## Goal

First-class Postgres visibility inside the IDE: schema browsing, an ERD, and —
the centerpiece — a **data grid that filters like a pandas DataFrame**. Good
enough that pgweb leaves the stack (task 14) and pgAdmin never enters it.

## Design

### Connections

- `extensions/burrow-db/`, driver = `pg` in the extension host (Postgres
  only at launch — that's the stack; the internal interface stays
  dialect-shaped for later).
- Zero-config first connection: parse `DATABASE_URL` from the active scheme's
  env (`launch.json`) — the NodeWatch contract means the right database is
  known the moment a scheme exists. Manual connections saved per workspace,
  passwords in the OS keychain.
- **Read-only by default.** Sessions open `default_transaction_read_only=on`;
  an explicit, visually-loud toggle (amber bar) enables writes. Row edits and
  DDL are deliberate acts, never a mis-click.

### Schema surface

- Tree: connection → databases → schemas → tables/views/matviews →
  columns (type, null, default), indexes, constraints, FKs, triggers.
  TimescaleDB-aware: hypertables badged, chunk/compression stats on the
  table page (the stack's db *is* Timescale).
- **Table page** (webview tab): columns grid, DDL (generated, copyable),
  indexes with sizes, FK in/out lists (each a jump-link), row-count estimate,
  size on disk.
- **ERD**: FK-graph diagram per schema — tables as nodes (PK/FK columns
  shown), crow's-foot edges, drag-to-arrange (layout persisted per workspace),
  focus mode (selected table + neighbors), export SVG/PNG. Layered auto-layout;
  no physics toys.

### The data grid (the pandas part)

- Virtualized, server-side everything: window fetches (keyset-paginated —
  LIMIT/OFFSET dies on big Timescale tables), so a 100M-row hypertable
  scrolls like a small one.
- **Filter chips per column, type-aware** — composing to a WHERE clause shown
  live (and copyable) at the bottom:
  - text: contains / = / regex / in-list;  numeric: = ≠ > ≥ < ≤ between;
  - timestamp: relative presets (`last 15m/1h/24h`) + absolute range picker —
    built for Timescale metric tables;
  - enum-ish (low-cardinality detected): checkbox set;  nullness: is/is not null.
- Sort (multi-column, shift-click), column hide/reorder/pin, cell popover
  for wide values (JSON cells get the task 06-style JSON tree), row detail
  pane, distinct-values + min/max/avg summary per column on demand
  (`pandas.describe()` energy).
- Export: visible window or full filtered set → CSV/JSON/`INSERT` statements.
- Edit mode (only when writes enabled): cell edits staged → reviewed as the
  literal UPDATEs → applied in one transaction.

### SQL editor

- SQL tabs with schema-aware autocomplete (tables/columns from the live
  catalog), run-selection (⌘⏎), results in the same grid (filter chips work on
  result sets client-side), query history per connection, **EXPLAIN
  (ANALYZE, BUFFERS) visualizer** — plan tree with per-node cost/rows/time
  bars, hot path highlighted.
- Kill-safe: long queries show elapsed time + cancel (server-side
  `pg_cancel_backend` via a second connection).

## Tasks

1. **Connection layer.** `pg` pooling, keychain secrets, `DATABASE_URL`
   auto-discovery from schemes, read-only session default + write toggle,
   cancel channel.
2. **Catalog + tree.** Introspection queries (pg_catalog + timescaledb
   catalog), tree view, table page with DDL/indexes/FK links.
3. **Data grid core.** Virtualized grid, keyset pagination, sort, column ops,
   cell/row detail panes.
4. **Filter chips.** Type-aware chip UI → parameterized WHERE composition,
   live SQL readout, distinct/summary popovers.
5. **SQL editor.** Autocomplete from catalog, run/cancel, history, results-
   into-grid, EXPLAIN visualizer.
6. **ERD.** FK graph, auto-layout + persisted manual layout, focus mode,
   SVG/PNG export.
7. **Write path.** Edit staging → SQL review → transactional apply; guarded
   by the write toggle; audit line in query history.
8. **Timescale + scale pass.** Hypertable badges/stats; correctness + latency
   against a seeded 100M-row metrics hypertable (the NodeWatch shape).

## Acceptance criteria

- Open NodeWatch workspace → connection appears from the scheme's
  `DATABASE_URL` with zero config → browse to a metrics hypertable → filter
  `time: last 1h` + `node_name contains eth` + sort by value ⇒ first window
  < 500 ms on the 100M-row seed, WHERE readout correct.
- ERD of the NodeWatch schema renders with correct FK edges and survives
  reopen with layout intact.
- EXPLAIN ANALYZE of a seq-scan query visibly flags the hot node.
- Impossible to mutate data without having flipped the amber write toggle.

## Out of scope

- Non-Postgres dialects; migration tooling (repo `tasks.json` owns that);
  server administration (roles, vacuum scheduling, replication) — explorer,
  not admin console.
