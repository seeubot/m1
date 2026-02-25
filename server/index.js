const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "../mobile")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ─── In-memory store (use Redis on Koyeb for production) ───────────────────
const devices = new Map();     // deviceId → { secret, ws }
const pendingTokens = new Map(); // token → { deviceId, expires }

// ─── Helpers ────────────────────────────────────────────────────────────────
function generateSecret() {
  return crypto.randomBytes(32).toString("hex");
}

function generateToken() {
  return crypto.randomBytes(16).toString("hex");
}

function hmac(secret, data) {
  return crypto.createHmac("sha256", secret).update(data).digest("hex");
}

// ─── REST: Pair a new device ─────────────────────────────────────────────────
// Call this once from your laptop to register it and get a device ID + secret
app.post("/pair", (req, res) => {
  const deviceId = generateSecret().slice(0, 16);
  const secret = generateSecret();
  devices.set(deviceId, { secret, ws: null, name: req.body.name || "laptop" });
  console.log(`[PAIR] New device registered: ${deviceId}`);
  res.json({
    deviceId,
    secret,
    message: "Save these credentials — the secret will not be shown again.",
  });
});

// ─── REST: Mobile requests unlock token (after fingerprint verified) ─────────
app.post("/request-unlock", (req, res) => {
  const { deviceId, signature, timestamp } = req.body;

  if (!deviceId || !signature || !timestamp) {
    return res.status(400).json({ error: "Missing fields" });
  }

  // Reject requests older than 30 seconds
  if (Math.abs(Date.now() - timestamp) > 30_000) {
    return res.status(401).json({ error: "Request expired" });
  }

  const device = devices.get(deviceId);
  if (!device) {
    return res.status(404).json({ error: "Device not found" });
  }

  // Verify HMAC signature: hmac(secret, deviceId + timestamp)
  const expected = hmac(device.secret, deviceId + timestamp);
  if (signature !== expected) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  // Create a short-lived unlock token
  const token = generateToken();
  pendingTokens.set(token, { deviceId, expires: Date.now() + 10_000 });

  // Push unlock command to laptop via WebSocket if connected
  if (device.ws && device.ws.readyState === 1) {
    device.ws.send(JSON.stringify({ type: "UNLOCK", token }));
    console.log(`[UNLOCK] Signal sent to device ${deviceId}`);
    res.json({ status: "sent", message: "Unlock signal delivered to laptop" });
  } else {
    // Laptop will poll for the token when it reconnects
    console.log(`[UNLOCK] Device ${deviceId} offline — token queued`);
    res.json({ status: "queued", message: "Laptop is offline; will unlock on reconnect" });
  }
});

// ─── REST: Health check ───────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ status: "ok", devices: devices.size }));

// ─── WebSocket: Laptop daemon connects here ───────────────────────────────────
wss.on("connection", (ws) => {
  let authenticatedDeviceId = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return ws.close(); }

    // Step 1: Laptop authenticates itself
    if (msg.type === "AUTH") {
      const { deviceId, signature, timestamp } = msg;
      if (Math.abs(Date.now() - timestamp) > 30_000) {
        return ws.send(JSON.stringify({ type: "ERROR", error: "Expired" }));
      }
      const device = devices.get(deviceId);
      if (!device) {
        return ws.send(JSON.stringify({ type: "ERROR", error: "Unknown device" }));
      }
      const expected = hmac(device.secret, deviceId + timestamp);
      if (signature !== expected) {
        return ws.send(JSON.stringify({ type: "ERROR", error: "Auth failed" }));
      }

      authenticatedDeviceId = deviceId;
      device.ws = ws;
      devices.set(deviceId, device);
      ws.send(JSON.stringify({ type: "AUTH_OK", deviceId }));
      console.log(`[WS] Laptop connected: ${deviceId}`);

      // Deliver any queued unlock tokens
      for (const [token, data] of pendingTokens) {
        if (data.deviceId === deviceId && data.expires > Date.now()) {
          ws.send(JSON.stringify({ type: "UNLOCK", token }));
          pendingTokens.delete(token);
        }
      }
    }

    if (msg.type === "PING" && authenticatedDeviceId) {
      ws.send(JSON.stringify({ type: "PONG" }));
    }
  });

  ws.on("close", () => {
    if (authenticatedDeviceId) {
      const device = devices.get(authenticatedDeviceId);
      if (device) { device.ws = null; devices.set(authenticatedDeviceId, device); }
      console.log(`[WS] Laptop disconnected: ${authenticatedDeviceId}`);
    }
  });
});

// Clean up expired tokens every minute
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of pendingTokens) {
    if (data.expires < now) pendingTokens.delete(token);
  }
}, 60_000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Unlock service running on port ${PORT}`));
