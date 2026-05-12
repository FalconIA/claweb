#!/usr/bin/env node
/**
 * Local dev server for CLAWeb browser client.
 *
 * Replicates the frontdoor `/claweb/` prefix-stripping behaviour so
 * local edits to app.js / style.css are served instead of the deployed
 * version that the reverse-proxy would return.
 *
 * Usage:
 *   node dev-server.js [PORT] [UPSTREAM]
 *
 * Defaults:
 *   PORT     = 8080
 *   UPSTREAM = http://10.19.29.13:30111   (override with env UPSTREAM=...)
 *
 * All API calls (/login, /history, /config, /upload, /ws …) that are
 * not matched by a local file are forwarded to UPSTREAM, including the
 * WebSocket upgrade for /ws.
 */

"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const net = require("net");
const { URL } = require("url");

const PORT = Number(process.env.PORT || process.argv[2] || 8080);
const UPSTREAM = (process.env.UPSTREAM || process.argv[3] || "http://10.19.29.13:30111").replace(/\/$/, "");

const STATIC_ROOT = __dirname;

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

// Parse upstream host/port once
const upstreamUrl = new URL(UPSTREAM);
const upstreamHost = upstreamUrl.hostname;
const upstreamPort = Number(upstreamUrl.port) || 80;

function proxyHttp(req, res) {
  const options = {
    hostname: upstreamHost,
    port: upstreamPort,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: upstreamUrl.host },
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

  console.log(`[proxy]  ${req.method} ${req.url} → ${UPSTREAM}`);
  proxyHttp(req, res);
});

// WebSocket proxy — tunnel the TCP connection
server.on("upgrade", (req, clientSocket, head) => {
  console.log(`[ws]     UPGRADE ${req.url} → ${UPSTREAM}`);
  const conn = net.connect(upstreamPort, upstreamHost, () => {
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
    console.error("[ws] upstream error:", err.message);
    clientSocket.destroy();
  });
  clientSocket.on("error", () => conn.destroy());
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`CLAWeb dev server  →  http://127.0.0.1:${PORT}`);
  console.log(`Static root        →  ${STATIC_ROOT}`);
  console.log(`Upstream (proxy)   →  ${UPSTREAM}`);
  console.log("(Ctrl+C to stop)\n");
});
