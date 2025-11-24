#!/usr/bin/env bash
# Entry point for lightLLM container
set -euo pipefail

# If conda is installed, initialize
if [ -f /opt/conda/etc/profile.d/conda.sh ]; then
  # shellcheck disable=SC1091
  . /opt/conda/etc/profile.d/conda.sh
fi

# If user passed "setup" as first arg, run setup in non-interactive mode
if [ "$#" -gt 0 ] && [ "$1" = "setup" ]; then
  shift
  echo "[entrypoint] Running setup.sh -y inside container"
  if [ -f ./setup.sh ]; then
    chmod +x ./setup.sh
    ./setup.sh -y "$@"
  else
    echo "[entrypoint] setup.sh not found in /opt/lightLLM"
    exit 1
  fi
  exit 0
fi

# Otherwise exec provided command (or start a bash)
exec "$@"
