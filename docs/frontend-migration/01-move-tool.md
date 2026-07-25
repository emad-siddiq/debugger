# 01 — Move the tool into burrow

> Part of the [frontend migration](00-overview.md).

## The move

```sh
mv /Users/emadinfstones/Projects/debugger/frontend \
   /Users/emadinfstones/Projects/debugger/burrow/tools/frontend-debugger
rm -rf burrow/tools/frontend-debugger/Dockerfile burrow/tools/frontend-debugger/docker
```

- `node_modules/` moves along — it is host-native macOS now (the Linux-volume dance is dead)
  and gitignored: burrow's `.gitignore` bare `node_modules/` and `dist` rules cover the tool,
  so `ui/dist` stays untracked too.
- The tool's `.claude/` (memory yamls, oracle, docs, commands, scripts) moves with it.
  `oracle.mjs` resolves its ROOT relative to itself, so `npm run oracle` keeps working from
  the new home unchanged.
- `debugger/` is not a git repo — there is no history to preserve; burrow gains the files as
  a plain import.

## Server edits in the new home

All paths relative to `burrow/tools/frontend-debugger/`.

1. **`server/config.js:27`** — the host fallback for the merkle testing ground was
   `path.resolve(__dirname, '../../../merkle')` (server → frontend → debugger → Projects).
   From the new home it needs five ups:
   `path.resolve(__dirname, '../../../../../merkle')`
   (server → frontend-debugger → tools → burrow → debugger → Projects). Update the comment
   ("burrow/tools/frontend-debugger sits two levels below the debugger checkout").
2. **`server/config.js:61`** — `backendTarget` default `'http://ide:8080'` (compose DNS) →
   `'http://localhost:8080'` (the Go backend under F5 on the host).
3. **`server/api.js:178`** — the live-mode preflight remediation string referenced the old
   Backend IDE (":6100"); reword to "F5 the Go backend in Burrow, or flip back to mock".
4. **Leave untouched:** the `SELECTION_FILE` read (`config.js:11` — `readSelection` swallows a
   missing file; the extension points it at an inert tmp path) and `TARGET_NODE_MODULES`
   (`config.js:35` — defaults to `<frontendDir>/node_modules`, correct on host). Keeping both
   keeps the oracle `env.yaml` name-set stable.

## Tool docs

- `CLAUDE.md` (tool-local): drop Docker/compose run instructions and volume lore; "Running it"
  becomes: bootstrap (`npm install && npm run build`), standalone dev (`npm run dev` +
  `MERKLE_FRONTEND_DIR`/`MERKLE_REPO_ROOT`), and "opened from Burrow via the
  burrow-frontend-debugger extension (attaches to a running dev instance on :6080)". Keep the
  oracle/memory rules verbatim — the gate travels with the tool.
- `README.md`: same sweep (ports stay 6080/5180 as defaults; note the extension auto-picks
  free ports on collision).

## Gate (before any code change lands on top)

```sh
cd burrow/tools/frontend-debugger
npm install && npm run build && npm run oracle   # oracle must be 0 FAIL
```

This proves the move alone is green: build works from the new path, oracle counts unchanged
(12 routes / 17 commands / 16 events / 16 env / 19 components).
