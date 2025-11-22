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

Each cycle produces `<slug>-TIMESTAMP.png` + `.json` detection files and appends summaries into `${VISION_LOG_FILE:-/workspace/logs/vision-monitor.log}`.

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
```

From inside the shell you can run any helper script directly (they live in `/usr/local/bin`).
All scripts honor the following environment overrides:

- `SERVER_URL` (default `http://server:3001`)
- `MCP0_URL` (default `http://mcp0:8010`)
- `MEETING_URL` (default `http://mcp-meeting:8008`)
- `HTTP_TIMEOUT` (seconds, default `15`)

Set them per invocation (e.g., `SERVER_URL=http://host.docker.internal:3001 mcp-health`).

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

Add new scripts under `mcp_debug/bin/` (prefixed with `mcp-`) and rebuild to bake them in.

### Browser automation quick start

1. `docker exec -it mcp-debug bash`
2. `mcp-playwright-install` (first run or after dependency changes)
3. `BASE_URL=http://client:5173 VITE_API_BASE_URL=http://server:3001 mcp-playwright-smoke`

Override `BASE_URL`, `VITE_API_BASE_URL`, or pass a spec pattern: `mcp-playwright-smoke meeting-panel.spec.ts`.

The default entrypoint runs `mcp-debug-idle`, which prints a heartbeat message every 30s and tails files specified via
`TAIL_FILES` (e.g., set `TAIL_FILES="/workspace/logs/*.log"` in compose overrides to stream diagnostics into `docker logs`).

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
