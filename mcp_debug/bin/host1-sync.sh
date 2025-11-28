#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/../.." &>/dev/null && pwd)"

CREDENTIAL_PATH="${STACK_HOST1_CREDENTIAL:-/workspace/shares/credentials/host1-ssh.json}"
COMPOSE_DIR="${STACK_ROOT_DIR:-/workspace}"

if [[ ! -f "$CREDENTIAL_PATH" ]]; then
  echo "[host1-sync] credential file not found: $CREDENTIAL_PATH" >&2
  exit 1
fi

echo "[host1-sync] Running remote deploy via host01"
"$SCRIPT_DIR/mcp-sshpass-test" -c "$CREDENTIAL_PATH" -- \
  "cd $COMPOSE_DIR && npx dotenv-cli -e .env -- docker compose --profile host1-sync run --rm host1-sync"

echo "[host1-sync] Completed"
