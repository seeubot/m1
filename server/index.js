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

// ─── In-memory stores ────────────────────────────────────────────────────────
const devices     = new Map(); // deviceId → { secret, ws, name }
const pendingTokens = new Map();
const passkeyUsers  = new Map(); // userId → { passkeys[], currentChallenge, deviceId }

// ─── Helpers ─────────────────────────────────────────────────────────────────
function generateSecret() { return crypto.randomBytes(32).toString("hex"); }
function hmac(secret, data) {
  return crypto.createHmac("sha256", secret).update(data).digest("hex");
}
function getRpId(req)   { return process.env.RP_ID   || req.hostname; }
function getOrigin(req) { return process.env.ORIGIN  || `https://${req.hostname}`; }

// ─── Pair a laptop ────────────────────────────────────────────────────────────
app.post("/pair", (req, res) => {
  const deviceId = crypto.randomBytes(8).toString("hex");
  const secret   = generateSecret();
  devices.set(deviceId, { secret, ws: null, name: req.body.name || "laptop" });
  console.log(`[PAIR] Device registered: ${deviceId}`);
  res.json({ deviceId, secret, message: "Save these — secret won't be shown again." });
});

// ════════════════════════════════════════════════════════════════════════════
//  WebAuthn Registration (one-time setup)
// ════════════════════════════════════════════════════════════════════════════
app.post("/webauthn/register/options", async (req, res) => {
  try {
    const { userId, deviceId } = req.body;
    if (!userId || !deviceId || !devices.has(deviceId)) {
      return res.status(400).json({ error: "Invalid userId or deviceId" });
    }
    const user = passkeyUsers.get(userId) || { passkeys: [], deviceId };
    const rpID = getRpId(req);

    const options = await generateRegistrationOptions({
      rpName: "Laptop Unlock",
      rpID,
      userID: new TextEncoder().encode(userId),
      userName: userId,
      userDisplayName: "Laptop Unlock",
      attestationType: "none",
      excludeCredentials: user.passkeys.map(p => ({
        id: p.id, type: "public-key",
      })),
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "required",        // ← forces fingerprint
        authenticatorAttachment: "platform", // ← device built-in biometric
      },
    });

    user.currentChallenge = options.challenge;
    user.deviceId = deviceId;
    passkeyUsers.set(userId, user);

    console.log(`[REGISTER] Options sent to user: ${userId}, rpID: ${rpID}`);
    res.json(options);
  } catch (err) {
    console.error("[REGISTER/options] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/webauthn/register/verify", async (req, res) => {
  try {
    const { userId, credential } = req.body;
    const user = passkeyUsers.get(userId);
    if (!user?.currentChallenge) {
      return res.status(400).json({ error: "No pending registration" });
    }

    console.log("[REGISTER/verify] Verifying for user:", userId);

    const verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge: user.currentChallenge,
      expectedOrigin: getOrigin(req),
      expectedRPID: getRpId(req),
      requireUserVerification: true,
    });

    console.log("[REGISTER/verify] Result:", JSON.stringify({
      verified: verification.verified,
      infoKeys: verification.registrationInfo
        ? Object.keys(verification.registrationInfo)
        : null,
    }));

    if (!verification.verified) {
      return res.status(400).json({ error: "Verification failed" });
    }

    const info = verification.registrationInfo;

    // ── Handle both v9 and v10 of @simplewebauthn/server ──────────────────
    // v10: info.credential.id / info.credential.publicKey / info.credential.counter
    // v9:  info.credentialID  / info.credentialPublicKey  / info.counter
    let credId, credPublicKey, credCounter;

    if (info.credential) {
      // v10 API
      credId        = info.credential.id;
      credPublicKey = Buffer.from(info.credential.publicKey).toString("base64");
      credCounter   = info.credential.counter;
    } else {
      // v9 API fallback
      credId        = info.credentialID;
      credPublicKey = Buffer.from(info.credentialPublicKey).toString("base64");
      credCounter   = info.counter;
    }

    console.log("[REGISTER/verify] Saving credId:", credId);

    user.passkeys.push({
      id: credId,
      publicKey: credPublicKey,
      counter: credCounter,
      transports: credential.response?.transports || [],
    });
    user.currentChallenge = null;
    passkeyUsers.set(userId, user);

    console.log(`[PASSKEY] ✅ Registered for user: ${userId}`);
    res.json({ verified: true });

  } catch (err) {
    console.error("[REGISTER/verify] Error:", err);
    res.status(400).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  WebAuthn Authentication (every unlock)
// ════════════════════════════════════════════════════════════════════════════
app.post("/webauthn/auth/options", async (req, res) => {
  try {
    const { userId } = req.body;
    const user = passkeyUsers.get(userId);
    if (!user?.passkeys?.length) {
      return res.status(400).json({ error: "No passkeys registered. Please set up first." });
    }

    const options = await generateAuthenticationOptions({
      rpID: getRpId(req),
      userVerification: "required",
      allowCredentials: user.passkeys.map(p => ({
        id: p.id, type: "public-key", transports: p.transports,
      })),
    });

    user.currentChallenge = options.challenge;
    passkeyUsers.set(userId, user);

    console.log(`[AUTH] Options sent to user: ${userId}`);
    res.json(options);
  } catch (err) {
    console.error("[AUTH/options] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/webauthn/auth/verify", async (req, res) => {
  try {
    const { userId, credential, deviceId } = req.body;
    const user = passkeyUsers.get(userId);
    if (!user?.currentChallenge) {
      return res.status(400).json({ error: "No pending authentication" });
    }

    const passkey = user.passkeys.find(p => p.id === credential.id);
    if (!passkey) {
      return res.status(400).json({ error: "Passkey not found" });
    }

    const verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge: user.currentChallenge,
      expectedOrigin: getOrigin(req),
      expectedRPID: getRpId(req),
      credential: {
        id: passkey.id,
        publicKey: Buffer.from(passkey.publicKey, "base64"),
        counter: passkey.counter,
        transports: passkey.transports,
      },
      requireUserVerification: true,
    });

    if (!verification.verified) {
      return res.status(401).json({ error: "Authentication failed" });
    }

    // Update counter (replay attack protection)
    passkey.counter = verification.authenticationInfo.newCounter;
    user.currentChallenge = null;
    passkeyUsers.set(userId, user);

    // ✅ Fingerprint verified → unlock laptop
    const targetDeviceId = deviceId || user.deviceId;
    const device = devices.get(targetDeviceId);

    if (device?.ws?.readyState === 1) {
      device.ws.send(JSON.stringify({ type: "UNLOCK" }));
      console.log(`[UNLOCK] ✅ Signal sent to ${targetDeviceId}`);
      res.json({ status: "sent", message: "Laptop unlocked! 🎉" });
    } else {
      const token = generateSecret().slice(0, 16);
      pendingTokens.set(token, { deviceId: targetDeviceId, expires: Date.now() + 30_000 });
      console.log(`[UNLOCK] Queued for offline device: ${targetDeviceId}`);
      res.json({ status: "queued", message: "Laptop offline — will unlock on reconnect" });
    }
  } catch (err) {
    console.error("[AUTH/verify] Error:", err);
    res.status(400).json({ error: err.message });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_, res) =>
  res.json({ status: "ok", devices: devices.size, passkeyUsers: passkeyUsers.size })
);

// ─── WebSocket: Laptop daemon ──────────────────────────────────────────────────
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
      if (!device)
        return ws.send(JSON.stringify({ type: "ERROR", error: "Unknown device" }));
      const expected = hmac(device.secret, deviceId + timestamp);
      if (signature !== expected)
        return ws.send(JSON.stringify({ type: "ERROR", error: "Auth failed" }));

      authenticatedDeviceId = deviceId;
      device.ws = ws;
      devices.set(deviceId, device);
      ws.send(JSON.stringify({ type: "AUTH_OK", deviceId }));
      console.log(`[WS] Laptop connected: ${deviceId}`);

      // Deliver queued unlocks
      for (const [token, data] of pendingTokens) {
        if (data.deviceId === deviceId && data.expires > Date.now()) {
          ws.send(JSON.stringify({ type: "UNLOCK" }));
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

// Cleanup
setInterval(() => {
  const now = Date.now();
  for (const [t, d] of pendingTokens) { if (d.expires < now) pendingTokens.delete(t); }
}, 60_000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Unlock service on port ${PORT}`));
