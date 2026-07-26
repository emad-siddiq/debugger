# flowscan

Static route→handler→store→SQL→table extractor for chi-shaped Go backends.
Produces `flows.json`, the data feed for the burrow-flow wire-diagram extension.

```
go run . --backend <backend-module-dir> \
         [--digest <oracle digest.md | launcher digest.json>] \
         [--out flows.json] [--filter substr]
```

- **Entry points** come from an interprocedural walk of the router wiring:
  every function calling `NewRouter()`/`NewMux()` is a root; `r.Route`/`r.Group`
  closures, `r.Use` stacks, register-func calls (including mount-base string
  params) and `r.With(...)` chains are followed. Detection is structural — no
  chi import required — so any chi-shaped project works unmodified.
- **The digest** (from the target project's oracle) supplies the authoritative
  route catalog to reconcile against (`coverage.unmatched` / `coverage.extra`)
  and the known-tables set used to filter SQL identifier extraction.
- **Call chains**: handler constructors are unwrapped to their returned
  closure; interface-typed store params resolve to the concrete type of the
  call-site argument (or the unique in-module implementation); helper calls in
  SQL-bearing packages are followed 4 hops deep. SQL is constant-folded
  (consts + concatenation; `Sprintf` formats kept with verbs, flagged partial).
- **Honesty over completeness**: unresolvable hops emit `kind:"unknown"` nodes
  with a reason; partially-folded SQL is flagged `partial`; nothing is silently
  dropped. `status` per flow: `traced` | `partial` | `unknown`.

## Verify

`go test ./...` — golden test over `testdata/fixtureapp` (a stdlib-only mini
app covering both nodewatch data-access styles) plus SQL classifier units.
Regenerate the golden after intentional changes with `go test -update`.

Against the real target:

```
cd <merkle>/test && go run ./cmd/oracle --digest nodewatch > /tmp/digest.md
go run . --backend <merkle>/backend --digest /tmp/digest.md --out /tmp/flows.json
```

Current merkle result: 235 flows — 209 traced, 26 partial (multi-impl billing
provider interface + dynamic SQL), 0 digest routes unmatched.
