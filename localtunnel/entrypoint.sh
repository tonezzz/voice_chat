#!/bin/sh
set -eu

LT_PORT=${LT_PORT:-80}
LT_HOST=${LT_HOST:-a_kakk}
LT_SUBDOMAIN=${LT_SUBDOMAIN:-}

if ! command -v lt >/dev/null 2>&1; then
  echo "[localtunnel] Installing localtunnel globally"
  npm install -g localtunnel
fi

CMD="lt --port ${LT_PORT} --local-host ${LT_HOST}"
if [ -n "$LT_SUBDOMAIN" ]; then
  CMD="$CMD --subdomain ${LT_SUBDOMAIN}"
fi

echo "[localtunnel] Launching tunnel: $CMD"
exec sh -c "$CMD"
