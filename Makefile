SHELL := /bin/bash
.DEFAULT_GOAL := help

BIN_DIR   := build/bin
EXE       := $(BIN_DIR)/ja-db.exe
LOG       := $(BIN_DIR)/ja-db.log
FRONTEND  := frontend
DIST      := $(FRONTEND)/dist
NODE_MODS := $(FRONTEND)/node_modules

# Stamped into the binary so a built exe can be traced back to a commit.
VERSION   ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS   := -X main.version=$(VERSION)

# Sources that should trigger a rebuild.
GO_SRC    := $(shell find . -name '*.go' -not -path './frontend/*' 2>/dev/null)
WEB_SRC   := $(shell find $(FRONTEND)/src -type f 2>/dev/null) \
             $(FRONTEND)/index.html $(FRONTEND)/vite.config.ts $(FRONTEND)/package.json

.PHONY: help
help:
	@echo 'ja-db'
	@echo
	@echo '  make windows      cross-compile $(EXE)'
	@echo '  make open         build, then launch $(EXE) in the background'
	@echo '  make check        fmt + vet + typecheck + all tests'
	@echo '  make vuln         govulncheck + npm audit (needs network)'
	@echo '  make release      tag the next version and push it; CI publishes it'
	@echo
	@echo '  make dev          run the API dev server (pair with: make web)'
	@echo '  make web          run the Vite dev server on :5173'
	@echo
	@echo '  make clean        remove build output'

# --- build -------------------------------------------------------------------------

.PHONY: windows
windows: $(EXE)
	@echo "built $(EXE) ($(VERSION))"
	@ls -lh $(EXE) | awk '{print "  size: " $$5}'

# -s skips Wails' own frontend step, since $(DIST) is already a prerequisite.
# Cross-compiling to Windows works from Linux because every driver is pure Go
# and the Windows webview binding needs no cgo.
$(EXE): $(GO_SRC) $(DIST) wails.json
	@mkdir -p $(BIN_DIR)
	wails build -platform windows/amd64 -s -ldflags "$(LDFLAGS)" -o ja-db.exe

# Launch detached so the terminal stays usable; stdout/stderr go to the log.
.PHONY: open
open: $(EXE)
	@nohup $(EXE) >$(LOG) 2>&1 & echo "launched $(EXE) (pid $$!), log: $(LOG)"

$(DIST): $(NODE_MODS) $(WEB_SRC)
	cd $(FRONTEND) && npm run build
	@touch $(DIST)

$(NODE_MODS): $(FRONTEND)/package-lock.json
	cd $(FRONTEND) && npm ci
	@touch $(NODE_MODS)

# --- development -------------------------------------------------------------------

.PHONY: dev
dev:
	go run ./cmd/devserver

.PHONY: web
web: $(NODE_MODS)
	cd $(FRONTEND) && npm run dev

# --- quality -----------------------------------------------------------------------

.PHONY: check
check: $(NODE_MODS)
	gofmt -w $(GO_SRC)
	cd $(FRONTEND) && npx prettier --write --log-level warn "src/**/*.{ts,tsx,css}"
	go vet ./...
	cd $(FRONTEND) && npx tsc --noEmit
	go test ./...
	cd $(FRONTEND) && npx vitest run
	@echo "all checks passed"

# Known-vulnerability scan of both dependency trees. Needs the network and is
# not part of `check`, so an advisory published today cannot fail an unrelated
# commit. Run before a release.
.PHONY: vuln
vuln: $(NODE_MODS)
	go run golang.org/x/vuln/cmd/govulncheck@latest ./...
	cd $(FRONTEND) && npm audit --omit=dev

# --- release -----------------------------------------------------------------------

# Tags the next version — worked out from the commit emoji (docs/adr/0004), or
# V=vX.Y.Z to choose — then pushes main and the tag. The tag is what
# .github/workflows/release.yml builds and publishes; running apps update from it.
.PHONY: release
release: check
	@test -z "$$(git status --porcelain --untracked-files=no)" || { echo 'commit or stash first'; exit 1; }
	@test "$$(git branch --show-current)" = main || { echo 'release from main'; exit 1; }
	git fetch -q origin main
	@git merge-base --is-ancestor origin/main HEAD || { echo 'origin/main has commits main lacks: pull first'; exit 1; }
	$(eval V ?= $(shell scripts/next-version.sh))
	@[[ "$(V)" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$$ ]] || { echo 'V must look like v1.2.3'; exit 1; }
	git tag -a $(V) -m "ja-db $(V)"
	git push --atomic origin main $(V)
	@echo "released $(V): https://github.com/Cleancookie/ja-database-gui/actions"

# --- housekeeping ------------------------------------------------------------------

.PHONY: clean
clean:
	rm -rf $(BIN_DIR) $(DIST)
