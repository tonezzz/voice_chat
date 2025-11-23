from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import logging
from typing import Any, Dict, List, Optional

import httpx
from fastapi import Body, Depends, FastAPI, Header, HTTPException, Path
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from registry import ProviderRegistry
from schemas import AggregatedHealth, ProviderDescriptor, ProviderInfo, ProxyResponse
from settings import Settings, get_settings
from tool_loader import ToolSourceError, load_tools_from_source

logger = logging.getLogger(__name__)

settings = get_settings()

if settings.admin_token:
    logger.info("Admin API enabled")
else:
    logger.warning("Admin API disabled (missing MCP0_ADMIN_TOKEN)")

auth_headers: Dict[str, Dict[str, str]] = {}
github_bearer = settings.github_personal_token or settings.github_token
if github_bearer:
    auth_headers["github"] = {"Authorization": f"Bearer {github_bearer}"}

registry = ProviderRegistry.from_env(settings.provider_list, auth_headers=auth_headers or None)


def _apply_dynamic_github_tools() -> None:
    if not settings.enable_dynamic_github_tools:
        return
    if not settings.github_tool_source:
        logger.warning(
            "MCP0_ENABLE_DYNAMIC_GITHUB_TOOLS is true but GITHUB_MCP_TOOLS is unset; skipping dynamic load"
        )
        return

    descriptor = registry.get_descriptor("githubModel")
    if not descriptor:
        logger.warning("Dynamic GitHub tools enabled, but provider 'githubModel' not found")
        return

    try:
        result = load_tools_from_source(settings.github_tool_source)
    except ToolSourceError as exc:
        logger.warning("Failed to load dynamic GitHub tools: %s", exc)
        return

    descriptor.default_tools = result.tools
    logger.info("Loaded %d GitHub MCP tools from %s", len(result.tools), result.source)


_apply_dynamic_github_tools()


@asynccontextmanager
async def app_lifespan(_app: FastAPI):  # noqa: D401
    """FastAPI lifespan handler to warm caches before serving traffic."""

    await asyncio.gather(
        registry.collect_health(),
        registry.refresh_capabilities(),
    )
    yield


app = FastAPI(title=settings.app_name, version="0.1.0", lifespan=app_lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins(),
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=True,
)


def get_registry() -> ProviderRegistry:
    return registry


def get_timeout() -> float:
    return settings.request_timeout


def require_admin(authorization: Optional[str] = Header(default=None)) -> None:
    if not settings.admin_token:
        logger.warning("require_admin: admin token unset; rejecting request")
        raise HTTPException(status_code=503, detail="Admin API disabled")
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid admin token")
    provided = authorization.split(" ", 1)[1].strip()
    if provided != settings.admin_token:
        raise HTTPException(status_code=403, detail="Forbidden")


class ProviderRegistration(BaseModel):
    descriptor: ProviderDescriptor
    headers: Optional[Dict[str, str]] = None


@app.get("/health", response_model=AggregatedHealth)
async def service_health(registry: ProviderRegistry = Depends(get_registry)) -> AggregatedHealth:
    return await registry.collect_health()


@app.get("/providers", response_model=List[ProviderInfo])
async def list_providers(refresh: bool = False, registry: ProviderRegistry = Depends(get_registry)) -> List[ProviderInfo]:
    if refresh:
        await registry.refresh_capabilities()
    return registry.list_providers()


async def _proxy_request(
    provider: str,
    relative_path: str,
    payload: Dict[str, Any],
    registry: ProviderRegistry,
    timeout: float,
) -> ProxyResponse:
    descriptor = registry.get_descriptor(provider)
    if not descriptor:
        raise HTTPException(status_code=404, detail=f"Unknown provider '{provider}'")

    target_url = registry.build_target_url(descriptor, relative_path)
    extra_headers: Dict[str, str] = {}
    if descriptor.name.lower() == "github" and settings.github_token:
        extra_headers["Authorization"] = f"Bearer {settings.github_token}"

    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            response = await client.post(target_url, json=payload, headers=extra_headers or None)
        except httpx.RequestError as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    parsed_response: Any
    content_type = response.headers.get("content-type", "")
    if "application/json" in content_type:
        try:
            parsed_response = response.json()
        except ValueError:
            parsed_response = response.text
    else:
        parsed_response = response.text

    return ProxyResponse(
        provider=provider,
        target_url=target_url,
        status_code=response.status_code,
        response=parsed_response,
    )


@app.post("/proxy/{provider}", response_model=ProxyResponse)
async def proxy_root(
    provider: str,
    payload: Dict[str, Any] = Body(default_factory=dict),
    registry: ProviderRegistry = Depends(get_registry),
    timeout: float = Depends(get_timeout),
) -> ProxyResponse:
    return await _proxy_request(provider, "", payload, registry, timeout)


@app.post("/proxy/{provider}/{relative_path:path}", response_model=ProxyResponse)
async def proxy_path(
    provider: str,
    relative_path: str = Path(..., description="Path relative to the provider base URL"),
    payload: Dict[str, Any] = Body(default_factory=dict),
    registry: ProviderRegistry = Depends(get_registry),
    timeout: float = Depends(get_timeout),
) -> ProxyResponse:
    return await _proxy_request(provider, relative_path, payload, registry, timeout)


@app.post("/admin/providers", response_model=ProviderInfo)
async def register_provider(
    payload: ProviderRegistration,
    registry: ProviderRegistry = Depends(get_registry),
    _: None = Depends(require_admin),
) -> ProviderInfo:
    info = registry.upsert_provider(payload.descriptor, headers=payload.headers)
    await asyncio.gather(registry.collect_health(), registry.refresh_capabilities())
    return info


@app.delete("/admin/providers/{provider_name}")
async def remove_provider(
    provider_name: str,
    registry: ProviderRegistry = Depends(get_registry),
    _: None = Depends(require_admin),
) -> Dict[str, str]:
    removed = registry.remove_provider(provider_name)
    if not removed:
        raise HTTPException(status_code=404, detail=f"Provider '{provider_name}' not found")
    return {"status": "removed", "provider": provider_name}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host=settings.host,
        port=settings.port,
        reload=False,
    )
