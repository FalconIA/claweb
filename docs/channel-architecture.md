# CLAWeb 通道架构

CLAWeb 是一个 **OpenClaw 面向客户端的通道（Channel）**，而非单纯的浏览器聊天页面。

本仓库包含的浏览器 UI 是**第一个参考客户端**，但通道本身可被多种客户端复用：

- 浏览器 Web
- 移动端 / App Shell
- 桌面客户端
- 嵌入式 Webview
- 未来的第一方或第三方客户端

---

## 整体架构图

下图展示了从 Web 客户端到 OpenClaw 核心的完整数据流，包括入站（用户消息）和出站（AI 回复及主动消息）两个方向。

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Web 客户端（浏览器 / App）                        │
│                          clients/browser/  或其他客户端                     │
└───────────────────┬─────────────────────────────────────┬───────────────────┘
                    │  HTTP GET /history                  │  WebSocket /ws
                    │  HTTP POST /login                   │  ① hello frame
                    │                                     │  ② ready frame
                    ▼                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         参考接入层：FrontDoor                               │
│                         access/frontdoor/server.js                          │
│                                                                             │
│  职责：                                                                     │
│  • /login  — 身份认证，颁发短期 session token                              │
│  • /history — 读取 / 追加本地 JSONL 历史记录                               │
│  • /ws     — WebSocket 代理：验证 token → 转发 hello 帧给上游              │
│                              上游 AI 回复 → 转发给客户端                    │
└───────────────────┬─────────────────────────────────────┬───────────────────┘
                    │  WebSocket（上游）                  │  WebSocket（下游）
                    │  hello { userId, roomId, token }    │  message / ready / error
                    │                                     │
                    ▼                                     │
┌─────────────────────────────────────────────────────────────────────────────┐
│                      CLAWeb 通道插件（Channel Plugin）                      │
│                      src/channel.ts · src/server/ws-server.ts              │
│                                                                             │
│  入站流程（Inbound）：                                                      │
│  WS frame ──► ws-server 解帧 ──► build-ctx ──► session 记录                 │
│              ──► dispatchReply ──► OpenClaw Agent                           │
│                                                                             │
│  出站流程（Outbound / 主动发送）：                                          │
│  outbound.sendText ──► sendToUser(userId)  [direct]                         │
│                    └──► sendToRoom(roomId) [group，广播给房间内所有连接]    │
│                                                                             │
│  目标解析（messaging.targetResolver / resolver.resolveTargets）：           │
│  "--target <id>" ──► 规范为 userId / roomId ──► gateway outbound            │
└───────────────────┬─────────────────────────────────────────────────────────┘
                    │  OpenClaw Plugin SDK
                    │  • routing.resolveAgentRoute()
                    │  • session.recordInboundSession()
                    │  • reply.dispatchReplyWithBufferedBlockDispatcher()
                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            OpenClaw 核心运行时                              │
│                                                                             │
│  • Agent 路由 & 会话管理                                                    │
│  • LLM 调用（流式 / 非流式）                                                │
│  • 历史记录持久化                                                           │
│  • 工具调用 & 媒体处理                                                      │
│  • openclaw message send --channel claweb --target <userId|roomId>          │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 数据流说明

#### 入站：用户 → AI

```
Web客户端
  │  WS message { type:"message", text:"Hi", id:"..." }
  ▼
FrontDoor /ws
  │  验证 session token → 透传给上游
  ▼
CLAWeb 插件 ws-server.ts
  │  解帧 → 提取 userId / roomId / text
  ▼
build-ctx.ts → 构建 inbound context（含媒体下载）
  ▼
OpenClaw 路由 → Agent 推理 → 流式 deliver → ws-server
  │  WsEnvelope { type:"message", role:"assistant", text:"..." }
  ▼
Web客户端 收到回复
```

#### 出站：主动发送（CLI / Agent Tool）

```
openclaw message send --channel claweb --target <id> --message "..."
  │
  │  <id> 可以是：
  │    userId / user:<userId>  → hello/connect 帧中携带的用户 ID（direct 场景，单播）
  │    roomId / room:<roomId>  → hello/connect 帧中携带的房间 ID（group 场景，广播）
  ▼
OpenClaw message tool
  │  messaging.targetResolver 规范目标（例如 user:1 → 1，room:main → main）
  │  通过 gateway delivery 调用 CLAWeb outbound
  ▼
outbound.sendText
  │  1. sendToUser(<id>)  → 命中则单播给该 userId
  │  2. sendToRoom(<id>)  → 未命中则广播给该 roomId 的所有连接
  │  3. 两者均失败 → 抛出错误
  ▼
ws-server
  │  sessions / rooms → ws.send(JSON.stringify(envelope))
  ▼
FrontDoor
  │  目标在线：推送给 Web 客户端，并写入该客户端历史
  │  目标离线：按已知 session / login 配置写入对应历史，等待下次打开回放
  ▼
Web客户端 收到主动推送或下次打开时从历史恢复
```

---

## 分层模型

### 第一层：通道运行时（Channel Runtime）

这是 OpenClaw 内部的 CLAWeb 通道核心层。

职责：
- 通道注册与插件 SDK 对接
- WS 帧流转（`hello → ready → message`）
- 会话语义（session key、路由、历史）
- 回复语义（流式聚合、媒体处理）
- 主动发送（`messaging.targetResolver` + gateway `outbound` 适配器）
- 与 OpenClaw 标准输出兼容（`MEDIA:`、`mediaUrl`、`mediaUrls`）

代码位置：
- `index.ts`
- `src/channel.ts`
- `src/server/ws-server.ts`
- `src/inbound/build-ctx.ts`
- `src/outbound/deliver.ts`

该层是**通道本体**，应尽量保持对客户端无感知。

### 第二层：参考接入层（Reference Access Layer）

该层将通道暴露给客户端应用。

职责：
- `/login` — 身份认证，颁发 session token
- `/history` — 历史记录读取 / 持久化
- `/ws` — 向上游 CLAWeb 通道做 WebSocket 代理
- 主机端 session 引导
- 历史记录回放

代码位置：
- `access/frontdoor/`
- `docs/browser-client-integration.md`
- `docs/state-model.md`

该层不是通道核心，但它是**客户端访问通道的参考方式**。

### 第三层：参考客户端（Reference Clients）

该层包含消费通道的客户端实现。

当前第一个参考客户端：
- `clients/browser/` — 浏览器客户端

职责可能包括：
- 渲染与 UI
- 乐观 UI 更新
- 断线重连
- 上传交互
- 回复 UI
- 媒体展示

注意：
- 参考客户端**不等于**通道定义
- 浏览器**不是**唯一合法的 CLAWeb 客户端形态
- 未来的 App / 桌面客户端应复用相同的通道语义

---

## 仓库思维模型

在本仓库工作时，按以下优先级思考：

1. **通道语义优先**
2. **接入契约其次**
3. **参考客户端行为最后**

这意味着：
- 不要仅凭浏览器 UI 来定义 CLAWeb
- 不要让某个客户端重新定义协议语义
- 不要将人设 / Prompt / 业务逻辑推入通道仓库

---

## 非目标

CLAWeb 不应成为：
- 仅限浏览器的项目
- 私有伴侣 Shell
- 人设 / Prompt 仓库
- 视频生成编排层
- 特定客户端的协议分支

---

## 实用判断标准

对未来变更的一个好测试：

> 如果浏览器客户端明天消失，底层 CLAWeb 通道契约对 App / 桌面 / 其他客户端依然有意义吗？

如果答案是否，说明设计可能过度依赖浏览器特性。
