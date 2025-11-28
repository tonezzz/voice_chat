#!/bin/sh
set -eu

: "${HOST1_HOST:?HOST1_HOST is required}"
: "${HOST1_USER:?HOST1_USER is required}"
: "${HOST1_SSH_KEY:?HOST1_SSH_KEY is required}"
: "${HOST1_CADDYFILE:?HOST1_CADDYFILE is required}"
: "${SOURCE_A_KAKK:?SOURCE_A_KAKK is required}"
: "${SOURCE_A_CHABA:?SOURCE_A_CHABA is required}"
: "${SOURCE_KK1:?SOURCE_KK1 is required}"

if ! command -v ssh >/dev/null 2>&1; then
  echo "[host1-sync] Installing openssh-client"
  apk add --no-cache openssh-client >/dev/null
fi

TEMP_KEY="/tmp/host1_ed25519.$$.key"
STAGE_DIR="$(mktemp -d -t host1-sync-XXXXXX)"

cleanup() {
  rm -f "$TEMP_KEY"
  rm -rf "$STAGE_DIR"
}

cp "${HOST1_SSH_KEY}" "$TEMP_KEY"
chmod 600 "$TEMP_KEY"
trap cleanup EXIT

echo "[host1-sync] Preparing staging directories"
mkdir -p "$STAGE_DIR/a_kakk" "$STAGE_DIR/a_chaba"
cp -r "${SOURCE_A_KAKK}/." "$STAGE_DIR/a_kakk"
cp -r "${SOURCE_A_CHABA}/." "$STAGE_DIR/a_chaba"

if [ -d "${SOURCE_KK1}" ]; then
  echo "[host1-sync] Injecting kk1 site into a_kakk"
  rm -rf "$STAGE_DIR/a_kakk/sites/kk1"
  mkdir -p "$STAGE_DIR/a_kakk/sites/kk1"
  cp -r "${SOURCE_KK1}/." "$STAGE_DIR/a_kakk/sites/kk1"
else
  echo "[host1-sync] Warning: SOURCE_KK1 directory not found" >&2
fi

SSH="ssh -i ${TEMP_KEY} -o StrictHostKeyChecking=no ${HOST1_USER}@${HOST1_HOST}"
SCP="scp -i ${TEMP_KEY} -o StrictHostKeyChecking=no"

echo "[host1-sync] Cleaning temp directories on Host1"
$SSH 'rm -rf /tmp/a_kakk /tmp/a_chaba /tmp/Caddyfile.host1'

echo "[host1-sync] Uploading a_kakk"
$SCP -r "${STAGE_DIR}/a_kakk" "${HOST1_USER}@${HOST1_HOST}:/tmp/a_kakk"

echo "[host1-sync] Uploading a_chaba"
$SCP -r "${STAGE_DIR}/a_chaba" "${HOST1_USER}@${HOST1_HOST}:/tmp/a_chaba"

echo "[host1-sync] Uploading Caddyfile"
$SCP "${HOST1_CADDYFILE}" "${HOST1_USER}@${HOST1_HOST}:/tmp/Caddyfile.host1"

echo "[host1-sync] Publishing static sites to /var/www"
$SSH 'sudo mkdir -p /var/www && sudo rm -rf /var/www/a-kakk /var/www/a-chaba && sudo cp -r /tmp/a_kakk /var/www/a-kakk && sudo cp -r /tmp/a_chaba /var/www/a-chaba'

echo "[host1-sync] Installing new Caddyfile and reloading"
$SSH 'sudo mv /tmp/Caddyfile.host1 /etc/caddy/Caddyfile && sudo chown caddy:caddy /etc/caddy/Caddyfile && sudo systemctl reload caddy'

echo "[host1-sync] Verifying endpoints"
$SSH 'curl -sfI http://localhost/a-kakk/sites/kk1/ >/dev/null && curl -sfI http://localhost/a-chaba/ >/dev/null'

echo "[host1-sync] Done"
