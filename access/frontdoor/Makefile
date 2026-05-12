.PHONY: install dev start format format-check test \
        smoke-http smoke-ws smoke-browser-login smoke-browser-login-oauth2 \
        check

install:
	pnpm install

start:
	pnpm start

dev:
	pnpm dev

format:
	pnpm format

format-check:
	pnpm format:check

test:
	pnpm test

smoke-http:
	pnpm smoke:http

smoke-ws:
	pnpm smoke:ws

smoke-browser-login:
	pnpm smoke:browser-login

smoke-browser-login-oauth2:
	pnpm smoke:browser-login-oauth2

# Run all checks (formatting + tests)
check: format-check test
