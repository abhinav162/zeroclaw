// ZeroClaw Bridge Server — ws + built-in http
// Auto-installs ws package to ~/.zeroclaw/bridge-deps/ on first run.

"use strict";

const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");
const http = require("http");
const crypto = require("crypto");
const os = require("os");

// --- Auto-install ws dependency ---
const DEPS_DIR = path.join(os.homedir(), ".zeroclaw", "bridge-deps");
const NODE_MODULES = path.join(DEPS_DIR, "node_modules");

function ensureDeps() {
  if (fs.existsSync(path.join(NODE_MODULES, "ws"))) return;
  console.log("[ZeroClaw] Installing bridge dependency (ws)...");
  fs.mkdirSync(DEPS_DIR, { recursive: true });
  const pkgPath = path.join(DEPS_DIR, "package.json");
  if (!fs.existsSync(pkgPath)) {
    fs.writeFileSync(pkgPath, JSON.stringify({ name: "zc-bridge-deps", private: true }));
  }
  execSync("npm install --prefix " + JSON.stringify(DEPS_DIR) + " ws", {
    stdio: "inherit",
    timeout: 60000,
  });
  console.log("[ZeroClaw] Dependency ready.");
}

ensureDeps();

// Load ws from deps dir
const modulePaths = require("module")._nodeModulePaths(DEPS_DIR);
for (const p of modulePaths) module.paths.unshift(p);

const { WebSocketServer, WebSocket } = require("ws");

// --- Configuration ---
const WS_PORT = 7822;
const REST_PORT = 7823;
const COMMAND_TIMEOUT_MS = 30000;

// --- State ---
let extensionSocket = null;
const pendingCommands = new Map();

// --- WebSocket Server ---
const wss = new WebSocketServer({ port: WS_PORT }, () => {
  console.log("[ZeroClaw] WebSocket server on ws://localhost:" + WS_PORT);
});

wss.on("connection", (socket) => {
  console.log("[ZeroClaw] Chrome extension connected");
  extensionSocket = socket;

  socket.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === "ping") return;
    if (msg.type === "extension_ready") {
      console.log("[ZeroClaw] Extension ready (v" + msg.version + ")");
      return;
    }
    if (msg.id && pendingCommands.has(msg.id)) {
      const { resolve, reject, timer } = pendingCommands.get(msg.id);
      clearTimeout(timer);
      pendingCommands.delete(msg.id);
      if (msg.success) resolve(msg.data);
      else reject(new Error(msg.error || "Extension command failed"));
    }
  });

  socket.on("close", () => {
    console.log("[ZeroClaw] Chrome extension disconnected");
    if (extensionSocket === socket) extensionSocket = null;
    for (const [id, { reject, timer }] of pendingCommands) {
      clearTimeout(timer);
      reject(new Error("Extension disconnected"));
      pendingCommands.delete(id);
    }
  });

  socket.on("error", (err) => {
    console.error("[ZeroClaw] WebSocket error:", err.message);
  });
});

// --- Send command to extension ---
function sendCommand(action, params) {
  return new Promise((resolve, reject) => {
    if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
      return reject(new Error("Chrome extension is not connected"));
    }
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      pendingCommands.delete(id);
      reject(new Error("Command timed out after " + (COMMAND_TIMEOUT_MS / 1000) + "s: " + action));
    }, COMMAND_TIMEOUT_MS);
    pendingCommands.set(id, { resolve, reject, timer });
    extensionSocket.send(JSON.stringify({ id, action, ...params }));
  });
}

// --- REST API (built-in http) ---
function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 10e6) { reject(new Error("Body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

const ACTIONS = new Set(["navigate","click","fill","scrape","snapshot","screenshot","scroll","hover","get_text","get_title"]);

const restServer = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost:" + REST_PORT);
    const p = url.pathname;

    if (req.method === "GET" && p === "/health") {
      return json(res, 200, {
        status: "ok",
        extensionConnected: extensionSocket !== null && extensionSocket.readyState === WebSocket.OPEN,
        pendingCommands: pendingCommands.size,
      });
    }

    if (req.method === "POST" && p === "/command") {
      const body = await parseBody(req);
      const { action, ...params } = body;
      if (!action) return json(res, 400, { success: false, error: "Missing 'action' field" });
      try {
        const data = await sendCommand(action, params);
        return json(res, 200, { success: true, data });
      } catch (err) {
        return json(res, err.message.includes("not connected") ? 503 : 500, { success: false, error: err.message });
      }
    }

    if (req.method === "POST") {
      const action = p.slice(1);
      if (ACTIONS.has(action)) {
        const body = await parseBody(req);
        try {
          const data = await sendCommand(action, body);
          return json(res, 200, { success: true, data });
        } catch (err) {
          return json(res, err.message.includes("not connected") ? 503 : 500, { success: false, error: err.message });
        }
      }
    }

    json(res, 404, { success: false, error: "Not found" });
  } catch (err) {
    json(res, 500, { success: false, error: "Internal server error" });
  }
});

restServer.listen(REST_PORT, () => {
  console.log("[ZeroClaw] REST API on http://localhost:" + REST_PORT);
});

// --- Shutdown ---
function shutdown() {
  console.log("\n[ZeroClaw] Shutting down...");
  for (const [id, { reject, timer }] of pendingCommands) {
    clearTimeout(timer);
    reject(new Error("Server shutting down"));
    pendingCommands.delete(id);
  }
  wss.close();
  restServer.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
