#!/usr/bin/env python3
"""
Laptop Unlock Daemon
Connects to your Koyeb server and unlocks the screen when a fingerprint
is verified on your mobile device.

Setup:
    pip install websocket-client

Run:
    python unlock-client.py

Or as a background service — see README for systemd/launchd instructions.
"""

import hashlib
import hmac as hmac_lib
import json
import logging
import os
import platform
import subprocess
import sys
import time
import threading

try:
    import websocket
except ImportError:
    print("Missing dependency. Run: pip install websocket-client")
    sys.exit(1)

# ─── Configuration ────────────────────────────────────────────────────────────
CONFIG_FILE = os.path.expanduser("~/.unlock-client.json")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("unlock-client")


def load_config():
    if not os.path.exists(CONFIG_FILE):
        print("\n🔧 First-time setup")
        print("─" * 40)
        server = input("Server URL (e.g. https://your-app.koyeb.app): ").strip().rstrip("/")
        device_id = input("Device ID (from /pair): ").strip()
        secret = input("Secret (from /pair): ").strip()
        cfg = {"server": server, "device_id": device_id, "secret": secret}
        with open(CONFIG_FILE, "w") as f:
            json.dump(cfg, f, indent=2)
        os.chmod(CONFIG_FILE, 0o600)
        print(f"✅ Config saved to {CONFIG_FILE}\n")
        return cfg
    with open(CONFIG_FILE) as f:
        return json.load(f)


# ─── HMAC signature ───────────────────────────────────────────────────────────
def sign(secret: str, device_id: str, timestamp: int) -> str:
    msg = (device_id + str(timestamp)).encode()
    return hmac_lib.new(secret.encode(), msg, hashlib.sha256).hexdigest()


# ─── OS-specific screen unlock ────────────────────────────────────────────────
def unlock_screen():
    system = platform.system()
    log.info(f"🔓 Unlocking screen on {system}...")

    try:
        if system == "Linux":
            # Try multiple methods
            session = os.environ.get("XDG_SESSION_TYPE", "")
            if session == "wayland":
                # GNOME Wayland
                subprocess.run(["loginctl", "unlock-sessions"], check=True)
            else:
                # X11 - kill screensaver
                try:
                    subprocess.run(["xdg-screensaver", "reset"], check=True)
                except FileNotFoundError:
                    subprocess.run(["loginctl", "unlock-sessions"], check=True)

        elif system == "Darwin":  # macOS
            # Kill the screensaver process
            subprocess.run(
                ["osascript", "-e",
                 'tell application "System Events" to keystroke "" '],
                check=False
            )
            # Alternative: disable screen lock temporarily
            subprocess.run(
                ["bash", "-c",
                 "osascript -e 'tell application \"ScreenSaverEngine\" to quit'"],
                check=False
            )

        elif system == "Windows":
            import ctypes
            # SendMessage to unlock - requires no password if called from same session
            # For full unlock you need to use credential providers
            ctypes.windll.user32.LockWorkStation()  # This LOCKS — for unlock see README
            log.warning("Windows auto-unlock requires additional setup. See README.")

        log.info("✅ Unlock command executed")

    except Exception as e:
        log.error(f"Failed to unlock: {e}")


# ─── WebSocket client ─────────────────────────────────────────────────────────
class UnlockClient:
    def __init__(self, config):
        self.config = config
        self.ws_url = config["server"].replace("https://", "wss://").replace("http://", "ws://")
        self.ws = None
        self.authenticated = False
        self.reconnect_delay = 2
        self._ping_thread = None

    def _on_open(self, ws):
        log.info(f"🔌 Connected to {self.ws_url}")
        self.reconnect_delay = 2  # reset backoff

        # Authenticate immediately
        timestamp = int(time.time() * 1000)
        signature = sign(
            self.config["secret"],
            self.config["device_id"],
            timestamp,
        )
        ws.send(json.dumps({
            "type": "AUTH",
            "deviceId": self.config["device_id"],
            "signature": signature,
            "timestamp": timestamp,
        }))

    def _on_message(self, ws, message):
        try:
            msg = json.loads(message)
        except json.JSONDecodeError:
            return

        t = msg.get("type")

        if t == "AUTH_OK":
            self.authenticated = True
            log.info(f"✅ Authenticated as device {msg.get('deviceId')}")
            self._start_ping()

        elif t == "UNLOCK":
            log.info("🔓 Unlock signal received!")
            unlock_screen()

        elif t == "PONG":
            pass  # Keep-alive response

        elif t == "ERROR":
            log.error(f"Server error: {msg.get('error')}")

    def _on_error(self, ws, error):
        log.error(f"WebSocket error: {error}")

    def _on_close(self, ws, code, reason):
        self.authenticated = False
        log.warning(f"🔌 Disconnected (code={code}). Reconnecting in {self.reconnect_delay}s...")

    def _start_ping(self):
        def ping_loop():
            while self.authenticated and self.ws:
                try:
                    self.ws.send(json.dumps({"type": "PING"}))
                    time.sleep(20)
                except Exception:
                    break
        self._ping_thread = threading.Thread(target=ping_loop, daemon=True)
        self._ping_thread.start()

    def run_forever(self):
        log.info(f"🚀 Starting unlock client — connecting to {self.ws_url}")
        while True:
            try:
                self.ws = websocket.WebSocketApp(
                    self.ws_url,
                    on_open=self._on_open,
                    on_message=self._on_message,
                    on_error=self._on_error,
                    on_close=self._on_close,
                )
                self.ws.run_forever(ping_interval=30, ping_timeout=10)
            except KeyboardInterrupt:
                log.info("Shutting down.")
                break
            except Exception as e:
                log.error(f"Connection failed: {e}")

            time.sleep(self.reconnect_delay)
            self.reconnect_delay = min(self.reconnect_delay * 2, 60)  # Exponential backoff


if __name__ == "__main__":
    config = load_config()
    client = UnlockClient(config)
    client.run_forever()
