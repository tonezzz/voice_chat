from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

BASE_URL = os.getenv("DNSTOOLS_MCP_URL", "http://localhost:8018").rstrip("/")
DEFAULT_DOMAIN = os.getenv("DNSTOOLS_TEST_DOMAIN", "surf-thailand.com")


def main() -> int:
    domain = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_DOMAIN
    print(f"Registrar lookup for {domain} via {BASE_URL}")
    payload = json.dumps({"tool": "registrar_lookup", "arguments": {"domain": domain}}).encode("utf-8")
    req = urllib.request.Request(
        f"{BASE_URL}/invoke",
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        print("HTTPError", exc.code, exc.read().decode("utf-8", errors="replace"))
        return 1
    print(json.dumps(data, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
