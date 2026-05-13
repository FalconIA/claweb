import { describe, it, expect, vi } from "vitest";
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

  it("routes outbound sends through the gateway", () => {
    expect(clawebPlugin.outbound!.deliveryMode).toBe("gateway");
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

// ---------------------------------------------------------------------------
// resolver.resolveTargets
// ---------------------------------------------------------------------------

describe("clawebPlugin resolver.resolveTargets", () => {
  it("resolves a non-empty userId target", async () => {
    const results = await clawebPlugin.resolver!.resolveTargets({
      cfg: makeCfg() as any,
      accountId: "default",
      inputs: ["user-guest-a"],
      kind: "user",
      runtime: {} as any,
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.resolved).toBe(true);
    expect(results[0]!.id).toBe("user-guest-a");
  });

  it("normalizes prefixed targets", async () => {
    const results = await clawebPlugin.resolver!.resolveTargets({
      cfg: makeCfg() as any,
      accountId: "default",
      inputs: ["user:1", "room:room-main"],
      kind: "user",
      runtime: {} as any,
    });
    expect(results[0]!.resolved).toBe(true);
    expect(results[0]!.id).toBe("1");
    expect(results[1]!.resolved).toBe(true);
    expect(results[1]!.id).toBe("room-main");
  });

  it("marks empty string input as unresolved", async () => {
    const results = await clawebPlugin.resolver!.resolveTargets({
      cfg: makeCfg() as any,
      accountId: "default",
      inputs: [""],
      kind: "user",
      runtime: {} as any,
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.resolved).toBe(false);
  });

  it("resolves multiple inputs", async () => {
    const results = await clawebPlugin.resolver!.resolveTargets({
      cfg: makeCfg() as any,
      accountId: "default",
      inputs: ["user-a", "user-b", ""],
      kind: "user",
      runtime: {} as any,
    });
    expect(results).toHaveLength(3);
    expect(results[0]!.resolved).toBe(true);
    expect(results[1]!.resolved).toBe(true);
    expect(results[2]!.resolved).toBe(false);
  });

  it("preserves the original input string in each result", async () => {
    const results = await clawebPlugin.resolver!.resolveTargets({
      cfg: makeCfg() as any,
      accountId: "default",
      inputs: ["user-guest-a"],
      kind: "user",
      runtime: {} as any,
    });
    expect(results[0]!.input).toBe("user-guest-a");
  });
});

// ---------------------------------------------------------------------------
// messaging.targetResolver
// ---------------------------------------------------------------------------

describe("clawebPlugin messaging.targetResolver", () => {
  it("treats opaque CLAWeb ids as target ids", () => {
    expect(clawebPlugin.messaging!.targetResolver!.looksLikeId!("1")).toBe(true);
    expect(clawebPlugin.messaging!.targetResolver!.looksLikeId!("room-main")).toBe(true);
  });

  it("resolves a bare userId target for message send", async () => {
    const result = await clawebPlugin.messaging!.targetResolver!.resolveTarget!({
      cfg: makeCfg() as any,
      accountId: "default",
      input: "1",
      normalized: "1",
      preferredKind: "user",
    });
    expect(result).toEqual({
      to: "1",
      kind: "user",
      display: "1",
      source: "normalized",
    });
  });

  it("resolves prefixed user and room targets", async () => {
    const user = await clawebPlugin.messaging!.targetResolver!.resolveTarget!({
      cfg: makeCfg() as any,
      accountId: "default",
      input: "user:1",
      normalized: "1",
      preferredKind: "user",
    });
    const room = await clawebPlugin.messaging!.targetResolver!.resolveTarget!({
      cfg: makeCfg() as any,
      accountId: "default",
      input: "room:room-main",
      normalized: "room-main",
      preferredKind: "group",
    });
    expect(user?.to).toBe("1");
    expect(user?.kind).toBe("user");
    expect(room?.to).toBe("room-main");
    expect(room?.kind).toBe("group");
  });

  it("normalizes explicit targets through messaging.normalizeTarget", () => {
    expect(clawebPlugin.messaging!.normalizeTarget!("user:1")).toBe("1");
    expect(clawebPlugin.messaging!.normalizeTarget!("room:room-main")).toBe("room-main");
  });
});

// ---------------------------------------------------------------------------
// outbound.resolveTarget
// ---------------------------------------------------------------------------

describe("clawebPlugin outbound.resolveTarget", () => {
  it("returns ok=true for a valid userId", () => {
    const result = clawebPlugin.outbound!.resolveTarget!({ to: "user-guest-a" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.to).toBe("user-guest-a");
  });

  it("trims whitespace from target", () => {
    const result = clawebPlugin.outbound!.resolveTarget!({ to: "  user-a  " });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.to).toBe("user-a");
  });

  it("normalizes user and room prefixes", () => {
    const user = clawebPlugin.outbound!.resolveTarget!({ to: "user:1" });
    const room = clawebPlugin.outbound!.resolveTarget!({ to: "room:room-main" });
    expect(user.ok).toBe(true);
    if (user.ok) expect(user.to).toBe("1");
    expect(room.ok).toBe(true);
    if (room.ok) expect(room.to).toBe("room-main");
  });

  it("returns ok=false for empty target", () => {
    const result = clawebPlugin.outbound!.resolveTarget!({ to: "" });
    expect(result.ok).toBe(false);
  });

  it("returns ok=false for whitespace-only target", () => {
    const result = clawebPlugin.outbound!.resolveTarget!({ to: "   " });
    expect(result.ok).toBe(false);
  });

  it("returns ok=false for empty prefixed targets", () => {
    expect(clawebPlugin.outbound!.resolveTarget!({ to: "user:" }).ok).toBe(false);
    expect(clawebPlugin.outbound!.resolveTarget!({ to: "room:" }).ok).toBe(false);
    expect(clawebPlugin.outbound!.resolveTarget!({ to: "claweb:" }).ok).toBe(false);
  });

  it("returns ok=false when to is undefined", () => {
    const result = clawebPlugin.outbound!.resolveTarget!({ to: undefined });
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// outbound.sendText — no active server
// ---------------------------------------------------------------------------

describe("clawebPlugin outbound.sendText without active server", () => {
  it("throws when no WS server is running for the account", async () => {
    await expect(
      clawebPlugin.outbound!.sendText!({
        cfg: makeCfg() as any,
        to: "user-guest-a",
        text: "Hello",
        accountId: "non-existent-account",
        identity: undefined,
      })
    ).rejects.toThrow(/no active WS server/);
  });
});

// ---------------------------------------------------------------------------
// outbound.sendText — with a mock WS handle
// ---------------------------------------------------------------------------

describe("clawebPlugin outbound.sendText with mock handle", () => {
  it("calls sendToUser and returns a delivery result", async () => {
    // Reach into the module-level handle map via the gateway hook pattern
    // by injecting a mock handle through the test-accessible __wsHandles export.
    const sendToUser = vi.fn().mockReturnValue({ ok: true });
    const mockHandle = {
      close: vi.fn(),
      sendToUser,
      sendToRoom: vi.fn().mockReturnValue({ ok: false, error: "not a room" }),
      connectedUserIds: () => ["user-guest-a"],
      connectedRoomIds: () => [],
    };

    // Access the internal handle map indirectly — import the setter exposed for tests.
    const mod = await import("./channel.js");
    // Use the test-only inject helper if available, else skip gracefully.
    if (typeof (mod as any).__setWsHandleForTest !== "function") {
      return;
    }
    const restore = (mod as any).__setWsHandleForTest("test-account", mockHandle);
    try {
      const result = await clawebPlugin.outbound!.sendText!({
        cfg: makeCfg() as any,
        to: "user-guest-a",
        text: "Hi there",
        accountId: "test-account",
        identity: undefined,
      });
      expect(sendToUser).toHaveBeenCalledOnce();
      const [userId, envelope] = sendToUser.mock.calls[0]!;
      expect(userId).toBe("user-guest-a");
      expect(envelope.text).toBe("Hi there");
      expect(envelope.role).toBe("assistant");
      expect(envelope.proactive).toBe(true);
      expect(result.messageId).toBeTruthy();
      expect(result.conversationId).toBe("user-guest-a");
    } finally {
      restore();
    }
  });

  it("normalizes prefixed targets before sending", async () => {
    const sendToUser = vi.fn().mockReturnValue({ ok: true });
    const mockHandle = {
      close: vi.fn(),
      sendToUser,
      sendToRoom: vi.fn().mockReturnValue({ ok: false, error: "not a room" }),
      connectedUserIds: () => ["1"],
      connectedRoomIds: () => [],
    };

    const mod = await import("./channel.js");
    if (typeof (mod as any).__setWsHandleForTest !== "function") return;
    const restore = (mod as any).__setWsHandleForTest("test-account-prefixed", mockHandle);
    try {
      const result = await clawebPlugin.outbound!.sendText!({
        cfg: makeCfg() as any,
        to: "user:1",
        text: "Hi there",
        accountId: "test-account-prefixed",
        identity: undefined,
      });
      expect(sendToUser).toHaveBeenCalledWith("1", expect.objectContaining({ text: "Hi there" }));
      expect(result.conversationId).toBe("1");
    } finally {
      restore();
    }
  });

  it("normalizes room prefixes before room fallback", async () => {
    const sendToUser = vi.fn().mockReturnValue({ ok: false, error: "no active connection" });
    const sendToRoom = vi.fn().mockReturnValue({ ok: true });
    const mockHandle = {
      close: vi.fn(),
      sendToUser,
      sendToRoom,
      connectedUserIds: () => [],
      connectedRoomIds: () => ["room-main"],
    };

    const mod = await import("./channel.js");
    if (typeof (mod as any).__setWsHandleForTest !== "function") return;
    const restore = (mod as any).__setWsHandleForTest("test-account-prefixed-room", mockHandle);
    try {
      const result = await clawebPlugin.outbound!.sendText!({
        cfg: makeCfg() as any,
        to: "room:room-main",
        text: "Hello room",
        accountId: "test-account-prefixed-room",
        identity: undefined,
      });
      expect(sendToUser).toHaveBeenCalledWith("room-main", expect.anything());
      expect(sendToRoom).toHaveBeenCalledWith("room-main", expect.objectContaining({ text: "Hello room" }));
      expect(result.conversationId).toBe("room-main");
    } finally {
      restore();
    }
  });

  it("throws when both sendToUser and sendToRoom fail", async () => {
    const sendToUser = vi.fn().mockReturnValue({ ok: false, error: "no active connection" });
    const sendToRoom = vi.fn().mockReturnValue({ ok: false, error: "no active connections for roomId" });
    const mockHandle = {
      close: vi.fn(),
      sendToUser,
      sendToRoom,
      connectedUserIds: () => [],
      connectedRoomIds: () => [],
    };

    const mod = await import("./channel.js");
    if (typeof (mod as any).__setWsHandleForTest !== "function") return;
    const restore = (mod as any).__setWsHandleForTest("test-account-fail", mockHandle);
    try {
      await expect(
        clawebPlugin.outbound!.sendText!({
          cfg: makeCfg() as any,
          to: "unknown-target",
          text: "Hello",
          accountId: "test-account-fail",
          identity: undefined,
        })
      ).rejects.toThrow(/neither a connected userId nor roomId/);
    } finally {
      restore();
    }
  });

  it("falls back to sendToRoom when userId not found", async () => {
    const sendToUser = vi.fn().mockReturnValue({ ok: false, error: "no active connection" });
    const sendToRoom = vi.fn().mockReturnValue({ ok: true });
    const mockHandle = {
      close: vi.fn(),
      sendToUser,
      sendToRoom,
      connectedUserIds: () => [],
      connectedRoomIds: () => ["room-main"],
    };

    const mod = await import("./channel.js");
    if (typeof (mod as any).__setWsHandleForTest !== "function") return;
    const restore = (mod as any).__setWsHandleForTest("test-account-room", mockHandle);
    try {
      const result = await clawebPlugin.outbound!.sendText!({
        cfg: makeCfg() as any,
        to: "room-main",
        text: "Hello room",
        accountId: "test-account-room",
        identity: undefined,
      });
      expect(sendToUser).toHaveBeenCalledOnce();
      expect(sendToRoom).toHaveBeenCalledOnce();
      const [roomId, envelope] = sendToRoom.mock.calls[0]!;
      expect(roomId).toBe("room-main");
      expect(envelope.text).toBe("Hello room");
      expect(result.conversationId).toBe("room-main");
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// resolver.resolveTargets — roomId awareness
// ---------------------------------------------------------------------------

describe("clawebPlugin resolver.resolveTargets roomId awareness", () => {
  it("resolves a roomId target without a note when room is connected", async () => {
    const mockHandle = {
      close: vi.fn(),
      sendToUser: vi.fn(),
      sendToRoom: vi.fn(),
      connectedUserIds: () => [],
      connectedRoomIds: () => ["room-main"],
    };
    const mod = await import("./channel.js");
    if (typeof (mod as any).__setWsHandleForTest !== "function") return;
    const restore = (mod as any).__setWsHandleForTest("test-account-resolver", mockHandle);
    try {
      const results = await clawebPlugin.resolver!.resolveTargets({
        cfg: makeCfg() as any,
        accountId: "test-account-resolver",
        inputs: ["room-main"],
        kind: "group",
        runtime: {} as any,
      });
      expect(results[0]!.resolved).toBe(true);
      expect(results[0]!.note).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("attaches a note when target matches neither userId nor roomId", async () => {
    const mockHandle = {
      close: vi.fn(),
      sendToUser: vi.fn(),
      sendToRoom: vi.fn(),
      connectedUserIds: () => ["user-a"],
      connectedRoomIds: () => ["room-main"],
    };
    const mod = await import("./channel.js");
    if (typeof (mod as any).__setWsHandleForTest !== "function") return;
    const restore = (mod as any).__setWsHandleForTest("test-account-resolver2", mockHandle);
    try {
      const results = await clawebPlugin.resolver!.resolveTargets({
        cfg: makeCfg() as any,
        accountId: "test-account-resolver2",
        inputs: ["unknown-id"],
        kind: "user",
        runtime: {} as any,
      });
      expect(results[0]!.resolved).toBe(true); // still resolved; error at send time
      expect(results[0]!.note).toMatch(/neither userId nor roomId/);
    } finally {
      restore();
    }
  });
});
