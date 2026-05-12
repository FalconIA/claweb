.PHONY: install format format-check lint test build pack \
        fd-install fd-docker-build format-all test-all \
        check all

# ── Root (plugin) ────────────────────────────────────────────────────────────

install:
	pnpm install

format:
	pnpm format

format-check:
	pnpm format:check

lint:
	pnpm typecheck

test: lint
	pnpm test

build:
	pnpm tsc -p tsconfig.json

pack: build
	pnpm pack:release

# ── access/frontdoor ─────────────────────────────────────────────────────────

fd-%:
	$(MAKE) -C access/frontdoor $*

fd-docker-build:
	bash docker/build.sh

# ── Aggregate ────────────────────────────────────────────────────────────────

format-all: format fd-format

test-all: test fd-test

# Run all checks (formatting + tests) across both packages
check: format-all test-all

all: install fd-install check pack fd-docker-build
