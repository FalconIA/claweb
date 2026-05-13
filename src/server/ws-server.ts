import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";

type ClawebHelloFrame = {
  type: "hello";
  token: string;
  clientId?: string;
  userId?: string;
  roomId?: string;
};

type ClawebMessageFrame = {
  type: "message";
  id?: string;
  text?: string;
  mediaUrl?: string;
  mediaType?: string;
  timestamp?: number;
  /** Mux fields injected by FrontDoor on the shared connection. */
  userId?: string;
  roomId?: string;
  clientId?: string;
};

type ReadyFrame = {
  type: "ready";
  serverVersion: string;
};

type ErrorFrame = {
  type: "error";
  id?: string;
  message: string;
};

/** Connect frame sent by FrontDoor when a browser client authenticates. */
type MuxConnectFrame = {
  type: "connect";
  userId: string;
  roomId?: string;
  clientId: string;
};

/** Disconnect frame sent by FrontDoor when a browser client disconnects. */
type MuxDisconnectFrame = {
  type: "disconnect";
  userId: string;
  roomId?: string;
  clientId?: string;
};

type StartWsServerInput = {
  host: string;
  port: number;
  authToken: string;
  serverVersion: string;
  onMessage: (params: {
    ws: WebSocket;
    clientId: string;
    userId: string;
    roomId?: string;
    messageId: string;
    text: string;
    mediaUrl?: string;
    mediaType?: string;
    timestamp: number;
  }) => Promise<void>;
};

export type WsProactiveEnvelope = {
  type: "message";
  id: string;
  role: "assistant";
  text: string;
  proactive?: boolean;
  mediaUrl?: string;
  mediaType?: string;
  mediaDataUrl?: string;
  mediaFilename?: string;
};

export type WsProactiveSendResult = { ok: true } | { ok: false; error: string };

export type WsServerHandle = {
  close: () => Promise<void>;
  /** 向单个 userId 推送消息（direct 场景）。 */
  sendToUser: (userId: string, envelope: WsProactiveEnvelope) => WsProactiveSendResult;
  /** 向某个 roomId 内所有已连接客户端广播消息（group 场景）。 */
  sendToRoom: (roomId: string, envelope: WsProactiveEnvelope) => WsProactiveSendResult;
  connectedUserIds: () => string[];
  connectedRoomIds: () => string[];
};

function send(ws: WebSocket, frame: ReadyFrame | ErrorFrame): void {
  ws.send(JSON.stringify(frame));
}

function parseFrame(raw: unknown): unknown {
  if (typeof raw !== "string") {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isHelloFrame(frame: unknown): frame is ClawebHelloFrame {
  if (!frame || typeof frame !== "object") {
    return false;
  }
  const record = frame as Record<string, unknown>;
  return record.type === "hello" && typeof record.token === "string";
}

function isMessageFrame(frame: unknown): frame is ClawebMessageFrame {
  if (!frame || typeof frame !== "object") {
    return false;
  }
  const record = frame as Record<string, unknown>;
  if (record.type !== "message") return false;
  const hasText = typeof record.text === "string";
  const hasMedia = typeof record.mediaUrl === "string";
  return hasText || hasMedia;
}

function isMuxConnectFrame(frame: unknown): frame is MuxConnectFrame {
  if (!frame || typeof frame !== "object") return false;
  const r = frame as Record<string, unknown>;
  return r.type === "connect" && typeof r.userId === "string";
}

function isMuxDisconnectFrame(frame: unknown): frame is MuxDisconnectFrame {
  if (!frame || typeof frame !== "object") return false;
  const r = frame as Record<string, unknown>;
  return r.type === "disconnect" && typeof r.userId === "string";
}

export async function startWsServer(input: StartWsServerInput): Promise<WsServerHandle> {
  const httpServer: Server = createServer();
  const wss = new WebSocketServer({ server: httpServer });

  // Online presence tracked from mux connect/disconnect frames sent by FrontDoor.
  const onlineUsers = new Set<string>();
  const onlineRoomMembers = new Map<string, Set<string>>(); // roomId → Set<userId>

  // The single authenticated shared connection from FrontDoor.
  let sharedWs: WebSocket | null = null;

  wss.on("connection", (ws) => {
    let authed = false;

    ws.on("message", async (chunk) => {
      const parsed = parseFrame(chunk.toString());

      if (!authed) {
        if (!isHelloFrame(parsed)) {
          send(ws, { type: "error", message: "first frame must be hello" });
          ws.close(1008, "hello required");
          return;
        }
        if (parsed.token.trim() !== input.authToken.trim()) {
          send(ws, { type: "error", message: "auth failed" });
          ws.close(1008, "unauthorized");
          return;
        }
        authed = true;
        sharedWs = ws;
        console.log(`[claweb][ws-server] shared upstream connected (FrontDoor handshake ok)`);
        send(ws, { type: "ready", serverVersion: input.serverVersion });
        return;
      }

      // Multiplexed frames from FrontDoor.
      if (isMuxConnectFrame(parsed)) {
        const userId = parsed.userId.trim();
        const roomId = parsed.roomId?.trim();
        if (userId) onlineUsers.add(userId);
        if (roomId) {
          if (!onlineRoomMembers.has(roomId)) onlineRoomMembers.set(roomId, new Set());
          onlineRoomMembers.get(roomId)!.add(userId);
        }
        console.log(
          `[claweb][ws-server] mux connect userId=${userId} roomId=${roomId ?? "(none)"} onlineUsers=[${Array.from(onlineUsers).join(",")}]`
        );
        return;
      }

      if (isMuxDisconnectFrame(parsed)) {
        const userId = parsed.userId.trim();
        const roomId = parsed.roomId?.trim();
        onlineUsers.delete(userId);
        if (roomId) {
          const members = onlineRoomMembers.get(roomId);
          if (members) {
            members.delete(userId);
            if (members.size === 0) onlineRoomMembers.delete(roomId);
          }
        }
        console.log(
          `[claweb][ws-server] mux disconnect userId=${userId} roomId=${roomId ?? "(none)"} onlineUsers=[${Array.from(onlineUsers).join(",")}]`
        );
        return;
      }

      if (!isMessageFrame(parsed)) {
        // Unknown frame type on the shared connection — silently ignore
        // to avoid breaking the shared channel.
        return;
      }

      // Mux message frame: userId / roomId / clientId are injected by FrontDoor.
      const muxMsg = parsed as ClawebMessageFrame;
      const userId = typeof muxMsg.userId === "string" ? muxMsg.userId.trim() || "web-user" : "web-user";
      const roomId = typeof muxMsg.roomId === "string" ? muxMsg.roomId.trim() || undefined : undefined;
      const clientId = typeof muxMsg.clientId === "string" ? muxMsg.clientId.trim() : randomUUID();
      const text = typeof muxMsg.text === "string" ? muxMsg.text.trim() : "";
      const mediaUrl = typeof muxMsg.mediaUrl === "string" ? muxMsg.mediaUrl.trim() : "";
      const mediaType = typeof muxMsg.mediaType === "string" ? muxMsg.mediaType.trim() : "";
      const target = { kind: roomId ? ("room" as const) : ("user" as const), id: roomId ?? userId };

      if (!text && !mediaUrl) {
        ws.send(JSON.stringify({ type: "error", id: muxMsg.id, target, message: "text is empty" }));
        return;
      }

      const messageId = muxMsg.id?.trim() || randomUUID();
      const timestamp =
        typeof muxMsg.timestamp === "number" && Number.isFinite(muxMsg.timestamp) ? muxMsg.timestamp : Date.now();

      try {
        await input.onMessage({
          ws,
          clientId,
          userId,
          roomId,
          messageId,
          text,
          mediaUrl: mediaUrl || undefined,
          mediaType: mediaType || undefined,
          timestamp,
        });
      } catch (error) {
        ws.send(JSON.stringify({ type: "error", id: messageId, target, message: `dispatch failed: ${String(error)}` }));
      }
    });

    ws.on("close", () => {
      if (sharedWs === ws) {
        console.log(`[claweb][ws-server] shared upstream disconnected, clearing onlineUsers/Rooms`);
        sharedWs = null;
        onlineUsers.clear();
        onlineRoomMembers.clear();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(input.port, input.host, () => resolve());
  });

  function sendToShared(frame: object): WsProactiveSendResult {
    const isOpen = sharedWs?.readyState === 1;
    console.log(
      `[claweb][ws-server] sendToShared sharedWs=${sharedWs ? `readyState=${sharedWs.readyState}` : "null"} isOpen=${isOpen} frame=${JSON.stringify(frame).slice(0, 120)}`
    );
    if (!sharedWs || sharedWs.readyState !== 1 /* WebSocket.OPEN */) {
      return { ok: false, error: "no active upstream connection (FrontDoor not connected)" };
    }
    try {
      sharedWs.send(JSON.stringify(frame));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  return {
    close: async () => {
      onlineUsers.clear();
      onlineRoomMembers.clear();
      sharedWs = null;
      for (const client of wss.clients) {
        try {
          client.close();
        } catch {
          // ignore
        }
      }
      await new Promise<void>((resolve, reject) => {
        wss.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    },
    sendToUser: (userId, envelope) => sendToShared({ ...envelope, target: { kind: "user", id: userId } }),
    sendToRoom: (roomId, envelope) => sendToShared({ ...envelope, target: { kind: "room", id: roomId } }),
    connectedUserIds: () => Array.from(onlineUsers),
    connectedRoomIds: () => Array.from(onlineRoomMembers.keys()),
  };
}
