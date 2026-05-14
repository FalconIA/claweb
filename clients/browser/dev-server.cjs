#!/usr/bin/env node
/**
 * Local dev server for CLAWeb browser client.
 *
 * Replicates the frontdoor `/claweb/` prefix-stripping behaviour so
 * local edits to app.js / style.css are served instead of the deployed
 * version that the reverse-proxy would return.
 *
 * Usage:
 *   node dev-server.js [PORT] [CLAWEB_FRONTDOOR_URL] [BIND]
 *
 * Defaults:
 *   PORT                 = 18082
 *   BIND                 = 127.0.0.1
 *   CLAWEB_FRONTDOOR_URL = http://127.0.0.1:18081
 *
 * Config precedence:
 *   shell env > command args > clients/browser/.env > defaults
 *
 * All API calls (/login, /history, /config, /upload, /ws …) that are
 * not matched by a local file are forwarded to the configured frontdoor,
 * including the WebSocket upgrade for /ws.
 */

"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const net = require("net");
const { URL } = require("url");

const STATIC_ROOT = __dirname;
const FILE_ENV = loadDotEnvFile(path.join(STATIC_ROOT, ".env"));
const DEFAULT_PORT = 18082;
const DEFAULT_BIND = "127.0.0.1";
const DEFAULT_FRONTDOOR_URL = "http://127.0.0.1:18081";

const PORT = Number(process.env.PORT || process.argv[2] || FILE_ENV.PORT || DEFAULT_PORT);
const BIND = String(process.env.BIND || process.argv[4] || FILE_ENV.BIND || DEFAULT_BIND).trim() || DEFAULT_BIND;
const FRONTDOOR_URL = (
  process.env.CLAWEB_FRONTDOOR_URL ||
  process.argv[3] ||
  FILE_ENV.CLAWEB_FRONTDOOR_URL ||
  DEFAULT_FRONTDOOR_URL
).replace(/\/$/, "");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".json": "application/json; charset=utf-8",
};

function mimeFor(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function loadDotEnvFile(filePath) {
  const env = {};
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return env;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const normalized = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trim() : trimmed;
    const eq = normalized.indexOf("=");
    if (eq < 1) continue;
    const key = normalized.slice(0, eq).trim();
    const value = normalized
      .slice(eq + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, "$2");
    if (key) env[key] = value;
  }

  console.log(`[env]    Loaded ${path.relative(process.cwd(), filePath)}`);
  return env;
}

/** Strip the /claweb prefix (mirrors frontdoor's compat alias logic). */
function stripClawebPrefix(pathname) {
  return pathname.startsWith("/claweb/") ? pathname.replace(/^\/claweb/, "") : pathname;
}

/** Try to resolve a pathname to a real local file. */
function resolveLocal(pathname) {
  if (pathname === "/" || !pathname) pathname = "/index.html";
  const stripped = stripClawebPrefix(pathname);
  const candidate = path.resolve(STATIC_ROOT, "." + stripped);
  // Prevent path traversal
  if (!candidate.startsWith(STATIC_ROOT + path.sep) && candidate !== STATIC_ROOT) return null;
  try {
    const stat = fs.statSync(candidate);
    return stat.isFile() ? candidate : null;
  } catch {
    return null;
  }
}

// Parse frontdoor host/port once
const frontdoorUrl = new URL(FRONTDOOR_URL);
const frontdoorHost = frontdoorUrl.hostname;
const frontdoorPort = Number(frontdoorUrl.port) || 80;

function proxyHttp(req, res) {
  const options = {
    hostname: frontdoorHost,
    port: frontdoorPort,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: frontdoorUrl.host },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain" });
    }
    res.end("Proxy error: " + err.message);
  });

  req.pipe(proxyReq, { end: true });
}

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url || "/", "http://localhost");
  const local = resolveLocal(parsed.pathname);

  if (local) {
    const data = fs.readFileSync(local);
    res.writeHead(200, {
      "content-type": mimeFor(local),
      "cache-control": "no-store",
      "content-length": String(data.length),
    });
    res.end(data);
    console.log(`[local]  ${req.method} ${req.url} → ${path.relative(STATIC_ROOT, local)}`);
    return;
  }

  console.log(`[proxy]  ${req.method} ${req.url} → ${FRONTDOOR_URL}`);
  proxyHttp(req, res);
});

// WebSocket proxy — tunnel the TCP connection
server.on("upgrade", (req, clientSocket, head) => {
  console.log(`[ws]     UPGRADE ${req.url} → ${FRONTDOOR_URL}`);
  const conn = net.connect(frontdoorPort, frontdoorHost, () => {
    conn.write(
      `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n` +
        Object.entries(req.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n") +
        "\r\n\r\n"
    );
    if (head && head.length) conn.write(head);
    conn.pipe(clientSocket, { end: true });
    clientSocket.pipe(conn, { end: true });
  });

  conn.on("error", (err) => {
    console.error("[ws] frontdoor error:", err.message);
    clientSocket.destroy();
  });
  clientSocket.on("error", () => conn.destroy());
});

server.listen(PORT, BIND, () => {
  console.log(`CLAWeb dev server  →  http://${BIND}:${PORT}`);
  console.log(`Static root        →  ${STATIC_ROOT}`);
  console.log(`Frontdoor (proxy)  →  ${FRONTDOOR_URL}`);
  console.log("(Ctrl+C to stop)\n");
});
