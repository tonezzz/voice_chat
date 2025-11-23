# Colab GPU Worker Deployment

This guide explains how the GPU job queue, Colab worker notebook, and supporting helpers fit together so you can redeploy or troubleshoot the Imagen/Ollama pipeline quickly.

## High-level architecture

```mermaid
flowchart LR
    subgraph Dev
        CLI[mcp-gpu-job helper]
        UI[Voice Chat client]
    end

    CLI -->|POST /gpu-jobs| Server
    UI -->|Queue jobs via server| Server

    subgraph Stack (docker-compose)
        Server[Express API\nserver/index.js]
        Queue[(gpuJobQueue)]
        MCPImagen[mcp-imagen service]
    end

    Server --> Queue
    Queue -->|GET /gpu-jobs/next| Colab
    Colab -->|POST /gpu-jobs/:id/complete| Server
    Colab -->|run imagenGenerate/ollamaChat| GPU
    GPU --> Colab
    Server -->|Fallback| MCPImagen
```

* **Server (`server/index.js`)** exposes the job queue endpoints with bearer-token auth and stores in-memory job state (`gpuJobStore` + `gpuJobQueue`).
* **Colab worker notebook** (`notebooks/colab_gpu_service_template.ipynb`) polls `/gpu-jobs/next`, runs jobs locally (Diffusers Imagen or Ollama), and reports results.
* **Helper CLI** (`mcp_debug/bin/mcp-gpu-job`) makes it easy to enqueue jobs from inside the `mcp-debug` container.
* **Fallback**: If no Colab worker is available, jobs can still be served by internal MCP Imagen/Ollama providers.

## Components & responsibilities

| Component | Location | Responsibilities |
| --- | --- | --- |
| Express server | `server/index.js` | Hosts `/gpu-jobs`, `/gpu-jobs/next`, `/gpu-jobs/:id/complete`, enforces `GPU_WORKER_TOKEN`, tracks leases + retries. |
| Colab notebook | `notebooks/colab_gpu_service_template.ipynb` | Installs Ollama + Diffusers, preloads models, runs background polling thread, executes `imagenGenerate`/`ollamaChat`. |
| Helper script | `mcp_debug/bin/mcp-gpu-job` | Wraps `curl + jq` to enqueue jobs with prompts, Imagen params, or raw payloads. |
| Logs / artifacts | `C:\_dev\_models\voice_chat\logs` | Stores job history and rendered images pulled from `/gpu-jobs/:id`. |

## End-to-end flow

1. Developer runs `docker compose exec mcp-debug mcp-gpu-job --tool imagenGenerate ...` (or the frontend enqueues via `/gpu-jobs`).
2. Server validates payload, pushes the job into `gpuJobQueue`, and returns a job ID.
3. Colab worker polls `/gpu-jobs/next` with its `STACK_WORKER_TOKEN`. When it leases a job, it logs `[worker] Leased job ...`.
4. Worker executes the tool:
   - `imagenGenerate`: Diffusers `AutoPipelineForText2Image` on CUDA (fp16), optional negative prompt, guidance, size clamps, deterministic seeds.
   - `ollamaChat`: Local Ollama daemon (started inside the notebook) handles prompts.
5. Worker posts completion to `/gpu-jobs/:id/complete` with either `{status: "completed", result: ...}` or `{status: "error", detail: ...}`.
6. Results are available via `/gpu-jobs/:id` and can be saved (e.g., `logs/images/*.png`).

## Key environment variables

| Variable | Location | Description |
| --- | --- | --- |
| `GPU_WORKER_TOKEN` | `.env` (server) | Shared secret checked by `/gpu-jobs/next` and `/gpu-jobs/:id/complete`. |
| `STACK_API_BASE` | Colab env | Public base URL of the server (ngrok, Cloudflare, etc.). |
| `STACK_WORKER_TOKEN` | Colab env | Must match `GPU_WORKER_TOKEN`. |
| `WORKER_ID` | Colab env (optional) | Label shown in job history/logs. |
| `OLLAMA_PRELOAD_MODELS` | Colab env | Comma list of models to `ollama pull` on boot. |
| `IMAGEN_MODEL_ID` | Colab env | Diffusers model (default `runwayml/stable-diffusion-v1-5`). |
| `GPU_JOB_ENDPOINT` | helper env | Override queue URL path (default `/gpu-jobs`). |

## Deployment steps

1. **Server**: ensure `docker compose` stack is running with `GPU_WORKER_TOKEN` set. Confirm `/gpu-jobs` endpoints respond locally.
2. **Ngrok/public tunnel**: expose the server base URL and update `STACK_API_BASE` accordingly.
3. **Colab notebook**: open `notebooks/colab_gpu_service_template.ipynb`, fill in env vars (or `ENV_OVERRIDES`), run the setup cell once. Watch logs for `Worker loop started` and model preload notices.
4. **Submit jobs**: use `mcp-gpu-job` or your application to enqueue jobs. Tail `logs/gpu_job_history.md` or check `/gpu-jobs/:id` to confirm progress.
5. **Persist outputs**: optionally fetch job results and save under `_models/voice_chat/logs` for archival.

## Operations tips

- `scripts/start-service.ps1` and `scripts/tail-service.ps1` automatically include optional/GPU compose overlays.
- Use `mcp_debug/bin/mcp-browser` to snapshot dashboard endpoints if you need visual verification; it defaults to writing under `/workspace/logs` (which now maps to `_models`).
- Colab runtime restarts clear the worker loop; re-run the setup cell to resume polling.
- For troubleshooting, enable verbose logging by watching the Colab cell output and querying `/gpu-jobs/:id` directly.
