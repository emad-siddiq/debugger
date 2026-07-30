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
| `burrow-flow`'s `detectProject()` returning `undefined` | The caller shows a warning naming `backend/go.mod`, so this one already complies |
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
- **Nothing consumes the descriptor yet.** `projectOf()` is exported for the
  extensions that currently hard-code merkle's shape; migrating them is the
  follow-on, and doing it in this work order would have meant changing every rail
  at once to a detection pass that had never run outside tests.
- **Go only**, deliberately. The engine is stack-agnostic; the templates are the
  work.
