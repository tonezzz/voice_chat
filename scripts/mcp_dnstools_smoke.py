"""Simple smoke test for mcp-dnstools endpoints."""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any, Dict

BASE_URL = os.getenv("DNSTOOLS_MCP_URL", "http://localhost:8018").rstrip("/")
DEFAULT_DOMAIN = os.getenv("DNSTOOLS_TEST_DOMAIN", "chaba.surf-thailand.com")


def _get(path: str) -> Dict[str, Any]:
    url = f"{BASE_URL}{path}"
    with urllib.request.urlopen(url, timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))


def _post(path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{BASE_URL}{path}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as response:
        return json.loads(response.read().decode("utf-8"))


def main() -> int:
    domain = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_DOMAIN
    print(f"Testing mcp-dnstools at {BASE_URL} (domain={domain})")
    try:
        health = _get("/health")
        print("/health =>", health)
        lookup = _post(
            "/invoke",
            {
                "tool": "lookup_record",
                "arguments": {"domain": domain, "record_type": "A"},
            },
        )
        print("lookup_record =>", json.dumps(lookup, indent=2))
    except urllib.error.HTTPError as exc:  # pragma: no cover - quick signal
        body = exc.read().decode("utf-8", errors="replace")
        print(f"HTTPError {exc.code}: {body}")
        return 1
    except Exception as exc:  # noqa: BLE001
        print("Error:", exc)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
