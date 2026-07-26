# Burrow — dev/dist wrappers over the upstream VS Code build.
# Node must match .nvmrc (24.17.0). Use `fnm use` (or `make node-check`) first.

SHELL := /bin/bash
ARCH  := $(shell uname -m)

.PHONY: help node-check deps dev dist install ledger-check clean

# Where `gulp vscode-darwin-<arch>` leaves the packaged app, and where macOS
# needs it for Launchpad to pick it up. Note the output is a SIBLING of the
# repo, not inside it — and `.build/electron` holds only the unpackaged Electron
# shell, which looks like the app but has no `Resources/app` payload at all.
NAME    := $(shell node -p "require('./product.json').nameLong" 2>/dev/null || echo "Burrow — Go IDE")
APP     := ../VSCode-darwin-$(ARCH)/$(NAME).app
# Launchpad indexes ~/Applications as well as /Applications, and ~/Applications
# needs no privileges — /Applications is root:admin, so installing there fails
# outright for a non-admin account. Override if you want it system-wide:
#   sudo make install INSTALL=/Applications/Burrow.app
INSTALL ?= $(HOME)/Applications/Burrow.app

help:
	@echo "Burrow build targets:"
	@echo "  make node-check   verify Node matches .nvmrc"
	@echo "  make deps         npm ci (Electron + native modules)"
	@echo "  make dev          run branded app from source (scripts/code.sh)"
	@echo "  make dist         packaged .app (gulp vscode-darwin-$(ARCH))"
	@echo "  make install      copy the packaged .app to $(INSTALL) for Launchpad"
	@echo "  make ledger-check  fail if core-source diffs lack a patch ledger entry"

node-check:
	@want=$$(cat .nvmrc); have=$$(node -v | sed 's/^v//'); \
	if [ "$$want" != "$$have" ]; then \
	  echo "Node mismatch: need $$want (.nvmrc), have $$have. Run 'fnm use'."; exit 1; \
	fi; echo "Node $$have OK"

deps: node-check
	npm ci

dev: node-check
	./scripts/code.sh

dist: node-check
	npm run gulp vscode-darwin-$(ARCH)

# Launchpad indexes /Applications, so installing IS copying there. The ad-hoc
# signature is what lets a locally-built, un-notarized app launch at all: the
# gulp output carries a stale signature once we have changed its contents, and
# macOS kills it on sight. `-s -` signs with no identity, which Gatekeeper
# accepts for a local build (full notarization is task 13).
install:
	@test -d "$(APP)" || { echo "No packaged app at '$(APP)' — run 'make dist' first."; exit 1; }
	mkdir -p "$(dir $(INSTALL))"
	rm -rf "$(INSTALL)"
	ditto "$(APP)" "$(INSTALL)"
	codesign --force --deep --sign - "$(INSTALL)"
	@echo "Installed $(INSTALL) — open Launchpad, or: open -a Burrow"
	@echo "First launch may need right-click -> Open (un-notarized local build)."

ledger-check:
	node build/burrow/check-ledger.js

clean:
	rm -rf out out-* .build node_modules/.cache
