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

### Environment files & secrets

- `.env` (tracked) contains all runtime configuration: host paths, container URLs, and any required API keys (OpenAI, Anthropic, EasySlip, etc.). Keep it in sync with teammates and rotate secrets when needed.

Add/adjust entries directly inside `.env`:

```
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=...
EASYSIP_API_KEY=...
```

When running Docker Compose or other tooling that relies on these variables, load `.env` with `dotenv` (ships with the repo via npm scripts):

```
npx dotenv -e .env -- docker compose up -d
```

On Windows `cmd.exe` (the default in this repo):

```
cmd /c npx dotenv -e .env -- docker compose up -d
```

This keeps the committed `.env` stable for collaborators while letting you rotate credentials locally.

### mcp-imagen (Stable Diffusion service)
The stack now ships with an MCP-compatible image generator service (`./mcp-imagen`) that exposes Stable Diffusion (default `runwayml/stable-diffusion-v1-5`) over both MCP and a simple REST shim. Relevant environment knobs (with their compose defaults) are:

```
IMAGE_MCP_URL=http://mcp-imagen:8001
IMAGE_MCP_GPU_URL=http://mcp-imagen-gpu:8001   # optional CUDA path exposed via docker-compose
IMAGE_MODEL_ID=runwayml/stable-diffusion-v1-5
IMAGE_TORCH_DEVICE=cpu                        # cpu service target
IMAGE_TORCH_DEVICE_GPU=cuda                   # gpu service target (maps to USE_GPU build arg)
IMAGE_STEPS=25
IMAGE_MAX_STEPS=60
IMAGE_WIDTH=512
IMAGE_HEIGHT=512
IMAGE_MODEL_ROOT=/mnt/c/_dev/_models/diffusers   # host cache path
```

The CPU service still works out of the box, but GPU hosts get an additional `mcp-imagen-gpu` container (see `docker-compose.yml`). The server automatically routes `/generate-image` calls to the GPU endpoint when the frontend asks for it. On the UI side, the Image Lab provides a CPU/GPU selector (with persistence) so you can draft quickly on CUDA hardware while falling back to CPU when needed.

Both endpoints are built automatically via `docker-compose.yml`, participate in health checks as `mcpImagen`/`mcpImagenGpu`, and the API server proxies `/generate-image` requests to them. Make sure your `.env` includes the `IMAGE_MCP_*` URLs (especially when syncing environments) so the server knows where to route requests. If you update the frontend, remember to run `npm run dev` for live testing and `npm run build:deploy` to sync the static assets served by the backend.

### Bank slip MCP (mock EasySlip proxy)

The stack also ships with a mock bank-slip verification MCP (`./bslip_mcp`). It exposes a `/verify` endpoint that returns canned transaction fields so you can exercise the Bank Slip panel without the real EasySlip API key.

```
BSLIP_MCP_URL=http://mcp-bslip:8002
```

- `docker-compose.yml` builds the FastAPI service, runs it on port `8002`, and the Node server proxies `/verify-slip` uploads to it. The mock returns the structured fields rendered in the UI (amount, sender, reference, etc.) plus a base64 preview.
- Health checks now include a `bslip` entry. When the container is healthy you will see its status in the UI status drawer.
- The frontend Bank Slip panel now calls `/verify-slip` instead of `/detect-image`, so the mock is the default path.

#### Switching to the real EasySlip API

1. Obtain an API key and store it in `.env` as `EASYSIP_API_KEY=...`.
2. Update `bslip_mcp/main.py` (or create a new service alongside it) so the FastAPI route forwards the multipart form data to `https://developer.easyslip.com/api/v1/verify` with the `Authorization: Bearer $EASYSIP_API_KEY` header.
3. Rebuild/restart the `mcp_bslip` service:
   ```
   docker compose build mcp_bslip
   docker compose up -d mcp_bslip
   ```
4. No frontend changes are required because `/verify-slip` already proxies to whatever MCP instance is running. Once the real API responds, the UI will show live data instead of the mock payload.

Until you wire the real API, the mock container lets you iterate on the UI/UX and test wiring without external dependencies.

### Memento memory MCP (SQLite/pgvector knowledge graph)

For persistent conversation memory we now ship [`./mcp_memento`](./mcp_memento), a FastAPI shim that shells out to the official [`@iachilles/memento`](https://github.com/iAchilles/memento) MCP server. This container exposes the full memory toolbelt (create entities, add observations, semantic search, etc.) over HTTP on port `8005` and registers itself with `mcp0`. Because `memento` only exposes MCP over stdio today, the bridge is gradually gaining a CLI fallback; until that lands, the service stays under the optional compose file.

Key environment knobs (all in `.env` / `.env.secure`):

```
MEMENTO_MCP_URL=http://mcp-memento:8005
MEMENTO_DATA_ROOT=C:/_dev/_models/memento   # host folder mounted to /data for the SQLite DB
MEMENTO_DB_DRIVER=sqlite                     # or postgres
MEMENTO_DB_PATH=/data/memento.db             # path inside the container when using sqlite
MEMENTO_DB_DSN=                              # optional postgres DSN (also mirrored to DATABASE_URL)
MEMENTO_SQLITE_VEC_PATH=                     # set if sqlite-vec auto-detection fails
MEMENTO_PGHOST=...
MEMENTO_PGPORT=...
MEMENTO_PGUSER=...
MEMENTO_PGPASSWORD=...
MEMENTO_PGDATABASE=...
MEMENTO_PGSSLMODE=...
```

The bridge monitors `/health`, serves a `/.well-known/mcp.json` manifest, and can be hit directly at `http://localhost:8005/invoke` for manual testing. Once the container is up, the Node server will surface `memento` in `/health`, and `mcp0` automatically advertises it to any MCP clients (Claude Desktop, etc.). Start it on-demand via the optional compose file:

```
cmd /c npx dotenv-cli -e .env -e .env.secure -- docker compose -f docker-compose.yml -f docker-compose.optional.yml up -d mcp-memento
```

Other opt-in MCP bridges (Tuya, Windows VMS, experimental sensors, etc.) now live in `docker-compose.optional.yml` as well, so the default `docker compose up -d` keeps only the core services online. When you need an optional service, include the extra file or use `--profile optional` on the relevant compose command.

### Meeting MCP (continuous transcription & notes)

`./mcp_meeting` is a FastAPI-based MCP provider that listens for meeting audio chunks, proxies them to the Whisper STT container, and stores lightweight transcripts + summaries in memory. It exposes tools for:

1. Starting/stopping sessions (`start_meeting`, `end_meeting`)
2. Appending manual text snippets (`append_transcript`)
3. Sending base64 audio chunks for transcription (`ingest_audio_chunk`)
4. Listing/summarizing sessions (`list_sessions`, `get_meeting_notes`, `summarize_meeting`)

Key environment variables (all in `.env`):

```
MEETING_MCP_URL=http://mcp-meeting:8008
MEETING_STT_URL=http://stt-whisper-gpu:5001   # whichever STT endpoint you want to use
MEETING_STT_HEALTH_PATH=/health
MEETING_MAX_SEGMENTS=1500                     # rolling transcript buffer
MEETING_SUMMARY_MAX_ENTRIES=20                # entries considered when summarizing
MEETING_DEFAULT_LANGUAGE=
MEETING_DEFAULT_WHISPER_MODEL=
MEETING_STORAGE_PATH=/data/meetings.json      # JSON snapshot written inside the container
MEETING_STORAGE_ROOT=C:/_dev/_models/meeting  # host folder mounted to /data
```

Bring it online (Windows `cmd.exe` example) once your `.env` is ready:

```
cmd /c "cd /d c:\_dev\windsurf_ai\voice_chat && npx dotenv-cli -e .env -- docker compose up -d mcp-meeting"
```

The service publishes `/.well-known/mcp.json` and `/health` at port `8008`. The API server now surfaces it in the `/health` response as `meeting`, and `mcp0` knows about it via the `MCP0_PROVIDERS` list so any downstream MCP client can invoke the new tools.

#### Meeting persistence quick check

1. Start the container after setting the storage env vars above so `/data/meetings.json` is backed by `C:/_dev/_models/meeting`.
2. Run the meeting tool trio (start → append → list) to seed data and verify the response:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\invoke-mcp-tools.ps1 \
     -ServiceFilter meeting \
     -ToolFilter start_meeting,append_transcript,list_sessions -AsJson
   ```

3. Restart the service and re-run only `list_sessions`; the `persistence-demo` session should still be present.

   ```powershell
   powershell -ExecutionPolicy Bypass -Command "docker compose --env-file .env restart mcp-meeting"
   powershell -ExecutionPolicy Bypass -File .\scripts\invoke-mcp-tools.ps1 -ServiceFilter meeting -ToolFilter list_sessions -AsJson
   ```

If those steps succeed, the JSON snapshot under `C:/_dev/_models/meeting/meetings.json` is fully wired and survives restarts.

### VMS MCP bridge (Windows-native)

`./mcp_vms` packages the upstream [`jyjune/mcp_vms`](https://github.com/jyjune/mcp_vms) stdio server plus an HTTP bridge (`main.py`) so the rest of the stack can talk to Windows-only DVRs. Because the vendor DLLs + `vmspy.pyd` are Windows binaries, you have two run modes:

1. **Host-run (recommended while Docker Desktop stays on Linux containers)**
   - Copy the vendor DLLs + `vmspy.pyd` into `mcp_vms/vendor/` (pull them from the official VMS client install or the `vmspy1.4-python3.11-x64` bundle).
   - Run the helper script whenever you need the bridge:
     ```powershell
     pwsh -ExecutionPolicy Bypass -File .\scripts\run-mcp-vms.ps1 \
       -VmsHost 192.168.1.50 -VmsPort 34567 \
       -VmsAccessId user -VmsAccessPw pass
     ```
     The script sets `PYTHONPATH` to `vendor`, exports the `VMS_*` env vars, and launches `main.py`, which in turn spawns `upstream/mcp_vms.py` over stdio @scripts/run-mcp-vms.ps1#1-49.
   - Leave `VMS_MCP_URL=http://host.docker.internal:8006` in `.env` so the Linux containers can reach the host service @.env#25-54.
   - Check health with `Invoke-WebRequest http://localhost:8006/health` (or `curl`); logs are written under `mcp_vms/data/<date>.log` by the upstream server @mcp_vms/upstream/mcp_vms.py#21-325.

2. **Optional Windows container**
   - When you are ready to switch Docker Desktop to Windows containers, build/run the `mcp-vms-win` profile:
     ```cmd
     cmd /c npx dotenv -e .env -- docker compose -f docker-compose.yml -f docker-compose.optional.yml up -d mcp-vms-win
     ```
     The service lives in `docker-compose.optional.yml` with `platform: windows/amd64` and exposes port `8006` @docker-compose.optional.yml#39-72.
   - Point `VMS_MCP_URL` at `http://mcp-vms-win:8006` when the container is active.

Either mode exposes `/health`, `/.well-known/mcp.json`, and `/invoke`. Once the endpoint is reachable, the Node server includes `vms` in `/health`, the status drawer, and any MCP0 provider list so frontends + Claude Desktop can call tools such as `get_channels`, `fetch_live_image`, and `move_ptz_to_preset` @mcp_vms/main.py#225-259 @mcp_vms/upstream/mcp_vms.py#52-396.

#### Automation helpers

- `scripts/run-mcp-vms.ps1` — starts the host bridge, handles all env vars.
- `scripts/check-mcp-health.ps1` — polls `/health` endpoints using URLs from `.env` (filter via `-Service` to target specific MCPs).
- `scripts/invoke-mcp-tools.ps1` — reads `scripts/mcp-tool-tests.json` and POSTs representative MCP tool invocations (VMS `get_channels`, meeting `list_sessions`, memento `search_nodes`).
- `scripts/run-mcp-checks.ps1` — orchestrates the two scripts above so you can run health checks first and tool invocations second (with shared filters, JSON output, and `-StopOnError`).

Examples:

```
powershell -ExecutionPolicy Bypass -File .\scripts\run-mcp-vms.ps1 -VmsHost 127.0.0.1 -VmsPort 3300
powershell -File .\scripts\check-mcp-health.ps1 -Service vms,meeting,mcp0
powershell -File .\scripts\invoke-mcp-tools.ps1 -StopOnError
powershell -ExecutionPolicy Bypass -File .\scripts\run-mcp-checks.ps1 -HealthService server,mcp0,meeting,vms -ToolService meeting,vms -ToolFilter start_meeting,append_transcript,list_sessions,get_channels -StopOnError
```

### Frontend deployment workflow

When shipping UI updates that must be visible through Docker:

1. Make your changes in `client/` and verify them with `npm run dev`.
2. Run `npm run build:deploy` inside `client/` to regenerate `client/dist` and sync to `server/public`.
3. Rebuild the server container so the fresh assets are baked into the image:
   ```
   cmd /c docker compose --env-file .env build server
   ```
4. Restart (or `up -d`) the server service to serve the new bundle:
   ```
   cmd /c docker compose --env-file .env up -d server
   ```

Following this loop avoids the “old UI” problem when exposing the stack through long-lived containers.

## Automation helpers

#### GitHub → MCP webhook automation

The `mcp-github` bridge now exposes a `/webhook` endpoint so GitHub can fan out events to MCP tools (default: `run_space`). To wire it up:

1. **Secrets** – add `GITHUB_PERSONAL_TOKEN` + `GITHUB_WEBHOOK_SECRET` to `.env`. Optionally set `GITHUB_WEBHOOK_TOOL` (global default), `GITHUB_WEBHOOK_EVENTS` (comma list allow-list), and `GITHUB_WEBHOOK_TOOL_MAP` (JSON object mapping event names to tool names) there as well.
2. **Compose** – the bridge already inherits those vars; start it with `cmd /c "cd /d c:\_dev\windsurf_ai\voice_chat && npx dotenv-cli -e .env -- docker compose up -d mcp-github"`.
3. **Ingress** – expose `mcp-github` port 8080 to GitHub (ngrok, reverse proxy, GitHub Apps, etc.) and point the webhook URL to `https://<your-host>/webhook`.
4. **GitHub settings** – in the repo/org webhook config choose `application/json`, the same secret, and select the events you allowed in `GITHUB_WEBHOOK_EVENTS` (leave blank to accept all).
5. **Testing** – use the GitHub "Recent Deliveries" feature or a helper script (see `scripts/` for MCP helpers) to replay payloads locally.

When a delivery arrives the FastAPI app validates the signature, enqueues the payload, and invokes the configured MCP tool via `/invoke`. Logs in `mcp-github` will show `Processed webhook <delivery>` once successful.

### GitHub Actions CI

- `.github/workflows/ci.yml` now runs on every push and pull request.
- Jobs executed:
  1. **client-quality** – installs client deps, runs `npm run build`, and calls `npm run build:deploy` to ensure `server/public` stays in sync. The produced `client/dist` bundle is stored as an artifact for reviewers.
  2. **server-smoke** – installs API server deps and runs `node --check index.js` as a fast syntax/require guard.
  3. **compose-validate** – runs `docker compose -f docker-compose.yml config` so Compose changes fail fast if the YAML or env wiring is invalid.

These jobs catch broken UI builds, missing sync steps, and compose typos before merges.

### Local pre-push checks (Windows)

Run `scripts/prepush-checks.cmd` from the repo root whenever you prepare to push:

```
cmd /c scripts\prepush-checks.cmd
```

What it does:

1. Verifies `.env` exists (per our deployment rule: always keep `.env` alongside the repo).
2. Runs `npm ci` (or `npm install` if no lockfile) inside `client/`, then `npm run build:deploy` so the latest UI assets populate `server/public`.
3. Runs `npm ci` (or `npm install`) inside `server/`, followed by `node --check index.js` for a quick syntax sanity check.
4. Executes `npx dotenv -e .env -- docker compose -f docker-compose.yml config` to ensure Compose stays valid with the loaded env file.

If any step fails, the script aborts with a non-zero exit code so you can fix issues before they hit CI.

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
3. Use `.env` for host paths and secrets (OpenAI, Anthropic, etc.).
4. From the repo root load it when starting the stack, e.g. `cmd /c npx dotenv -e .env -- docker compose up -d`.

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
