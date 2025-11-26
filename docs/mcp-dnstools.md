# mcp-dnstools

DNS helper MCP service that mirrors MXToolbox-style checks.

## Endpoints & tools

| Tool | Description |
|------|-------------|
| `lookup_record` | Single record lookup with optional nameserver override. |
| `dns_summary` | Snapshot for A/AAAA/CNAME/MX/TXT/NS/SOA (configurable). |
| `mx_health` | Ensures MX hosts have reachable A/AAAA glue. |
| `spf_inspect` | Parses SPF TXT records to highlight include/ip/all rules. |

All tools accept `nameservers` (array or comma string) to bypass the default resolver list (`DNSTOOLS_NAMESERVERS`, default `1.1.1.1,8.8.8.8`).

## Configuration

| Env var | Purpose |
|---------|---------|
| `DNSTOOLS_PROVIDER_NAME` | Name registered with MCP0. |
| `DNSTOOLS_NAMESERVERS` | Default resolver list. |
| `DNSTOOLS_ENABLE_DOH` | Toggle DoH fallback (default `true`). |
| `DNSTOOLS_DOH_ENDPOINT` | HTTPS resolver (default Google). |
| `DNSTOOLS_SUMMARY_TYPES` | Comma list for `dns_summary`. |
| `DNSTOOLS_HEALTH_DOMAIN` | Domain probed by `/health`. |

The service auto-registers itself with MCP0 when `MCP0_URL`/`MCP0_ADMIN_TOKEN` are provided. After UI changes, rebuild via `cmd /c "cd /d c:\_dev\windsurf_ai\voice_chat && npx dotenv-cli -e .env -- docker compose build mcp-dnstools"` then `docker compose up -d mcp-dnstools`.
