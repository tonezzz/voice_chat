# Voice Chat

## Linux / WSL setup (recommended)

### One-line install (CPU-only stack)
Run the installer script directly from GitHub (requires `sudo`). It installs Docker, clones this repo into `/opt/voice_chat`, downloads checkpoints/models, writes `.env.linux`, and launches the CPU services defined in `docker-compose.yml`:

```
curl -fsSL https://raw.githubusercontent.com/tonezzz/voice_chat/main/scripts/install_cpu.sh | sudo bash
```

After the script finishes you can manage the stack with:

```
cd /opt/voice_chat
docker compose --env-file .env.linux ps
```

To run the services manually outside the installer, stay in the repo root and use the Linux profile:

```
docker compose --env-file .env.linux up -d
```

### Host model paths (Linux / WSL)
These defaults are already baked into `.env` and the installer, but keep them handy if you relocate your local model cache:

```
OPENVOICE_DATA_ROOT=/mnt/c/_dev/_models/openvoice/data
OPENVOICE_CHECKPOINT_ROOT=/mnt/c/_dev/_models/openvoice/checkpoints
OPENVOICE_REFERENCE_ROOT=/mnt/c/_dev/_models/openvoice/references
OLLAMA_DATA_ROOT=/mnt/c/_dev/_models/ollama
HF_STT_MODELS=/mnt/c/_dev/_models/huggingface/stt
HF_TTS_MODELS=/mnt/c/_dev/_models/huggingface/tts
YOLO_MODEL_ROOT=/mnt/c/_dev/_models/yolo
OLLAMA_MODEL=llama3.2:3b
```

### MCP image generator service
The stack now ships with an MCP-compatible image generator (`./image_mcp`) that exposes Stable Diffusion (default `runwayml/stable-diffusion-v1-5`) over both MCP and a simple REST shim. Relevant environment knobs (with their compose defaults) are:

```
IMAGE_MCP_URL=http://image_mcp:8001
IMAGE_MCP_GPU_URL=http://image_mcp_gpu:8001   # optional CUDA path exposed via docker-compose
IMAGE_MODEL_ID=runwayml/stable-diffusion-v1-5
IMAGE_TORCH_DEVICE=cpu                        # cpu service target
IMAGE_TORCH_DEVICE_GPU=cuda                   # gpu service target (maps to USE_GPU build arg)
IMAGE_STEPS=25
IMAGE_MAX_STEPS=60
IMAGE_WIDTH=512
IMAGE_HEIGHT=512
IMAGE_MODEL_ROOT=/mnt/c/_dev/_models/diffusers   # host cache path
```

The CPU image generator still works out of the box, but GPU hosts get an additional `image_mcp_gpu` service (see `docker-compose.yml`). The server automatically routes `/generate-image` calls to the GPU endpoint when the frontend asks for it. On the UI side, the Image Lab provides a CPU/GPU selector (with persistence) so you can draft quickly on CUDA hardware while falling back to CPU when needed.

The service is built automatically (`docker-compose.yml`), participates in health checks, and the API server proxies `/generate-image` requests to it. If you update the frontend, remember to run `npm run dev` for live testing and `npm run build:deploy` to sync the static assets served by the backend.

### Frontend deployment workflow

When shipping UI updates that must be visible through Docker/ngrok:

1. Make your changes in `client/` and verify them with `npm run dev`.
2. Run `npm run build:deploy` inside `client/` to regenerate `client/dist` and sync to `server/public`.
3. Rebuild the server container so the fresh assets are baked into the image:
   ```
   cmd /c docker compose --env-file .env build server
   ```
4. Restart (or `up -d`) the server + ngrok services to serve the new bundle:
   ```
   cmd /c docker compose --env-file .env up -d server ngrok
   ```

Following this loop avoids the “old UI” problem when exposing the stack via ngrok or any long-lived container.

### Switching LLM providers from the UI

The chat frontend now ships with a "Provider" dropdown (next to the LLM + Whisper selectors) that lets you toggle between local Ollama, Anthropic Claude, or OpenAI GPT for each session. A few tips:

1. **Configure credentials first.** Make sure the server has the relevant API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.) and `LLM_PROVIDER` default set in `.env`. Providers without keys show up as disabled once the health check runs.
2. **Pick a provider before you send a message.** The selection is persisted in `localStorage`, and every text or audio request includes the provider, so the backend can swap models mid-session without restarting.
3. **Watch the status helper.** The chip shows real-time availability labels (e.g., `Anthropic Claude (Available)` or `OpenAI GPT (Unknown)`). If the current provider turns unhealthy, the UI auto-falls back to the next healthy option.
4. **Applies to both text and mic flows.** Whether you type, upload attachments, or use the microphone, the same provider flag is sent to `/voice-chat` and `/voice-chat-audio`, so replies always come from the selected LLM.

## Windows Docker Desktop setup
If you prefer running Docker directly on Windows (without WSL), follow these steps:

1. Install Docker Desktop and make sure it is using the Windows container backend.
2. Clone this repository somewhere on your Windows filesystem.
3. Use the provided `.env` (or `.env.win`) as the Windows profile and update host paths if your directories differ.
4. From the repo root run `docker compose --env-file .env.win up -d` (or rely on the default `.env`).

### Host model paths (Windows)

```
OPENVOICE_DATA_ROOT=C:/_dev/_models/openvoice/data
OPENVOICE_CHECKPOINT_ROOT=C:/_dev/_models/openvoice/checkpoints
OPENVOICE_REFERENCE_ROOT=C:/_dev/_models/openvoice/references
OLLAMA_DATA_ROOT=C:/_dev/_models/ollama
HF_STT_MODELS=C:/_dev/_models/huggingface/stt
HF_TTS_MODELS=C:/_dev/_models/huggingface/tts
YOLO_MODEL_ROOT=C:/_dev/_models/yolo
OLLAMA_MODEL=llama3.2:3b
```

Keep `.env` aligned with whichever environment you are using, then run `docker compose up -d` to bring everything online.
