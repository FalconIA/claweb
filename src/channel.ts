import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { ChannelPlugin, OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { buildAccountScopedDmSecurityPolicy } from "openclaw/plugin-sdk/channel-policy";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import { waitUntilAbort } from "openclaw/plugin-sdk/channel-runtime";
import { z } from "openclaw/plugin-sdk/zod";
import { buildInboundCtx } from "./inbound/build-ctx.js";
import { createWsDeliver } from "./outbound/deliver.js";
import { startWsServer } from "./server/ws-server.js";
import type { WsServerHandle } from "./server/ws-server.js";

type ClawebAccount = {
  accountId: string;
  enabled: boolean;
  listenHost: string;
  listenPort: number;
  authToken?: string;
  authTokenFile?: string;
  defaultAgentId?: string;
};

type ClawebConfigRoot = {
  enabled?: boolean;
  listenHost?: string;
  listenPort?: number;
  authToken?: string;
  authTokenFile?: string;
  defaultAgentId?: string;
  accounts?: Record<string, Partial<ClawebAccount>>;
};

const CHANNEL_ID = "claweb";

type ClawebTargetKind = "user" | "group";

type ClawebTarget = {
  id: string;
  kind: ClawebTargetKind;
};

function parseClawebTarget(input?: string | null, preferredKind?: string | null): ClawebTarget | null {
  let raw = input?.trim() ?? "";
  if (!raw) return null;

  const clawebPrefixed = raw.match(/^claweb:(.*)$/i);
  if (clawebPrefixed) {
    raw = clawebPrefixed[1]?.trim() ?? "";
    if (!raw) return null;
  }

  const kindPrefixed = raw.match(/^(user|dm|direct|room|group|channel):(.*)$/i);
  if (kindPrefixed) {
    const prefix = kindPrefixed[1].toLowerCase();
    const id = kindPrefixed[2]?.trim() ?? "";
    if (!id) return null;
    return {
      id,
      kind: prefix === "user" || prefix === "dm" || prefix === "direct" ? "user" : "group",
    };
  }

  return {
    id: raw,
    kind: preferredKind === "group" || preferredKind === "channel" ? "group" : "user",
  };
}

function normalizeClawebTarget(input?: string | null, preferredKind?: string | null): string {
  return parseClawebTarget(input, preferredKind)?.id ?? "";
}

function readClawebConfigRoot(cfg: OpenClawConfig): ClawebConfigRoot {
  return ((cfg as Record<string, unknown>).channels as Record<string, unknown> | undefined)?.claweb as ClawebConfigRoot;
}

function listClawebAccountIds(cfg: OpenClawConfig): string[] {
  const root = readClawebConfigRoot(cfg);
  const ids = Object.keys(root?.accounts ?? {});
  return ids.length > 0 ? ids : [DEFAULT_ACCOUNT_ID];
}

function resolveClawebAccount(cfg: OpenClawConfig, accountId?: string | null): ClawebAccount {
  const root = readClawebConfigRoot(cfg);
  const resolvedAccountId = accountId?.trim() || DEFAULT_ACCOUNT_ID;
  const accountPatch = root?.accounts?.[resolvedAccountId] ?? {};

  return {
    accountId: resolvedAccountId,
    enabled: accountPatch.enabled ?? root?.enabled ?? false,
    listenHost: accountPatch.listenHost ?? root?.listenHost ?? "127.0.0.1",
    listenPort: Number(accountPatch.listenPort ?? root?.listenPort ?? 18999),
    authToken: accountPatch.authToken ?? root?.authToken,
    authTokenFile: accountPatch.authTokenFile ?? root?.authTokenFile,
    defaultAgentId: accountPatch.defaultAgentId ?? root?.defaultAgentId,
  };
}

async function resolveAuthToken(account: ClawebAccount): Promise<string> {
  if (account.authToken?.trim()) {
    return account.authToken.trim();
  }
  if (account.authTokenFile?.trim()) {
    const raw = await readFile(account.authTokenFile.trim(), "utf8");
    return raw.trim();
  }
  return "";
}

let _pluginRuntime: PluginRuntime | undefined;

export function injectPluginRuntime(r: PluginRuntime): void {
  _pluginRuntime = r;
}

/** Active WS server handles keyed by accountId — used by the outbound adapter. */
const _wsHandles = new Map<string, WsServerHandle>();

/**
 * Test-only helper: inject a mock WsServerHandle and return a restore function.
 * Exposed as `__setWsHandleForTest` so tests can simulate an active account
 * without spinning up a real WebSocket server.
 */
export function __setWsHandleForTest(accountId: string, handle: WsServerHandle): () => void {
  _wsHandles.set(accountId, handle);
  return () => _wsHandles.delete(accountId);
}

export const clawebPlugin: ChannelPlugin<ClawebAccount> = {
  id: CHANNEL_ID,
  meta: {
    id: CHANNEL_ID,
    label: "CLAWeb",
    selectionLabel: "CLAWeb (WebSocket)",
    docsPath: "/channels/claweb",
    docsLabel: "claweb",
    blurb: "WebSocket bridge that routes browser text messages through OpenClaw channel pipeline.",
    order: 200,
    aliases: ["web", "ws"],
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.claweb"] },
  configSchema: buildChannelConfigSchema(z.object({}).passthrough()),
  security: {
    resolveDmPolicy: ({ cfg, accountId }) =>
      buildAccountScopedDmSecurityPolicy({
        cfg,
        channelKey: CHANNEL_ID,
        accountId,
        defaultPolicy: "allow_all",
      }),
  },
  config: {
    listAccountIds: (cfg) => listClawebAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveClawebAccount(cfg, accountId),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isConfigured: (account) => Boolean(account.authToken?.trim() || account.authTokenFile?.trim()),
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: Boolean(account.authToken?.trim() || account.authTokenFile?.trim()),
      baseUrl: `ws://${account.listenHost}:${account.listenPort}`,
    }),
  },
  messaging: {
    normalizeTarget: (raw) => normalizeClawebTarget(raw) || undefined,
    inferTargetChatType: ({ to }) => (parseClawebTarget(to)?.kind === "group" ? "group" : "direct"),
    targetResolver: {
      looksLikeId: (raw, normalized) => Boolean(parseClawebTarget(raw) ?? parseClawebTarget(normalized)),
      hint: "Use a CLAWeb userId or roomId, for example user:1 or room:room-main.",
      resolveTarget: async ({ input, normalized, preferredKind }) => {
        const target = parseClawebTarget(input, preferredKind) ?? parseClawebTarget(normalized, preferredKind);
        if (!target) return null;
        return {
          to: target.id,
          kind: target.kind,
          display: target.id,
          source: "normalized" as const,
        };
      },
    },
    formatTargetDisplay: ({ target, kind }) => `${kind === "group" ? "room" : "user"}:${target}`,
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = resolveClawebAccount(ctx.cfg, ctx.accountId);

      if (!account.enabled) {
        ctx.log?.info?.(`[claweb] account ${account.accountId} disabled, skip startup`);
        return waitUntilAbort(ctx.abortSignal);
      }

      const authToken = await resolveAuthToken(account);
      if (!authToken) {
        ctx.log?.warn?.(`[claweb] account ${account.accountId} missing authToken/authTokenFile`);
        return waitUntilAbort(ctx.abortSignal);
      }

      const core = ctx.channelRuntime as PluginRuntime["channel"] | undefined;
      if (!core) {
        ctx.log?.warn?.(`[claweb] channelRuntime not available, skipping account ${account.accountId}`);
        return waitUntilAbort(ctx.abortSignal);
      }
      const ws = await startWsServer({
        host: account.listenHost,
        port: account.listenPort,
        authToken,
        serverVersion: _pluginRuntime?.version ?? "unknown",
        onMessage: async ({ ws, userId, roomId, messageId, text, mediaUrl, mediaType, timestamp }) => {
          const cfg = _pluginRuntime?.config.loadConfig() ?? ctx.cfg;
          const chatType = roomId ? "group" : "direct";
          // Use || not ?? : roomId may be "" (empty string from FrontDoor config),
          // which passes the ?? null-check but is semantically "no room".
          const peerId = roomId || userId;
          const route = core.routing.resolveAgentRoute({
            cfg,
            channel: CHANNEL_ID,
            accountId: account.accountId,
            peer: {
              kind: chatType,
              id: peerId,
            },
          });

          if (mediaUrl) {
            ctx.log?.info?.(
              `[claweb] inbound media: type=${String(mediaType || "unknown")} url=${String(mediaUrl).slice(0, 120)}`
            );
          }

          const inboundCtx = await buildInboundCtx({
            runtime: _pluginRuntime!,
            channel: CHANNEL_ID,
            accountId: account.accountId,
            sessionKey: route.sessionKey,
            userId,
            roomId,
            text,
            mediaUrl,
            mediaType,
            messageId,
            timestamp,
          });

          const storePath = core.session.resolveStorePath(
            (cfg.session as Record<string, unknown> | undefined)?.store as string | undefined,
            { agentId: route.agentId }
          );

          await core.session.recordInboundSession({
            storePath,
            sessionKey: route.sessionKey,
            ctx: inboundCtx,
            onRecordError: (error: unknown) => {
              ctx.log?.warn?.(`[claweb] recordInboundSession failed: ${String(error)}`);
            },
          });

          await core.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: inboundCtx,
            cfg,
            dispatcherOptions: {
              deliver: createWsDeliver(ws, messageId, { userId, roomId }),
            },
          });
        },
      });

      ctx.log?.info?.(
        `[claweb] ws server started on ws://${account.listenHost}:${account.listenPort} (account=${account.accountId})`
      );

      _wsHandles.set(account.accountId, ws);

      await waitUntilAbort(ctx.abortSignal);
      _wsHandles.delete(account.accountId);
      await ws.close();
      ctx.log?.info?.(`[claweb] ws server stopped (account=${account.accountId})`);
    },
  },

  resolver: {
    resolveTargets: async ({ inputs, accountId, kind }) => {
      const handle = _wsHandles.get(accountId ?? DEFAULT_ACCOUNT_ID);
      const connectedUsers = new Set(handle?.connectedUserIds() ?? []);
      const connectedRooms = new Set(handle?.connectedRoomIds() ?? []);
      console.log(
        `[claweb][resolver] resolveTargets accountId=${accountId ?? DEFAULT_ACCOUNT_ID} handle=${handle ? "ok" : "MISSING"} connectedUsers=[${[...connectedUsers].join(",")}] connectedRooms=[${[...connectedRooms].join(",")}] inputs=${JSON.stringify(inputs)}`
      );
      return inputs.map((input) => {
        const target = parseClawebTarget(input, kind);
        if (!target) return { input, resolved: false, note: "empty target" };
        // Treat as resolved even when no client is currently connected — the
        // real error surfaces at send time if the connection is absent.
        const isConnected = connectedUsers.has(target.id) || connectedRooms.has(target.id);
        const hasClients = connectedUsers.size > 0 || connectedRooms.size > 0;
        const note =
          hasClients && !isConnected
            ? `"${target.id}" is not currently connected (neither userId nor roomId)`
            : undefined;
        return { input, resolved: true, id: target.id, name: target.id, note };
      });
    },
  },

  outbound: {
    deliveryMode: "gateway" as const,
    resolveTarget: ({ to }) => {
      const normalized = normalizeClawebTarget(to);
      if (!normalized) return { ok: false, error: new Error("claweb: target is empty") };
      return { ok: true, to: normalized };
    },
    sendText: async ({ to, text, accountId }) => {
      const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
      const handle = _wsHandles.get(resolvedAccountId);
      if (!handle) {
        throw new Error(`[claweb] no active WS server for account "${resolvedAccountId}" — is the channel running?`);
      }
      const target = normalizeClawebTarget(to);
      if (!target) {
        throw new Error("claweb: target is empty");
      }
      const messageId = randomUUID();
      const envelope = { type: "message" as const, id: messageId, role: "assistant" as const, text, proactive: true };
      // Try direct (userId) first, then group (roomId) broadcast.
      const userResult = handle.sendToUser(target, envelope);
      console.log(
        `[claweb][outbound] sendToUser("${target}") => ok=${userResult.ok}${"error" in userResult ? ` error=${userResult.error}` : ""}`
      );
      if (userResult.ok) {
        return { channel: CHANNEL_ID as "claweb", messageId, conversationId: target };
      }
      const roomResult = handle.sendToRoom(target, envelope);
      console.log(
        `[claweb][outbound] sendToRoom("${target}") => ok=${roomResult.ok}${"error" in roomResult ? ` error=${roomResult.error}` : ""}`
      );
      if (roomResult.ok) {
        return { channel: CHANNEL_ID as "claweb", messageId, conversationId: target };
      }
      throw new Error(
        `[claweb] sendText failed: target "${target}" is neither a connected userId nor roomId` +
          ` (user: ${userResult.error}; room: ${roomResult.error})`
      );
    },
  },
};
