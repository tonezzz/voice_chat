from __future__ import annotations

import asyncio
import contextlib
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from mcp_sdk import create_mcpsdk


logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
logger = logging.getLogger("mcp_tuya_bridge")


class BridgeConfig(BaseModel):
    """Configuration required for connecting the Tuya MCP SDK."""

    endpoint: str = Field(..., description="Tuya MCP endpoint")
    access_id: str = Field(..., description="Tuya Access ID")
    access_secret: str = Field(..., description="Tuya Access Secret")
    custom_mcp_server_endpoint: str = Field(..., description="Local MCP server endpoint that Tuya should call")
    reconnect_min_seconds: int = Field(5, ge=1, le=300)
    reconnect_max_seconds: int = Field(60, ge=5, le=900)

    @classmethod
    def from_env(cls) -> "BridgeConfig":
        def required(name: str) -> str:
            value = os.getenv(name, "").strip()
            if not value:
                raise ValueError(f"Environment variable {name} is required")
            return value

        data = {
            "endpoint": required("TUYA_ENDPOINT"),
            "access_id": required("TUYA_ACCESS_ID"),
            "access_secret": required("TUYA_ACCESS_SECRET"),
            "custom_mcp_server_endpoint": required("TUYA_CUSTOM_MCP_ENDPOINT"),
            "reconnect_min_seconds": int(os.getenv("TUYA_RECONNECT_MIN_SECONDS", "5")),
            "reconnect_max_seconds": int(os.getenv("TUYA_RECONNECT_MAX_SECONDS", "60")),
        }

        config = cls(**data)
        if config.reconnect_min_seconds > config.reconnect_max_seconds:
            raise ValueError("TUYA_RECONNECT_MIN_SECONDS cannot be greater than TUYA_RECONNECT_MAX_SECONDS")
        return config


class BridgeStatus(BaseModel):
    status: Literal["connected", "connecting", "stopped", "error"]
    connected: bool
    last_error: Optional[str] = None
    last_connected_at: Optional[str] = None
    reconnect_attempts: int = 0


class TuyaMCPBridge:
    def __init__(self, config: BridgeConfig) -> None:
        self._config = config
        self._task: asyncio.Task[None] | None = None
        self._stop_event = asyncio.Event()
        self._connected = False
        self._last_error: Optional[str] = None
        self._last_connected_at: Optional[str] = None
        self._reconnect_attempts = 0

    async def start(self) -> None:
        if self._task and not self._task.done():
            return
        logger.info("Starting Tuya MCP bridge loop")
        self._stop_event.clear()
        self._task = asyncio.create_task(self._run(), name="tuya-mcp-bridge")

    async def stop(self) -> None:
        if not self._task:
            return
        logger.info("Stopping Tuya MCP bridge loop")
        self._stop_event.set()
        self._task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self._task
        self._task = None
        self._connected = False

    async def _run(self) -> None:
        backoff = self._config.reconnect_min_seconds
        while not self._stop_event.is_set():
            try:
                logger.info(
                    "Connecting tuya-mcp-sdk to %s -> %s",
                    self._config.endpoint,
                    self._config.custom_mcp_server_endpoint,
                )
                async with create_mcpsdk(
                    endpoint=self._config.endpoint,
                    access_id=self._config.access_id,
                    access_secret=self._config.access_secret,
                    custom_mcp_server_endpoint=self._config.custom_mcp_server_endpoint,
                ) as sdk:
                    self._connected = True
                    self._last_error = None
                    self._last_connected_at = datetime.utcnow().isoformat()
                    self._reconnect_attempts = 0
                    backoff = self._config.reconnect_min_seconds
                    await sdk.run()
            except asyncio.CancelledError:
                logger.info("Bridge loop cancelled")
                break
            except Exception as exc:  # noqa: BLE001
                self._connected = False
                self._last_error = str(exc)
                self._reconnect_attempts += 1
                logger.warning("Tuya MCP bridge disconnected: %s", exc)
                if self._stop_event.is_set():
                    break
                delay = min(backoff, self._config.reconnect_max_seconds)
                try:
                    await asyncio.wait_for(self._stop_event.wait(), timeout=delay)
                except asyncio.TimeoutError:
                    pass
                backoff = min(backoff * 2, self._config.reconnect_max_seconds)

        self._connected = False

    def status(self) -> BridgeStatus:
        if self._connected:
            status = "connected"
        elif self._task and not self._task.done():
            status = "connecting" if not self._last_error else "error"
        else:
            status = "stopped"
        return BridgeStatus(
            status=status,
            connected=self._connected,
            last_error=self._last_error,
            last_connected_at=self._last_connected_at,
            reconnect_attempts=self._reconnect_attempts,
        )


def create_app() -> FastAPI:
    try:
        config = BridgeConfig.from_env()
    except ValueError as exc:
        disabled_reason = f"Tuya bridge disabled: {exc}"
        logger.warning(disabled_reason)

        disabled_status = BridgeStatus(
            status="error",
            connected=False,
            last_error=disabled_reason,
            last_connected_at=None,
            reconnect_attempts=0,
        )

        app = FastAPI(title="mcp-tuya-bridge", version="0.1.0")

        @app.get("/health", response_model=BridgeStatus)
        async def health_disabled() -> BridgeStatus:
            return disabled_status

        @app.post("/restart")
        async def restart_disabled() -> BridgeStatus:
            raise HTTPException(status_code=503, detail=disabled_reason)

        @app.get("/status", response_model=BridgeStatus)
        async def status_disabled() -> BridgeStatus:
            return disabled_status

        @app.get("/.well-known/ready")
        async def readiness_disabled() -> dict[str, str]:
            raise HTTPException(status_code=503, detail=disabled_reason)

        return app

    bridge = TuyaMCPBridge(config)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        await bridge.start()
        try:
            yield
        finally:
            await bridge.stop()

    app = FastAPI(title="mcp-tuya-bridge", version="0.1.0", lifespan=lifespan)

    @app.get("/health", response_model=BridgeStatus)
    async def health() -> BridgeStatus:
        return bridge.status()

    @app.post("/restart")
    async def restart() -> BridgeStatus:
        await bridge.stop()
        await bridge.start()
        return bridge.status()

    @app.get("/status", response_model=BridgeStatus)
    async def status() -> BridgeStatus:
        return bridge.status()

    @app.get("/.well-known/ready")
    async def readiness() -> dict[str, str]:
        state = bridge.status()
        if state.status == "error":
            raise HTTPException(status_code=503, detail=state.last_error or "tuya bridge error")
        return {"status": state.status}

    return app


app = create_app()
