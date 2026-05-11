# CLAWeb Frontdoor (Reference Access Host)

This directory contains the **reference access host** for the CLAWeb channel.

It is not the channel runtime itself.
It is also not the only possible deployment shape.

## Role in the repository

CLAWeb is organized around three layers:

- **Channel runtime**: `src/`
- **Reference access layer**: `access/frontdoor/`
- **Reference clients**: `clients/browser/`

This directory is the current reference implementation of the **access layer**.

## What it provides

- `GET /` static hosting of `clients/browser/*`
- `POST /login` passphrase-based login (canonical)
- `POST /oauth2/login` OAuth2 ROPC login (enabled when `CLAWEB_OAUTH2_ENABLED=true`)
- `GET /config` public UI config (includes `authMode`)
- `GET /history` (canonical)
- `WS /ws` (canonical)

It also supports compatibility aliases:
- `/claweb/login`
- `/claweb/history`
- `/claweb/ws`

## Why this exists

The CLAWeb OpenClaw channel plugin exposes the upstream WebSocket channel.
A client-facing deployment usually needs a small access host to:

- serve a client UI
- implement login + history
- proxy WS to the upstream OpenClaw channel
- persist raw history with a stable ordering tie-break (`_idx`)

## Config

Env vars can be set via the shell environment or a `.env` file.  
The server searches for a `.env` file in this order and loads the first one it finds:

1. `$CLAWEB_ENV_FILE` (explicit override)
2. `./config/.env`
3. `./.env`

Existing shell environment variables always take priority over values in the file.

### Required env

- `PORT` (default: `18081`)
- `BIND` (default: `127.0.0.1`)
- `CLAWEB_STATIC_ROOT` (default: `../../clients/browser`)
- `CLAWEB_LOGIN_CONFIG` (default: `./config/claweb-login.example.json`) — passphrase mode only; can be replaced or supplemented by `CLAWEB_LOGIN_<N>_*` vars (see below)
- `CLAWEB_HISTORY_DIR` (default: `./data/history`)

### Passphrase users via env (passphrase mode)

As an alternative to (or merged on top of) the JSON config file, users can be defined inline with numbered env vars. Env vars win on key collision.

| Variable | Description |
|---|---|
| `CLAWEB_LOGIN_<N>_NAME` | Identity key — **required** for the slot to be loaded |
| `CLAWEB_LOGIN_<N>_DISPLAY_NAME` | Display name (default: same as `NAME`) |
| `CLAWEB_LOGIN_<N>_PASSPHRASE` | Single passphrase |
| `CLAWEB_LOGIN_<N>_PASSPHRASES` | Comma-separated list of passphrases (additive with `_PASSPHRASE`) |
| `CLAWEB_LOGIN_<N>_USER_ID` | User ID (default: `user-<NAME>`) |
| `CLAWEB_LOGIN_<N>_ROOM_ID` | Room ID |
| `CLAWEB_LOGIN_<N>_CLIENT_ID` | Client ID (default: same as `NAME`) |

`<N>` is any positive integer; slots are processed in ascending numeric order.

### Upstream (OpenClaw claweb channel)

- `CLAWEB_UPSTREAM_WS` (default: `ws://127.0.0.1:18999`)
- `CLAWEB_UPSTREAM_TOKEN` or `CLAWEB_UPSTREAM_TOKEN_FILE`

The upstream token is the `channels.claweb.authToken` configured in OpenClaw.

### Authentication mode

The server supports two mutually exclusive auth modes, controlled by `CLAWEB_OAUTH2_ENABLED`:

| `CLAWEB_OAUTH2_ENABLED` | Active mode | Login endpoint |
|---|---|---|
| unset / `false` | Passphrase | `POST /login` |
| `true` | OAuth2 ROPC | `POST /oauth2/login` |

The `GET /config` endpoint advertises the active mode via `authMode: "passphrase" | "oauth2"`.

### OAuth2 env (when `CLAWEB_OAUTH2_ENABLED=true`)

**Required:**

- `CLAWEB_OAUTH2_CLIENT_ID` — OAuth2 client ID
- `CLAWEB_OAUTH2_CLIENT_SECRET` — OAuth2 client secret  
  (or `CLAWEB_OAUTH2_CLIENT_SECRET_FILE` — path to a file containing the secret)
- `CLAWEB_OAUTH2_TOKEN_URL` — token endpoint (ROPC `grant_type=password`)
- `CLAWEB_OAUTH2_USERINFO_URL` — userinfo endpoint  
  (or `CLAWEB_OAUTH2_USERINFO_IN_TOKEN` — name of the field in the token response that contains the userinfo object)

**Optional:**

- `CLAWEB_OAUTH2_SCOPE` — space-separated scopes to request (default: none)
- `CLAWEB_OAUTH2_USERINFO_ID_FIELD` — userinfo field used as the user identity (default: `sub`)
- `CLAWEB_OAUTH2_USERINFO_NAME_FIELD` — userinfo field used as the display name (default: `name`)
- `CLAWEB_OAUTH2_INTROSPECT_URL` — token introspection endpoint; when set, active sessions are re-validated periodically
- `CLAWEB_OAUTH2_INTROSPECT_TTL` — introspection cache TTL in **seconds** (default: `60`)
- `CLAWEB_OAUTH2_DEFAULT_ROOM_ID` — room ID assigned to all OAuth2 sessions
- `CLAWEB_OAUTH2_DEFAULT_CLIENT_ID_PREFIX` — prefix prepended to the identity to form the client ID (default: identity value used as-is)

## Run

```bash
cd access/frontdoor
pnpm i
pnpm start
```

## Smoke tests

### HTTP smoke (passphrase mode)

```bash
pnpm smoke:http -- \
  --base https://claweb.example.com \
  --passphrase demo-passphrase \
  --userId demo-user --roomId demo-room --clientId demo-client \
  --insecure
```

### WebSocket smoke

```bash
pnpm smoke:ws -- \
  --base https://claweb.example.com \
  --passphrase demo-passphrase \
  --clientId demo-client \
  --message "ping" \
  --insecure
```

This validates:
- `hello -> ready`
- assistant reply carries `replyTo`
- user and assistant ids do not collide

### Browser login smoke

Passphrase mode:

```bash
pnpm smoke:browser -- \
  --base https://claweb.example.com \
  --passphrase demo-passphrase
```

OAuth2 mode:

```bash
pnpm smoke:browser -- \
  --base https://claweb.example.com \
  --username demo-user \
  --password demo-password
```

## Migration note

Older docs may refer to `examples/frontdoor/`.
That directory has now been promoted to `access/frontdoor/` to make the repository layering clearer.
