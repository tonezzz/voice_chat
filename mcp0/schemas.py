from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class ProviderDescriptor(BaseModel):
    name: str = Field(..., description="Unique identifier for the downstream MCP service")
    base_url: str = Field(..., description="Base URL for the provider (internal Docker hostname is fine)")
    health_path: str = Field("/health", description="Relative path used for health polling")
    health_method: str = Field("GET", description="HTTP method used when polling health")
    capabilities_path: Optional[str] = Field(
        "/.well-known/mcp.json", description="Optional relative path for the provider manifest"
    )
    default_tools: List[str] = Field(default_factory=list, description="Tool names this provider is expected to expose")


class ProviderHealth(BaseModel):
    name: str
    status: str
    detail: Optional[Any] = None
    latency_ms: Optional[int] = None
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class ProviderInfo(BaseModel):
    name: str
    base_url: str
    health_path: str
    capabilities_path: Optional[str]
    default_tools: List[str] = Field(default_factory=list)
    health: Optional[ProviderHealth] = None
    capabilities: Optional[Dict[str, Any]] = None
    capabilities_updated_at: Optional[datetime] = None


class AggregatedHealth(BaseModel):
    status: str
    services: List[ProviderHealth]
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class ProxyResponse(BaseModel):
    provider: str
    target_url: str
    status_code: int
    response: Any = None


class RouteDescriptor(BaseModel):
    name: str = Field(..., description="Unique identifier for the routed backend")
    path_prefix: str = Field(..., description="Incoming path prefix that should proxy to the target")
    target_url: str = Field(..., description="Upstream URL that receives the routed traffic")
    strip_prefix: bool = Field(False, description="Remove the matching prefix before proxying")
    preserve_host: bool = Field(False, description="Forward the original Host header instead of the upstream host")
    websockets: bool = Field(True, description="Allow WebSocket upgrades to flow through the route")


class RouteInfo(RouteDescriptor):
    created_at: datetime = Field(default_factory=datetime.utcnow)


class RouteListResponse(BaseModel):
    routes: List[RouteInfo]
    updated_at: datetime = Field(default_factory=datetime.utcnow)
