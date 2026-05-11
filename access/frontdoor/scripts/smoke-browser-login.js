#!/usr/bin/env node
/**
 * CLAWeb frontdoor browser login smoke test (Playwright)
 *
 * Launches a visible Chrome window and verifies the login flow end-to-end
 * through the actual browser UI.
 *
 * Prerequisites:
 *   playwright-core is a devDependency — run `pnpm i` in access/frontdoor first.
 *
 * Usage — passphrase mode:
 *   node scripts/smoke-login-browser.js \
 *     --base http://localhost:3888 \
 *     --passphrase demo-pass
 *
 * Usage — OAuth2 mode:
 *   node scripts/smoke-login-browser.js \
 *     --base http://localhost:3888 \
 *     --username alice \
 *     --password secret
 *
 * Options:
 *   --base        Frontdoor URL                 [http://localhost:3888]
 *   --passphrase  Passphrase for passphrase mode
 *   --username    Username for OAuth2 mode
 *   --password    Password for OAuth2 mode
 *   --chrome      Path to Chrome executable     [auto-detect]
 *   --timeout     Per-action timeout ms          [15000]
 *   --slow        Slow-down between actions ms   [300]
 *   --no-close    Keep browser open after test
 *   --mock        Auto-start local mock servers and set credentials automatically.
 *                 Passphrase mode (default): sets --base and --passphrase.
 *                 OAuth2 mode (--username / --password): also starts a fake
 *                 OAuth2 provider (token + userinfo endpoints) and wires it up.
 *                 All --mock defaults can be overridden by explicit flags.
 */

import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    base: "",
    passphrase: "",
    username: "",
    password: "",
    chrome: "",
    timeout: 15_000,
    slow: 300,
    noClose: false,
    mock: false,
    oauth2: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base")            args.base       = argv[++i] ?? args.base;
    else if (a === "--passphrase") args.passphrase = argv[++i] ?? "";
    else if (a === "--username")   args.username   = argv[++i] ?? "";
    else if (a === "--password")   args.password   = argv[++i] ?? "";
    else if (a === "--chrome")     args.chrome     = argv[++i] ?? "";
    else if (a === "--timeout")    args.timeout    = Number(argv[++i] ?? args.timeout);
    else if (a === "--slow")       args.slow       = Number(argv[++i] ?? args.slow);
    else if (a === "--no-close")   args.noClose    = true;
    else if (a === "--mock")       args.mock       = true;
    else if (a === "--oauth2")     args.oauth2     = true;
  }
  // --oauth2 implies --mock and sets oauth2 credential defaults
  if (args.oauth2) {
    args.mock = true;
    if (!args.username) args.username = MOCK_OAUTH2_USERNAME;
    if (!args.password) args.password = MOCK_OAUTH2_PASSWORD;
  }
  // Apply remaining --mock defaults
  if (args.mock) {
    if (!args.base) args.base = "http://localhost:38888";
    const isOAuth2 = Boolean(args.username || args.password);
    if (!isOAuth2 && !args.passphrase) args.passphrase = "smoke-pass";
  }
  if (!args.base) args.base = "http://localhost:3888";
  return args;
}

// ---------------------------------------------------------------------------
// Locate Chrome
// ---------------------------------------------------------------------------

function findChrome(hint = "") {
  if (hint && existsSync(hint)) return hint;

  // 1. playwright-core's bundled chromium (only if actually downloaded)
  try {
    const pw = require("playwright-core");
    const p = pw.chromium.executablePath();
    if (p && existsSync(p)) return p;
  } catch { /* ignore */ }

  // 2. Windows registry / well-known paths
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env["LOCALAPPDATA"] && process.env["LOCALAPPDATA"] + "\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    process.env["PROGRAMFILES"] && process.env["PROGRAMFILES"] + "\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  throw new Error(
    "Cannot find Chrome or Edge. Install one or pass --chrome <path>."
  );
}

// ---------------------------------------------------------------------------
// Mock server
// ---------------------------------------------------------------------------

const MOCK_PORT = 38888;
const MOCK_OAUTH2_PROVIDER_PORT = 38889;
const MOCK_PASSPHRASE = "smoke-pass";
const MOCK_OAUTH2_USERNAME = "mockuser";
const MOCK_OAUTH2_PASSWORD = "mock-pass";
const MOCK_OAUTH2_ACCESS_TOKEN = "fake-access-token-smoke";

function writeMockEnv(envPath, mode, oauth2ProviderPort) {
  const base = [
    `PORT=${MOCK_PORT}`,
    `BIND=127.0.0.1`,
    `CLAWEB_UPSTREAM_WS=ws://127.0.0.1:19999`,
    `CLAWEB_UPSTREAM_TOKEN=smoke-test-token`,
  ];
  let extra;
  if (mode === "oauth2") {
    extra = [
      `CLAWEB_OAUTH2_ENABLED=true`,
      `CLAWEB_OAUTH2_TOKEN_URL=http://127.0.0.1:${oauth2ProviderPort}/token`,
      `CLAWEB_OAUTH2_USERINFO_URL=http://127.0.0.1:${oauth2ProviderPort}/userinfo`,
      `CLAWEB_OAUTH2_CLIENT_ID=smoke-client`,
      `CLAWEB_OAUTH2_CLIENT_SECRET=smoke-secret`,
      `CLAWEB_OAUTH2_DEFAULT_ROOM_ID=main`,
      `CLAWEB_OAUTH2_DEFAULT_CLIENT_ID_PREFIX=client-`,
    ];
  } else {
    extra = [
      `CLAWEB_LOGIN_1_NAME=smokeuser`,
      `CLAWEB_LOGIN_1_DISPLAY_NAME=Smoke User`,
      `CLAWEB_LOGIN_1_PASSPHRASE=${MOCK_PASSPHRASE}`,
      `CLAWEB_LOGIN_1_USER_ID=user-smoke`,
      `CLAWEB_LOGIN_1_ROOM_ID=main`,
      `CLAWEB_LOGIN_1_CLIENT_ID=client-smoke`,
    ];
  }
  mkdirSync(path.dirname(envPath), { recursive: true });
  writeFileSync(envPath, [...base, ...extra].join("\n"), "utf8");
}

/**
 * Spawn a minimal OAuth2 provider that handles:
 *   POST /token    — validates username+password, returns access_token
 *   GET  /userinfo — validates Bearer token, returns user identity
 */
function spawnMockOAuth2Provider(port) {
  return new Promise((resolve, reject) => {
    const srv = createHttpServer((req, res) => {
      const send = (status, obj) => {
        const body = JSON.stringify(obj);
        res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
        res.end(body);
      };

      if (req.method === "POST" && req.url === "/token") {
        let raw = "";
        req.on("data", (c) => { raw += c; });
        req.on("end", () => {
          const params = new URLSearchParams(raw);
          const user = params.get("username");
          const pass = params.get("password");
          if (user === MOCK_OAUTH2_USERNAME && pass === MOCK_OAUTH2_PASSWORD) {
            send(200, { access_token: MOCK_OAUTH2_ACCESS_TOKEN, token_type: "bearer", expires_in: 3600 });
          } else {
            send(401, { error: "invalid_client" });
          }
        });
        return;
      }

      if (req.method === "GET" && req.url === "/userinfo") {
        const auth = req.headers["authorization"] ?? "";
        if (auth === `Bearer ${MOCK_OAUTH2_ACCESS_TOKEN}`) {
          send(200, { sub: MOCK_OAUTH2_USERNAME, name: "Mock OAuth2 User" });
        } else {
          send(401, { error: "invalid_token" });
        }
        return;
      }

      send(404, { error: "not_found" });
    });

    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", () => resolve(srv));
  });
}

function waitForPort(port, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    function attempt() {
      const sock = createConnection(port, "127.0.0.1");
      sock.once("connect", () => { sock.destroy(); resolve(); });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() >= deadline) return reject(new Error(`Port ${port} not ready after ${timeoutMs}ms`));
        setTimeout(attempt, 150);
      });
    }
    attempt();
  });
}

async function spawnMockServer(mode) {
  const root = path.resolve(__dirname, "..");
  const envPath = path.join(root, "config", ".env.smoke-auto");

  // For OAuth2 mode, start the fake provider first so its port is known
  let oauth2Srv = null;
  if (mode === "oauth2") {
    log("mock", `Starting mock OAuth2 provider on port ${MOCK_OAUTH2_PROVIDER_PORT}...`);
    oauth2Srv = await spawnMockOAuth2Provider(MOCK_OAUTH2_PROVIDER_PORT);
    log("mock", "Mock OAuth2 provider ready ✓");
  }

  writeMockEnv(envPath, mode, MOCK_OAUTH2_PROVIDER_PORT);

  const child = spawn(
    process.execPath,
    [path.join(root, "server.js")],
    {
      env: { ...process.env, CLAWEB_ENV_FILE: envPath },
      stdio: ["ignore", "pipe", "pipe"],
      cwd: root,
    }
  );

  child.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`.replace(/\n/g, "\n[server] ").trimEnd() + "\n"));
  child.stderr.on("data", (d) => process.stderr.write(`[server:err] ${d}`.replace(/\n/g, "\n[server:err] ").trimEnd() + "\n"));

  await waitForPort(MOCK_PORT, 12_000);
  child._oauth2Srv = oauth2Srv; // stash for cleanup
  return child;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(tag, msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${tag}] ${msg}`);
}

function fail(msg) {
  console.error(`\n✗  FAIL: ${msg}\n`);
  process.exit(1);
}

function pass(msg) {
  console.log(`\n✓  PASS: ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv);

// --mock: start local mock servers automatically
let mockChild = null;
if (args.mock) {
  const mockMode = (args.username || args.password) ? "oauth2" : "passphrase";
  log("mock", `Starting mock server on port ${MOCK_PORT} (mode: ${mockMode})...`);
  try {
    mockChild = await spawnMockServer(mockMode);
    log("mock", "Mock server ready ✓");
  } catch (e) {
    fail(`Failed to start mock server: ${e.message}`);
  }
}

const authMode = args.username ? "oauth2" : "passphrase";
if (authMode === "passphrase" && !args.passphrase) {
  console.error("Provide --passphrase <value>  OR  --username <u> --password <p>  OR  --mock");
  process.exit(1);
}
if (authMode === "oauth2" && !args.password) {
  console.error("--password is required with --username");
  process.exit(1);
}

function stopMock() {
  if (mockChild && !mockChild.killed) {
    mockChild.kill();
    log("mock", "Mock server stopped.");
  }
  if (mockChild?._oauth2Srv) {
    mockChild._oauth2Srv.close();
    log("mock", "Mock OAuth2 provider stopped.");
  }
}

let chromePath;
try {
  chromePath = findChrome(args.chrome);
} catch (e) {
  stopMock();
  fail(e.message);
}
log("setup", `Chrome: ${chromePath}`);
log("setup", `Target: ${args.base}`);
log("setup", `Auth mode: ${authMode}`);

let pw;
try {
  pw = require("playwright-core");
} catch {
  stopMock();
  fail("playwright-core not found. Run: pnpm i");
}

const browser = await pw.chromium.launch({
  executablePath: chromePath,
  headless: false,
  slowMo: args.slow,
  args: ["--start-maximized"],
});

const ctx = await browser.newContext({
  viewport: null, // let the window decide
});
const page = await ctx.newPage();
page.setDefaultTimeout(args.timeout);

try {
  // ------------------------------------------------------------------
  // 1. Load the page
  // ------------------------------------------------------------------
  log("nav", `Navigating to ${args.base}`);
  await page.goto(args.base, { waitUntil: "domcontentloaded" });

  // ------------------------------------------------------------------
  // 2. Verify login panel is visible
  // ------------------------------------------------------------------
  log("check", "Waiting for login panel...");
  await page.waitForSelector("#login-panel:not(.hidden)", { timeout: args.timeout });
  log("check", "Login panel is visible ✓");

  // ------------------------------------------------------------------
  // 3. Fetch config and fill login fields from loginFields descriptor
  // ------------------------------------------------------------------
  const configResp = await page.evaluate(async (base) => {
    const r = await fetch(`${base}/config`);
    return r.json();
  }, args.base);
  log("config", `loginEndpoint: ${configResp.loginEndpoint ?? "(not set)"}`);
  log("config", `loginFields:   ${JSON.stringify(configResp.loginFields ?? [])}`);

  // Map CLI args to field values by name
  const fieldValues = {
    passphrase: args.passphrase,
    username: args.username,
    password: args.password,
  };

  const fields = configResp.loginFields ?? [];
  if (fields.length === 0) fail("/config returned no loginFields");

  for (const f of fields) {
    const selector = `#${f.id}`;
    await page.waitForSelector(`${selector}:visible`, { timeout: 5_000 });
    log("check", `Field #${f.id} (${f.name}) visible ✓`);
    const value = fieldValues[f.name] ?? "";
    if (!value) fail(`No value provided for field "${f.name}" (--${f.name})`);
    log("fill", `Filling #${f.id}: ${f.name === "password" || f.name === "passphrase" ? "***" : value}`);
    await page.fill(selector, value);
  }

  // ------------------------------------------------------------------
  // 4. Click login button
  // ------------------------------------------------------------------
  log("action", "Clicking login button...");
  await page.click("#login-btn");

  // ------------------------------------------------------------------
  // 5. Verify chat panel appears (login success)
  // ------------------------------------------------------------------
  log("check", "Waiting for chat panel (login success)...");
  await page.waitForSelector("#chat-panel:not(.hidden)", { timeout: args.timeout });
  pass("Login succeeded — chat panel is visible");

  // ------------------------------------------------------------------
  // 6. Snapshot: collect session info from page state
  // ------------------------------------------------------------------
  const sessionInfo = await page.evaluate(() => {
    // Access the module-scoped `state` via a known DOM side-effect:
    // session-desc is updated by showChatPanel
    const desc = document.getElementById("session-desc");
    return {
      sessionDesc: desc ? desc.textContent : "(no session-desc element)",
      statusText: document.getElementById("conn-status-text")?.textContent ?? "",
    };
  });
  log("session", `session-desc: ${sessionInfo.sessionDesc}`);
  log("session", `status: ${sessionInfo.statusText}`);

  // ------------------------------------------------------------------
  // 7. Verify no error message shown
  // ------------------------------------------------------------------
  const errorText = await page.$eval("#login-error", el => el.textContent.trim()).catch(() => "");
  if (errorText) {
    fail(`Login error message visible: "${errorText}"`);
  }
  log("check", "No login error visible ✓");

} catch (err) {
  // Take a screenshot on failure
  try {
    const shot = `smoke-login-fail-${Date.now()}.png`;
    await page.screenshot({ path: shot, fullPage: true });
    log("screenshot", `Saved: ${shot}`);
  } catch { /* ignore screenshot errors */ }
  stopMock();
  fail(String(err?.message ?? err));
} finally {
  if (!args.noClose) {
    await browser.close();
  } else {
    log("info", "Browser left open (--no-close). Close it manually.");
  }
  stopMock();
}
