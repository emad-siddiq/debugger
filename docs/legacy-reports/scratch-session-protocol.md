# The scratch session protocol

> One page. You read it once before you start and never again — during the session you only write
> lines. Companion to `burrow-run-protocol.md`, which governs how work orders are run; this one
> governs how the **from-scratch experience is measured on a person**.
>
> It exists because §2 of WO-78 can count what the surface *fails to say*, and cannot see what you
> had to already know. **Only a human produces the list of things they looked up elsewhere**, and
> that list is the curriculum's real failure mode.

---

## Before you start

Open a plain file beside the scratch window — `SESSION.md` in the scratch folder is fine, it is
ignored by the plan. Write three lines and then forget about them:

```
date · machine · was the network up · how long you intend to sit
toolchains already installed:  go X · node X · docker Y/N · psql Y/N
what you already know about this project:  one sentence, honestly
```

That last line is the control. A protocol run by the person who wrote the reference measures
something different from one run by a stranger, and the report has to say which.

## During — four marks, and nothing else

One line per event. **Tag, step id, then plain words.** No form, no scores, no rating out of five.

| tag | when you write it | why it is the one to catch |
|---|---|---|
| `STOP` | you stopped moving for more than a minute | where the path breaks. Say what you were about to do, not how you felt |
| `RE-READ` | you scrolled back up, or reopened a step you had finished | the surface said it once and it did not land. Re-reads are cheap signal and nobody remembers them afterwards |
| `KNEW` | you moved on only because you already knew something the page did not say | **the invisible one.** Every `KNEW` is a step that would have stopped a stranger, and it leaves no trace anywhere else |
| `OUT` | you left Burrow — a doc, a search, a colleague, a shell, another repo | **the deliverable.** The curriculum's failure mode is not confusion, it is exit |

```
STOP    backend/go.mod        what does tidy do here, there is nothing to tidy yet
KNEW    frontend/tsconfig.json   that a "files": [] tsconfig with references is the solution file
OUT     infra/docker-compose.yml  went to hub.docker.com to see what timescaledb/latest-pg16 is
RE-READ @foundations          came back for the "Run once" commands after the check failed
```

Rules that keep the lines usable:

- **Write the mark before you fix it.** A line written afterwards records the solution and loses
  the question, and the question is the measurement.
- **`OUT` beats every other tag.** If you left Burrow, write `OUT` even when you also stopped, also
  re-read, and already knew half of it.
- **A `KNEW` you are not sure about is still a `KNEW`.** Over-reporting this one costs nothing;
  under-reporting it is the entire blind spot.
- Do not write what the tooling already records. Timestamps, which checks failed, which steps are
  green — the scratch folder has all of that in `.burrow-scratch/progress.json`.

## When you stop for the day

Four lines, and stop:

```
last step reached        (id, and whether its checks were green)
the worst STOP           the one you would fix first
did anything RUN         did you ever see the thing you are building do something
would you open it again  yes / no, and the first reason that comes to mind
```

The third line is the one to be strict about. *Something compiled* is not *something ran*, and a
session that never ran anything is the strongest abandonment signal there is — WO-78 measured
**step 164 of 2,094** before the first `go build` on your own code, and **step 605** before the app
itself compiles.

## What happens to the file

It goes in the work order that acts on it, verbatim and unedited — including the lines that make
the feature look bad, which are the only ones with any information in them. Nothing is aggregated
into a percentage. Four `OUT` lines naming four different Go docs is a finding; "80% satisfaction"
is not.
