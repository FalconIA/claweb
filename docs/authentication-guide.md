# CLAWeb 认证指南

本文档介绍 CLAWeb frontdoor 参考宿主所支持的两种认证模式、它们如何协同工作，以及各自的配置方法。

---

## 1. 概览

frontdoor 通过一个环境变量控制两种认证模式的切换：

| 模式 | 环境变量 | 说明 |
|------|---------|------|
| `passphrase` | *(默认，无需设置)* | 通过 JSON 配置文件或环境变量维护固定的凭据映射 |
| `oauth2` | `CLAWEB_OAUTH2_ENABLED=true` | 将登录委托给**外部** OAuth 2.0 / OIDC 提供商，所有端点地址均可配置 |

两种模式互斥。设置 `CLAWEB_OAUTH2_ENABLED=true` 后，密语登录路由将被禁用；未设置时，OAuth2 路由不会注册。

两种模式的共同点：

- 产出完全相同的 session 对象：`{ token, identity, displayName, userId, roomId, clientId, wsUrl }`
- WebSocket 升级流程（`/ws`）完全一致——浏览器发送携带 session token 的 `hello` 帧，其余逻辑不变
- 前端通过 `GET /config` 读取 `authMode` 字段，自动切换 UI 显示

---

## 2. 密语模式（默认）

### 工作原理

```
   Browser              frontdoor              Config / Env
      |                     |                        |
      |-- POST /login ----> |                        |
      |   { passphrase }    |-- loadLoginConfig() -> |
      |                     |<-- identity map -------|
      |                     |   findByPassphrase()   |
      |                     |   buildSession()       |
      |<-- { ok, session } -|                        |
      |                     |                        |
      |-- WS /ws ---------> |                        |
      |   hello: token      |                        |
```

frontdoor 在启动时（以及文件 mtime 变化时热重载）从两个来源解析凭据：

1. **JSON 配置文件** — 路径由 `CLAWEB_LOGIN_CONFIG` 指定
2. **环境变量** — `CLAWEB_LOGIN_<N>_*` 槽位（键冲突时环境变量优先覆盖文件配置）

### 配置文件格式

```json
{
  "alice": {
    "displayName": "Alice",
    "passphrases": ["my-secret-phrase"],
    "userId": "user-alice",
    "roomId": "room-main",
    "clientId": "alice-fixed"
  },
  "bob": {
    "displayName": "Bob",
    "passphrases": ["another-phrase", "legacy-phrase"],
    "userId": "user-bob",
    "roomId": "room-main",
    "clientId": "bob-fixed"
  }
}
```

顶层键为身份名称。`passphrases` 为数组，允许多个密语映射到同一身份（便于轮换）。若一个密语匹配到多个身份，则返回 HTTP 500（`ambiguous_passphrase`），视为配置错误。

### 环境变量槽位

每个槽位通过数字索引 `<N>`（1、2、3、…）标识：

| 变量 | 是否必填 | 说明 |
|------|---------|------|
| `CLAWEB_LOGIN_<N>_NAME` | 是 | 身份键名（必须唯一） |
| `CLAWEB_LOGIN_<N>_DISPLAY_NAME` | — | 用于界面显示的名称 |
| `CLAWEB_LOGIN_<N>_PASSPHRASE` | 二选一 | 单个密语 |
| `CLAWEB_LOGIN_<N>_PASSPHRASES` | 二选一 | 逗号分隔的多个密语 |
| `CLAWEB_LOGIN_<N>_USER_ID` | — | session 中携带的 `userId` |
| `CLAWEB_LOGIN_<N>_ROOM_ID` | — | session 中携带的 `roomId` |
| `CLAWEB_LOGIN_<N>_CLIENT_ID` | — | session 中携带的 `clientId` |

仅使用环境变量配置两个身份的示例：

```bash
CLAWEB_LOGIN_1_NAME=alice
CLAWEB_LOGIN_1_DISPLAY_NAME="Alice"
CLAWEB_LOGIN_1_PASSPHRASE=my-secret-phrase
CLAWEB_LOGIN_1_USER_ID=user-alice
CLAWEB_LOGIN_1_ROOM_ID=room-main

CLAWEB_LOGIN_2_NAME=bob
CLAWEB_LOGIN_2_DISPLAY_NAME="Bob"
CLAWEB_LOGIN_2_PASSPHRASES=primary-phrase,legacy-phrase
CLAWEB_LOGIN_2_USER_ID=user-bob
CLAWEB_LOGIN_2_ROOM_ID=room-main
```

### 密语模式下的前端行为

`GET /config` 返回 `{ authMode: "passphrase", ... }`。

登录面板显示密语输入框和登录按钮。登录成功后，session 存入 `localStorage`，聊天面板随即展示。

---

## 3. OAuth2 模式

### 概念说明

OAuth2 密码模式（Resource Owner Password Credentials，ROPC，`grant_type=password`）由**外部提供商**（Keycloak、Authentik、Authelia、Zitadel 等支持 ROPC 的自托管 OIDC 服务）验证用户凭据。用户在 CLAWeb 登录页直接输入用户名和密码，frontdoor 将凭据转发至提供商的令牌端点换取 access_token，再调用 userinfo 端点获取用户信息，最终建立 session 返回给浏览器。

所有提供商端点地址均通过环境变量配置，frontdoor 实现本身**不对任何特定提供商做任何假设**。

> **注意**：ROPC 流程中用户凭据会经由 frontdoor 中转，请仅在 frontdoor 处于完全受信任的内网环境下使用。GitHub、Google 等公共提供商不支持此模式。

### 请求流程

```
   Browser               frontdoor                External OAuth2 Provider
      |                       |                              |
      | [enter user + pwd]    |                              |
      |-- POST /oauth2/login->|                              |
      |   { username, pwd }   | POST OAUTH2_TOKEN_URL        |
      |                       |   grant_type=password        |
      |                       |   username=…                |
      |                       |   password=…                |
      |                       |   client_id=…               |
      |                       |   client_secret=…           |
      |                       |   scope=…                   |
      |                       |<-- { access_token, … } -----|
      |                       | GET OAUTH2_USERINFO_URL      |
      |                       |   Authorization: Bearer …   |
      |                       |<-- { sub, name, email, … } -|
      |                       | map userinfo→buildSession()  |
      |<-- { ok, session } ---|                              |
      |                       |                              |
      |-- WS /ws hello: token>|                              |
```

### 必填环境变量

| 变量 | 说明 |
|------|------|
| `CLAWEB_OAUTH2_ENABLED` | 设为 `true` 以启用 OAuth2 密码模式 |
| `CLAWEB_OAUTH2_CLIENT_ID` | 提供商颁发的 Client ID |
| `CLAWEB_OAUTH2_CLIENT_SECRET` | Client Secret 明文（与 `_FILE` 二选一） |
| `CLAWEB_OAUTH2_CLIENT_SECRET_FILE` | 包含 Client Secret 的文件路径 |
| `CLAWEB_OAUTH2_TOKEN_URL` | 提供商令牌端点，例如 `https://provider.example.com/oauth/token` |
| `CLAWEB_OAUTH2_USERINFO_URL` | 提供商 UserInfo Endpoint，例如 `https://provider.example.com/userinfo`；若已设置 `CLAWEB_OAUTH2_USERINFO_IN_TOKEN` 则可省略 |

### 可选环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CLAWEB_OAUTH2_SCOPE` | `openid profile email` | 空格分隔的 OAuth2 权限范围 |
| `CLAWEB_OAUTH2_USERINFO_ID_FIELD` | `sub` | userinfo 响应中用作 `identity` / `userId` 的字段。Keycloak 用 `preferred_username` |
| `CLAWEB_OAUTH2_USERINFO_NAME_FIELD` | `name` | userinfo 响应中用作 `displayName` 的字段 |
| `CLAWEB_OAUTH2_USERINFO_IN_TOKEN` | *(空)* | 当提供商在令牌响应中内嵌用户信息时，填写该字段名（如 `user_info`）；设置后无需 `CLAWEB_OAUTH2_USERINFO_URL` |
| `CLAWEB_OAUTH2_INTROSPECT_URL` | *(空)* | 令牌自省端点（RFC 7662 / Spring `/oauth/check_token`）；设置后 frontdoor 将定期调用此端点验证 session 关联的 `access_token` 是否仍处于 `active` 状态 |
| `CLAWEB_OAUTH2_INTROSPECT_TTL` | `60` | 自省结果缓存秒数；在此 TTL 内对同一 session 的请求不重复调用自省端点 |
| `CLAWEB_OAUTH2_DEFAULT_ROOM_ID` | *(空)* | 所有 OAuth2 session 的默认 `roomId` |
| `CLAWEB_OAUTH2_DEFAULT_CLIENT_ID_PREFIX` | *(空)* | 拼接在身份值前作为 `clientId` 前缀 |

### 各提供商快速配置

#### 标准 OIDC（Keycloak、Authentik、Authelia、Zitadel 等）

在 Keycloak 中需在客户端设置里开启 **Direct Access Grants**；其他 OIDC 提供商名称可能不同，但均需启用 ROPC / 直接访问授权。

```bash
CLAWEB_OAUTH2_ENABLED=true
CLAWEB_OAUTH2_CLIENT_ID=claweb
CLAWEB_OAUTH2_CLIENT_SECRET_FILE=/run/secrets/oauth2_client_secret
CLAWEB_OAUTH2_TOKEN_URL=https://auth.internal.example.com/realms/myrealm/protocol/openid-connect/token
CLAWEB_OAUTH2_USERINFO_URL=https://auth.internal.example.com/realms/myrealm/protocol/openid-connect/userinfo
CLAWEB_OAUTH2_SCOPE=openid profile email
CLAWEB_OAUTH2_USERINFO_ID_FIELD=preferred_username
CLAWEB_OAUTH2_USERINFO_NAME_FIELD=name
```

#### 通用 OIDC（自动发现）

查阅提供商的 `<base>/.well-known/openid-configuration` 发现文档，找到以下字段并确认该 client 已启用 ROPC / 直接访问授权：

- `token_endpoint` → `CLAWEB_OAUTH2_TOKEN_URL`
- `userinfo_endpoint` → `CLAWEB_OAUTH2_USERINFO_URL`

### OAuth2 模式下的前端行为

`GET /config` 返回 `{ authMode: "oauth2", ... }`。

密语输入框被替换为**用户名**和**密码**两个输入框，提交后 `POST /oauth2/login`。成功后前端直接收到 `{ ok, session }`，后续流程与密语登录完全一致。

---

## 4. Session 对象

两种模式产出完全相同的 session 结构，存储在 `localStorage` 的 `claweb:session:v1` 键下。

```jsonc
{
  "identity":    "alice",            // 内部标识用户的键名
  "displayName": "Alice",            // 界面显示名称
  "token":       "tok_<uuid>",       // frontdoor 短期 session 令牌
  "userId":      "user-alice",       // 通过 WS hello 帧转发给 OpenClaw
  "roomId":      "room-main",        // 通过 WS hello 帧转发给 OpenClaw
  "clientId":    "alice-fixed",      // 通过 WS hello 帧转发给 OpenClaw
  "wsUrl":       "/ws"               // WebSocket 端点（frontdoor 固定为 /ws）
}
```

session token 在服务端仅保存于内存（`sessionsByToken` Map），**不持久化到磁盘**。重启 frontdoor 进程会使所有活跃 session 失效，客户端将被要求重新登录。

---

## 5. 前端切换机制

`GET /config` 的响应始终包含 `authMode` 字段：

```jsonc
// 密语模式
{ "authMode": "passphrase", "assistantName": "…" }

// OAuth2 密码模式
{ "authMode": "oauth2", "assistantName": "…" }
```

`app.js` 在页面加载时读取该字段：

- **`passphrase`** — 显示密语输入框（`#passphrase-input`），隐藏 `#oauth2-username` 和 `#oauth2-password`
- **`oauth2`** — 隐藏密语输入框，显示用户名（`#oauth2-username`）和密码（`#oauth2-password`）输入框；提交后 POST 到 `/oauth2/login`

前端其余部分不受影响。session 结构、WS 握手、历史记录加载及所有聊天逻辑在两种模式下完全相同。

---

## 6. 安全说明

### 凭据中转

与授权码模式不同，ROPC 流程中用户的用户名和密码会经由 frontdoor 中转至提供商。请仅在 frontdoor 与提供商均部署于同一受信任内网的场景下使用，不应在可公开访问的端点上暴露此流程。

### 提供商兼容性

ROPC（`grant_type=password`）已在 OAuth 2.1 草案中被列为不推荐用法，GitHub、Google 等公共提供商均不支持。支持该模式的常见自托管方案包括 Keycloak（需启用 Direct Access Grants）、Authentik、Authelia 及 Zitadel。使用前请确认提供商客户端配置中已开启对应权限。

### Client Secret 安全

在 Docker Secrets 或 Kubernetes Secrets 挂载文件的部署场景中，建议优先使用 `CLAWEB_OAUTH2_CLIENT_SECRET_FILE`，避免在环境变量中明文传递密钥。该文件在启动时读取一次。

### Token 不转发

`access_token` **永远不会转发给浏览器**，也不会写入磁盘。

- 若**未配置** `CLAWEB_OAUTH2_INTROSPECT_URL`：token 在进程内完成 userinfo 调用后即被丢弃，session 中不保留任何 provider 凭据。
- 若**已配置** `CLAWEB_OAUTH2_INTROSPECT_URL`：token 以内部字段 `_accessToken` 保存于 `sessionsByToken` Map 中（仅在进程内存中），用于后续自省调用，不序列化到任何响应或磁盘文件。

### Token 吊销检测（需配置自省端点）

当 `CLAWEB_OAUTH2_INTROSPECT_URL` 已设置时，frontdoor 在每次鉴权操作（`/history`、`/upload`、WS `hello` 帧）前会检查 session 的自省缓存是否过期。过期后调用自省端点：

```
POST <CLAWEB_OAUTH2_INTROSPECT_URL>
Authorization: Basic base64(CLIENT_ID:CLIENT_SECRET)
Content-Type: application/x-www-form-urlencoded

token=<access_token>
```

- 若响应 `{ "active": true }`：刷新缓存时间戳，请求正常放行。
- 若响应 `{ "active": false }` 或调用失败：从 `sessionsByToken` 删除 session，返回 HTTP 401，前端触发重新登录。

缓存 TTL 由 `CLAWEB_OAUTH2_INTROSPECT_TTL`（默认 60 秒）控制，避免对自省端点产生过多请求。TTL 内同一 session 的请求不重复调用。

---

## 7. 完整环境变量参考

### 通用配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `BIND` | `127.0.0.1` | HTTP 服务器绑定的网络接口 |
| `PORT` | `18081` | HTTP 服务器端口 |
| `CLAWEB_UPSTREAM_WS` | `ws://127.0.0.1:18999` | OpenClaw claweb 频道的 WebSocket 地址 |
| `CLAWEB_UPSTREAM_TOKEN` | — | 上游频道的认证令牌 |
| `CLAWEB_UPSTREAM_TOKEN_FILE` | — | 包含上游令牌的文件路径 |
| `CLAWEB_LOGIN_CONFIG` | `./config/claweb-login.example.json` | 密语身份映射 JSON 文件路径 |
| `CLAWEB_HISTORY_DIR` | `./data/history` | JSONL 历史文件存储目录 |
| `CLAWEB_MEDIA_DIR` | `./data/media` | 上传媒体文件存储目录 |
| `CLAWEB_STATIC_ROOT` | `../../clients/browser` | 前端静态文件目录 |
| `CLAWEB_LOG_LEVEL` | `info` | 日志级别：`debug`、`info`、`warn`、`error` |
| `CLAWEB_LOG_JSON` | — | 设为 `1` 输出换行分隔的 JSON 日志 |
| `CLAWEB_UI_TITLE` | — | 覆盖页面/应用标题 |
| `CLAWEB_UI_CHARACTER_NAME` | — | 覆盖助手显示名称 |
| `CLAWEB_UI_AVATAR` | — | 覆盖头像（emoji 字符或图片 URL） |
| `CLAWEB_UI_AVATAR_MODE` | — | `emoji` 或 `image` |

### 密语模式

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CLAWEB_LOGIN_<N>_NAME` | — | 第 N 个槽位的身份键名 |
| `CLAWEB_LOGIN_<N>_DISPLAY_NAME` | — | 第 N 个槽位的显示名称 |
| `CLAWEB_LOGIN_<N>_PASSPHRASE` | — | 第 N 个槽位的单个密语 |
| `CLAWEB_LOGIN_<N>_PASSPHRASES` | — | 第 N 个槽位的逗号分隔密语列表 |
| `CLAWEB_LOGIN_<N>_USER_ID` | — | 第 N 个槽位的 `userId` |
| `CLAWEB_LOGIN_<N>_ROOM_ID` | — | 第 N 个槽位的 `roomId` |
| `CLAWEB_LOGIN_<N>_CLIENT_ID` | — | 第 N 个槽位的 `clientId` |

### OAuth2 模式

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CLAWEB_OAUTH2_ENABLED` | — | 设为 `true` 启用 OAuth2 密码模式 |
| `CLAWEB_OAUTH2_CLIENT_ID` | — | Client ID |
| `CLAWEB_OAUTH2_CLIENT_SECRET` | — | Client Secret 明文 |
| `CLAWEB_OAUTH2_CLIENT_SECRET_FILE` | — | 包含 Client Secret 的文件路径 |
| `CLAWEB_OAUTH2_TOKEN_URL` | — | 提供商令牌端点 |
| `CLAWEB_OAUTH2_USERINFO_URL` | — | 提供商用户信息端点 |
| `CLAWEB_OAUTH2_SCOPE` | `openid profile email` | 请求的 OAuth2 权限范围 |
| `CLAWEB_OAUTH2_USERINFO_ID_FIELD` | `sub` | userinfo 字段 → `identity` / `userId` |
| `CLAWEB_OAUTH2_USERINFO_NAME_FIELD` | `name` | userinfo 字段 → `displayName` |
| `CLAWEB_OAUTH2_USERINFO_IN_TOKEN` | *(空)* | 令牌响应中内嵌用户信息的字段名（如 `user_info`）；设置后无需 `CLAWEB_OAUTH2_USERINFO_URL` |
| `CLAWEB_OAUTH2_INTROSPECT_URL` | *(空)* | 令牌自省端点；设置后启用 session 关联 token 的吊销检测 |
| `CLAWEB_OAUTH2_INTROSPECT_TTL` | `60` | 自省结果缓存秒数 |
| `CLAWEB_OAUTH2_DEFAULT_ROOM_ID` | *(空)* | 所有 OAuth2 session 的默认 `roomId` |
| `CLAWEB_OAUTH2_DEFAULT_CLIENT_ID_PREFIX` | *(空)* | 拼接在身份值前的 `clientId` 前缀 |

---

## 8. 实现 Checklist（贡献者参考）

以下是实现 OAuth2 模式所需的改动，均不影响现有密语登录路径。

### `access/frontdoor/server.js`

- [ ] 启动时读取并校验 `CLAWEB_OAUTH2_*` 环境变量；若 `ENABLED=1` 但必填变量（`TOKEN_URL`、`USERINFO_URL`）缺失，输出警告（不崩溃）
- [ ] 注册 `POST /oauth2/login` — 读取 `{ username, password }`，向 `CLAWEB_OAUTH2_TOKEN_URL` 发起 `grant_type=password` 请求，获取 `access_token`；若配置了 `CLAWEB_OAUTH2_USERINFO_IN_TOKEN` 则直接从令牌响应提取用户信息，否则调用 `CLAWEB_OAUTH2_USERINFO_URL`；调用 `buildSession()`，返回 `{ ok, session }`
- [ ] `buildSession()` 在 OAuth2 模式下将 `access_token` 保存为 session 内部字段 `_accessToken`（不序列化到响应中），供后续自省使用；若未配置自省端点则登录后即丢弃
- [ ] 扩展 `GET /config`，返回 `authMode: "passphrase" | "oauth2"`
- [ ] 当 `CLAWEB_OAUTH2_ENABLED=true` 时禁用 `POST /login` 路由
- [ ] 使用内置 `fetch()`（Node.js 18+，无需新依赖）完成令牌请求和用户信息请求；同时兼容 `application/json` 和 `application/x-www-form-urlencoded` 两种令牌响应格式
- [ ] 实现 `introspectSession(session)` 辅助函数：`POST INTROSPECT_URL`，`Authorization: Basic base64(CLIENT_ID:CLIENT_SECRET)`，body `token=<_accessToken>`；解析 `active` 字段；失败或 `active: false` 时从 `sessionsByToken` 删除 session
- [ ] 实现自省 TTL 缓存：在 session 对象上维护 `_introspectValidUntil` 时间戳；鉴权中间件（`requireSession`）在 TTL 过期后调用 `introspectSession()`，调用成功则刷新时间戳
- [ ] 将自省检查应用于所有需鉴权的路由（`/history`、`/threads`、`/upload`、`/upload-file`）和 WS `hello` 帧处理
- [ ] 提供商返回错误时（如凭据错误），将 HTTP 状态映射为 401 返回给浏览器，不暴露原始 provider 错误体

### `clients/browser/index.html`

- [ ] 在 `#login-panel` 内添加 `<input id="oauth2-username" class="hidden" type="text" autocomplete="username" placeholder="用户名" />` 和 `<input id="oauth2-password" class="hidden" type="password" autocomplete="current-password" placeholder="密码" />`

### `clients/browser/app.js`

- [ ] 页面启动时请求 `/config`，将 `authMode` 存入 `state.authMode`
- [ ] 在 `showLoginPanel()` 中：`passphrase` 模式显示密语输入框，`oauth2` 模式显示用户名 + 密码输入框
- [ ] 提交时 POST 到 `/oauth2/login`（替代 `/login`），响应结构与密语登录相同，后续调用 `persistSession()` 和 `connect()` 无需改动

---

*另请参阅：[`setup-guide.md`](./setup-guide.md)（安装指南）、[`channel-architecture.md`](./channel-architecture.md)（整体架构说明）。*
