---
name: claweb-troubleshoot
description: Troubleshoot CLAWeb channel usage from OpenClaw, especially target resolution and proactive message delivery.
---

# CLAWeb Troubleshooting

Use this skill when an OpenClaw-side CLAWeb channel action fails, especially target resolution, proactive sends, or channel availability.

Do not turn this into host-application operations guidance. Keep the focus on how OpenClaw uses the installed `claweb` channel plugin.

## Channel Availability

Collect the smallest useful state before guessing:

```bash
openclaw --version
openclaw plugins list
openclaw plugins info claweb
openclaw gateway status
openclaw channels status
```

If the channel is not listed or not healthy, inspect plugin installation and channel configuration before debugging message content.

## Plugin Does Not Load

Check:

```bash
openclaw plugins doctor
openclaw plugins inspect claweb
```

Likely causes:
- stale `plugins.entries.claweb` config entry
- invalid `openclaw.plugin.json`
- plugin installed but gateway not restarted
- packaged plugin missing files listed in `package.json.files`

## Outbound Target Fails

If `openclaw message send --channel claweb -t 1 -m "Hi"` fails with an unknown target error, check whether the installed plugin contains the CLAWeb `messaging.targetResolver`.

Preferred target forms:
- `user:<userId>` for direct messages
- `room:<roomId>` for room messages

Useful checks:

```bash
openclaw channels resolve --channel claweb user:1
openclaw message send --channel claweb -t user:1 -m "Hi"
```

If target resolution works but sending fails, check the channel/gateway logs for whether a CLAWeb channel connection exists. Do not assume a bare numeric id is a room; use `room:<id>` when the user intends group delivery.

## Message Sent But User Reports Nothing

Separate OpenClaw send success from client-side presentation. A successful `message send` means the CLAWeb channel accepted the outbound frame. It does not prove that a particular client UI rendered it.

OpenClaw-side checks:
- confirm the target id matches the intended `userId` or `roomId`
- prefer `user:<id>` or `room:<id>` to remove ambiguity
- check the channel/gateway logs for the generated message id
- if the user expects delayed visibility, confirm the host application supports offline persistence for CLAWeb outbound frames

## Media Looks Wrong

Common causes:
- output used a local path that the channel could not serve
- output embedded a URL that the client could not reach
- output put media only inside prose instead of a structured media field
- assistant output lacked both text and media, so the client had nothing useful to render

Prefer OpenClaw-standard media outputs such as `MEDIA:`, `mediaUrl`, or `mediaUrls` when available.
