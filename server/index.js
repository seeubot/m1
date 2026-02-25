const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");
const path = require("path");
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require("@simplewebauthn/server");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "../mobile")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ─── In-memory stores (use Redis/Postgres for production) ──────────────────
const devices = new Map();       // deviceId → { secret, ws, name }
const pendingTokens = new Map(); // token → { deviceId, expires }
const passkeyUsers = new Map();  // userId → { passkeys[], currentChallenge, deviceId }

// ─── Helpers ────────────────────────────────────────────────────────────────
function generateSecret() { return crypto.randomBytes(32).toString("hex"); }
function hmac(secret, data) {
  return crypto.createHmac("sha256", secret).update(data).digest("hex");
}
function getRpId(req) {
  return process.env.RP_ID || req.hostname;
}
function getOrigin(req) {
  return process.env.ORIGIN || `https://${req.hostname}`;
}

// ─── Pair a laptop ───────────────────────────────────────────────────────────
app.post("/pair", (req, res) => {
  const deviceId = crypto.randomBytes(8).toString("hex");
  const secret = generateSecret();
  devices.set(deviceId, { secret, ws: null, name: req.body.name || "laptop" });
  console.log(`[PAIR] Device registered: ${deviceId}`);
  res.json({ deviceId, secret, message: "Save these — secret won't be shown again." });
});

// ════════════════════════════════════════════════════════════════════════════
//  PASSKEY (WebAuthn) — Registration (one-time setup on mobile)
// ════════════════════════════════════════════════════════════════════════════
app.post("/webauthn/register/options", async (req, res) => {
  const { userId, deviceId } = req.body;
  if (!userId || !deviceId || !devices.has(deviceId)) {
    return res.status(400).json({ error: "Invalid userId or deviceId" });
  }
  const user = passkeyUsers.get(userId) || { passkeys: [], deviceId };
  const options = await generateRegistrationOptions({
    rpName: "Laptop Unlock",
    rpID: getRpId(req),
    userID: new TextEncoder().encode(userId),
    userName: userId,
    userDisplayName: "Laptop Unlock",
    attestationType: "none",
    excludeCredentials: user.passkeys.map((p) => ({ id: p.credentialID, type: "public-key" })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "required",        // forces biometric every time
      authenticatorAttachment: "platform", // uses device built-in (fingerprint/Face ID)
    },
  });
  user.currentChallenge = options.challenge;
  user.deviceId = deviceId;
  passkeyUsers.set(userId, user);
  res.json(options);
});

app.post("/webauthn/register/verify", async (req, res) => {
  const { userId, credential } = req.body;
  const user = passkeyUsers.get(userId);
  if (!user?.currentChallenge) return res.status(400).json({ error: "No pending registration" });
  try {
    const verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge: user.currentChallenge,
      expectedOrigin: getOrigin(req),
      expectedRPID: getRpId(req),
      requireUserVerification: true,
    });
    if (!verification.verified) return res.status(400).json({ error: "Verification failed" });
    const { credential: cred } = verification.registrationInfo;
    user.passkeys.push({
      credentialID: cred.id,
      credentialPublicKey: Buffer.from(cred.publicKey).toString("base64"),
      counter: cred.counter,
      transports: credential.response.transports || [],
    });
    user.currentChallenge = null;
    passkeyUsers.set(userId, user);
    console.log(`[PASSKEY] Registered for user: ${userId}`);
    res.json({ verified: true });
  } catch (err) {
    console.error("[PASSKEY] Registration error:", err);
    res.status(400).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  PASSKEY (WebAuthn) — Authentication (every unlock attempt)
// ════════════════════════════════════════════════════════════════════════════
app.post("/webauthn/auth/options", async (req, res) => {
  const { userId } = req.body;
  const user = passkeyUsers.get(userId);
  if (!user?.passkeys?.length) {
    return res.status(400).json({ error: "No passkeys registered. Please set up first." });
  }
  const options = await generateAuthenticationOptions({
    rpID: getRpId(req),
    userVerification: "required",
    allowCredentials: user.passkeys.map((p) => ({
      id: p.credentialID,
      type: "public-key",
      transports: p.transports,
    })),
  });
  user.currentChallenge = options.challenge;
  passkeyUsers.set(userId, user);
  res.json(options);
});

app.post("/webauthn/auth/verify", async (req, res) => {
  const { userId, credential, deviceId } = req.body;
  const user = passkeyUsers.get(userId);
  if (!user?.currentChallenge) return res.status(400).json({ error: "No pending auth" });
  const passkey = user.passkeys.find((p) => p.credentialID === credential.id);
  if (!passkey) return res.status(400).json({ error: "Passkey not found" });
  try {
    const verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge: user.currentChallenge,
      expectedOrigin: getOrigin(req),
      expectedRPID: getRpId(req),
      credential: {
        id: passkey.credentialID,
        publicKey: Buffer.from(passkey.credentialPublicKey, "base64"),
        counter: passkey.counter,
        transports: passkey.transports,
      },
      requireUserVerification: true,
    });
    if (!verification.verified) return res.status(401).json({ error: "Auth failed" });
    passkey.counter = verification.authenticationInfo.newCounter;
    user.currentChallenge = null;
    passkeyUsers.set(userId, user);

    // ✅ Fingerprint verified — send unlock to laptop
    const targetDeviceId = deviceId || user.deviceId;
    const device = devices.get(targetDeviceId);
    if (device?.ws?.readyState === 1) {
      device.ws.send(JSON.stringify({ type: "UNLOCK" }));
      console.log(`[UNLOCK] Sent to ${targetDeviceId}`);
      res.json({ status: "sent", message: "Laptop unlocked! 🎉" });
    } else {
      const token = generateSecret().slice(0, 16);
      pendingTokens.set(token, { deviceId: targetDeviceId, expires: Date.now() + 30_000 });
      res.json({ status: "queued", message: "Laptop offline — will unlock on reconnect" });
    }
  } catch (err) {
    console.error("[AUTH] Error:", err);
    res.status(400).json({ error: err.message });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────
app.get("/health", (_, res) =>
  res.json({ status: "ok", devices: devices.size, passkeyUsers: passkeyUsers.size })
);

// ─── WebSocket: Laptop daemon ─────────────────────────────────────────────
wss.on("connection", (ws) => {
  let authenticatedDeviceId = null;
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return ws.close(); }
    if (msg.type === "AUTH") {
      const { deviceId, signature, timestamp } = msg;
      if (Math.abs(Date.now() - timestamp) > 30_000)
        return ws.send(JSON.stringify({ type: "ERROR", error: "Expired" }));
      const device = devices.get(deviceId);
      if (!device) return ws.send(JSON.stringify({ type: "ERROR", error: "Unknown device" }));
      const expected = hmac(device.secret, deviceId + timestamp);
      if (signature !== expected)
        return ws.send(JSON.stringify({ type: "ERROR", error: "Auth failed" }));
      authenticatedDeviceId = deviceId;
      device.ws = ws;
      devices.set(deviceId, device);
      ws.send(JSON.stringify({ type: "AUTH_OK", deviceId }));
      console.log(`[WS] Laptop connected: ${deviceId}`);
      for (const [token, data] of pendingTokens) {
        if (data.deviceId === deviceId && data.expires > Date.now()) {
          ws.send(JSON.stringify({ type: "UNLOCK", token }));
          pendingTokens.delete(token);
        }
      }
    }
    if (msg.type === "PING" && authenticatedDeviceId)
      ws.send(JSON.stringify({ type: "PONG" }));
  });
  ws.on("close", () => {
    if (authenticatedDeviceId) {
      const device = devices.get(authenticatedDeviceId);
      if (device) { device.ws = null; devices.set(authenticatedDeviceId, device); }
      console.log(`[WS] Laptop disconnected: ${authenticatedDeviceId}`);
    }
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [t, d] of pendingTokens) { if (d.expires < now) pendingTokens.delete(t); }
}, 60_000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Unlock service on port ${PORT}`));
