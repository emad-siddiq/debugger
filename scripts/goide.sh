#!/usr/bin/env bash
# goide — launch Burrow (the Go IDE) from sources.
#
# Wraps ./scripts/code.sh with everything the dev build needs on this machine:
#   - scrubs VSCODE_*/ELECTRON_* (a shell spawned from an extension host inherits
#     ELECTRON_RUN_AS_NODE=1, which makes Electron run as plain Node and crash)
#   - puts the pinned Node (24.17.0) first on PATH
#   - uses a SHORT, persistent --user-data-dir (macOS unix sockets cap at 103 chars)
#   - disables workspace trust (burrow-go-debug declares untrustedWorkspaces:false
#     by design, and an untrusted folder silently disables the Go debugger)
#
# Usage:
#   goide                 # open the current directory
#   goide <path>          # open a folder or file
#   goide --build         # compile sources first, then launch
#   goide --check         # report build freshness and exit
#   goide --clean         # discard the goide profile (settings/state) and launch
#   goide -- <args...>    # everything after -- is forwarded to code.sh verbatim
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$HOME/.local/burrow-node/current/bin"
UDD="$HOME/.burrow-dev"

die() { printf 'goide: %s\n' "$*" >&2; exit 1; }

build_marker="$REPO/out/vs/workbench/workbench.desktop.main.js"

report_freshness() {
	[ -f "$build_marker" ] || { echo "not built"; return 1; }
	local newer
	newer=$(find "$REPO/src" -newer "$build_marker" -name '*.ts' 2>/dev/null | wc -l | tr -d ' ')
	if [ "$newer" != "0" ]; then
		echo "stale: $newer source file(s) newer than out/ — run 'goide --build' to pick them up"
	else
		echo "up to date"
	fi
	return 0
}

INVOKED_DIR="$PWD"
DO_BUILD=0
PASSTHRU=()
while [ $# -gt 0 ]; do
	case "$1" in
		--build) DO_BUILD=1 ;;
		--clean) rm -rf "$UDD"; echo "goide: profile $UDD discarded" ;;
		--check)
			printf 'repo:  %s\nnode:  %s\nout/:  ' "$REPO" "$("$NODE_BIN/node" -v 2>/dev/null || echo 'MISSING')"
			report_freshness || true
			exit 0 ;;
		--) shift; PASSTHRU+=("$@"); break ;;
		*) PASSTHRU+=("$1") ;;
	esac
	shift
done

[ -x "$NODE_BIN/node" ] || die "pinned Node not found at $NODE_BIN (see burrow/README)"
export PATH="$NODE_BIN:$PATH"
# TMPDIR must be short for the same 103-char socket reason as the user-data-dir.
export TMPDIR=/tmp
for v in $(env | grep -oE '^(VSCODE|ELECTRON)[A-Z_]*' | sort -u); do unset "$v"; done

cd "$REPO"

if [ "$DO_BUILD" = "1" ]; then
	echo "goide: compiling (this takes a few minutes)…"
	npm run compile
	# out/ keeps flushing for a moment after gulp exits; booting mid-flush dies with
	# ERR_MODULE_NOT_FOUND on out/vs/base/common/performance.js.
	sleep 3
fi

[ -f "$build_marker" ] || die "sources are not built — run 'goide --build' first"

# Default to the current directory when no target was given.
if [ "${#PASSTHRU[@]}" -eq 0 ]; then
	PASSTHRU=("$INVOKED_DIR")
fi

echo "goide: $(report_freshness)"
exec ./scripts/code.sh --user-data-dir="$UDD" --disable-workspace-trust --skip-release-notes "${PASSTHRU[@]}"
