from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Iterable, List

import httpx

logger = logging.getLogger(__name__)


class ToolSourceError(RuntimeError):
    """Raised when we fail to resolve a usable list of tools."""


@dataclass(slots=True)
class ToolSourceResult:
    tools: List[str]
    source: str


def load_tools_from_source(source: str, *, timeout: float = 5.0) -> ToolSourceResult:
    """Return tool names provided by the configured source.

    The source can be one of:
      * A `+` or `,` delimited literal list (e.g., "foo+bar" or "foo,bar").
      * An HTTP(S) URL returning either an array of strings or an object with a
        `tools`/`default_tools` field containing an array of strings.
    """

    value = (source or "").strip()
    if not value:
        raise ToolSourceError("tool source is empty")

    if value.startswith(("http://", "https://")):
        payload = _fetch_remote_payload(value, timeout=timeout)
        tools = _extract_tools_from_payload(payload)
    else:
        tools = _split_literal_tools(value)

    if not tools:
        raise ToolSourceError("tool source resolved to an empty list")

    logger.debug("Loaded %d tools from %s", len(tools), value)
    return ToolSourceResult(tools=tools, source=value)


def _fetch_remote_payload(url: str, *, timeout: float) -> object:
    try:
        with httpx.Client(timeout=timeout) as client:
            response = client.get(url)
            response.raise_for_status()
            return response.json()
    except (httpx.HTTPError, json.JSONDecodeError) as exc:  # noqa: BLE001
        raise ToolSourceError(f"failed to fetch dynamic tools from {url}: {exc}") from exc


def _extract_tools_from_payload(payload: object) -> List[str]:
    if isinstance(payload, list):
        return _normalize(payload)
    if isinstance(payload, dict):
        for key in ("tools", "default_tools", "defaultTools"):
            maybe_tools = payload.get(key)
            if isinstance(maybe_tools, list):
                return _normalize(maybe_tools)
    raise ToolSourceError("payload did not contain a tools list")


def _split_literal_tools(value: str) -> List[str]:
    # Support both + and , delimiters so we can keep the existing syntax.
    tokens: List[str] = []
    for chunk in value.replace(",", "+").split("+"):
        chunk = chunk.strip()
        if chunk:
            tokens.append(chunk)
    return tokens


def _normalize(items: Iterable[object]) -> List[str]:
    normalized: List[str] = []
    for item in items:
        if isinstance(item, str):
            trimmed = item.strip()
            if trimmed:
                normalized.append(trimmed)
    return normalized
