#!/usr/bin/env bash
set -euo pipefail
# Convenience wrapper: run `web/start.sh` inside the project and (if possible) inside conda env
# After services start it will open the browser and then exit (non-blocking).

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
WEB_DIR="$ROOT_DIR/web"
URL="http://127.0.0.1:8000"
WAIT_TIMEOUT=30
POLL_INTERVAL=1

if [ ! -f "$WEB_DIR/start.sh" ]; then
  echo "Missing $WEB_DIR/start.sh"; exit 1
fi

cd "$WEB_DIR"

# Allow passing args to control what to start (e.g. --backend, --ollama MODEL, --all)
ARGS=("$@")
if [ ${#ARGS[@]} -eq 0 ]; then
  ARGS=("--all")
fi

echo "Starting services with: ./start.sh ${ARGS[*]}"
bash ./start.sh "${ARGS[@]}"

# Wait for backend to be ready
echo "Waiting for backend to be ready at $URL (timeout ${WAIT_TIMEOUT}s)"
start_ts=$(date +%s)
while true; do
  if curl -s -o /dev/null -w '%{http_code}' "$URL/" | grep -q "200"; then
    echo "Backend is up"
    break
  fi
  now_ts=$(date +%s)
  if [ $((now_ts - start_ts)) -ge $WAIT_TIMEOUT ]; then
    echo "Timeout waiting for backend after ${WAIT_TIMEOUT}s"
    break
  fi
  sleep $POLL_INTERVAL
done

# Try to open browser (non-fatal)
open_cmd=""
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" >/dev/null 2>&1 || true &
  open_cmd="xdg-open"
elif command -v gnome-open >/dev/null 2>&1; then
  gnome-open "$URL" >/dev/null 2>&1 || true &
  open_cmd="gnome-open"
else
  # python fallback
  if command -v python3 >/dev/null 2>&1; then
    python3 -m webbrowser -t "$URL" >/dev/null 2>&1 || true &
    open_cmd="python3 -m webbrowser"
  fi
fi

if [ -n "$open_cmd" ]; then
  echo "Opened browser with: $open_cmd $URL"
else
  echo "No browser opener found; please open $URL manually"
fi

echo "start_all finished (services running in background)."
