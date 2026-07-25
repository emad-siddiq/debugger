# Pass 1 — stack-truth report (WO-18)

Runner: [`pass1.sh`](pass1.sh) · Route sweep: [`pass1-endpoints.md`](pass1-endpoints.md)
Target: `~/Projects/merkle` @ Mode B (Auth0 OFF, real SQL) via `infra/merkle --start`.
Run: 2026-07-25, macOS, Docker 28.0.4, seeded default org `…0001`.

## Result

**6 / 7 steps PASS.** One genuine defect surfaced (step 2) — a stale merkle test
fixture, exactly the class of "stack truth" problem Pass 1 exists to catch before
Pass 2/3 blame the tooling.

| # | Step | Result | Evidence |
|---|---|---|---|
| 1 | `./merkle --start` → `/healthz` + web root 200 within 90 s | **PASS** | `healthz=200 web=200` |
| 2 | seed + backfill apply idempotently | **FAIL** | `backfill.sql` ON CONFLICT has no matching constraint (see below) |
| 3 | `infra/test/smoke.sh` | **PASS** | `15 passed` |
| 4 | endpoint sweep (`e2e.sh`) → `pass1-endpoints.md` | **PASS** | `56 passed, 0 failed` across 56 routes |
| 5 | ingest door: `POST /ingest` then read back via `/api/metrics` | **PASS** | `POST=200, /api/metrics=200, points=6` |
| 6 | `./merkle --restart-api` recovers < 5 s, no orphan listeners | **PASS** | `recovered in 0s, listeners=1` |
| 7 | `./merkle --down && --start` — world intact | **PASS** | `nodes=22 survived restart` |

`pass1.sh` exits non-zero while any step is red, so this run exits `1`.

## The one defect (step 2) — stale `backfill.sql` vs. live `node_metrics` schema

```
psql:…/infra/test/mock/backfill.sql:52: ERROR: there is no unique or exclusion
constraint matching the ON CONFLICT specification
```

Root cause — the live table is a plain heap with **no unique/PK constraint**:

```
Table "public.node_metrics"
 node_id | ts | metric_name | metric_value | hmac_sha256 | org_id (nullable)
Indexes: "idx_node_metrics_lookup" btree (node_id, metric_name, ts DESC)   -- non-unique
FK: node_metrics_org_id_fkey (org_id) → organizations(id)
```

But `backfill.sql` (lines 51 & 65) does
`ON CONFLICT (org_id, node_id, ts, metric_name) DO UPDATE`. Migration `069`
(partition + `PRIMARY KEY (org_id,node_id,ts,metric_name)`) is **not present in
this database**, so the ON CONFLICT target does not exist and the whole script
aborts under `ON_ERROR_STOP` — zero backfill rows are written. The only
`cpu_percent` points present (6) come from the live `seed.sh`/ingest ticks, not
the intended 288-point 24 h grid.

Impact: dashboards will **not** show 24 h of history (Pass 3 Act 1 step 5, and the
"metric history ≥ 24 h" canonical-world assumption in `05 §1`). Backend + all 56
API routes are healthy; this is purely the history-backfill fixture.

Recommended fix (merkle repo — a defect WO, not WO-18's file scope):
- Make `backfill.sql` self-idempotent without depending on an absent constraint:
  `DELETE FROM node_metrics WHERE org_id=… AND node_id IN(…) AND ts >= now()-interval '24 hours'`
  then plain `INSERT` (no `ON CONFLICT`). This also makes the row count genuinely
  **stable** across re-runs (see note below), which the current grid-on-`now()`
  form can never be. **Or** re-apply migration `069` so the PK exists.

This is left as a filed defect per `05 §4` ("each untick filed as a defect WO");
`pass1.sh` correctly reports it rather than papering over it.

## Grounding corrections applied to the script (vs. `05 §2`)

The plan's step spec was written before reading the fixtures; `pass1.sh` matches
what actually exists:

1. **`merkle` lives at `infra/merkle`**, not the merkle repo root. Vite `base` is
   now `/` (the old `/watch/app/` prefix is retired), so `curl :5173/` → 200.
2. **`seed.sh` is not "the 8-node fleet + orgs".** It pushes live heartbeats for
   the two seeded nodes (eth/sol); the seeded world (nodes, orgs, `test-key-eth`)
   comes from the backend's own startup migrations/seed. `seed.sh` **appends**
   rows and is not count-invariant.
3. **"row counts unchanged" is not a valid idempotency assertion.** Both `seed.sh`
   (appends live ticks) and `backfill.sql` (grid anchored to `now()`, so a re-run
   shifts every `ts` → new PK rows) grow the table by design. Step 2 therefore
   asserts *"re-runs cleanly + history present"*, not count invariance.
4. **No `newman`/Postman runner installed.** `infra/test/mock/e2e.sh` **is** the
   endpoint sweep (every route group, chained IDs, documented expected status incl.
   the deliberate 401/403s, exit 0 only if all match) — the plan's step 4 sanctions
   exactly this substitution ("or e2e.sh if that's its job — read it first").
5. The compose db **does** publish `5432:5432` (contra the socat-forward note), so
   host `psql "$DATABASE_URL"` reaches it directly.

## How to run

```bash
bash docs/plans/scripts/pass1.sh              # start, run 7 steps, tear back down
KEEP_UP=1 bash docs/plans/scripts/pass1.sh    # leave api+web up afterward
MERKLE_DIR=~/src/merkle bash …/pass1.sh       # different checkout
```

Env knobs: `API_BASE`, `WEB_BASE`, `DATABASE_URL`, `HEALTH_TIMEOUT`, `KEEP_UP`.
The script starts the stack only if it isn't already up, and tears down only what
it started (the db container is always left running, as `merkle --down` does).
