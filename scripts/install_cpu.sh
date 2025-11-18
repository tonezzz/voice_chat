#!/usr/bin/env bash
set -euo pipefail

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    echo "[install] Please run this script as root (sudo)."
    exit 1
  fi
}

log() {
  echo -e "[install] $*"
}

STACK_DIR=${STACK_DIR:-/opt/voice_chat}
REPO_URL=${REPO_URL:-https://github.com/tonezzz/voice_chat.git}
MODELS_ROOT=${MODELS_ROOT:-/opt/voice_chat_models}
OPENVOICE_ZIP_URL=${OPENVOICE_ZIP_URL:-https://myshell-public-repo-hosting.s3.amazonaws.com/checkpoints_1226.zip}
OPENVOICE_REFERENCE_URL=${OPENVOICE_REFERENCE_URL:-https://github.com/myshell-ai/OpenVoice/raw/main/assets/demo_speaker0.mp3}
PIPER_MODEL_URL=${PIPER_MODEL_URL:-https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US-amy-medium.onnx}
PIPER_CONFIG_URL=${PIPER_CONFIG_URL:-https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US-amy-medium.onnx.json}
YOLO_MODEL_URL=${YOLO_MODEL_URL:-https://github.com/ultralytics/assets/releases/download/v0.0.0/yolov8n.pt}
OLLAMA_MODEL=${OLLAMA_MODEL:-llama3.2:3b}
NGROK_AUTHTOKEN=${NGROK_AUTHTOKEN:-}

install_prereqs() {
  log "Installing base packages..."
  apt-get update
  apt-get install -y ca-certificates curl git gnupg lsb-release unzip
}

install_docker() {
  if command -v docker >/dev/null 2>&1; then
    log "Docker already installed. Skipping."
    return
  fi

  log "Installing Docker Engine + Compose plugin..."
  install -m 0755 -d /etc/apt/keyrings
  if [[ ! -f /etc/apt/keyrings/docker.gpg ]]; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  fi
  chmod a+r /etc/apt/keyrings/docker.gpg

  local codename
  codename=$(. /etc/os-release && echo "$VERSION_CODENAME")
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${codename} stable" >/etc/apt/sources.list.d/docker.list

  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
}

clone_repo() {
  if [[ -d "${STACK_DIR}/.git" ]]; then
    log "Repository already present. Pulling latest changes..."
    git -C "${STACK_DIR}" pull --ff-only
  else
    log "Cloning repository into ${STACK_DIR}..."
    rm -rf "${STACK_DIR}"
    git clone --depth 1 "${REPO_URL}" "${STACK_DIR}"
  fi
}

ensure_dir() {
  mkdir -p "$1"
}

download_file() {
  local url="$1"
  local dest="$2"
  local label="$3"
  if [[ -s "${dest}" ]]; then
    log "${label} already present. Skipping download."
    return
  fi
  ensure_dir "$(dirname "${dest}")"
  log "Downloading ${label}..."
  curl -L "${url}" -o "${dest}.tmp"
  mv "${dest}.tmp" "${dest}"
}

prepare_models() {
  log "Preparing model directories under ${MODELS_ROOT}..."
  ensure_dir "${MODELS_ROOT}/openvoice/data"
  ensure_dir "${MODELS_ROOT}/openvoice/checkpoints"
  ensure_dir "${MODELS_ROOT}/openvoice/references"
  ensure_dir "${MODELS_ROOT}/huggingface/stt"
  ensure_dir "${MODELS_ROOT}/huggingface/tts"
  ensure_dir "${MODELS_ROOT}/yolo"
  ensure_dir "${MODELS_ROOT}/ollama"

  local ckpt_flag="${MODELS_ROOT}/openvoice/checkpoints/base_speakers/EN/checkpoint.pth"
  if [[ ! -f "${ckpt_flag}" ]]; then
    log "Fetching OpenVoice checkpoints..."
    local tmp_zip
    tmp_zip=$(mktemp)
    curl -L "${OPENVOICE_ZIP_URL}" -o "${tmp_zip}"
    unzip -oq "${tmp_zip}" -d "${MODELS_ROOT}/openvoice"
    rm -f "${tmp_zip}"
  else
    log "OpenVoice checkpoints already exist."
  fi

  download_file "${OPENVOICE_REFERENCE_URL}" "${MODELS_ROOT}/openvoice/references/demo_speaker0.mp3" "OpenVoice demo reference"
  download_file "${PIPER_MODEL_URL}" "${MODELS_ROOT}/huggingface/tts/$(basename "${PIPER_MODEL_URL}")" "Piper voice model"
  download_file "${PIPER_CONFIG_URL}" "${MODELS_ROOT}/huggingface/tts/$(basename "${PIPER_CONFIG_URL}")" "Piper voice config"
  download_file "${YOLO_MODEL_URL}" "${MODELS_ROOT}/yolo/yolov8n.pt" "YOLOv8n weights"
}

write_env_file() {
  log "Writing deployment env file (.env.linux)..."
  cat >"${STACK_DIR}/.env.linux" <<EOF
OPENVOICE_DATA_ROOT=${MODELS_ROOT}/openvoice/data
OPENVOICE_CHECKPOINT_ROOT=${MODELS_ROOT}/openvoice/checkpoints
OPENVOICE_REFERENCE_ROOT=${MODELS_ROOT}/openvoice/references
OLLAMA_DATA_ROOT=${MODELS_ROOT}/ollama
HF_STT_MODELS=${MODELS_ROOT}/huggingface/stt
HF_TTS_MODELS=${MODELS_ROOT}/huggingface/tts
YOLO_MODEL_ROOT=${MODELS_ROOT}/yolo
OLLAMA_MODEL=${OLLAMA_MODEL}
NGROK_AUTHTOKEN=${NGROK_AUTHTOKEN}
EOF
}

wait_for_container() {
  local name="$1"
  local attempts=0
  local max_attempts=30
  pushd "${STACK_DIR}" >/dev/null
  until docker compose --env-file .env.linux ps --services --filter "status=running" | grep -q "^${name}$"; do
    attempts=$((attempts + 1))
    if (( attempts > max_attempts )); then
      log "Timeout waiting for container ${name} to start."
      popd >/dev/null
      return 1
    fi
    sleep 2
  done
  popd >/dev/null
  return 0
}

bring_up_stack() {
  log "Starting CPU-only docker-compose stack..."
  pushd "${STACK_DIR}" >/dev/null
  docker compose --env-file .env.linux up -d openvoice-tts stt tts yolo_mcp ollama server ngrok
  popd >/dev/null
}

seed_ollama_model() {
  log "Waiting for Ollama service..."
  if ! wait_for_container "ollama"; then
    log "Skipping Ollama model pull (container not ready)."
    return
  fi
  log "Pulling default Ollama model (${OLLAMA_MODEL})..."
  pushd "${STACK_DIR}" >/dev/null
  docker compose --env-file .env.linux exec ollama ollama pull "${OLLAMA_MODEL}" || log "Warning: Ollama pull failed. Try manually later."
  popd >/dev/null
}

main() {
  require_root
  install_prereqs
  install_docker
  clone_repo
  prepare_models
  write_env_file
  bring_up_stack
  seed_ollama_model
  log "Deployment complete!"
  log "Run the following to manage the stack later:"
  log "  cd ${STACK_DIR}"
  log "  docker compose --env-file .env.linux ps"
}

main "$@"
