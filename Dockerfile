# ── Base ──────────────────────────────────────────────────────────────────
FROM python:3.12-slim

# ── Env ───────────────────────────────────────────────────────────────────
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000

# ── Workdir ───────────────────────────────────────────────────────────────
WORKDIR /app

# ── Dependencies ──────────────────────────────────────────────────────────
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ── App files ─────────────────────────────────────────────────────────────
COPY server.py .
COPY static/ ./static/

# ── Expose ────────────────────────────────────────────────────────────────
EXPOSE 8000

# ── Start ─────────────────────────────────────────────────────────────────
CMD gunicorn server:app \
    --bind 0.0.0.0:$PORT \
    --workers 1 \
    --threads 4 \
    --timeout 60 \
    --access-logfile - \
    --error-logfile -
