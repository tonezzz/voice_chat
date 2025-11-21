"""Runtime configuration for the VMS MCP server."""

from __future__ import annotations

import os
from typing import Any, Dict


def _env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _env_str(name: str, default: str) -> str:
    value = os.getenv(name)
    if value is None or not value.strip():
        return default
    return value.strip()


vms_config: Dict[str, Any] = {
    "img_width": _env_int("VMS_IMG_WIDTH", 320),
    "img_height": _env_int("VMS_IMG_HEIGHT", 240),
    "pixel_format": _env_str("VMS_PIXEL_FORMAT", "RGB"),
    "url": _env_str("VMS_HOST", "127.0.0.1"),
    "port": _env_int("VMS_PORT", 3300),
    "access_id": _env_str("VMS_ACCESS_ID", "admin"),
    "access_pw": _env_str("VMS_ACCESS_PW", "admin"),
}


__all__ = ["vms_config"]
