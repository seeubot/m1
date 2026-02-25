"""
Remote Lock Agent — Runs on your Windows Laptop
Polls the Koyeb server every 2 seconds and activates a fullscreen lock when commanded.

Requirements:
    pip install requests pillow

Usage:
    python lock_agent.py --server https://your-app.koyeb.app --secret your-secret
    
Or set env vars:
    LOCK_SERVER=https://your-app.koyeb.app
    LOCK_SECRET=your-secret
"""

import sys, os, time, threading, argparse, ctypes, requests
import tkinter as tk
from tkinter import font as tkfont

# ── Config ─────────────────────────────────────────────────────────────────
DEFAULT_SERVER = os.environ.get("LOCK_SERVER", "https://your-app.koyeb.app")
DEFAULT_SECRET = os.environ.get("LOCK_SECRET", "change-me-secret-123")
POLL_INTERVAL  = 2   # seconds between server polls

# ── Lock Window ────────────────────────────────────────────────────────────
class LockScreen:
    def __init__(self, message: str):
        self.root = tk.Tk()
        self._configure_window()
        self._build_ui(message)
        self._block_taskbar()

    def _configure_window(self):
        r = self.root
        r.title("")
        r.configure(bg="#0a0a0f")
        # Fullscreen on all monitors via geometry hack
        r.attributes("-fullscreen", True)
        r.attributes("-topmost", True)
        r.attributes("-toolwindow", True)
        r.overrideredirect(True)                 # Remove title bar
        # Span entire virtual desktop (multi-monitor)
        sw = r.winfo_screenwidth()
        sh = r.winfo_screenheight()
        r.geometry(f"{sw}x{sh}+0+0")
        # Disable all close methods
        r.protocol("WM_DELETE_WINDOW", lambda: None)
        r.bind("<Alt-F4>",          lambda e: "break")
        r.bind("<Escape>",          lambda e: "break")
        r.bind("<Control-Alt-Delete>", lambda e: "break")
        r.focus_force()
        r.grab_set()                             # Capture all events

    def _build_ui(self, message: str):
        r = self.root
        sw = r.winfo_screenwidth()
        sh = r.winfo_screenheight()

        # Dark gradient canvas background
        canvas = tk.Canvas(r, bg="#0a0a0f", highlightthickness=0,
                           width=sw, height=sh)
        canvas.place(x=0, y=0)

        # Animated scanlines illusion via repeated rectangles
        for y in range(0, sh, 4):
            canvas.create_line(0, y, sw, y, fill="#111118", width=1)

        # Red pulsing circle accent (static version)
        cx, cy = sw // 2, sh // 2 - 80
        for r_ in range(120, 0, -10):
            alpha_hex = hex(int(15 * (r_ / 120)))[2:]
            canvas.create_oval(cx - r_, cy - r_, cx + r_, cy + r_,
                                outline=f"#ff{alpha_hex}0000" if len(alpha_hex)==1
                                        else f"#ff{alpha_hex}00",
                                width=1)

        # Warning icon (⚠)
        warn_font = tkfont.Font(family="Segoe UI Symbol", size=64)
        canvas.create_text(cx, cy, text="⚠", fill="#cc2200",
                            font=warn_font, anchor="center")

        # Headline
        headline_font = tkfont.Font(family="Segoe UI", size=28, weight="bold")
        canvas.create_text(sw // 2, cy + 110,
                            text="SYSTEM ACCESS RESTRICTED",
                            fill="#ff3322", font=headline_font, anchor="center")

        # Divider line
        canvas.create_line(sw//2 - 300, cy + 145,
                           sw//2 + 300, cy + 145,
                           fill="#331111", width=2)

        # Message block
        msg_font = tkfont.Font(family="Segoe UI", size=14)
        canvas.create_text(sw // 2, cy + 210,
                            text=message,
                            fill="#aaaaaa", font=msg_font,
                            anchor="center", justify="center",
                            width=600)

        # Admin contact footer
        footer_font = tkfont.Font(family="Courier New", size=10)
        canvas.create_text(sw // 2, sh - 60,
                            text="[SYS-LOCK v1.0]  •  Contact your administrator to restore access",
                            fill="#333344", font=footer_font, anchor="center")

        # Blinking cursor effect in bottom right
        self._blink_cursor(canvas, sw - 30, sh - 30)

    def _blink_cursor(self, canvas, x, y):
        """Blinking terminal cursor for atmosphere."""
        cursor_id = canvas.create_text(x, y, text="█", fill="#cc2200",
                                       font=("Courier New", 12))
        def toggle(visible=[True]):
            canvas.itemconfig(cursor_id, fill="#cc2200" if visible[0] else "#0a0a0f")
            visible[0] = not visible[0]
            canvas.after(600, toggle)
        toggle()

    def _block_taskbar(self):
        """Hide taskbar via Windows API."""
        try:
            SW_HIDE = 0
            taskbar = ctypes.windll.user32.FindWindowW("Shell_TrayWnd", None)
            ctypes.windll.user32.ShowWindow(taskbar, SW_HIDE)
            self._taskbar_handle = taskbar
        except Exception:
            pass

    def _restore_taskbar(self):
        try:
            SW_SHOW = 5
            ctypes.windll.user32.ShowWindow(self._taskbar_handle, SW_SHOW)
        except Exception:
            pass

    def destroy(self):
        self._restore_taskbar()
        try:
            self.root.grab_release()
            self.root.destroy()
        except Exception:
            pass

    def mainloop(self):
        self.root.mainloop()


# ── Polling Agent ──────────────────────────────────────────────────────────
class LockAgent:
    def __init__(self, server: str, secret: str):
        self.server  = server.rstrip("/")
        self.headers = {"X-Lock-Secret": secret}
        self.lock_win: LockScreen | None = None
        self._lock_thread: threading.Thread | None = None
        self._running = True

    def poll(self):
        """Background thread: polls server and manages lock state."""
        was_locked = False
        while self._running:
            try:
                r = requests.get(f"{self.server}/api/status",
                                 headers=self.headers, timeout=5)
                data = r.json()
                is_locked = data.get("locked", False)
                message   = data.get("message", "System restricted.")

                if is_locked and not was_locked:
                    # Need to show lock on main thread
                    self._show_lock(message)
                elif not is_locked and was_locked:
                    self._hide_lock()

                was_locked = is_locked
            except Exception as e:
                print(f"[poll error] {e}")

            time.sleep(POLL_INTERVAL)

    def _show_lock(self, message: str):
        """Must be called from the main thread via after()."""
        def _do():
            if self.lock_win is None:
                self.lock_win = LockScreen(message)
                # Non-blocking mainloop via update loop
                self._pump_tk()
        # Schedule on tkinter main loop if running, else call directly
        if self.lock_win:
            return
        _do()

    def _pump_tk(self):
        """Keep tkinter alive while polling runs in background."""
        if self.lock_win:
            try:
                self.lock_win.root.update()
            except tk.TclError:
                self.lock_win = None
                return
        if self.lock_win:
            threading.Timer(0.05, self._pump_tk).start()

    def _hide_lock(self):
        if self.lock_win:
            self.lock_win.destroy()
            self.lock_win = None

    def run(self):
        print(f"🔐 Lock Agent running — polling {self.server}")
        poll_thread = threading.Thread(target=self.poll, daemon=True)
        poll_thread.start()

        # Main thread just keeps alive
        try:
            while self._running:
                if self.lock_win:
                    try:
                        self.lock_win.root.update()
                    except tk.TclError:
                        self.lock_win = None
                time.sleep(0.05)
        except KeyboardInterrupt:
            print("\n[Agent stopped]")
            self._running = False
            if self.lock_win:
                self.lock_win.destroy()


# ── System Tray (optional, requires pystray) ───────────────────────────────
def run_with_tray(agent: LockAgent):
    """Wrap agent in a system tray icon so it hides in background."""
    try:
        import pystray
        from PIL import Image, ImageDraw

        # Simple red square icon
        img = Image.new("RGB", (64, 64), color="#cc2200")
        d = ImageDraw.Draw(img)
        d.text((16, 18), "🔒", fill="white")

        def on_quit(icon, item):
            agent._running = False
            icon.stop()

        icon = pystray.Icon(
            "RemoteLock",
            img,
            "Remote Lock Agent",
            menu=pystray.Menu(
                pystray.MenuItem("Remote Lock Agent (Running)", lambda: None, enabled=False),
                pystray.MenuItem("Quit", on_quit)
            )
        )
        # Run agent in separate thread, tray in main thread
        t = threading.Thread(target=agent.run, daemon=True)
        t.start()
        icon.run()
    except ImportError:
        # No pystray — just run headlessly
        agent.run()


# ── Entry Point ────────────────────────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Remote Lock Agent")
    parser.add_argument("--server", default=DEFAULT_SERVER,
                        help="Koyeb server URL")
    parser.add_argument("--secret", default=DEFAULT_SECRET,
                        help="Shared secret for authentication")
    parser.add_argument("--tray", action="store_true",
                        help="Run in system tray (requires pystray + pillow)")
    args = parser.parse_args()

    agent = LockAgent(server=args.server, secret=args.secret)

    if args.tray:
        run_with_tray(agent)
    else:
        agent.run()
