# Multi-session Cascade Coordination

This note outlines a lightweight process to keep overlapping Cascade sessions from colliding. Adjust the pieces below to match your team size, but try to keep the disciplines consistent so every session knows what information to produce and where to put it.

## 1. Session ownership & scope
- Every Cascade run declares its scope _before_ touching code: branch name, directory focus, and any high-risk files (compose, Dockerfiles, shared configs).
- Default branch naming: `cascade/<date>-<short-tag>` (e.g., `cascade/2025-11-21-prepush`). Include the task ID if you have one.
- If a session needs to edit outside its declared scope, it must update the change log (below) _first_ so other sessions see the expansion.

## 2. Central change log template
Keep a single shared Markdown document (Notion, Google Doc, etc.) titled **Cascade Session Log** that every session updates. Recommended fields:

```
| Session | Editor | Branch | Focus Area(s) | Locked Files | Start | ETA/Status | Notes |
|---------|--------|--------|----------------|--------------|-------|------------|-------|
| A | Cascade (ChatGPT) | cascade/2025-11-21-prepush | client/src/hooks, docker-compose.yml | docker-compose.yml | 14:05 | In progress | Adding MCP meeting envs |
```

Guidelines:
1. Update **Start** when work begins.
2. Set **ETA/Status** to `In progress`, `Blocked`, or `Ready for Review`.
3. Move rows to a "Completed" subsection with a summary once merged to main.

## 3. File/area locking rules
- Any file listed under **Locked Files** is treated as exclusive. Other sessions either avoid it or explicitly coordinate before editing.
- Locks auto-expire after 2 hours unless renewed in the log to avoid stale blocks.
- For binary assets (images, DLLs) rely on Git LFS locking when available; otherwise note "binary" in the log so others know to wait for the push.

## 4. Session lifecycle checklists
**Kickoff (before you type):**
1. Pull latest `main` and run `git status` to confirm clean base.
2. Create/checkout your `cascade/<date>-<tag>` branch.
3. Fill in the log row (scope, locks, ETA).
4. Skim the log for overlapping areas and ping owners if needed.

**While working:**
- Keep commits scoped to the declared focus.
- When you expand scope or grab a new lock, update the log immediately.
- If you discover global changes (config migrations, dependency upgrades), pause and coordinate before proceeding.

**Handoff/finish:**
1. Push branch + open draft PR (or note "awaiting review" in log).
2. Release locks (clear the column) and mark status `Ready for Review` or `Complete`.
3. Leave a short summary + blockers/next steps in **Notes** so the next session can continue.
4. If abandoned mid-task, mark status `Needs pickup` with clear TODO bullets.

## 5. Avoiding merge pain
- Rebase frequently: `git fetch origin && git rebase origin/main` at least once per session.
- Run the agreed pre-push script (`scripts/prepush-checks.cmd`) before handing off so downstream sessions inherit a clean state.
- When touching shared YAML/JSON, format using the repo’s formatter (Prettier, ESLint, etc.) to keep diffs minimal.

## 6. Optional automation hooks
- **Log helpers:** a tiny script can append/update log rows via CLI to avoid manual editing.
- **Pre-commit guards:** reject commits that modify locked files unless the committer’s session is listed as owner.
- **Notification bot:** watches the log document (or a text file in the repo) and posts to Slack/Teams when a lock is taken or released.

Start with the manual process (sections 1–5). Once the routine feels natural, automate the parts that cause the most friction (usually the log updates and lock reminders).

## 7. Edge/local compute scheduler plan

### Device tiers & tags

- **tier:mobile-wasm** – browsers with Web Workers + WASM SIMD, often battery-limited (<2 GB/tab). Jobs: ≤1 s audio feature windows, tokenizer/chunking slices (<250 ms), compression/encryption before upload.
- **tier:desktop-webgpu** – desktop Chrome/Edge/Safari (macOS) with WebGPU + ≥8 GB RAM. Jobs: small/medium transformer blocks (≤200 MB weights), 30 s DSP batches, vision preprocessing.
- **tier:native-helper** – Android/iOS companion (TFLite/CoreML/NNAPI) when on Wi-Fi + charging. Jobs: quantized ASR/TTS, background conversions, opportunistic accelerator work.

Devices post `capabilities.tags` using detection output:

| Capability                  | Tag fragment |
|-----------------------------|--------------|
| `hasWebGPU`                 | `webgpu`     |
| `hasWasmSimd`               | `wasm-simd`  |
| `isMobile`                  | `mobile`     |
| `battery.charging === true` | `charging`   |
| `hardwareConcurrency >= 8`  | `hc8`        |
| `deviceMemory >= 8`         | `mem8`       |

Scheduler derives tier (e.g., `tier:mobile-wasm+charging`) and assigns jobs only when `requirements ⊆ tags`.

### Job envelope

```ts
interface LocalEdgeJob {
  id: string
  kind: string
  priority: 'low' | 'normal' | 'high'
  requirements: string[] // e.g., ['mobile', 'wasm-simd']
  payload: Record<string, unknown>
  maxSliceMs?: number
  budgetMs?: number
}
```

Jobs flow `queued → claimed → reporting → completed/failed`. Devices poll `/edge-jobs/next?tags=mobile%2Cwasm-simd`, server matches earliest compatible job and records lease deadline.

### Control flow

1. **Register**: `useDeviceCapabilities` posts to `/edge-workers/register` with `{workerId, tags, battery, webgpu}`; server returns lease interval + heartbeat cadence.
2. **Poll**: worker hits `/edge-jobs/next?worker=...&tags=...`; server filters by `requirements`, prioritizes `priority` then FIFO.
3. **Execute**: client slices work respecting `maxSliceMs` within Web Worker/WebGPU. Optional `PATCH /edge-jobs/:id` for progress/telemetry.
4. **Complete**: `POST /edge-jobs/:id/complete` with `{status, result, metrics}`. Failures requeue with exponential backoff capped per worker.

### Telemetry & throttling

- Capture `durationMs`, `avgSliceMs`, memory estimate, `thermalThrottled` flag, and battery state when reporting results.
- Server maintains worker reliability score; pause or deprioritize workers after repeated failures/timeouts.
- Respect privacy: send only derived stats, never raw sensor streams; require explicit opt-in UI.

### Immediate implementation steps

1. **Server**: add `/edge-workers/register`, `/edge-workers/heartbeat`, `/edge-jobs` endpoints modeled after GPU queue but keyed by requirements/tags.
2. **Client**: extend `useLocalComputeWorker` context with worker IDs, consent toggles, heartbeat, and job fetch helpers for interested panels.
3. **UI**: enhance status overlay with “Local compute” section (capability lines, consent toggle, manual probe button, recent job metrics).
4. **Workloads**: start routing tokenizer/audio preprocess tasks through scheduler; then gate WebGPU inference experiments behind `VITE_LOCAL_COMPUTE_WEBGPU` flag.

## 8. MCP profile strategy & runtime registration

### 8.1 Profiles & commands

| Profile | Services included | Start command (PowerShell)* |
| --- | --- | --- |
| *(none)* | `server`, `mcp0`, `mcp-github`, `mcp-meeting`, `ngrok` | `cmd /c "cd /d C:\_dev\windsurf_ai\voice_chat && npx dotenv-cli -e .env -- docker compose up -d"` |
| `internal-cpu` | `mcp_bslip`, `mcp_idp`, `mcp_yolo`, `mcp-imagen`, other CPU-only MCPs | `scripts/start-mcp-profile.ps1 -Profiles internal-cpu` |
| `internal-gpu` | `stt-gpu`, `mcp-imagen-gpu`, `openvoice-tts-gpu`, `ollama-gpu` | `scripts/start-mcp-profile.ps1 -Profiles internal-gpu` |
| `optional` / `external` | Tuya, memento, Google bridges, OpenVoice CPU, sequentialthinking, etc. | `scripts/start-mcp-profile.ps1 -Profiles optional` |

\*All helper scripts call `cmd /c "cd /d … && npx dotenv-cli -e .env -- docker compose …"` to honor the project’s dotenv-cli rule.

`scripts/start-mcp-profile.ps1` accepts multiple profiles (comma-separated) and optional `-Services` for one-off containers:

```powershell
scripts/start-mcp-profile.ps1 -Profiles @('internal-cpu','optional') -Services mcp-seqthink
```

Supported actions:

| Usage | Effect |
| --- | --- |
| `-Action up` (default) | `docker compose up -d --build --remove-orphans --profile …` |
| `-Action down` | `docker compose down --remove-orphans --profile …` |
| `-Action restart` | `docker compose restart --profile …` |

### 8.2 Always-on vs selective MCPs

| MCP Service | Always-on | `internal-cpu` | `internal-gpu` | Optional profiles |
| --- | --- | --- | --- | --- |
| `mcp0`, `mcp-github`, `mcp-meeting` | ✅ | — | — | `cpu`, `gpu` (allowed) |
| `mcp_bslip`, `mcp_idp`, `mcp_yolo`, `mcp-imagen` | — | ✅ | — | `bslip` (where applicable) |
| GPU MCPs (`stt-gpu`, `mcp-imagen-gpu`, `openvoice-tts-gpu`, `ollama-gpu`) | — | — | ✅ | — |
| Bridges / optional (`mcp-memento`, `mcp-gdrive`, `mcp-gphotos`, `mcp_tuya`, `openvoice-tts`, `mcp-vms-win`, etc.) | — | — | — | `optional`, `tuya`, `openvoice`, `debug` |

### 8.3 Runtime registration via mcp-0 admin API

1. Set `MCP0_ADMIN_TOKEN` in `.env` (already present). Keep the token secret—only helper scripts and trusted MCP containers should know it.
2. To add a dynamic MCP without restarting `mcp0`, POST to `/admin/providers`:

   ```powershell
   $body = '{"descriptor":{"name":"seqthink","base_url":"http://mcp-seqthink:8015","health_path":"/health","capabilities_path":"/.well-known/mcp.json","default_tools":["sequential_thinking"]}}'
   cmd /c "cd /d C:\_dev\windsurf_ai\voice_chat && npx dotenv-cli -e .env -- curl -s -X POST http://localhost:8010/admin/providers -H 'Authorization: Bearer ' + $env:MCP0_ADMIN_TOKEN + ' -H "Content-Type: application/json" -d ' + $body"
   ```

3. Optional MCP containers can call that endpoint during their entrypoint (pass the token via env) so registration survives partial restarts. Pair this with the profile scripts above for reproducible startups.

4. Persist descriptors for dynamic MCPs in a small JSON file (e.g., `server/conf/mcp_dynamic.json`) and have a bootstrap task replay them on `mcp0` restarts to avoid manual re-registration.

> Tip: before exposing a new optional MCP to users, run `scripts/check-mcp-health.ps1` so the aggregated status page reflects which providers are online and which are intentionally dormant.
