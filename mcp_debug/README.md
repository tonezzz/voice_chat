### Remote browser control (`mcp-browser`)

`mcp-browser` exposes Playwright-powered actions without diving into a full test runner. Common flows:

```bash
# Screenshot a page and save into /workspace/logs
mcp-browser screenshot http://server:3001/jobs

# Dump rendered HTML to STDOUT
mcp-browser html http://client:5173

# Run an inline JS snippet (JSON printed)
mcp-browser eval http://client:5173 "return document.title"

# Generate a PDF (optional custom path)
mcp-browser pdf https://example.com /workspace/logs/example.pdf
```

Environment knobs (all optional):

- `LOG_DIR` (defaults to `/workspace/logs`)
- `BROWSER_HEADLESS=true|false`
- `BROWSER_TIMEOUT` (ms, default `45000`)
- `BROWSER_VIEWPORT` (e.g., `1440x900`)
- `BROWSER_WAIT_UNTIL` (`load`, `domcontentloaded`, `networkidle`, ...)

Because the helper runs inside `mcp-debug`, you can trigger it via ttyd/ngrok for remote diagnostics without exposing another service.

### Automated capture + AI vision (`mcp-browser-vision`)

Need a one-liner to screenshot a UI and immediately run object detection? The `mcp-browser-vision` helper stitches the two workflows together.

```bash
# Capture client UI (defaults to http://client:5173) and run YOLO detections
mcp-browser-vision

# Target a specific URL and tighten confidence threshold
YOLO_CONFIDENCE=0.4 mcp-browser-vision https://example.com/dashboard

# Save into a custom folder
CAPTURE_DIR=/workspace/logs/captures mcp-browser-vision
```

Under the hood:

1. `mcp-browser screenshot …` writes a PNG into `/workspace/logs` (configurable via `CAPTURE_DIR`, `CAPTURE_BASENAME`, or `CAPTURE_PATH`).
2. `mcp-vision-yolo` base64-encodes the image and POSTs it to `${YOLO_URL:-http://mcp-yolo:8000}/detect`.
3. Output defaults to a TSV table; set `YOLO_OUTPUT_FORMAT=json` for structured responses. Pass `YOLO_SILENT=true` to suppress progress logs when scripting.

`mcp-vision-yolo` can be used directly for local PNG/JPEGs you already have:

```bash
mcp-vision-yolo /workspace/logs/browser-2025-11-22T13-45-40-557Z.png
YOLO_URL=http://host.docker.internal:8000 YOLO_OUTPUT_FORMAT=json mcp-vision-yolo ./test.png
```

Both helpers respect `YOLO_CONFIDENCE` (clamped to `0-1`) and auto-detect mime types when the `file` utility is present inside the container.

### Scheduler (`mcp-browser-vision-watch`)

For hands-off monitoring, run `mcp-browser-vision-watch`. It accepts a comma-separated `VISION_URLS` list (defaults to `http://client:5173`) and captures screenshots for each on a fixed cadence.

Environment knobs:

- `VISION_INTERVAL_SECONDS` (default `300`)
- `VISION_URLS` (comma-separated list of URLs)
- `VISION_CAPTURE_DIR` (default `/workspace/logs/vision`)
- `VISION_MAX_HISTORY` (keep N most recent captures per URL; `0` disables pruning)
- `VISION_ONCE=true` to run a single pass (useful for cron/testing)
- `YOLO_CONFIDENCE`, `YOLO_OUTPUT_FORMAT`, and other vars from the underlying helpers

Each cycle produces `<slug>-TIMESTAMP.png` + `.json` detection files and appends summaries into `${VISION_LOG_FILE:-/workspace/logs/vision-monitor.log}`. From Windows hosts you can launch everything (including alert/webhook presets) via `scripts/run-vision-monitor.ps1 -Preset alerts|full|baseline`, which shells into `mcp-debug` with the right environment.

#### Alerts + MCP forwarding (`mcp-vision-hook`)

If present in `$PATH`, `mcp-browser-vision-watch` automatically calls `mcp-vision-hook <url> <slug> <png> <json>` after every successful detection run. Configure it with environment variables:

- `VISION_ALERT_CLASSES="error_banner,warning"` — only trigger when YOLO sees one of these classes (default: any class).
- `VISION_ALERT_MIN_CONF=0.5` — minimum confidence for matches (default `0.4`).
- `VISION_ALERT_ALWAYS=true` — force alerts even without matches (handy for heartbeat tests).
- `VISION_ALERT_WEBHOOK_URL=https://hooks.slack.com/...` — JSON POST payload for Slack/Teams/etc.
- `VISION_ALERT_INCLUDE_IMAGE=true` — embed the screenshot as a base64 data URL inside the payload.
- `VISION_MCP_FORWARD_URL=http://server:3001/detect-image` — forward detections + screenshot to another MCP/HTTP endpoint. Set `VISION_MCP_FORWARD_MODE=multipart` to use file uploads instead of raw JSON, and `VISION_MCP_FORWARD_HEADERS="Authorization: Bearer abc;X-Env: prod"` for custom headers.
- `VISION_ALERT_COMMAND='scripts/process-vision.sh'` — run a local command with payload context in `VISION_HOOK_*` env vars (ideal for chaining memento/meeting/VMS updates).

The hook payload includes the source URL, slug, timestamps, summarized matches, the full YOLO detections, and the original file paths, so you can push notifications, update MCP graph stores, or kick off remediation jobs automatically.

# MCP Debug Helper Container

This utility container is meant to be the fastest way to poke at services from *inside* the Docker network.
It now ships with the following:

- **Core tools:** httpie, curl, jq, wscat, socat, openssl, net-tools, git, sqlite3, vim-tiny.
- **Node.js runtime:** lets you run ad-hoc npm packages (Playwright, diagnostics scripts, etc.).
- **Helper scripts:** opinionated wrappers prefixed with `mcp-` for common meeting + MCP flows.
- **Diagnostics harness:** `/workspace/diagnostics/run_all.sh` plus the `mcp-diag` shortcut to capture a
  one-shot snapshot of service health.
- **Idle heartbeat:** container logs now emit a heartbeat + optional tail of `/workspace/logs` so `docker logs mcp-debug`
  confirms the helper is alive and shows recent diagnostics output.

## Usage

```bash
# Start the container (debug profile)
docker compose -f docker-compose.yml -f docker-compose.optional.yml up -d mcp-debug

# Attach a shell
docker exec -it mcp-debug bash

# (optional) SSH in from another container/host once you've mounted keys
ssh -i /path/to/key debug@mcp-debug
```

From inside the shell you can run any helper script directly (they live in `/usr/local/bin`).
All scripts honor the following environment overrides:

- `SERVER_URL` (default `http://server:3001`)
- `MCP0_URL` (default `http://mcp0:8010`)
- `MEETING_URL` (default `http://mcp-meeting:8008`)
- `HTTP_TIMEOUT` (seconds, default `15`)
- `SSH_ENABLED` (`auto` by default) — set `false` to disable sshd entirely or `true` to force startup even when keys are missing.
- `SSH_PORT` (default `22`) — change if another container already binds the port.
- `SSH_AUTHORIZED_KEYS_FILE` (default `/workspace/localdata/ssh/authorized_keys`) — bind-mount a file with public keys to grant access.
- `SSH_AUTHORIZED_KEYS` — provide inline public keys instead of a file.

Set them per invocation (e.g., `SERVER_URL=http://host.docker.internal:3001 mcp-health`).

When sshd is enabled you can connect from any container on the compose network using

```bash
ssh -i /workspace/localdata/keys/host1_ed25519 debug@mcp-debug
```

Only public-key auth is allowed and the `debug` account has no password, so be sure to mount the proper keypair into `/workspace/localdata/ssh` or inject it via `SSH_AUTHORIZED_KEYS`.

## Helper commands

| Command | Purpose |
| --- | --- |
| `mcp-health` | Hit the Express `/health` endpoint and pretty-print results. |
| `mcp-providers-refresh` | Force-refresh `/mcp/providers` and show duration. |
| `mcp-meeting-list [sessionId]` | List all meeting sessions or fetch a specific one. |
| `mcp-meeting-append <sessionId> <text> [speaker]` | Append transcript text via the Express proxy. |
| `mcp-watch-providers [intervalSeconds]` | Continuous monitor of provider refresh latency. |
| `mcp-diag` | Run the full diagnostics suite (see below). |
| `mcp-playwright-install` | Install client dependencies + Playwright browsers for UI tests. |
| `mcp-playwright-smoke [specPattern]` | Run Playwright tests (defaults to `meeting-panel.spec.ts`). |
| `mcp-browser <cmd> <url>` | One-off Playwright browser control (`screenshot`, `html`, `eval`, `pdf`). |
| `mcp-vision-yolo <path>` | POST a local image to the YOLO MCP and pretty-print detections. |
| `mcp-browser-vision [url]` | Capture a screenshot via `mcp-browser` then analyze it with YOLO. |
| `mcp-browser-vision-watch` | Looping monitor that screenshots URLs on a cadence and stores YOLO results. |
| `mcp-vision-hook` | Optional alert/MCP forwarding hook invoked after each detection pass. |
| `mcp-wsl [cmd]` | Execute commands inside your host WSL distro over SSH (see "WSL bridge"). |
| `mcp-pc1-uptime` | Shortcut for `mcp-wsl uptime -p` targeting the PC1 WSL host (overrides via `WSL_*`). |

Add new scripts under `mcp_debug/bin/` (prefixed with `mcp-`) and rebuild to bake them in.

### Browser automation quick start

1. `docker exec -it mcp-debug bash`
2. `mcp-playwright-install` (first run or after dependency changes)
3. `BASE_URL=http://client:5173 VITE_API_BASE_URL=http://server:3001 mcp-playwright-smoke`

Override `BASE_URL`, `VITE_API_BASE_URL`, or pass a spec pattern: `mcp-playwright-smoke meeting-panel.spec.ts`.

The default entrypoint runs `mcp-debug-idle`, which prints a heartbeat message every 30s and tails files specified via
`TAIL_FILES` (e.g., set `TAIL_FILES="/workspace/logs/*.log"` in compose overrides to stream diagnostics into `docker logs`).

### WSL bridge (Windows hosts)

You can drive your Windows Subsystem for Linux (WSL) distro from inside `mcp-debug` using the `mcp-wsl` helper.

1. **Inside WSL** install + harden OpenSSH:

   ```bash
   sudo apt update && sudo apt install -y openssh-server
   sudo tee /etc/ssh/sshd_config.d/99-mcp-debug.conf >/dev/null <<'CONF'
   PasswordAuthentication no
   PermitRootLogin no
   AllowUsers $USER
   AuthenticationMethods publickey
   CONF
   mkdir -p ~/.ssh && chmod 700 ~/.ssh
   cat <<'KEY' >> ~/.ssh/authorized_keys
   # paste the public key that mcp-debug will use
   KEY
   chmod 600 ~/.ssh/authorized_keys
   sudo systemctl enable --now ssh
   ```

2. **On Windows** expose WSL SSH via portproxy (replace the IP if it changes):

   ```powershell
   $wslIp = '192.168.1.37' # run `wsl hostname -I` to refresh on reboot
   netsh interface portproxy delete v4tov4 listenport=2222 listenaddress=0.0.0.0 2>$null
   netsh interface portproxy add v4tov4 listenport=2222 listenaddress=0.0.0.0 connectport=22 connectaddress=$wslIp
   New-NetFirewallRule -DisplayName "WSL SSH Proxy 2222" -Direction Inbound -Protocol TCP -LocalPort 2222 -Action Allow -Profile Any
   ```

   The repo also ships `scripts/setup-wsl-ssh-proxy.ps1` to automate the IP detection, portproxy, and key sync in one go.

3. **Provide the private key** to mcp-debug (once per key change):

   ```powershell
   Copy-Item C:\_dev\_models\tony\conf\chaba-idc\wsl_debug_ed25519 C:\_chaba\chaba-1\mcp-debug\keys\wsl_debug_ed25519
   docker exec mcp-debug bash -lc "mcp-wsl key-install"
   ```

4. **Run commands** from inside the container:

   ```bash
   docker exec mcp-debug env WSL_USER=tony mcp-wsl test
   docker exec mcp-debug env WSL_USER=tony mcp-wsl 'htop -b -n1'
   ```

`mcp-wsl` accepts overrides such as `WSL_HOST`, `WSL_PORT`, `WSL_SSH_ARGS`, and defaults `WSL_STRICT=no` so it works with the port proxy without prompting.

## Diagnostics workflow

`mcp-diag` (or `/workspace/diagnostics/run_all.sh`) collects a timestamped report under
`/workspace/logs/diagnostics-YYYYmmdd-HHMMSS.log`. It captures:

1. Key environment overrides and container metadata.
2. Health of Express, MCP0, and the meeting service.
3. Provider refresh output and response time.
4. Meeting session list snapshot.
5. Meeting MCP storage stats (if `/data` is mounted).

Example:

```bash
mcp-diag
cat /workspace/logs/diagnostics-20241122-132530.log
```

Send the resulting log whenever you need help reproducing a failure.

## Automation ideas

- Use `mcp-watch-providers` (or roll your own script) to tail endpoints and stream results into `/workspace/logs`.
- Add new scripts for other MCP services (YOLO, Imagen, Tuya) using the existing helpers as templates.
- Combine with Playwright (`npx playwright test`) once you want browser-level smoke tests that still run
  from inside the network.

If you need additional tooling, update the Dockerfile and rebuild with:

```bash
docker compose -f docker-compose.yml -f docker-compose.optional.yml build mcp-debug
```
