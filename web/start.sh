#!/usr/bin/env bash
set -euo pipefail
# One-click start script for web backend and optionally Ollama.
# Usage: start.sh [--backend] [--ollama [MODEL]] [--all] [--foreground]

ENV_NAME="lightllm"
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)/.."
WEB_DIR="$ROOT_DIR/web"
LOG_DIR="$ROOT_DIR/logs"
mkdir -p "$LOG_DIR"
UVICORN_LOG="$LOG_DIR/web_uvicorn.log"
OLLAMA_LOG="$LOG_DIR/ollama.log"

run_in_conda() {
  local cmd="$1"
  if command -v conda >/dev/null 2>&1; then
    # Use conda run to execute inside environment if available
    conda run -n "$ENV_NAME" --no-capture-output bash -lc "$cmd"
  else
    bash -lc "$cmd"
  fi
}

kill_port() {
  local port="$1"
  local pids
  pids=$(lsof -ti:"$port" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "Killing processes on port $port: $pids"
    kill -9 $pids || true
  fi
}

start_backend() {
  echo "Starting backend..."
  kill_port 8000

  # Prefer to invoke python from the conda env (if available) and pass PYTHONPATH atomically.
  if command -v conda >/dev/null 2>&1; then
    # Try to get the python executable path inside the env
    PY_CMD="$(conda run -n "$ENV_NAME" --no-capture-output which python 2>/dev/null || true)"
      if [ -z "$PY_CMD" ]; then
        # Fallback to conda run python -m
        echo "Using 'conda run -n $ENV_NAME python -m uvicorn' fallback"
        if [ "$FOREGROUND" -eq 1 ]; then
          echo "Running uvicorn in foreground (conda run)...";
          PYTHONPATH="$ROOT_DIR" conda run -n "$ENV_NAME" --no-capture-output bash -lc 'python -m uvicorn web.backend:app --host 127.0.0.1 --port 8000 --reload'
        else
          (PYTHONPATH="$ROOT_DIR" conda run -n "$ENV_NAME" --no-capture-output bash -lc 'nohup python -m uvicorn web.backend:app --host 127.0.0.1 --port 8000 --reload > "$UVICORN_LOG" 2>&1 &')
        fi
      else
    else
      echo "Using python: $PY_CMD"
      if [ "$FOREGROUND" -eq 1 ]; then
        echo "Running uvicorn in foreground using $PY_CMD";
        PYTHONPATH="$ROOT_DIR" exec "$PY_CMD" -m uvicorn web.backend:app --host 127.0.0.1 --port 8000
      else
        (PYTHONPATH="$ROOT_DIR" nohup "$PY_CMD" -m uvicorn web.backend:app --host 127.0.0.1 --port 8000 > "$UVICORN_LOG" 2>&1 &)
      fi
    fi
  else
    fi
  else
    # No conda: use system python3 if available
    if command -v python3 >/dev/null 2>&1; then
      if [ "$FOREGROUND" -eq 1 ]; then
        echo "Running uvicorn in foreground using system python3";
        PYTHONPATH="$ROOT_DIR" exec python3 -m uvicorn web.backend:app --host 127.0.0.1 --port 8000
      else
        (PYTHONPATH="$ROOT_DIR" nohup python3 -m uvicorn web.backend:app --host 127.0.0.1 --port 8000 > "$UVICORN_LOG" 2>&1 &)
      fi
    else
      # Fallback: try uvicorn directly
      if [ "$FOREGROUND" -eq 1 ]; then
        echo "Running uvicorn in foreground (uvicorn CLI)";
        PYTHONPATH="$ROOT_DIR" exec uvicorn web.backend:app --host 127.0.0.1 --port 8000
      else
        (PYTHONPATH="$ROOT_DIR" nohup uvicorn web.backend:app --host 127.0.0.1 --port 8000 > "$UVICORN_LOG" 2>&1 &)
      fi
    fi
  fi

  # give subprocess a moment to start
  sleep 2
  echo "Backend started (log: $UVICORN_LOG)"
}

start_ollama() {
  local model="$1"
  echo "Starting Ollama (if installed)..."
  if ! command -v ollama >/dev/null 2>&1; then
    echo "ollama binary not found in PATH; skipping ollama start"
    return 1
  fi
  kill_port 11434 || true
  if [ -n "$model" ]; then
    echo "Pulling model: $model (this may take time)" | tee -a "$OLLAMA_LOG"
    ollama pull "$model" >> "$OLLAMA_LOG" 2>&1 || true
  fi
  if [ "$FOREGROUND" -eq 1 ]; then
    echo "Running ollama serve in foreground (logs to stdout/stderr)"
    exec ollama serve
  else
    nohup ollama serve > "$OLLAMA_LOG" 2>&1 &
    sleep 2
    echo "Ollama served (log: $OLLAMA_LOG)"
  fi
}

print_usage() {
  cat <<EOF
Usage: $0 [--backend] [--ollama [MODEL]] [--all]

--backend       Start only the backend (uvicorn).
--ollama MODEL  Start ollama serve and optionally pull MODEL before serving.
--all           Start backend and Ollama (if available).
--help          Show this message.
EOF
}

if [ "$#" -eq 0 ]; then
  # default: start backend only
  start_backend
  exit 0
fi

MODE_BACKEND=0
MODE_OLLAMA=0
OLLAMA_MODEL=""
FOREGROUND=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --backend)
      MODE_BACKEND=1; shift;;
    --ollama)
      MODE_OLLAMA=1; shift; if [ "$#" -gt 0 ] && [[ ! "$1" =~ ^-- ]]; then OLLAMA_MODEL="$1"; shift; fi;;
    --all)
      MODE_BACKEND=1; MODE_OLLAMA=1; shift;;
    --help|-h)
      print_usage; exit 0;;
    --foreground|--fg)
      FOREGROUND=1; shift;;
    *)
      echo "Unknown arg: $1"; print_usage; exit 1;;
  esac
done

if [ "$MODE_BACKEND" -eq 1 ]; then
  start_backend
fi
if [ "$MODE_OLLAMA" -eq 1 ]; then
  start_ollama "$OLLAMA_MODEL"
fi

echo "Done."
