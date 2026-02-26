# Bridge Server Rewrite Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Clean rewrite of the bridge server to use `ws` + built-in `http` (no Express), with auto-install of `ws` only to `~/.zeroclaw/bridge-deps/`, and remove bridge-server from the extension repo.

**Architecture:** Bridge server is a single JS file bundled into ZeroClaw binary via `include_str!`. On first use, ZeroClaw writes it to `~/.zeroclaw/bridge-server/server.js` and spawns it with `node`. The server auto-installs `ws` to `~/.zeroclaw/bridge-deps/` on first run. Extension repo keeps only the Chrome extension files.

**Tech Stack:** Node.js built-in `http` + `ws` npm package, Rust `include_str!` + `tokio::process::Command`

---

### Task 1: Rewrite bridge-server/server.js in ZeroClaw repo

**Files:**
- Rewrite: `/Users/apple/Desktop/den/zeroclaw/bridge-server/server.js`

**Step 1: Write the new server.js**

Replace the current auto-install-express version with ws + built-in http. Key changes:
- Auto-install only `ws` (not express) to `~/.zeroclaw/bridge-deps/`
- Replace Express routes with Node built-in `http.createServer`
- Use `ws.WebSocketServer` for WebSocket
- Use `~/.zeroclaw/bridge-deps/` as install dir (persistent, not /tmp)

```javascript
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

const ACTIONS = new Set(["navigate","click","fill","scrape","screenshot","scroll","hover","get_text","get_title"]);

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
```

**Step 2: Test it runs and connects**

```bash
# Kill anything on the ports
lsof -ti:7822,7823 | xargs kill 2>/dev/null
# Start server
node /Users/apple/Desktop/den/zeroclaw/bridge-server/server.js &
sleep 5
# Verify health
curl -s http://localhost:7823/health
# Expected: {"status":"ok","extensionConnected":true,...}
# (if extension is loaded in Chrome)
# Test a command
curl -s -X POST http://localhost:7823/command -H "Content-Type: application/json" -d '{"action":"get_title"}'
# Expected: {"success":true,"data":{"title":"...","url":"...","tabId":...}}
# Cleanup
lsof -ti:7822,7823 | xargs kill 2>/dev/null
```

**Step 3: Commit**

```bash
cd /Users/apple/Desktop/den/zeroclaw
git add bridge-server/server.js
git commit -m "feat(bridge): rewrite server with ws + built-in http, drop express"
```

---

### Task 2: Update browser.rs to use ~/.zeroclaw/ instead of /tmp/

**Files:**
- Modify: `/Users/apple/Desktop/den/zeroclaw/src/tools/browser.rs` lines 410-418

**Step 1: Change the directory from /tmp to ~/.zeroclaw/**

Replace:
```rust
let dir = std::env::temp_dir().join("zeroclaw-bridge");
```

With:
```rust
let home = dirs::home_dir()
    .unwrap_or_else(|| std::env::temp_dir());
let dir = home.join(".zeroclaw").join("bridge-server");
```

**Step 2: Check that `dirs` crate is already a dependency**

```bash
grep 'dirs' Cargo.toml
# Expected: dirs = "6.0.0" or similar
```

If not available, use the environment variable approach:
```rust
let home = std::env::var("HOME")
    .map(std::path::PathBuf::from)
    .unwrap_or_else(|_| std::env::temp_dir());
let dir = home.join(".zeroclaw").join("bridge-server");
```

**Step 3: Also add .deps to .gitignore in zeroclaw repo**

Add `bridge-server/.deps/` to the zeroclaw repo's `.gitignore` if it has one.

**Step 4: Run tests**

```bash
cargo test --lib -- browser
```

Expected: all 52+ browser tests pass.

**Step 5: Commit**

```bash
git add src/tools/browser.rs
git commit -m "feat(bridge): write server.js to ~/.zeroclaw/bridge-server/ instead of /tmp"
```

---

### Task 3: Clean up extension repo — remove bridge-server/

**Files:**
- Delete: `/Users/apple/Desktop/den/zeroclaw-extension/bridge-server/` (entire directory)
- Modify: `/Users/apple/Desktop/den/zeroclaw-extension/README.md`
- Modify: `/Users/apple/Desktop/den/zeroclaw-extension/.gitignore`

**Step 1: Remove bridge-server directory**

```bash
cd /Users/apple/Desktop/den/zeroclaw-extension
rm -rf bridge-server/
```

**Step 2: Update .gitignore**

Remove `node_modules/` (no longer relevant). Keep `.DS_Store` and `*.log`.

```
.DS_Store
*.log
```

**Step 3: Update README.md**

Rewrite to focus on the Chrome extension only. Remove all bridge-server setup/usage instructions. Point users to ZeroClaw for the bridge server.

**Step 4: Commit and push**

```bash
cd /Users/apple/Desktop/den/zeroclaw-extension
git add -A
git commit -m "refactor: remove bridge-server, extension-only repo

Bridge server now lives in the ZeroClaw repo and is auto-spawned.
This repo contains only the Chrome extension."
git push
```

---

### Task 4: Rebuild ZeroClaw binary and end-to-end test

**Step 1: Rebuild**

```bash
cd /Users/apple/Desktop/den/zeroclaw
touch src/tools/browser.rs  # force re-embed of server.js
cargo build --release --features rag-pdf
```

**Step 2: Copy binary**

Copy `target/release/zeroclaw` to wherever the user's zeroclaw binary is installed.

**Step 3: End-to-end test**

1. Make sure Chrome extension is loaded
2. Kill any existing bridge processes: `lsof -ti:7822,7823 | xargs kill 2>/dev/null`
3. Restart zeroclaw daemon
4. Send a browser command (via Telegram or CLI)
5. Verify `curl -s http://localhost:7823/health` shows `extensionConnected: true`
6. Verify the command returns actual browser data

**Step 4: Commit remaining changes and push**

```bash
cd /Users/apple/Desktop/den/zeroclaw
git add -A
git commit -m "feat(bridge): complete bridge architecture rewrite

- ws + built-in http (dropped Express)
- Auto-installs ws to ~/.zeroclaw/bridge-deps/
- Writes server.js to ~/.zeroclaw/bridge-server/
- Persistent deps dir survives reboots"
git push
```

---

### Task 5: Commit the design doc

**Step 1:** Commit docs in extension repo

```bash
cd /Users/apple/Desktop/den/zeroclaw-extension
git add docs/
git commit -m "docs: add bridge architecture design doc"
```
