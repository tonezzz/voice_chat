#!/usr/bin/env bash
set -uo pipefail

SERVER_URL="${SERVER_URL:-http://server:3001}"
MCP0_URL="${MCP0_URL:-http://mcp0:8010}"
MEETING_URL="${MEETING_URL:-http://mcp-meeting:8008}"
MEETING_STORAGE_PATH="${MEETING_STORAGE_PATH:-/data/meetings.json}"
HTTP_TIMEOUT="${HTTP_TIMEOUT:-20}"
LOG_DIR="${LOG_DIR:-/workspace/logs}"

mkdir -p "$LOG_DIR"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
LOG_FILE="${LOG_DIR}/diagnostics-${TIMESTAMP}.log"

exec > >(tee -a "$LOG_FILE") 2>&1

echo "# MCP Diagnostics"
echo "timestamp: $(date -Iseconds)"
echo "SERVER_URL=${SERVER_URL}"
echo "MCP0_URL=${MCP0_URL}"
echo "MEETING_URL=${MEETING_URL}"
echo "MEETING_STORAGE_PATH=${MEETING_STORAGE_PATH}"
echo "HTTP_TIMEOUT=${HTTP_TIMEOUT}"
echo "LOG_FILE=${LOG_FILE}"

declare -i failures=0

run_cmd() {
  local label="$1"
  shift
  echo
  echo "## ${label}"
  echo "cmd: $*"
  if "$@"; then
    echo "status: ok"
  else
    local rc=$?
    echo "status: failed (exit ${rc})"
    failures+=1
  fi
}

run_http() {
  local label="$1"
  local url="$2"
  shift 2
  run_cmd "$label" http --timeout "$HTTP_TIMEOUT" --pretty=format "$@" "$url"
}

run_http "Express /health" "${SERVER_URL}/health" GET
run_http "MCP providers refresh" "${SERVER_URL}/mcp/providers?refresh=true" GET
run_http "Meeting sessions list" "${SERVER_URL}/meeting/sessions" GET
run_http "Meeting MCP health" "${MEETING_URL}/health" GET
run_http "MCP0 health" "${MCP0_URL}/health" GET

if [ -f "$MEETING_STORAGE_PATH" ]; then
  run_cmd "Meeting storage stats" ls -lh "$MEETING_STORAGE_PATH"
  run_cmd "Meeting storage tail" tail -n 40 "$MEETING_STORAGE_PATH"
else
  echo
  echo "## Meeting storage"
  echo "File not found at ${MEETING_STORAGE_PATH}"
fi

echo
if [ "$failures" -gt 0 ]; then
  echo "Diagnostics complete with ${failures} failing command(s)."
else
  echo "Diagnostics complete successfully."
fi

echo "Log saved to ${LOG_FILE}"
