import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseOAuth2Config, validateOAuth2Config } from "../lib/oauth2.js";

describe("parseOAuth2Config", () => {
  it("returns disabled when CLAWEB_OAUTH2_ENABLED is unset", () => {
    const cfg = parseOAuth2Config({});
    assert.equal(cfg.enabled, false);
  });

  it("parses enabled=true", () => {
    const cfg = parseOAuth2Config({ CLAWEB_OAUTH2_ENABLED: "true" });
    assert.equal(cfg.enabled, true);
  });

  it("reads clientId and clientSecret from env", () => {
    const cfg = parseOAuth2Config({
      CLAWEB_OAUTH2_CLIENT_ID: "my-client",
      CLAWEB_OAUTH2_CLIENT_SECRET: "s3cr3t",
    });
    assert.equal(cfg.clientId, "my-client");
    assert.equal(cfg.clientSecret, "s3cr3t");
  });

  it("trims whitespace from string fields", () => {
    const cfg = parseOAuth2Config({
      CLAWEB_OAUTH2_TOKEN_URL: "  https://auth.example.com/token  ",
    });
    assert.equal(cfg.tokenUrl, "https://auth.example.com/token");
  });

  it("defaults userinfoIdField to sub", () => {
    assert.equal(parseOAuth2Config({}).userinfoIdField, "sub");
  });

  it("defaults userinfoNameField to name", () => {
    assert.equal(parseOAuth2Config({}).userinfoNameField, "name");
  });

  it("converts introspectTtlMs to milliseconds with minimum of 10s", () => {
    assert.equal(parseOAuth2Config({ CLAWEB_OAUTH2_INTROSPECT_TTL: "30" }).introspectTtlMs, 30_000);
    // Values below 10 are clamped to 10 (seconds), so 5 → 10_000 ms
    assert.equal(parseOAuth2Config({ CLAWEB_OAUTH2_INTROSPECT_TTL: "5" }).introspectTtlMs, 10_000);
  });
});

describe("validateOAuth2Config", () => {
  it("emits no logs when oauth2 is disabled", () => {
    const calls = [];
    validateOAuth2Config(parseOAuth2Config({}), (...args) => calls.push(args));
    assert.equal(calls.length, 0);
  });

  it("warns when tokenUrl is missing and oauth2 is enabled", () => {
    const warns = [];
    validateOAuth2Config(parseOAuth2Config({ CLAWEB_OAUTH2_ENABLED: "true" }), (level, msg, fields) => {
      if (level === "warn") warns.push(fields);
    });
    assert.ok(warns.some((f) => f?.missing?.includes("CLAWEB_OAUTH2_TOKEN_URL")));
  });

  it("logs info with introspect flag when fully configured", () => {
    const infos = [];
    validateOAuth2Config(
      parseOAuth2Config({
        CLAWEB_OAUTH2_ENABLED: "true",
        CLAWEB_OAUTH2_TOKEN_URL: "https://auth.example.com/token",
        CLAWEB_OAUTH2_USERINFO_URL: "https://auth.example.com/userinfo",
        CLAWEB_OAUTH2_INTROSPECT_URL: "https://auth.example.com/introspect",
      }),
      (level, msg, fields) => {
        if (level === "info") infos.push({ msg, fields });
      }
    );
    assert.ok(infos.some((e) => e.msg === "oauth2_mode_enabled" && e.fields?.introspect === true));
  });
});
