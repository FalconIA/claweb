import { describe, it, expect } from "vitest";
import { clawebPlugin } from "./channel.js";

// ---------------------------------------------------------------------------
// Config fixture helpers
// ---------------------------------------------------------------------------

function makeCfg(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    channels: {
      claweb: {
        enabled: true,
        authToken: "test-token",
        listenHost: "127.0.0.1",
        listenPort: 18999,
        ...patch,
      },
    },
  };
}

function makeCfgWithAccounts(accounts: Record<string, Record<string, unknown>>): Record<string, unknown> {
  return {
    channels: {
      claweb: {
        enabled: true,
        authToken: "root-token",
        listenHost: "127.0.0.1",
        listenPort: 18999,
        accounts,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin shape
// ---------------------------------------------------------------------------

describe("clawebPlugin shape", () => {
  it("has correct id", () => {
    expect(clawebPlugin.id).toBe("claweb");
  });

  it("has meta label", () => {
    expect(clawebPlugin.meta?.label).toBe("CLAWeb");
  });

  it("supports direct and group chat types", () => {
    expect(clawebPlugin.capabilities?.chatTypes).toContain("direct");
    expect(clawebPlugin.capabilities?.chatTypes).toContain("group");
  });
});

// ---------------------------------------------------------------------------
// config.resolveAccount
// ---------------------------------------------------------------------------

describe("clawebPlugin config.resolveAccount", () => {
  it("resolves account from root config", () => {
    const account = clawebPlugin.config!.resolveAccount!(makeCfg() as any, undefined);
    expect(account.authToken).toBe("test-token");
    expect(account.listenHost).toBe("127.0.0.1");
    expect(account.listenPort).toBe(18999);
    expect(account.enabled).toBe(true);
  });

  it("falls back to defaults when fields missing", () => {
    const account = clawebPlugin.config!.resolveAccount!({ channels: { claweb: {} } } as any, undefined);
    expect(account.listenHost).toBe("127.0.0.1");
    expect(account.listenPort).toBe(18999);
    expect(account.enabled).toBe(false);
  });

  it("applies account-level patch over root", () => {
    const cfg = makeCfgWithAccounts({
      alice: { authToken: "alice-token", listenPort: 19001 },
    });
    const account = clawebPlugin.config!.resolveAccount!(cfg as any, "alice");
    expect(account.authToken).toBe("alice-token");
    expect(account.listenPort).toBe(19001);
    // host falls through to root
    expect(account.listenHost).toBe("127.0.0.1");
  });
});

// ---------------------------------------------------------------------------
// config.isConfigured
// ---------------------------------------------------------------------------

describe("clawebPlugin config.isConfigured", () => {
  it("returns true when authToken present", () => {
    const account = clawebPlugin.config!.resolveAccount!(makeCfg() as any, undefined);
    expect(clawebPlugin.config!.isConfigured!(account, undefined as any)).toBe(true);
  });

  it("returns true when authTokenFile present", () => {
    const account = clawebPlugin.config!.resolveAccount!(
      makeCfg({ authToken: undefined, authTokenFile: "/run/secrets/token" }) as any,
      undefined
    );
    expect(clawebPlugin.config!.isConfigured!(account, undefined as any)).toBe(true);
  });

  it("returns false when neither token field is set", () => {
    const account = clawebPlugin.config!.resolveAccount!(makeCfg({ authToken: undefined }) as any, undefined);
    expect(clawebPlugin.config!.isConfigured!(account, undefined as any)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// config.describeAccount
// ---------------------------------------------------------------------------

describe("clawebPlugin config.describeAccount", () => {
  it("reports correct baseUrl", () => {
    const account = clawebPlugin.config!.resolveAccount!(makeCfg() as any, undefined);
    const desc = clawebPlugin.config!.describeAccount!(account, undefined as any);
    expect(desc.baseUrl).toBe("ws://127.0.0.1:18999");
  });

  it("reports configured=true when token present", () => {
    const account = clawebPlugin.config!.resolveAccount!(makeCfg() as any, undefined);
    const desc = clawebPlugin.config!.describeAccount!(account, undefined as any);
    expect(desc.configured).toBe(true);
  });

  it("reports configured=false when no token", () => {
    const account = clawebPlugin.config!.resolveAccount!(makeCfg({ authToken: undefined }) as any, undefined);
    const desc = clawebPlugin.config!.describeAccount!(account, undefined as any);
    expect(desc.configured).toBe(false);
  });

  it("does not expose token value in description", () => {
    const account = clawebPlugin.config!.resolveAccount!(makeCfg() as any, undefined);
    const desc = clawebPlugin.config!.describeAccount!(account, undefined as any);
    expect(desc).not.toHaveProperty("authToken");
    expect(desc).not.toHaveProperty("token");
  });
});

// ---------------------------------------------------------------------------
// config.listAccountIds
// ---------------------------------------------------------------------------

describe("clawebPlugin config.listAccountIds", () => {
  it("returns default account id when no accounts block", () => {
    const ids = clawebPlugin.config!.listAccountIds!(makeCfg() as any);
    expect(ids).toEqual(["default"]);
  });

  it("returns explicit account ids when accounts block present", () => {
    const cfg = makeCfgWithAccounts({ alice: {}, bob: {} });
    const ids = clawebPlugin.config!.listAccountIds!(cfg as any);
    expect(ids).toContain("alice");
    expect(ids).toContain("bob");
    expect(ids).not.toContain("default");
  });
});

// ---------------------------------------------------------------------------
// security.resolveDmPolicy
// ---------------------------------------------------------------------------

describe("clawebPlugin security.resolveDmPolicy", () => {
  it("returns a policy object", () => {
    const account = clawebPlugin.config!.resolveAccount!(makeCfg() as any, undefined);
    const policy = clawebPlugin.security!.resolveDmPolicy!({
      cfg: makeCfg() as any,
      accountId: "default",
      account,
    });
    expect(policy).not.toBeNull();
    expect(typeof policy?.policy).toBe("string");
  });

  it("policy is allow_all", () => {
    const account = clawebPlugin.config!.resolveAccount!(makeCfg() as any, undefined);
    const policy = clawebPlugin.security!.resolveDmPolicy!({
      cfg: makeCfg() as any,
      accountId: "default",
      account,
    });
    expect(policy?.policy).toBe("allow_all");
  });
});
