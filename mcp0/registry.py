from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional
from urllib.parse import urljoin

import httpx

from schemas import (
    AggregatedHealth,
    ProviderDescriptor,
    ProviderHealth,
    ProviderInfo,
    RouteDescriptor,
    RouteInfo,
)

logger = logging.getLogger(__name__)


class ProviderRegistry:
    def __init__(
        self,
        providers: List[ProviderDescriptor],
        timeout_seconds: float = 10.0,
        auth_headers: Optional[Dict[str, Dict[str, str]]] = None,
    ) -> None:
        self._providers = {provider.name: provider for provider in providers}
        self._timeout = timeout_seconds
        self._health: Dict[str, ProviderHealth] = {}
        self._capabilities: Dict[str, Dict[str, Any]] = {}
        self._capabilities_updated_at: Dict[str, datetime] = {}
        self._auth_headers = {name.lower(): headers for name, headers in (auth_headers or {}).items()}

    @classmethod
    def from_env(
        cls,
        env_value: str | None,
        *,
        timeout_seconds: float = 10.0,
        auth_headers: Optional[Dict[str, Dict[str, str]]] = None,
    ) -> "ProviderRegistry":
        providers: List[ProviderDescriptor] = []
        if env_value:
            entries = [entry.strip() for entry in env_value.split(",") if entry.strip()]
            for entry in entries:
                parts = [part for part in entry.split("|") if part]
                if not parts:
                    continue
                name_url = parts[0]
                name, _, base_url = name_url.partition(":")
                if not name or not base_url:
                    logger.warning("Skipping invalid MCP entry: %s", entry)
                    continue
                kwargs: Dict[str, Any] = {}
                for option in parts[1:]:
                    opt_key, _, opt_value = option.partition("=")
                    opt_key = opt_key.strip().lower()
                    opt_value = opt_value.strip()
                    if opt_key in {"health", "health_path"} and opt_value:
                        kwargs["health_path"] = opt_value
                    elif opt_key in {"health_method", "healthmethod"} and opt_value:
                        kwargs["health_method"] = opt_value
                    elif opt_key in {"capabilities", "capabilities_path"}:
                        kwargs["capabilities_path"] = opt_value or None
                    elif opt_key in {"tools", "default_tools"}:
                        tools = [tool.strip() for tool in opt_value.split("+") if tool.strip()]
                        kwargs["default_tools"] = tools
                descriptor = ProviderDescriptor(
                    name=name.strip(),
                    base_url=base_url.strip(),
                    health_path=kwargs.get("health_path", "/health"),
                    health_method=kwargs.get("health_method", "GET"),
                    capabilities_path=kwargs.get("capabilities_path", "/.well-known/mcp.json"),
                    default_tools=kwargs.get("default_tools", []),
                )
                providers.append(descriptor)
        return cls(providers=providers, timeout_seconds=timeout_seconds, auth_headers=auth_headers)

    def get_descriptor(self, provider_name: str) -> Optional[ProviderDescriptor]:
        return self._providers.get(provider_name)

    def build_target_url(self, descriptor: ProviderDescriptor, relative_path: str) -> str:
        relative = relative_path.lstrip("/")
        return urljoin(descriptor.base_url.rstrip("/") + "/", relative)

    def _headers_for(self, descriptor: ProviderDescriptor) -> Dict[str, str] | None:
        return self._auth_headers.get(descriptor.name.lower())

    def _build_provider_info(self, descriptor: ProviderDescriptor) -> ProviderInfo:
        return ProviderInfo(
            name=descriptor.name,
            base_url=descriptor.base_url,
            health_path=descriptor.health_path,
            capabilities_path=descriptor.capabilities_path,
            default_tools=descriptor.default_tools,
            health=self._health.get(descriptor.name),
            capabilities=self._capabilities.get(descriptor.name),
            capabilities_updated_at=self._capabilities_updated_at.get(descriptor.name),
        )

    def list_providers(self) -> List[ProviderInfo]:
        return [self._build_provider_info(descriptor) for descriptor in self._providers.values()]

    def get_provider_info(self, provider_name: str) -> Optional[ProviderInfo]:
        descriptor = self._providers.get(provider_name)
        if not descriptor:
            return None
        return self._build_provider_info(descriptor)

    def upsert_provider(self, descriptor: ProviderDescriptor, headers: Optional[Dict[str, str]] = None) -> ProviderInfo:
        self._providers[descriptor.name] = descriptor
        if headers:
            self._auth_headers[descriptor.name.lower()] = headers
        return self._build_provider_info(descriptor)

    def remove_provider(self, provider_name: str) -> bool:
        descriptor = self._providers.pop(provider_name, None)
        if not descriptor:
            return False
        self._health.pop(provider_name, None)
        self._capabilities.pop(provider_name, None)
        self._capabilities_updated_at.pop(provider_name, None)
        self._auth_headers.pop(provider_name.lower(), None)
        return True

    async def collect_health(self) -> AggregatedHealth:
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            tasks = [self._fetch_health(client, descriptor) for descriptor in self._providers.values()]
            results = await asyncio.gather(*tasks, return_exceptions=True)

        health_entries: List[ProviderHealth] = []
        for descriptor, result in zip(self._providers.values(), results, strict=False):
            if isinstance(result, ProviderHealth):
                self._health[descriptor.name] = result
                health_entries.append(result)
            else:
                detail = str(result)
                failure = ProviderHealth(name=descriptor.name, status="error", detail=detail)
                self._health[descriptor.name] = failure
                health_entries.append(failure)

        overall_status = "ok" if all(entry.status == "ok" for entry in health_entries) else "error"
        return AggregatedHealth(status=overall_status, services=health_entries)

    async def refresh_capabilities(self) -> None:
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            tasks = [self._fetch_capabilities(client, descriptor) for descriptor in self._providers.values()]
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _fetch_health(self, client: httpx.AsyncClient, descriptor: ProviderDescriptor) -> ProviderHealth:
        url = urljoin(descriptor.base_url.rstrip("/") + "/", descriptor.health_path.lstrip("/"))
        method = (descriptor.health_method or "GET").upper()
        started = datetime.utcnow()
        try:
            response = await client.request(method, url, headers=self._headers_for(descriptor))
            latency = int((datetime.utcnow() - started).total_seconds() * 1000)
            if response.status_code >= 400:
                return ProviderHealth(name=descriptor.name, status="error", detail=f"HTTP {response.status_code}", latency_ms=latency)
            detail = None
            content_type = response.headers.get("content-type", "")
            if "application/json" in content_type:
                with contextlib.suppress(json.JSONDecodeError):
                    detail = response.json()
            return ProviderHealth(name=descriptor.name, status="ok", detail=detail, latency_ms=latency)
        except Exception as exc:  # noqa: BLE001
            return ProviderHealth(name=descriptor.name, status="error", detail=str(exc))

    async def _fetch_capabilities(self, client: httpx.AsyncClient, descriptor: ProviderDescriptor) -> None:
        if not descriptor.capabilities_path:
            return
        url = urljoin(descriptor.base_url.rstrip("/") + "/", descriptor.capabilities_path.lstrip("/"))
        try:
            response = await client.get(url, headers=self._headers_for(descriptor))
            response.raise_for_status()
            self._capabilities[descriptor.name] = response.json()
            self._capabilities_updated_at[descriptor.name] = datetime.utcnow()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Failed to fetch capabilities for %s: %s", descriptor.name, exc)


class HTTPRouteRegistry:
    def __init__(self, routes: Optional[Dict[str, RouteInfo]] = None) -> None:
        self._routes: Dict[str, RouteInfo] = routes or {}

    @classmethod
    def from_env(cls, env_value: Optional[str]) -> "HTTPRouteRegistry":
        routes: Dict[str, RouteInfo] = {}
        if env_value:
            entries = [entry.strip() for entry in env_value.split(",") if entry.strip()]
            for entry in entries:
                parts = [part for part in entry.split("|") if part]
                if not parts:
                    continue
                name_prefix = parts[0]
                name, _, path_prefix = name_prefix.partition(":")
                if not name or not path_prefix:
                    logger.warning("Skipping invalid HTTP route entry: %s", entry)
                    continue
                options: Dict[str, Any] = {"path_prefix": path_prefix}
                for option in parts[1:]:
                    opt_key, _, opt_value = option.partition("=")
                    opt_key = opt_key.strip().lower()
                    opt_value = opt_value.strip()
                    if opt_key in {"target", "target_url"}:
                        options["target_url"] = opt_value
                    elif opt_key in {"strip", "strip_prefix"}:
                        options["strip_prefix"] = opt_value.lower() in {"true", "1", "yes", "on"}
                    elif opt_key in {"preserve_host", "preservehost"}:
                        options["preserve_host"] = opt_value.lower() in {"true", "1", "yes", "on"}
                    elif opt_key in {"websockets", "ws"}:
                        options["websockets"] = opt_value.lower() not in {"false", "0", "no", "off"}
                if "target_url" not in options:
                    logger.warning("Skipping HTTP route '%s': missing target", entry)
                    continue
                descriptor = RouteDescriptor(name=name.strip(), **options)
                routes[descriptor.name] = RouteInfo(**descriptor.model_dump())
        return cls(routes=routes)

    def list_routes(self) -> List[RouteInfo]:
        return list(self._routes.values())

    def upsert_route(self, descriptor: RouteDescriptor) -> RouteInfo:
        info = RouteInfo(**descriptor.model_dump())
        self._routes[descriptor.name] = info
        return info

    def remove_route(self, route_name: str) -> bool:
        return self._routes.pop(route_name, None) is not None
