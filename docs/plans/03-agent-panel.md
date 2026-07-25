# 03 — The agent: a right-hand panel wired to your Claude Code account

> Workstream 3 of the [master plan](00-master-plan.md). New extension:
> `burrow/extensions/burrow-agent`. Target: **one toggleable right-hand panel** that knows what
> you have open, offers insights, answers questions about a selection, uses merkle's memory
> structure — and never touches your code without you accepting a diff.

---

## Part 1 — Technical summary (for product review)

**What it is.** A single view in Burrow's right dock (`⌘⌥D` — the binding already exists in
`burrow-core`). Open it and it shows: what it can currently see (context chips), an insight card
about the thing you're looking at, a conversation, and a composer. Close it and Burrow is exactly
the IDE it was.

**How it talks to Claude.** It spawns your **local Claude Code CLI** (`~/.local/bin/claude`,
v2.1.216) in streaming-JSON mode, in the workspace folder. That means:
- your **Claude Code subscription/account** is the only credential — no API key is stored,
  requested, or supported, and no other provider is reachable;
- merkle's `CLAUDE.md`, `.claude/skills`, and settings are picked up by the CLI automatically,
  because the CLI runs *inside merkle*;
- sessions resume (`--resume`), so the panel keeps a real conversation across restarts;
- if the CLI is missing, the panel says so in one sentence and everything else in Burrow works.

**What it knows without being told.** A context envelope assembled per turn from Burrow itself:
the open tab groups; the *page bundle* (open `Badge.tsx` with `Badge.css` beside it and the live
isolation preview → the agent sees all three plus the current props and viewport as one unit);
your selection with its enclosing symbol; the active debug session's stopped frame; the current
DB table or last HTTP response; and the matching rows from **merkle's `.claude/memory/*.yaml`**
(`repo`, `api`, `db`, `env`, `design`, `contract`) instead of a blind grep. Chips show every piece
of context and can be removed with a click before you send.

**Three ways to use it** (all advisory):
1. **Insights (automatic).** Open a file or select code → a debounced, cached, ≤3-bullet card:
   what this does, what it touches, what looks risky. Off for a file type in one click.
2. **Ask (explicit).** A question, with the context chips attached.
3. **Propose (guarded).** Ask for a change and it returns a **unified diff** rendered in Burrow's
   native diff editor. Nothing is written until you press Apply. Writing tools are disabled at the
   CLI level by default (`--disallowedTools Edit,Write,…`), so this is enforced, not promised.

**Why this shape.** The brief was "classical" software engineering with AI assistance — a
colleague at your elbow, not an autopilot. So: no inline ghost text, no autocomplete takeover, no
background commits, no agent-only workflows. Everything the panel can do, you can also do by hand,
and the panel always shows its work.

**Cost:** ~2 weeks. Phase 1 (panel + CLI transport + ask) ~4 days; Phase 2 (context engine +
memory) ~4 days; Phase 3 (insights + selection) ~3 days; Phase 4 (diff-apply + polish) ~3 days.

**Privacy note to state plainly in the UI:** the panel sends the context you can see in the chips
to Anthropic through your Claude Code account. Secrets are excluded by path (`.env*`,
`infra/secrets/**`, `**/*.pem`, `**/secret*`) and the envelope is previewable before every send.

---

## Part 2 — Details for the implementing agent

### 1. Extension skeleton

`extensions/burrow-agent/` (layer 4, no ledger entry, follows the `burrow-*` house style):

```
package.json          contributes: viewsContainers.secondary + views + commands + config
src/extension.ts      activation (onStartupFinished), wiring, disposables
src/transport.ts      claude CLI process: spawn, stream-json in/out, resume, cancel
src/context.ts        the context envelope builder (§3)
src/memory.ts         merkle .claude/memory reader + row selection (§4)
src/insights.ts       debounce, hash-cache, budget, cancellation (§5)
src/diff.ts           unified-diff → preview → apply via WorkspaceEdit (§6)
src/panel.ts          webview host (HTML/CSS/TS, no framework — house idiom)
media/                panel.css, panel.js
```

Contribution sketch:

```jsonc
"viewsContainers": { "secondary": [ { "id": "burrow-agent", "title": "Agent", "icon": "media/agent.svg" } ] },
"views": { "burrow-agent": [ { "id": "burrowAgentChat", "name": "Agent", "type": "webview" } ] },
"commands": [
  "burrow.agent.toggle", "burrow.agent.ask", "burrow.agent.explainSelection",
  "burrow.agent.insightsForActiveEditor", "burrow.agent.newSession",
  "burrow.agent.showContext", "burrow.agent.applyProposal", "burrow.agent.stop"
],
"keybindings": [
  { "command": "burrow.agent.toggle", "key": "cmd+alt+d" },                 // reuse the existing binding
  { "command": "burrow.agent.explainSelection", "key": "cmd+alt+i", "when": "editorHasSelection" }
]
```

Settings (all `burrow.agent.*`): `cliPath` (default `claude`, resolved via PATH then
`~/.local/bin/claude`), `model` (empty = whatever your CLI defaults to), `insights.enabled`
(default `true`), `insights.languages` (default `["typescriptreact","typescript","go","css"]`),
`insights.maxPerHour` (default `60`), `contextBudgetTokens` (default `12000`),
`memory.enabled` (default `true`), `memory.root` (default: workspace `.claude/memory`),
`autoApply` (default `false`, **never** flip in code), `denyGlobs` (default list in §7).

### 2. Transport — the Claude Code CLI

Spawn once per session, keep it alive, stream both ways:

```ts
const args = [
  '--print',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--include-partial-messages',
  '--verbose',                                  // required with stream-json in print mode
  '--permission-mode', 'plan',                  // advisory by default
  '--disallowedTools', 'Edit,Write,MultiEdit,NotebookEdit',
  '--append-system-prompt', BURROW_SYSTEM_PREAMBLE,
];
if (sessionId) { args.push('--resume', sessionId); }
if (model) { args.push('--model', model); }
cp.spawn(cliPath, args, { cwd: workspaceRoot, env: scrubbedEnv });
```

- **Write** one JSON object per line to stdin:
  `{"type":"user","message":{"role":"user","content":[{"type":"text","text": envelope + question}]}}`
- **Read** stdout line-delimited JSON: `system/init` (capture `session_id`), `assistant` deltas
  (render incrementally), `result` (final text, `total_cost_usd`, `usage`, `duration_ms`) — render
  the cost/latency line in the panel footer.
- **Cancel** = kill the child and mark the turn aborted; never leave a zombie (register in a
  `DisposableStore`, kill on `deactivate`).
- **Errors**: CLI not found → panel shows *"Claude Code CLI not found. Install it or set
  `burrow.agent.cliPath`."* with a button opening the setting. Non-zero exit → show stderr tail
  verbatim in a collapsible block. Never swallow.
- **Env scrub:** strip `ANTHROPIC_API_KEY` and any `ANTHROPIC_*` overrides from the child env so
  the CLI can only use the account login. This is the machine-enforced half of "my Claude Code
  account only".
- **Alternative considered:** `@anthropic-ai/claude-agent-sdk` (npm). It drives the same CLI and
  adds typed events + a `canUseTool` callback. Rejected for v1 to keep `burrow-agent` dependency-free
  (house rule: dependency-light) — revisit if the diff-apply flow needs interactive permissions.

`BURROW_SYSTEM_PREAMBLE` (constant, ~15 lines): you are embedded in Burrow, an IDE for the merkle
repo; you receive a context envelope describing what the developer is looking at; prefer citing
`path:line`; when asked to change code, reply with a unified diff in a single fenced block and
nothing else; keep insight answers to three bullets; read `.claude/memory/*.yaml` rows given to you
before grepping.

### 3. The context engine (`src/context.ts`)

Assemble per turn, cheapest-first, stop at `contextBudgetTokens`:

| Layer | Source | Content |
|---|---|---|
| Workspace | `workspace.workspaceFolders` | repo root, git branch, dirty file count |
| **Open pages** | `window.tabGroups.all` | per tab: path, language, group index, active/dirty. This is "which pages I have open" |
| **Page bundle** | derived | for an active `*.tsx`: its colocated `*.css`, `*.samples.*`, `*_test`/`*.test.*` siblings — the CSS+React pair the brief calls out |
| **Live surface** | `extensions.getExtension('burrow.burrow-frontend-debugger')!.exports` | isolated component name, current props JSON, viewport preset, mode (mock/live), route where it renders. **Requires exporting a small read-only API from the FD extension's `activate()` — do that as part of this WO** |
| Selection | `window.activeTextEditor` | selected text (capped ~200 lines), enclosing symbol via `executeDocumentSymbolProvider`, file path + line range |
| Debug | `debug.activeDebugSession` + tracker | session type, stopped-at frame `file:line`, top 10 locals summarized (names + types, values elided if > 80 chars) |
| Data | `burrow-db` / `burrow-http` exports (add if absent) | current connection + table; last request method/path/status/duration |
| **Memory** | `src/memory.ts` (§4) | selected rows only |

Rendering: a compact, deterministic markdown block — headings, no JSON soup — capped and
**shown to the user** behind `burrow.agent.showContext`. Every layer is a removable chip in the
panel; removing a chip removes it from the envelope for the next turn only.

### 4. merkle memory integration (`src/memory.ts`)

merkle's `.claude/memory/` is a real contract (see its `README.md`/`MEMORY.md`): `repo.yaml` is
always cheap; side files load by concern.

Selection rules (deterministic, no model call):

| Trigger | Load |
|---|---|
| always | `MEMORY.md` index (titles only) + `repo.yaml` `meta`, `prefs[]`, `traps[]` |
| active file under `backend/**` and route-ish (`router.go`, `*handler*`, `*/api/*`) | `api.yaml` rows matching the file, else all `endpoints[]` for that dir |
| migration/`*.sql`/`store` files | `db.yaml` (`tables`, `migrations[]`) |
| any `os.Getenv` / `import.meta.env` hit in the open file | `env.yaml` rows for those names |
| `*.css` / token edits | `design.yaml` `tokens[]` |
| `models/*.go` or its TS mirror | `contract.json` shape for that struct |
| user asks "what's in the repo / what's shipped" | `repo.yaml` fully |

Also surface the contract *to the user*: after the agent proposes a change that touches a route,
env var, table, or token, the panel shows a one-line reminder — *"merkle's memory contract wants
`api.yaml` updated with this change"* — with a button that asks the agent to draft the row. This is
how the IDE keeps merkle's memory from drifting, which is the whole reason merkle has it.

Never write to `.claude/memory/**` directly from the panel; drafted rows go through the same diff
flow as code (§6).

### 5. Auto-insights (`src/insights.ts`)

- **Triggers:** active editor changed, selection settled (≥ 3 lines), or file saved.
  Debounce 800 ms; coalesce; cancel in-flight on a new trigger.
- **Cache:** key = sha256(file path + content hash + selection range + insight version). Store in
  `ExtensionContext.workspaceState` (bounded, LRU 200). A cache hit renders instantly and costs
  nothing.
- **Budget:** `insights.maxPerHour` (default 60) and a hard "no insight while a turn is streaming"
  rule. A visible counter in the panel footer; when exhausted, insights pause with a one-line notice
  rather than failing silently.
- **Prompt shape:** "≤3 bullets: what this does · what it touches (cite `path:line`) · one risk or
  smell. No preamble." For a **page bundle**, the prompt gets the TSX+CSS pair and asks
  specifically about the styling↔markup seam (unused selectors, tokens not from `design.yaml`,
  hard-coded colours) — this is the highest-value insight for merkle's frontend.
- **For Go:** at a debug breakpoint, the insight uses the stopped frame — "you are stopped in
  `handler.go:88` with `orgID` empty; the middleware chain sets it at …".
- **Off switches:** per-language toggle in the card's `…`, global setting, and a kill switch in the
  panel header. Default on for `tsx/ts/go/css` only.

### 6. Proposals, diffs, and applying (`src/diff.ts`)

1. User asks for a change → transport runs with the write tools still disabled.
2. Model returns a fenced unified diff (enforced by the system preamble; if it returns prose+diff,
   extract the first fenced ```diff block).
3. Panel renders **Preview** → open Burrow's native diff editor (`vscode.diff` with an in-memory
   right-hand document), file by file.
4. **Apply** → `WorkspaceEdit` applied in one undoable step; the panel logs what was applied with
   `path:line` counts. **Never auto-save, never commit, never touch git.**
5. Rejected proposals stay in the transcript so the conversation keeps its thread.

Failure modes to handle explicitly: diff doesn't apply cleanly (show the reject hunks, offer
"ask the agent to rebase the diff on the current file"), diff touches a deny-glob path (refuse,
say why), diff touches files outside the workspace (refuse).

### 7. Safety, plainly

- **Deny globs** (never read, never send, never diff): `**/.env*`, `**/infra/secrets/**`,
  `**/*.pem`, `**/*.key`, `**/secret*`, `**/.claude/settings.local.json`, `**/node_modules/**`,
  `**/.git/**`. Applied in `context.ts` *and* re-checked in `diff.ts`.
- **Context preview** is one click away at all times (`burrow.agent.showContext`).
- **No telemetry.** Burrow ships with telemetry off (`product.json:181`); this extension adds none.
- **No silent network.** The only egress is the CLI child process.

### 8. UI specification (webview, house idiom: vanilla TS + CSS custom properties from the theme)

```
┌ Agent ──────────────────────────────── ◐  ⛶  + … ┐
│ Context  [Badge.tsx ×] [Badge.css ×]           ┃ ● │  ← ● session tabs: a slim
│          [isolation ×] [memory: design.yaml ×] ┃ ○ │    VERTICAL rail on the
├────────────────────────────────────────────────┃ ○ │    panel's right edge —
│ ▸ Insight                                      ┃ + │    one dot per session,
│   • Renders one status pill; tone→colour via … ┃   │    hover = title tooltip,
│   • Touches lib/statusColor.ts:14              ┃   │    click = switch, + = new,
│   • `--badge-*` declared but `size=xs` never   ┃   │    middle-click/× = close.
│     sets them (Badge.css:42)                   ┃   │    Each session is its own
├────────────────────────────────────────────────┃   │    CLI conversation
│ you  why is the dot misaligned at xs?          ┃   │    (resumed via its
│ agent …streaming…                              ┃   │    session_id).
│      [Preview diff] [Apply]                    ┃   │
├────────────────────────────────────────────────┃   │
│ [ask about the selection…              ] ⌘↩    ┃   │
│ session 3f2a · 1,204 tok · $0.02 · plan mode   ┃   │
└────────────────────────────────────────────────┴───┘
```

**Sessions (user ask, 2026-07-24).** Multiple concurrent conversations, presented as **vertical
tabs** on the panel's right edge (dots + tooltips at normal width; dot+short-title when the panel
is half-screen or wider). State per session: `session_id` (CLI resume token), title (first
question, editable), transcript, and its own context-chip choices. Persisted in
`ExtensionContext.workspaceState`; on Burrow restart the tabs come back and each resumes lazily on
first message (`--resume <id>`). Only the visible session may stream; switching away pauses
rendering but not the child process; closing a tab kills its child. Cap 8 tabs, oldest-idle
evicted with a confirm.

**Panel width — three states (user ask).** The header `◐/⛶` controls cycle:
1. **Docked** — the normal auxiliary-bar width (~360 px).
2. **Half screen** (`◐`) — the panel expands to ~50% of the window by resizing the auxiliary bar
   part (`workbench.action.resizeAuxiliaryBar`-family layout API if callable; otherwise set the
   part size via the layout service command `workbench.action.evenEditorWidths`-adjacent APIs —
   spike this first; fallback: open the panel as an editor tab in a split group at 50%, same
   webview, state shared).
3. **Full screen** (`⛶`) — the shared Focus Mode from `01` with the agent surface as the only
   thing on screen; `Esc` exits back to the *previous* state (remember which).
The three states are one command (`burrow.agent.cycleSize`) so muscle memory is a single spot.

Rules: same density and type ramp as file `02`; theme tokens only; markdown rendered with the same
typography work already shipped for the markdown preview (`report.md`); code blocks use the
existing `computeFullSyntaxHighlighting` path so agent code looks like editor code; `⌘↩` sends,
`Esc` returns focus to the editor (and exits Focus Mode per file `01 §4`); the panel is **never**
modal and never steals focus.

### 9. Phasing (each phase independently shippable)

| Phase | Delivers | Done when |
|---|---|---|
| A | Panel + transport + ask/answer + session resume + cost line + vertical session tabs + the three size states | you can ask a question about the repo and get a streamed answer with `claude` unmodified; two sessions switch cleanly; ◐/⛶/Esc cycle works |
| B | Context engine + chips + preview + FD/debug/db exports | asking "why is this misaligned?" with `Badge.tsx`+`Badge.css` open works with **no file names typed** |
| C | Memory reader + contract reminders | an answer cites a `merkle/.claude/memory` row, and touching a route offers the `api.yaml` row draft |
| D | Insights + selection insights + budgets/caches | opening a file yields a ≤3-bullet card in < 3 s, cached on reopen, and can be switched off in one click |
| E | Diff propose/preview/apply | a requested change lands as an undoable single edit after you press Apply |

### 10. Acceptance

- `⌘⌥D` toggles the panel; closing it changes nothing else.
- With `claude` removed from PATH, Burrow boots, every other view works, and the panel shows one
  actionable sentence.
- `ANTHROPIC_API_KEY` set in the environment does **not** change behaviour (scrubbed).
- Context preview shows exactly what was sent; removing a chip removes it from the next send.
- Insight latency: cached < 100 ms, cold < 3 s p50 on a 300-line TSX file.
- No write reaches disk without an explicit Apply (verify by trying to make it edit a file).
- `npm run gulp compile-extensions` clean; live evidence: screenshots of the panel answering a
  bundle question, a diff preview, and the memory-contract reminder.
</content>
