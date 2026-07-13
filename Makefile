# Burrow — dev/dist wrappers over the upstream VS Code build.
# Node must match .nvmrc (24.17.0). Use `fnm use` (or `make node-check`) first.

SHELL := /bin/bash
ARCH  := $(shell uname -m)

.PHONY: help node-check deps dev dist ledger-check clean

help:
	@echo "Burrow build targets:"
	@echo "  make node-check   verify Node matches .nvmrc"
	@echo "  make deps         npm ci (Electron + native modules)"
	@echo "  make dev          run branded app from source (scripts/code.sh)"
	@echo "  make dist         packaged .app (gulp vscode-darwin-$(ARCH))"
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

ledger-check:
	node build/burrow/check-ledger.js

clean:
	rm -rf out out-* .build node_modules/.cache
