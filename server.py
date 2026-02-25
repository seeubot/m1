"""
Remote Lock Server — Deploy on Koyeb
Handles lock/unlock state and serves the admin control panel.
"""
from flask import Flask, jsonify, request, send_from_directory, abort
import time, os, secrets

app = Flask(__name__, static_folder="static")

# ── State ──────────────────────────────────────────────────────────────────
lock_state = {
    "locked": False,
    "message": "⚠️ System Error Detected\n\nPlease contact your System Administrator\nto resolve this issue.",
    "triggered_at": None,
    "triggered_by": None,
}

# Simple shared secret — set via env var LOCK_SECRET on Koyeb
ADMIN_SECRET = os.environ.get("LOCK_SECRET", "change-me-secret-123")

# ── Helper ─────────────────────────────────────────────────────────────────
def require_auth():
    token = request.headers.get("X-Lock-Secret") or request.args.get("secret")
    if token != ADMIN_SECRET:
        abort(403, "Forbidden: invalid secret")

# ── API Routes ─────────────────────────────────────────────────────────────
@app.route("/api/status", methods=["GET"])
def status():
    """Laptop agent polls this endpoint every 2 seconds."""
    return jsonify(lock_state)

@app.route("/api/lock", methods=["POST"])
def lock():
    require_auth()
    data = request.get_json(silent=True) or {}
    lock_state["locked"] = True
    lock_state["message"] = data.get("message", lock_state["message"])
    lock_state["triggered_at"] = time.time()
    lock_state["triggered_by"] = request.remote_addr
    return jsonify({"ok": True, "state": lock_state})

@app.route("/api/unlock", methods=["POST"])
def unlock():
    require_auth()
    lock_state["locked"] = False
    lock_state["triggered_at"] = time.time()
    return jsonify({"ok": True, "state": lock_state})

@app.route("/api/message", methods=["POST"])
def update_message():
    """Update lock screen message without changing lock state."""
    require_auth()
    data = request.get_json(silent=True) or {}
    lock_state["message"] = data.get("message", lock_state["message"])
    return jsonify({"ok": True, "state": lock_state})

# ── Serve Frontend ─────────────────────────────────────────────────────────
@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def serve(path):
    if path and os.path.exists(os.path.join(app.static_folder, path)):
        return send_from_directory(app.static_folder, path)
    return send_from_directory(app.static_folder, "index.html")

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    print(f"🔐 Remote Lock Server starting on port {port}")
    print(f"🔑 Secret: {ADMIN_SECRET}")
    app.run(host="0.0.0.0", port=port)
