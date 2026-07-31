# 18 — The project spine

Burrow could open a folder. It could not make one, and every tool went inert
without a config file that had been hand-written for one repository. This is the
mechanism that writes those files, and the rule that keeps it honest.

Proved on **Go only** (WO-71) — the one stack whose language server, debugger and
inspector already ship. Python, Rust and C/C++ are then template work rather than
engine work, which is the whole reason to prove it in isolation.

## The house rule: write the file, don't own it

> Every scaffold materializes canonical, readable, editable files in the form that
> language's own community would write them. Burrow's state lives in `.burrow/`,
> additive and removable. **Burrow is never the only thing that can build the
> project.**

**The gate, and it is permanent rather than a one-time check:**

```
rm -rf .burrow && <the project's own build and run command>
```

must still work, on every scaffold, forever. It is `P2-14`, a Pass 2 scenario, not
a paragraph anybody has to remember. This is the concrete line between what we are
building and an IDE that hides the toolchain behind a wizard — and it is
*checkable*, which is why it is the gate rather than an aspiration.

**Corollary:** no generated file may reference Burrow, `.burrow/`, or any Burrow
command. If a template needs one, the template is wrong.

That corollary is a unit test
(`extensions/burrow-project/test/goTemplate.test.js`), not a convention. It scans
every generated file for `/burrow/i` and fails naming the line. `.gitignore` is the
single exception, and only to *ignore* `.burrow/` — which is what makes the
directory gitignorable, as the descriptor's contract requires.

## The house rule: nothing declines silently

> Grey-with-a-reason has governed what the UI *shows*. It now governs what Burrow
> **does**: **no Burrow code path may decline to act without saying why.** A
> provider that cannot resolve a configuration says so. A tier that cannot start
> names what it needed. An action that no-ops explains itself.

**What it costs to break it.** WO-71 spent a large fraction of its budget on 130
seconds of nothing, three times over, and concluded F5 was broken. It was not —
`resolveDebugConfiguration` never declined, the adapter never failed, and the
session started every time in about 28 seconds. What produced "nothing" was a
*probe* reading `.debug-toolbar`'s `innerText`, which is empty in this fork because
the toolbar is icon-only. A live session and no session looked identical.

So the rule earns its place, but note carefully what the incident actually
demonstrates: **the absence of a signal is not evidence of absence.** The fix that
generalises is not only "say why you declined" but "make presence legible" — if the
only way to tell a session is running is an element with no text, every observer of
that state is one bad selector away from a wrong diagnosis.

Applied here:

- `burrow-go-debug`'s config provider logs the module root it chose when it differs
  from the workspace root, so a `program` you did not write is traceable.
- `capabilities()` distinguishes **`live` (measured)** from **`unknown` (needs the
  tool run to find out)** from **`inert` (measured absent)** — see below.

Found and **not** fixed here, listed as the rule requires:

| Where | The silent decline |
|---|---|
| `Debug: Start Debugging` with no configuration selected | Upstream's; it did start a session here, so it is not a decline — recorded because it was suspected and cleared |
| `burrow-flow`'s `detectProject()` returning `undefined` | ~~The caller shows a warning naming `backend/go.mod`, so this one already complies~~ **It did not comply.** It said *something*, which is not the same as saying *why*: "open a project with backend/go.mod" is a true statement about merkle and wrong advice everywhere else, and a user with a `go.mod` at the root was told to create a second one. Fixed 2026-07-30 — the message now names each directory that was searched. **A message that is confidently wrong is a worse failure than silence**, because silence at least prompts a question |
| `sidecarTargetUrl()` returning `undefined` on an inactive extension | The browser tier logs "the sidecar reported no URL — skipped"; complies |

## Detection first, declaration second

A folder with a `go.mod` is a Go project without anyone writing anything. **A
repository that has never seen Burrow must work.**

```
                    ┌── detect(tree) ──┐
  the folder ───────┤                  ├──→ merge() ──→ Project
                    └── .burrow/… ─────┘        ▲
                          (optional)            │
                                        the file always wins,
                                        and every field it supplied
                                        is named in `declared`
```

`detect()` reads an injected `Tree`, not the filesystem, which is why it can be
unit-tested against shapes nobody has on disk — the failure being corrected is
that detection had only ever seen one repository. `burrow-flow`'s `detectProject()`
still looks for `backend/go.mod`, `router.go` and `MERKLE_ROOT`; that is the
gravity this replaces.

### What detection infers, with no descriptor at all

| | |
|---|---|
| Go stack | `go.mod` in the root, else in `backend/ server/ api/ cmd/ src/ service/`. Root wins. |
| Module path | the `module` line, when there is one |
| Build / run | `go build ./...` / `go run .` — the project's own commands |
| Postgres | a compose service on a `postgres`/`postgis`/`timescaledb` image, in any of the four compose filenames |
| Connection | the first `KEY=postgres://…` in `.env`, `.env.local` or `.env.development` — under **any** key name |

A folder with nothing recognisable is a project with **no stacks**, not an error.
The rails then go inert *with a reason* — `capabilities()` returns one line each —
because a rail that goes quiet silently is exactly what made Burrow feel like it
only worked on one repository.

### `unknown` has to be able to stop being unknown

Three states, and the third is the one that had nowhere to live:

| state | means | `flow` reaches it when |
|---|---|---|
| `unknown` | **nobody has run the tool** | no `.burrow/flow.json` |
| `live` | ran, and found something | `routes > 0` |
| `inert` | **ran, and there is nothing here** | `routes === 0` |

`flow` used to read `unknown` for every Go stack — correct at detection time,
because only running flowscan answers it, and *still* `unknown` after flowscan had
run and produced a number. The missing state is `inert`-by-measurement, and it is
go-chi/chi's honest answer: the walk completed and found no router it recognised.
Reporting that as `unknown` sends someone to run a tool that has already answered.

**Where it lives: `.burrow/flow.json`, beside the descriptor and not inside it.**
The descriptor states what a project *is* and is meant to be committed; this
records what a tool *did*, on this machine, at a revision. Counts only — no route
paths, no SQL, no handler names; `flows.json` keeps all of that in the extension's
own storage. Deleting `.burrow/` returns the state to "not tried", which is true.

`burrow-project` **reads the file** rather than calling `burrow-flow`, so a
capability report never depends on another extension having activated. The two
copies of the shape are bound by `burrow-flow/test/spine.test.js`, which requires
both compiled modules and fails if they drift — see *Duplicate, but bind the copies*
below.

**No new affordance.** The traffic light's three states already map onto the three
answers — *find out* / *yes* / *no*. A fourth colour would be a fourth thing to
learn for a distinction the reason sentence carries better: "traced `.` and found no
routes" and "no go.mod found" are both `inert` and never say the same thing, which
is asserted.

**A wrong count is worse than a missing one.** flowscan exits **zero** whatever it
found. WO-75 measured two binaries against the same merkle tree and got
**235 routes / 209 traced** from one and **235 / 6 / 229 partial** from the other —
the same shape of answer, off by two hundred, with no signal at the call site.

**The cause is not established, and the first guess was wrong.** WO-75 attributed it
to the Go release the tracer was built with. WO-76 could not reproduce that: a
go1.24 build of the current tracer reports 45 packages it cannot type-check and
still traces 209 of 235. So missing type information is a real signal that the walk
is working with less than the whole program, and it is not on its own enough to
collapse the answer.

That is the argument for `P2-15` rather than a better diagnosis. The load-error
count rides along in the state file and both the notification and the capability say
the counts may be incomplete — but a **floor on the numbers** catches the collapse
whatever produced it, which a defence aimed at one suspected cause cannot.

### Duplicate, but bind the copies

WO-72's precedent — duplicate detection rather than importing it, because an
extension that cannot work until a *sibling has activated* has a new way to fail —
is about **runtime** coupling and holds unchanged. `burrow-flow` carries its own
copy of the search order in `src/spine.ts`.

This case adds one thing WO-72's did not have: the two copies also share a
**serialized format**. Duplication across a format drifts silently, and the symptom
is a capability reporting the wrong state forever. So the copy stays and a
**contract test** binds it — `test/spine.test.js` requires *both* this extension's
`out/spine.js` and `burrow-project`'s `out/descriptor.js` and asserts they agree on
the search order, the file paths, and every field of the state file. A test-only
require has no runtime coupling at all, and turns drift into a red test.

Both red cases were demonstrated, per standing rule 5: reordering `GO_SEARCH_ORDER`
in one copy fails the order assertion; dropping `loadErrors` from the reader fails
the field assertion.

### The descriptor

`.burrow/project.json`, version 1. JSON, because it needs no new parser and a
person can edit it. Every field optional: it is an **override sheet, not a
manifest**.

```json
{
  "version": 1,
  "name": "myservice",
  "stacks":   [{ "id": "go", "root": ".", "module": "example.com/myservice",
                 "build": "go build ./...", "run": "go run ." }],
  "services": [{ "kind": "postgres", "composeFile": "compose.yaml",
                 "composeService": "db", "urlEnv": "DATABASE_URL" }]
}
```

**No secrets.** Detection holds the resolved DSN in memory — the Data rail needs
it — and `serialize()` writes only the env var's *name*. The env file stays the one
place the value lives, so the descriptor is safe to paste into an issue. Asserted:
`serialize records the env var NAME and never the connection string`.

**A broken descriptor is ignored, not fatal.** `parse()` swallows anything;
detection alone is enough to work. A config file that can stop a project opening is
the failure mode this whole design exists to avoid.

### Anything that becomes a file needs a driven case

WO-74 shipped entry-point resolution with 91 green unit tests and stored the
remembered choice as an **absolute path** — `/private/tmp/wo74-alertmanager/cmd/amtool`
— in `.burrow/project.json`, a file meant to be committed and shared. On any other
machine it names nothing. Every unit test passed, and they were right to: they built
a `Project` in memory, called `chooseEntry`, and asserted on ids that were relative
because the fixtures made them relative. Nothing was wrong with the tests. **They
were simply not looking at the place the bug was.**

The general shape, and it is not about paths:

> A unit test observes the value a function returns. A descriptor observes the value
> the **UI wrote down**. Between the two sits everything the user contributed — the
> folder they opened, the item they picked, the absolute `fsPath` VS Code handed the
> extension — and none of it exists in a test that constructs its own inputs.

So: **anything that becomes a file gets at least one driven case.** Not a driven
case per behaviour — one, that opens the real app, performs the real gesture, and
reads the bytes that landed on disk. It is the only test that can see the
contribution the UI makes to state, and by construction it is the only place a bug
of this class can be caught.

The rule earns its keep because the class is common and the symptom is delayed:
absolute paths, `file://` URIs that should have been workspace-relative, a
machine-local temp directory, a timestamp in a committed file, a resolved secret
where a variable name belonged. All of them pass in memory. All of them are wrong
the moment someone else opens the repository — which is a bug report from a
different person, weeks later, about a file you cannot reproduce.

The corollary for review: when a diff adds a field to a serialized file, the
question is not "is it tested" but **"has anyone read the file the app writes"**.

## The scaffold engine

Three modules, split by what they are allowed to touch:

- **`goTemplate.ts`** — pure. `path → content`, plus the handler's
  `breakpointLine`, **computed from the content** rather than hard-coded, because a
  hard-coded line number is a line-anchored reference and the fork's standing
  invariant forbids them.
- **`descriptor.ts`** — pure. Detect, merge, serialize, capabilities.
- **`scaffold.ts`** — the only place that writes. **Never overwrites**: existing
  files are skipped and reported, so "add Postgres to a project that already has
  half of it" is safe. The descriptor is written last and separately, so a failure
  part-way through never leaves a descriptor describing files that are not there.

### The surface: a quick-pick chain

Four questions and a folder picker, which the palette already does well. A welcome
page is a design decision a single work order should not make alone, and the
commands underneath will not change if one arrives later.

`burrow.project.create` · `burrow.project.addPostgres` · `burrow.project.describe`
· `burrow.project.explain`

`explain` is the one to reach for when a rail is quiet: it prints the stack, the
services, and `LIVE`/`inert` per capability with the reason.

## Network

Scaffolding is user-initiated, so the standing invariant permits network here — but
**writing files** and **downloading a Postgres image** are different moments and
the user gets to tell them apart and decline the second.

- Writing the files touches no network at all. The Go template is **stdlib-only on
  purpose**: `go.mod` has no `require` block, so a first `go build ./...` succeeds
  offline. Adding a dependency is the user's first `go get`.
- `docker compose up -d` pulls `postgres:17-alpine` (~80 MB) the first time. The
  modal says so, in those words, before anything is written — and the service
  starts and answers without it.

## Both Postgres paths

At create time via the quick-pick, **and** afterwards via `addPostgres`, because
"add Postgres to this existing project" is the more common gesture. Asserted
identical: `adding Postgres afterwards yields the same files as asking at create
time`. If they ever diverge, one of them is second-class and the test says so.

## Known gaps

- **One Go module per project.** A monorepo with several is a real shape; detection
  stops at the first and does not guess.
- ~~**Nothing consumes the descriptor yet.**~~ `burrow-go-debug` migrated in WO-72,
  `burrow-flow` in this work order. What remains hard-coded to merkle is the
  frontend debugger's `MERKLE_*` env contract and `<root>/nodewatch/frontend`,
  which belong to the browser-surface work.
- ~~**flowscan only recognises `NewRouter()` / `NewMux()` call sites**~~ — fixed in
  WO-76. The seed is now a table in `tools/flowscan/routers.go` carrying a
  **dialect** as well as a name, because chi puts the method in the CALL
  (`r.Get("/x", h)`) and Go 1.22's `ServeMux` puts it in the PATTERN
  (`mux.HandleFunc("GET /x", h)`) — a list of bare names cannot express that.
  `http.DefaultServeMux` is seeded separately, since `http.HandleFunc("/x", h)` in a
  `main` is a complete service with no router value to find.
- **flowscan's coverage can collapse without its exit code changing, and the cause
  is unknown.** Measured once (235/209 vs 235/6 on the same tree); the obvious
  suspect — the Go release the tracer was built with — does not reproduce. `P2-15`
  gates the numbers rather than the suspected cause. Standing lines: 235 routes,
  209 traced.
- **Go only**, deliberately. The engine is stack-agnostic; the templates are the
  work.
