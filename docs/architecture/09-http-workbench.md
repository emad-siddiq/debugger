# 09 — HTTP workbench (the Postman replacement)

> Part of the [Go IDE overhaul](00-overview.md). Depends on: 03. Effort: ~3 wk.

## Goal

A Postman-class HTTP client, integrated: collections, environments, a proper
request editor, and a rich response viewer — so exercising the backend under
debug never needs an external app. File-backed and git-friendly, compatible
with the `.http` scratchpads the stack already uses (`api.http`).

## Design

### Files are the database

- Requests live in **`.http` files** (the humao/JetBrains dialect the repo
  already has): `###`-separated requests, `@var` definitions, `{{var}}`
  interpolation. The existing `vscode/api.http` (54 NodeWatch requests) opens
  and works day one — that file is the compatibility fixture.
- **Environments** in `http-env.json` next to the collection
  (`{"dev": {"baseUrl": "http://localhost:8080"}, "compose": …}`), switcher in
  the workbench toolbar. Secrets never in-repo: `{{$env:VAR}}` reads process
  env; an OS-keychain-backed `{{$secret:name}}` for tokens.
- A **collection** = a directory of `.http` files. Tree view mirrors the
  files; no proprietary sidecar database, so PRs review requests like code.

### Two faces, one model

- **In-editor:** `.http` files get syntax highlighting, `{{var}}` resolution
  hints, and a **Send** codelens per request (the workflow people already
  have, kept).
- **Workbench panel** (`extensions/burrow-http/`, editor-area webview): the
  Postman-style three-pane experience —
  - *left:* collection tree + history;
  - *center:* request editor — method/URL bar, tabs for **Params · Headers ·
    Body (raw/JSON editor/form/file) · Auth (bearer, basic, API-key header) ·
    Settings (timeout, redirects, TLS-verify toggle)** — all of it
    round-tripping losslessly to the `.http` text;
  - *right/bottom:* response — status + timing + size chips; headers table;
    body as **JSON tree with filter and path-copy (`$.items[3].id`)**, raw,
    or preview; large-body streaming with truncation guards; response history
    diffing (this run vs. last).
- Send executes via undici in the extension host: full timing breakdown
  (DNS/connect/TLS/TTFB/total), cookie jar per environment (inspectable,
  clearable), redirect chain shown.

### Debugger + stack integration (the moat)

- **Breakpoint-aware sends:** hitting a breakpoint while a workbench request
  is in flight badges that request "paused in `ingest.HandleIngest`" — send,
  stop in handler, inspect (task 05/06), continue, see the response. The
  core loop of backend debugging, one window.
- Every send injects **`X-Request-Id`** (toggleable) and hands the id to the
  Request Trace feature (ported in task 14), linking request → slog lines.
- **Generate from routes:** the digest's route table (launcher `/api/digest`,
  see task 14) generates/refreshes a `routes.generated.http` — every backend
  route as a ready request (the existing `generateApiHttp` feature, upgraded).
- Export/import: copy-as-cURL, import-from-cURL; OpenAPI import (paths →
  collection) best-effort.

## Tasks

1. **`.http` parser/printer.** Lossless round-trip (comments preserved) of the
   humao dialect: requests, `@vars`, `{{}}` interpolation, `###` separators;
   `api.http` as the golden fixture. Env resolution with `$env`/`$secret`.
2. **Send engine.** undici-based executor: timing phases, cookie jar, redirect
   capture, cancellation, streaming bodies, size guards.
3. **In-editor face.** Grammar, codelens Send, inline var hints, "open in
   workbench" jump.
4. **Workbench panel.** Three-pane webview: tree/history, request editor tabs
   with lossless text round-trip, response viewer (JSON tree + filter +
   path-copy, headers, timing chips, history diff).
5. **Environments + secrets.** `http-env.json` switcher, keychain-backed
   secrets, cookie-jar-per-env.
6. **Debug + trace hooks.** In-flight ⇄ breakpoint badge wiring,
   `X-Request-Id` injection + trace handoff interface (consumed in task 14),
   route-digest → generated collection.
7. **Import/export.** cURL both ways; OpenAPI import.

## Acceptance criteria

- `vscode/api.http` opens with all requests sendable — codelens and workbench
  — against the backend under debug; auth-less NodeWatch dev contract works
  as-is.
- Send → breakpoint in handler → inspect → continue → response renders, with
  the request badge showing the pause; total flow inside one window.
- A 25 MB JSON response streams, renders truncated-safe, and the tree filter
  stays responsive.
- Round-trip test: parse → edit in UI → print yields a minimal, comment-
  preserving diff.

## Out of scope

- Mock servers, contract testing, gRPC/WebSocket clients (post-launch
  candidates; gRPC is the most likely follow-on for a Go IDE).
- Postman collection-format import (cURL/OpenAPI cover the real cases).
