# 🔒 SysLock — Remote Lock System

A remote lock screen system for your Windows laptop.  
Trigger a full-screen overlay from any mobile or browser in seconds.

---

## Architecture

```
[Your Phone / Browser]
        │  HTTP
        ▼
[Koyeb Server]  ←── lock_state in memory
        │  Polling (every 2s)
        ▼
[Windows Laptop — lock_agent.py]
        │
        ▼
[Fullscreen Tkinter Lock Overlay]
```

---

## Part 1 — Deploy the Server on Koyeb

### Option A: GitHub + Koyeb (Recommended)

1. Push this entire project to a **GitHub repo** (public or private)
2. Go to [koyeb.com](https://koyeb.com) → Create Service → **Web Service**
3. Select your GitHub repo
4. Set:
   - **Build command:** `pip install -r requirements.txt`
   - **Start command:** `gunicorn server:app --bind 0.0.0.0:$PORT --workers 1 --threads 4`
   - **Port:** `8000`
5. Add **Environment Variable:**
   - `LOCK_SECRET` = `your-strong-password-here`
6. Deploy → copy your app URL e.g. `https://syslock-xxx.koyeb.app`

### Option B: Local test (no Koyeb needed)
```bash
pip install flask gunicorn
LOCK_SECRET=mysecret python server.py
# Open http://localhost:8000
```

---

## Part 2 — Run the Agent on Your Laptop

### Install
```bash
pip install requests
# Optional (for system tray icon):
pip install pystray pillow
```

### Run
```bash
# Basic
python lock_agent.py --server https://your-app.koyeb.app --secret your-strong-password-here

# With system tray icon (hides in background)
python lock_agent.py --server https://your-app.koyeb.app --secret your-strong-password-here --tray
```

### Auto-start on Windows Boot (optional)
1. Press `Win + R` → type `shell:startup`
2. Create a shortcut to `lock_agent.py` in that folder  
   Or create a `.bat` file:
   ```bat
   @echo off
   cd /d C:\path\to\remote-lock
   python lock_agent.py --server https://your-app.koyeb.app --secret your-password --tray
   ```

---

## Part 3 — Use the Control Panel

1. Open `https://your-app.koyeb.app` on your **phone or any browser**
2. Enter your server URL and secret → click **CONNECT**
3. Use the big button or **🔒 LOCK NOW** to trigger the lock
4. The lock screen appears on the laptop instantly (within 2 seconds)
5. Click **🔓 UNLOCK** to release it

---

## Lock Screen Look

The lock screen on the laptop shows:
- Full black overlay covering **all monitors**
- ⚠ Warning icon
- Red headline: **SYSTEM ACCESS RESTRICTED**
- Your custom message (configurable from the panel)
- Taskbar is hidden while locked
- All keyboard shortcuts (Alt-F4, Escape) are blocked

---

## Security Notes

- The `LOCK_SECRET` is the only authentication — make it strong!
- The server holds state in memory (resets on restart) — for personal use this is fine
- For added security, you can add IP whitelisting in `server.py`
- The agent only accepts commands from your Koyeb server URL

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Lock screen doesn't appear | Check agent is running, verify server URL + secret |
| Agent can't connect | Confirm Koyeb app is running, check the URL |
| Taskbar still visible | Restart agent as Administrator |
| Ctrl+Alt+Delete still works | This is a Windows security feature — cannot be blocked by user apps |
