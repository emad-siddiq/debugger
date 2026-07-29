# Burrow run protocol — integration + optimization run

_Operating contract for the prompt/report loop between the chat-side architect
and the IDE-side agent. Binding for every work order (WO) in this run.
2026-07-13; standing rule 5 added 2026-07-29 (WO-60b)._

> **Where this lives.** Work orders cite it as `.claude/docs/burrow-run-protocol.md`
> — the path the header asked for on day one. It has never been at that path;
> `.claude/docs/` holds `convos/` and `plans/` only. The file is here, in the
> burrow repo, under version control, which is the better home for a document
> that binds commits. Cite it as `burrow/docs/legacy-reports/burrow-run-protocol.md`.

## The run

Three workstreams, replacing the plan's strict 03→04→05 order for this run:

| Track | Goal | Plan lineage |
|---|---|---|
| **RD** | Run & Debug lives in the **right** aux bar by default; auto-reveal on session; ⌥⌘D toggle | task 05, layout slice, pulled forward |
| **IX** | Kill the recursive Variables tree: type-aware one-line summaries, Miller-column inspector + breadcrumb + value pane, paged big collections | task 05 core, plus minimal slices of 03/04 as prerequisite (a live `dlv dap` session to build against) |
| **FD** | The frontend debugger (browser simulator + box model diagrams + CSS window) docked inside Burrow, minimizable/restorable, with click-through from a matched rule or box-model region to the **authored CSS source** in the workspace | new — becomes task 15; architecture doc written once recon decides the design |

Out of scope this run: full task 03 (tool manager, scheme bar), task 06
visualizers beyond the value-pane mount point, task 12 polish, packaging,
the deferred chat excision.

## Loop mechanics

- The architect issues numbered work orders (WO-nn). The agent executes exactly
  one WO per session, then files a report. The user ferries both verbatim.
- One WO = one bounded objective sized to a single session, always ending with
  a bootable app.
- No speculative work on future WOs. A WO that finishes early spends the
  remainder deepening verification, not widening scope.

## Standing rules (inherited fork discipline — non-negotiable)

1. **Four layers, cheapest that works.** Prefer layer 4 (`extensions/burrow-*`).
   Any core-source diff needs a `patches/NNNN-*.md` ledger entry
   (`build/burrow/check-ledger.js` enforces it); budget < 15 patches, < 300
   lines each. The IX inspector view is the plan's pre-approved big exception —
   still ledgered, with honest size.
2. **Commits only when the active WO says so**, with the messages it specifies;
   keep the bisectable `strip:` / `build:` / `feat:` style. Never push.
3. **Every WO ends verified:** `npm run compile` → 0 errors; dev boot from a
   clean shell (Node 24.17.0 on PATH via `~/.local/burrow-node/current/bin`;
   scrub `VSCODE_*` / `ELECTRON_*` vars; short `--user-data-dir` like `/tmp/bw`;
   let `out/` settle after compile; allow ~40 s to the 10-process tree); plus
   the WO's feature-specific check.
4. **Invariants:** persisted code references are symbol-anchored, never
   line-anchored — extended to FD: persist selectors/rule identity, resolve to
   positions live. Zero non-user-initiated network. No marketplace.
   `defaultChatAgent` stays (load-bearing) until the chat-excision task.
   The NodeWatch debug-env contract is preserved verbatim.
5. **One session owns the working tree.** Added WO-60b, 2026-07-29, after a
   second session committed three times mid-WO and swept part of another
   session's `burrow-scratch` change into a commit of its own. Nothing was lost
   that time; nothing guarantees that twice. The rule:

   - **The session running the active WO owns `burrow/`.** It is the only one
     that commits there, and it stages **by explicit path** — never `git add -A`,
     `git add .`, or `git commit -a`, all three of which silently adopt whatever
     a concurrent session has left in the tree.
   - **A second session that finds the tree claimed does not write to it.**
     Read, search, compile, run tests, drive the packaged app — all fine. What it
     must not do is edit tracked files, commit, or `git checkout`/`stash`/`reset`.
     Either wait for the owner's report, or take a branch of its own
     (`git worktree add ../burrow-<wo> -b wo-<nn>`) and work there, which costs
     one command and removes the question entirely.
   - **How to tell it is claimed.** The tree is claimed while any WO is open —
     i.e. from the first edit of a WO until its report is filed. There is no lock
     file; `git log --since=1.hour` and `git status` are the check. If in doubt,
     assume claimed: the cost of asking is a message, the cost of guessing wrong
     is someone else's commit containing your half-finished work.
   - **On finding your own edits inside someone else's commit:** do not rewrite
     their history. Verify your change is intact at HEAD (by symbol, not by
     diff), say so in the report naming their SHA, and carry on. WO-60 §Changed
     is the worked example.

6. **Knowledge lands in files, not just chat:** durable gotchas →
   `.claude/memory/burrow-go-ide-fork.md`; design decisions → the owning
   `burrow/docs/architecture/*.md` (FD gets `15-frontend-debugger.md` in house
   style once its architecture is fixed); upstream surprises → the relevant
   patch's Rebase notes; `burrow/README.md` status boxes updated at milestone WOs.

## Report contract

File at `.claude/reports/WO-nn-report.md` **and** paste back to the user.
Keep it ≤ ~80 lines. Template:

```markdown
# WO-nn report — <objective>
STATUS: DONE | PARTIAL | BLOCKED

## Changed
- <layer · files · patch numbers · commits made (only if authorized)>

## Verified
- compile: <result> · boot: <result> · feature check: <what was demonstrated, how>

## Discoveries
- <upstream surprises, load-bearing code, changed assumptions — anything that should re-plan the run>

## Decisions
- made: <decision — one-line rationale>
- needed: <question, options with costs, and your recommendation>

## Next
- <recommended next WO, prerequisites, open risks>
```

Report style: file paths and symbol names, not prose descriptions; numbers, not
vibes. If the architect would have to guess at anything, the report is defective.

## Escalation — stop and file PARTIAL/BLOCKED when

- a change wants a core patch the WO didn't name;
- boot breaks in a way that isn't a 15-minute fix (the `defaultChatAgent` class
  of surprise);
- the same verification fails twice for the same cause;
- a genuine design fork appears (two defensible architectures, different
  costs) — never pick silently; report both with a recommendation.

## Sequencing (initial — re-planned after every report)

- **WO-0** — baseline commits + three-track recon (read-only beyond the commits).
- **WO-1** — RD: right-hand debug layout patch (quick; verifiable with no debug
  adapter aboard).
- **WO-2** — IX prerequisite: minimal Delve — a live `dlv dap` session against
  a fixture Go module.
- **WO-3+** — IX in slices: DAP data layer → summary renderer → Miller UI →
  value pane → stock-tree retirement. The bulk of the run.
- **FD WOs** slot in once WO-0's recon fixes the architecture. FD is the
  independent switch-to track whenever IX is waiting on an architect decision.

## Definition of done (run level)

- **RD:** a fresh profile boots with Run & Debug in the right aux bar;
  auto-reveals on session start; ⌥⌘D toggles it.
- **IX:** a value 8 levels deep is reached with breadcrumb + ≤ 2 columns, never
  horizontal scrolling; summaries cover slice `len/cap`, map size, pointer
  one-level auto-deref, error-chain unwrap, `time.Time` humanized; a
  50k-element slice stays responsive via paging; the stock recursive tree is
  gone from the debug bar.
- **FD:** the simulator opens and minimizes inside Burrow without losing state;
  clicking a matched rule in the CSS window, or a box-model region's
  contributing property, opens the authored source file at the rule.