---
name: claweb-channel-rules
description: CLAWeb channel usage rules for OpenClaw agents, including response style, target selection, and proactive message delivery.
alwaysActive: true
---

# CLAWeb Channel Rules

## Scope

Use this skill when an OpenClaw agent is replying through, or proactively sending through, the `claweb` channel.

This skill is not an operations guide for any specific host application. Keep normal replies focused on CLAWeb channel behavior, message content, target selection, and media handoff.

CLAWeb is a client-facing OpenClaw channel. OpenClaw still owns routing, prompts, memory, tools, and agent behavior.

## Response Style

- Reply naturally and directly in the current conversation unless the user explicitly asks to send a proactive message elsewhere.
- Prefer concise paragraphs for short answers. Use lists only when they improve scanability.
- Markdown is allowed, but keep it within the safe subset expected by CLAWeb clients: headings, emphasis, links, lists, blockquotes, and fenced code blocks.
- Do not emit raw HTML, scripts, iframe content, or executable snippets as rendered chat content.
- For code or command output, use fenced code blocks with a language hint when possible.

## Media And Attachments

CLAWeb supports OpenClaw-standard media handoff patterns such as `MEDIA:`, `mediaUrl`, and `mediaUrls`. Prefer structured media outputs when the runtime provides them.

When returning media:
- Prefer the channel's normal attachment/media fields when available.
- Do not invent a public URL for a local file.
- Do not embed raw base64 unless the active tool/runtime explicitly expects it.
- Keep any explanatory text near the media short, so the client can render the attachment cleanly.

## Targets

CLAWeb targets are channel identities, not client implementation details:
- `userId` for direct user delivery
- `roomId` for room/group delivery
- `clientId` is not the normal outbound target

Accepted target formats:
- Direct user: `user:<userId>` or bare `<userId>`
- Room/group: `room:<roomId>` or `group:<roomId>`
- Explicit channel prefix is also valid: `claweb:user:<userId>` or `claweb:room:<roomId>`

For example:

```bash
openclaw message send --channel claweb -t user:1 -m "Hi"
openclaw message send --channel claweb -t room:room-main -m "Hello room"
```

If both a user and room might share the same bare id, prefer an explicit prefix. When the user says "send to the room" or names a room, use `room:<id>`. When the user names a person or account, use `user:<id>`.

## Outbound Behavior

Use the OpenClaw message/channel sending mechanism for proactive CLAWeb delivery. CLAWeb outbound delivery is gateway-scoped, because the gateway owns the active channel connection.

When sending proactively:
- Normalize the target before sending.
- Prefer explicit `user:<id>` and `room:<id>` targets.
- Use `room:<roomId>` for broadcast-style delivery.
- Do not promise delivery if the target identity is unknown to the channel.
- Keep proactive messages self-contained; they may be read later from channel history rather than immediately.

## Boundaries

Do not place persona, memory strategy, business policy, or authentication implementation details in CLAWeb channel output. Those belong to OpenClaw configuration, tools, or the host application.
