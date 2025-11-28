#!/usr/bin/env bash
set -euo pipefail

REPO_URL=${REPO_URL:-https://github.com/tonezzz/voice_chat.git}
INSTALL_ROOT=${INSTALL_ROOT:-/chaba}
REPO_DIR=${REPO_DIR:-$INSTALL_ROOT/voice_chat}
ENV_FILE=${ENV_FILE:-$REPO_DIR/.env.host01}
PROFILE=${PROFILE:-agent-host01}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    echo "[agent-install] Please run this script as root." >&2
    exit 1
  fi
}

log() {
  echo "[agent-install] $*"
}

install_prereqs() {
  log "Installing prerequisites (curl, git, docker)..."
  apt-get update >/dev/null
  apt-get install -y ca-certificates curl git >/dev/null

  if ! command -v docker >/dev/null 2>&1; then
    log "Docker not found. Installing Docker Engine + compose plugin."
    install -m 0755 -d /etc/apt/keyrings
    if [[ ! -f /etc/apt/keyrings/docker.gpg ]]; then
      curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    fi
    chmod a+r /etc/apt/keyrings/docker.gpg
    source /etc/os-release
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" >/etc/apt/sources.list.d/docker.list
    apt-get update >/dev/null
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
    systemctl enable --now docker
  fi
}

clone_repo() {
  mkdir -p "${INSTALL_ROOT}"
  if [[ -d "${REPO_DIR}/.git" ]]; then
    log "Repository already exists. Pulling latest changes..."
    git -C "${REPO_DIR}" fetch --all --prune
    git -C "${REPO_DIR}" reset --hard origin/main
  else
    log "Cloning repository into ${REPO_DIR}"
    rm -rf "${REPO_DIR}"
    git clone --depth 1 "${REPO_URL}" "${REPO_DIR}"
  fi
}

write_env() {
  if [[ -f "${ENV_FILE}" ]]; then
    log ".env.host01 already exists. Skipping rewrite."
    return
  fi
  log "Writing ${ENV_FILE}"
  cat >"${ENV_FILE}" <<'EOF'
MAIN_STACK_HEALTH_URL=http://voice-chat-server:3000/health
HOST1_PUBLISH_INTERVAL_SECONDS=300
HOST1_HEALTH_CHECK_INTERVAL_SECONDS=60
HOST1_HEALTH_TIMEOUT_MS=5000
HOST1_LOG_DIR=/workspace/logs/agent-host01
STORAGE_ENDPOINT=http://pc1-storage.local:8031
EOF
}

start_agent() {
  pushd "${REPO_DIR}" >/dev/null
  log "Pulling latest container images..."
  docker compose --env-file "${ENV_FILE}" pull "${PROFILE}"
  log "Starting agent-host01 compose service..."
  docker compose --env-file "${ENV_FILE}" up -d "${PROFILE}"
  popd >/dev/null
}

main() {
  require_root
  install_prereqs
  clone_repo
  write_env
  start_agent
  log "Installation complete. View logs with: docker compose --env-file ${ENV_FILE} logs -f ${PROFILE}"
}

main "$@"
