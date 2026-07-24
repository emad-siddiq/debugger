# Decision — the shared "lab shell" is a spec, not a shared stylesheet (WO-13 / 04 §6)

**Context.** Several bench-like surfaces want one visual family (docs/plans/04 §6,
02 §5): the isolation canvas (here), the Test Lab (WO-06b, `burrow-go-test`), the
HTTP response viewer (`burrow-http`), and the DB grid in Focus (`burrow-db`). Each
is a **32-px top bar** (name · state chips · actions · ⛶) over a subtly-inset dark
stage, no borders, spacing/surface from theme tokens.

**Choice: duplicate the ~40 lines per surface; do NOT extract a shared stylesheet.**

**Why.** The four surfaces live in **four independent extensions/tools** that this
repo deliberately keeps decoupled (outer `CLAUDE.md`: "dependency-light … match the
local idiom"; extensions iframe their tools by public origin and own their own
webview chrome). A shared stylesheet under `tools/frontend-debugger/server/` would
make `burrow-go-test` / `burrow-http` / `burrow-db` import CSS across a tool
boundary they otherwise never cross — a new coupling and a new build/staging edge
(the packaged `.app` staging list, `task-15-4`, would have to ship one tool's asset
into three others). The isolation top-bar CSS is ~40 lines and already inlined in
[`server/isolateHarness.js`](../server/isolateHarness.js) (`#iso-top`, `.tbtn`,
`.tlabel`, `.sep`); duplicating that little into each surface is cheaper than the
coupling.

**How the four stay consistent without sharing code.** The visual contract is
written down (values, not a stylesheet) so each surface copies the same numbers:

| Token | Value |
|---|---|
| top-bar height | `32px`, `padding: 4px 8px`, `gap: 6px` |
| bar background / text | `#15181e` / `#c9d1d9`; bottom border `1px solid #2b3138` |
| name | `font-weight:700; font-size:12px; color:#e6edf3` |
| chip (`.tbtn`) | `border:1px solid #2b3138; background:#1c2128; radius:4px; padding:1px 7px`; hover `#262c34`; on `#2f81f7` |
| label (`.tlabel`) | `10px uppercase; letter-spacing:.05em; color:#8b949e` |
| stage canvas | dark `#101418`; 20-px gutters; inset stage; no borders |

When Burrow's theme-token layer (task 12 / `02 §5`) lands, these hex values become
`var(--*)` references and the "duplication" collapses to the same token names in
each surface — still no shared stylesheet, still decoupled. Revisit only if a fifth
bench surface appears **and** the token layer hasn't shipped.
