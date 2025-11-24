#!/usr/bin/env bash
# Simple local mock for `google-search` MCP server used by the demo.
# It reads optional stdin and replies with a short mock result.
set -euo pipefail
PAYLOAD=""
if read -t 0; then
  # read remainder of stdin
  PAYLOAD=$(cat -)
fi
if [ -z "$PAYLOAD" ]; then
  echo "MOCK google-search: no payload received"
else
  echo "MOCK google-search result for: ${PAYLOAD//\n/ }"
fi
