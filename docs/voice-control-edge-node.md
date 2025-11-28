# Voice Control Edge Node (VCEN)

## 1. Purpose
The Voice Control Edge Node keeps the floating mic panel + site responsive when the primary desktop stack is offline. It hosts:

- Static UI build (`client/dist` synced into `server/public` or served directly by Caddy/NGINX)
- Minimal APIs the mic panel calls (chat, STT, health)
- GPU/CPU workers that power those APIs (Ollama, STT, Imagen, OpenVoice, etc.)

Running this subset on host01 lets the main workstation sleep while the UI remains reachable.

## 2. Containers to relocate
| Category | Services | Notes |
| --- | --- | --- |
| Core UI/API | `server` (or static files + thin proxy) | Serves `/`, `/api/*`, `/health`. If disk is tight, host static files via Caddy and proxy APIs to GPU/STT containers. |
| Persistence | `redis` | Used for health + snapshot cache. Optional but recommended (`REDIS_URL=redis://redis:6379/0`). |
| LLM + STT | `ollama-gpu` (or `ollama`), `stt-gpu` (or `stt`) | Required for `/api/chat` and server-side STT. |
| Voice/TTS | `openvoice-tts-gpu` (or CPU), `mcp-vaja` | Needed only if you want spoken replies when main stack is down. |
| Image/gen extras | `mcp-imagen-gpu` (and CPU fallback) | Optional unless the mic panel needs Imagen tooling online. |
| Bridges | Any MCPs referenced in `.env` (tuya, meeting, memento, etc.) | Move only the ones you expect to keep serving while the desktop sleeps. |

No new containers are required—the existing compose files already define them under `docker-compose.yml` and `docker-compose.optional.yml`.

## 3. Deployment workflow (host01)
1. **Prep host01**
   - Clone/pull repo to `c:\_dev\windsurf_ai\voice_chat`.
   - Mirror model/data directories referenced in `.env` (e.g., `C:\_dev\_models\ollama`, `...\openvoice_v2`).
   - Copy the project `.env` (with secrets) to host01.

2. **Build static client + sync**
   - On development box run `npm install` in `client/` if needed.
   - Run `cmd /c "cd /d c:\_dev\windsurf_ai\voice_chat\client && npm run build:deploy"` to produce/rsync `client/dist` into `server/public`.
   - Transfer updated `server/public` (or `client/dist`) to host01. If serving statically, drop contents into Caddy/NGINX root.

3. **Start required containers on host01**
   - Example: `cmd /c "cd /d c:\_dev\windsurf_ai\voice_chat && npx dotenv-cli -e .env -- docker compose -f docker-compose.yml -f docker-compose.optional.yml up -d server redis ollama-gpu stt-gpu openvoice-tts-gpu"`.
   - Include any other MCP services you need concurrently.

4. **Point primary stack to host01**
   - On the desktop `.env`, set URLs such as `OLLAMA_GPU_URL=http://host01:11435`, `STT_GPU_URL=http://host01:5002`, `OPENVOICE_GPU_URL=http://host01:8101`, etc.
   - Restart the local stack omitting those services so only host01 instances stay active.

5. **DNS / reverse proxy cutover**
   - If host01 serves the UI, update DNS (or Caddy/Cloudflare tunnel) to send traffic there.
   - Keep TTL low (60s) for quick failback.

## 4. Downtime expectations
- Building + syncing static assets: none (run ahead of time).
- Host01 container startup: <1 minute per service; do this before redirecting traffic.
- DNS/proxy switch: <1 minute if TTL is low. Users may see a brief blip while caches update.
- Future redeploys: repeat the build + sync, then `docker compose up -d --build` on host01; no downtime if you roll updates before flipping traffic.

## 5. Operations checklist
- [ ] Verify `/health` on host01 shows `status: ok` for relocated services.
- [ ] Confirm mic panel in browser points to host01 URLs (inspect network calls).
- [ ] Document host01 IP + firewall rules so other hosts can reach the ports.
- [ ] Schedule periodic `docker system prune` on host01 to keep disk usage low.

## 6. Automated deployment workflow (host01)

Automate the "build → sync → restart" loop so host01 always serves the latest UI without manual steps:

1. **Local build + sync script** (run on your dev box):
   ```powershell
   # scripts/vcen-deploy.ps1
   param(
     [string]$Host = "chaba.surf-thailand.com",
     [string]$RemotePath = "/opt/vcen/current"
   )
   cmd /c "cd /d c:\_dev\windsurf_ai\voice_chat\client && npm run build:deploy"
   robocopy c:\_dev\windsurf_ai\voice_chat\server\public \\$Host\share\vcen\public /MIR
   cmd /c "cd /d c:\_dev\windsurf_ai\voice_chat && npx dotenv-cli -e .env -- docker compose restart server"
   ```
   Adjust the copy step to match however host01 exposes storage (SCP/rsync/SMB).

2. **Remote restart**: from `mcp-debug`, use the host01 credential with `mcp-sshpass-test` to run:
   ```bash
   /workspace/mcp_debug/bin/mcp-sshpass-test -c /workspace/shares/credentials/host1-ssh.json -- \
     "cd /opt/vcen/current && docker compose up -d --build server"
   ```

3. **Optional GitHub Action**: schedule a nightly job that runs the PowerShell script above, then posts to Slack when complete.

## 7. Health monitoring & alerts

- Point an UptimeRobot (or Cloudflare Load Balancer) health probe at `http://chaba.surf-thailand.com:3001/health` every 60 s.
- Configure alerting for HTTP status ≠ 200 or when the JSON `status` field returns `error`.
- Optionally expose a lightweight `/ready` endpoint on host01 that checks docker service status and use that for DNS failover rules.
- Keep Docker Desktop and Windows Event Log alerts enabled on host01 so the service auto-restarts after reboots.

## 7.1 Live metrics collection (CPU, uptime, disks)

To keep the hosts dashboard updated with real telemetry:

1. **Metrics fetcher script**
   - Script: `mcp_debug/bin/mcp-host-metrics`
   - Reads CPU/load/memory/disk from host01 via `mcp-sshpass-test` and merges manual data for PC1/PC2/Pom01.
   - Output file: `_models/a_chaba/sites/hosts/metrics.json` (the dashboard fetches this every 5 minutes).

2. **How to run (from Windows dev box):**
   ```powershell
   cmd /c "cd /d c:\_dev\windsurf_ai\voice_chat && docker exec mcp-debug /workspace/mcp_debug/bin/mcp-host-metrics"
   ```

3. **Automate via cron/systemd** (optional):
   - Inside `mcp-debug`, add a cron entry (`crontab -e`) such as `*/10 * * * * /workspace/mcp_debug/bin/mcp-host-metrics >> /workspace/localdata/logs/metrics.log 2>&1`.
   - Ensure `/workspace/_models/a_chaba/sites/hosts/metrics.json` is writable in the container.

4. **Publish to Host01**
   - After metrics update + static edits, run the sync profile so `metrics.json` and the dashboard deploy together:
     ```powershell
     cmd /c "cd /d c:\_dev\windsurf_ai\voice_chat && npx dotenv-cli -e .env -- docker compose --profile host1-sync run --rm host1-sync"
     ```

5. **Verification**
   - Visit `https://chaba.surf-thailand.com/a-chaba/sites/hosts/` and confirm the hero banner shows “Live metrics · updated …” with current timestamps and CPU curves.

## 8. Preparing host02 / pom01 redundancy

1. **Mirror assets**: clone the repo + model directories to pom01, ensure `.env` matches host01 with host-specific overrides.
2. **Reuse profiles**: run the same compose profiles (`server`, `redis`, `stt-cpu`, `ollama`, `openvoice-tts`) so either host can serve the mic panel.
3. **Shared storage**: mount the same `_models` root via SMB/NFS or run hourly rsync jobs so caches and meeting data stay in sync.
4. **Failover plan**: configure Cloudflare/Godaddy failover to check `/health` on both host01 and pom01; when host01 fails, traffic automatically shifts to pom01.
5. **Testing**: once pom01 is online, temporarily flip DNS to it during off-hours to confirm the VCEN workload functions identically.

With host01 running the VCEN component set—and pom01 queued up for redundancy—you can power down the main desktop while retaining a live mic panel, voice control, and essential APIs.
