#!/usr/bin/env bash
set -euo pipefail

WG_IF=${WG_IF:-wg0}
WG_SUBNET=${WG_SUBNET:-10.42.0.0/24}
WG_ADDR=${WG_ADDR:-10.42.0.1/24}
WG_PORT=${WG_PORT:-51820}
WG_DIR=/etc/wireguard
PRIVATE_KEY_FILE="$WG_DIR/server_private.key"
PUBLIC_KEY_FILE="$WG_DIR/server_public.key"
SYSCTL_FILE=/etc/sysctl.d/99-wireguard.conf

log() {
  echo "[host1-wireguard] $*"
}

require_root() {
  if [[ $EUID -ne 0 ]]; then
    echo "[host1-wireguard] Must be run as root" >&2
    exit 1
  fi
}

ensure_packages() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y wireguard iproute2 iptables
}

ensure_keys() {
  umask 077
  mkdir -p "$WG_DIR"
  if [[ ! -f "$PRIVATE_KEY_FILE" ]]; then
    log "Generating server key pair"
    wg genkey | tee "$PRIVATE_KEY_FILE" | wg pubkey > "$PUBLIC_KEY_FILE"
  fi
}

write_config() {
  local iface
  iface=$(ip route list default | awk '{print $5; exit}')
  if [[ -z "$iface" ]]; then
    echo "[host1-wireguard] Unable to determine default interface" >&2
    exit 1
  fi
  local private_key
  private_key=$(<"$PRIVATE_KEY_FILE")
  cat >"$WG_DIR/$WG_IF.conf" <<EOF
[Interface]
Address = $WG_ADDR
ListenPort = $WG_PORT
PrivateKey = $private_key
PostUp = iptables -t nat -A POSTROUTING -o $iface -j MASQUERADE; iptables -A FORWARD -i %i -j ACCEPT; iptables -A FORWARD -o %i -j ACCEPT
PostDown = iptables -t nat -D POSTROUTING -o $iface -j MASQUERADE; iptables -D FORWARD -i %i -j ACCEPT; iptables -D FORWARD -o %i -j ACCEPT
EOF
  chmod 600 "$WG_DIR/$WG_IF.conf"
  log "Wrote $WG_DIR/$WG_IF.conf"
}

ensure_sysctl() {
  cat > "$SYSCTL_FILE" <<'EOF'
net.ipv4.ip_forward=1
net.ipv6.conf.all.forwarding=1
EOF
  sysctl --system >/dev/null
  log "Enabled IP forwarding"
}

start_service() {
  systemctl enable --now "wg-quick@$WG_IF"
  log "WireGuard interface $WG_IF active"
  wg show "$WG_IF"
}

require_root
ensure_packages
ensure_keys
write_config
ensure_sysctl
start_service
log "Server public key: $(<"$PUBLIC_KEY_FILE")"
# TODO: Add backup/restore instructions
