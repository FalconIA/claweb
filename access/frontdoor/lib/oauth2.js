// OAuth2 ROPC (Resource Owner Password Credentials) support for CLAWeb frontdoor.
// Extracted from server.js to keep the main file focused on routing and infrastructure.
//
// Usage:
//   import { parseOAuth2Config, validateOAuth2Config, createOAuth2Handler } from "./lib/oauth2.js";
//   const oauth2Config = parseOAuth2Config(process.env);
//   validateOAuth2Config(oauth2Config, log);               // call once after logger is ready
//   const oauth2 = createOAuth2Handler(oauth2Config, { sessionsByToken, log });
//   // then use oauth2.requireSessionWithIntrospect(req)
//   //      oauth2.handleOAuth2Login(req, res, { json, readJsonBody })

import { randomUUID } from "node:crypto";
import fs from "node:fs";

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

/**
 * Read all CLAWEB_OAUTH2_* environment variables and return a typed config object.
 * File-based secrets are read synchronously (same pattern as server.js startup).
 *
 * @param {Record<string, string>} env - process.env
 */
export function parseOAuth2Config(env) {
  const enabled =
    String(env.CLAWEB_OAUTH2_ENABLED || "")
      .trim()
      .toLowerCase() === "true";

  const clientId = String(env.CLAWEB_OAUTH2_CLIENT_ID || "").trim();

  let clientSecret = "";
  if (env.CLAWEB_OAUTH2_CLIENT_SECRET_FILE) {
    try {
      clientSecret = fs.readFileSync(env.CLAWEB_OAUTH2_CLIENT_SECRET_FILE, "utf8").trim();
    } catch {
      // file unreadable — leave empty, validation will warn if needed
    }
  } else {
    clientSecret = String(env.CLAWEB_OAUTH2_CLIENT_SECRET || "").trim();
  }

  // prettier-ignore
  return {
    enabled,
    clientId,
    clientSecret,
    tokenUrl:             String(env.CLAWEB_OAUTH2_TOKEN_URL                  || "").trim(),
    userinfoUrl:          String(env.CLAWEB_OAUTH2_USERINFO_URL               || "").trim(),
    userinfoInToken:      String(env.CLAWEB_OAUTH2_USERINFO_IN_TOKEN          || "").trim(),
    scope:                String(env.CLAWEB_OAUTH2_SCOPE                      || "").trim(),
    userinfoIdField:      String(env.CLAWEB_OAUTH2_USERINFO_ID_FIELD          || "sub").trim(),
    userinfoNameField:    String(env.CLAWEB_OAUTH2_USERINFO_NAME_FIELD        || "name").trim(),
    introspectUrl:        String(env.CLAWEB_OAUTH2_INTROSPECT_URL             || "").trim(),
    introspectTtlMs:      Math.max(10, Number(env.CLAWEB_OAUTH2_INTROSPECT_TTL || 60) || 60) * 1000,
    defaultRoomId:        String(env.CLAWEB_OAUTH2_DEFAULT_ROOM_ID            || "").trim(),
    defaultClientIdPrefix:String(env.CLAWEB_OAUTH2_DEFAULT_CLIENT_ID_PREFIX  || "").trim(),
  };
}

// ---------------------------------------------------------------------------
// Startup validation
// ---------------------------------------------------------------------------

/**
 * Emit startup warnings for incomplete OAuth2 configuration.
 * Call once after the logger is available.
 *
 * @param {ReturnType<typeof parseOAuth2Config>} config
 * @param {(level: string, msg: string, fields?: object) => void} log
 */
export function validateOAuth2Config(config, log) {
  if (!config.enabled) return;
  if (!config.tokenUrl) {
    log("warn", "oauth2_config_incomplete", { missing: "CLAWEB_OAUTH2_TOKEN_URL" });
  }
  if (!config.userinfoUrl && !config.userinfoInToken) {
    log("warn", "oauth2_config_incomplete", {
      missing: "CLAWEB_OAUTH2_USERINFO_URL or CLAWEB_OAUTH2_USERINFO_IN_TOKEN",
    });
  }
  log("info", "oauth2_mode_enabled", { introspect: Boolean(config.introspectUrl) });
}

// ---------------------------------------------------------------------------
// Runtime handler factory
// ---------------------------------------------------------------------------

/**
 * Create OAuth2 runtime helpers bound to a shared session store.
 *
 * @param {ReturnType<typeof parseOAuth2Config>} config
 * @param {{ sessionsByToken: Map<string, object>, log: Function }} deps
 */
export function createOAuth2Handler(config, { sessionsByToken, log }) {
  // --- session construction ---

  function buildSessionFromOAuth2(userinfo, accessToken) {
    const identity = String(userinfo[config.userinfoIdField] || "").trim();
    if (!identity) return null;
    const token = `tok_${randomUUID()}`;
    const session = {
      identity,
      displayName: String(userinfo[config.userinfoNameField] || identity),
      token,
      userId: String(userinfo.uuid || userinfo.sub || identity),
      roomId: config.defaultRoomId,
      clientId: config.defaultClientIdPrefix ? `${config.defaultClientIdPrefix}${identity}` : identity,
      wsUrl: "/ws",
    };
    if (config.introspectUrl && accessToken) {
      session._accessToken = accessToken;
      session._introspectValidUntil = 0; // force check on first use
    }
    sessionsByToken.set(token, session);
    return session;
  }

  // --- token introspection ---

  async function introspectToken(accessToken) {
    if (!config.introspectUrl || !accessToken) return true;
    try {
      const creds = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
      const resp = await fetch(config.introspectUrl, {
        method: "POST",
        headers: {
          Authorization: `Basic ${creds}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ token: accessToken }).toString(),
      });
      if (!resp.ok) return false;
      const data = await resp.json();
      return data?.active === true;
    } catch {
      return false;
    }
  }

  // --- session guard (used by all protected routes) ---

  async function requireSessionWithIntrospect(req) {
    const token = String(req.headers["x-claweb-token"] || "").trim();
    if (!token) return null;
    const session = sessionsByToken.get(token) || null;
    if (!session) return null;
    if (config.introspectUrl && session._accessToken) {
      const now = Date.now();
      if (now >= (session._introspectValidUntil || 0)) {
        const active = await introspectToken(session._accessToken);
        if (!active) {
          sessionsByToken.delete(token);
          return null;
        }
        session._introspectValidUntil = now + config.introspectTtlMs;
      }
    }
    return session;
  }

  // --- /oauth2/login route body ---

  async function handleOAuth2Login(req, res, { json, readJsonBody }) {
    const body = await readJsonBody(req);
    const username = String(body?.username || "").trim();
    const password = String(body?.password || "").trim();
    if (!username || !password) {
      return json(res, 400, { ok: false, error: "missing_credentials" });
    }

    // Exchange credentials for OAuth2 token (ROPC)
    let tokenData;
    try {
      const params = new URLSearchParams({ grant_type: "password", username, password });
      const useBasicAuth = Boolean(config.clientId && config.clientSecret);
      // Only add client credentials to body if NOT using Basic auth header
      if (!useBasicAuth && config.clientId) params.set("client_id", config.clientId);
      if (!useBasicAuth && config.clientSecret) params.set("client_secret", config.clientSecret);
      if (config.scope) params.set("scope", config.scope);

      const headers = { "Content-Type": "application/x-www-form-urlencoded" };
      if (useBasicAuth) {
        headers["Authorization"] =
          `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;
      }

      const tokenResp = await fetch(config.tokenUrl, { method: "POST", headers, body: params.toString() });
      if (!tokenResp.ok) {
        log("warn", "oauth2_token_failed", { status: tokenResp.status });
        return json(res, 401, { ok: false, error: "invalid_credentials" });
      }
      const ct = String(tokenResp.headers.get("content-type") || "").toLowerCase();
      if (ct.includes("application/x-www-form-urlencoded")) {
        tokenData = Object.fromEntries(new URLSearchParams(await tokenResp.text()));
      } else {
        tokenData = await tokenResp.json();
      }
    } catch (e) {
      log("error", "oauth2_token_error", { error: String(e?.message || e) });
      return json(res, 502, { ok: false, error: "provider_unreachable" });
    }

    const accessToken = String(tokenData?.access_token || "").trim();
    if (!accessToken) return json(res, 401, { ok: false, error: "invalid_credentials" });

    // Resolve userinfo
    let userinfo;
    try {
      if (config.userinfoInToken) {
        userinfo = tokenData[config.userinfoInToken];
        if (!userinfo || typeof userinfo !== "object") {
          log("warn", "oauth2_userinfo_in_token_missing", { field: config.userinfoInToken });
          return json(res, 502, { ok: false, error: "provider_userinfo_missing" });
        }
      } else {
        const uiResp = await fetch(config.userinfoUrl, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!uiResp.ok) {
          log("warn", "oauth2_userinfo_failed", { status: uiResp.status });
          return json(res, 401, { ok: false, error: "invalid_credentials" });
        }
        userinfo = await uiResp.json();
      }
    } catch (e) {
      log("error", "oauth2_userinfo_error", { error: String(e?.message || e) });
      return json(res, 502, { ok: false, error: "provider_unreachable" });
    }

    const session = buildSessionFromOAuth2(userinfo, accessToken);
    if (!session) {
      log("warn", "oauth2_identity_missing", { idField: config.userinfoIdField });
      return json(res, 502, { ok: false, error: "provider_identity_missing" });
    }
    log("info", "oauth2_login_ok", {
      identity: session.identity,
      userId: session.userId,
      roomId: session.roomId,
      clientId: session.clientId,
    });
    // Omit internal token-tracking fields from the response payload
    const { _accessToken: _a, _introspectValidUntil: _b, ...publicSession } = session;
    return json(res, 200, { ok: true, session: publicSession });
  }

  return { buildSessionFromOAuth2, introspectToken, requireSessionWithIntrospect, handleOAuth2Login };
}
