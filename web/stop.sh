#!/usr/bin/env bash
set -euo pipefail
# Stop backend and Ollama started by start.sh

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)/.."
LOG_DIR="$ROOT_DIR/logs"
UVICORN_LOG="$LOG_DIR/web_uvicorn.log"
OLLAMA_LOG="$LOG_DIR/ollama.log"

stop_by_port() {
  local port="$1"
  local pids
  pids=$(lsof -ti:"$port" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "Killing processes on port $port: $pids"
    kill -9 $pids || true
  else
    echo "No process on port $port"
  fi
}

stop_by_name() {
  local name="$1"
  local pids
  pids=$(pgrep -f "$name" || true)
  if [ -n "$pids" ]; then
    echo "Killing processes matching '$name': $pids"
    kill -9 $pids || true
  else
    echo "No process matching '$name'"
  fi
}

echo "Stopping backend (port 8000)..."
stop_by_port 8000

echo "Stopping Ollama (port 11434 / process ollama)..."
stop_by_port 11434 || true
stop_by_name "ollama" || true

echo "Done. Logs:"
if [ -f "$UVICORN_LOG" ]; then echo "-- $UVICORN_LOG --"; tail -n 20 "$UVICORN_LOG"; fi
if [ -f "$OLLAMA_LOG" ]; then echo "-- $OLLAMA_LOG --"; tail -n 20 "$OLLAMA_LOG"; fi
