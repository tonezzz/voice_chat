from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
from typing import Any, Dict, Optional

from fastapi import FastAPI, HTTPException, status
from pydantic import BaseModel, Field

logger = logging.getLogger("mcp_memento_bridge")
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))

BRIDGE_PROTOCOL_VERSION = "2024-11-05"
DEFAULT_BRIDGE_NAME = "mcp-memento-bridge"
DEFAULT_BRIDGE_VERSION = "0.1.0"
DEFAULT_PORT = int(os.environ.get("PORT", "8005"))


class BridgeStatus(BaseModel):
    status: str
    detail: Optional[str] = None


class InvokeRequest(BaseModel):
    tool: str = Field(..., description="Tool name exposed by @iachilles/memento")
    arguments: Dict[str, Any] = Field(default_factory=dict)


class MementoBridge:
    def __init__(self, command: str, args: Optional[list[str]] = None, env_overrides: Optional[Dict[str, str]] = None) -> None:
        self._command = command
        self._args = args or []
        self._env_overrides = env_overrides or {}
        self._proc: asyncio.subprocess.Process | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self._pending: Dict[int, asyncio.Future[Dict[str, Any]]] = {}
        self._lock = asyncio.Lock()
        self._id_seq = 0
        self._capabilities: Dict[str, Any] = {}
        self._writer: asyncio.StreamWriter | None = None
        self._reader: asyncio.StreamReader | None = None

    async def start(self) -> None:
        if self.is_running:
            return

        env = os.environ.copy()
        env.update(self._env_overrides)

        logger.info("Starting memento MCP server via %s", self._command)
        self._proc = await asyncio.create_subprocess_exec(
            self._command,
            *self._args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        assert self._proc.stdout and self._proc.stdin
        self._writer = self._proc.stdin
        self._reader = self._proc.stdout

        if self._proc.stderr:
            self._stderr_task = asyncio.create_task(self._drain_stream(self._proc.stderr))
        self._reader_task = asyncio.create_task(self._listen_for_responses())

        await self._initialize_session()

    async def stop(self) -> None:
        if not self._proc:
            return
        logger.info("Stopping memento MCP server")
        self._proc.terminate()
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(self._proc.wait(), timeout=5)
        if self._reader_task:
            self._reader_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._reader_task
        if self._stderr_task:
            self._stderr_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._stderr_task
        self._pending.clear()
        self._proc = None
        self._writer = None
        self._reader = None
        self._reader_task = None
        self._stderr_task = None

    async def invoke_tool(self, tool: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        params = {"tool": tool, "arguments": arguments or {}}
        try:
            return await self._request("tools/call", params)
        except HTTPException as exc:
            detail = exc.detail if isinstance(exc.detail, dict) else {}
            if isinstance(detail, dict) and detail.get("code") == -32601:
                # Some MCP servers expose tools via tools.invoke (older spec). Try that as a fallback.
                return await self._request("tools.invoke", params)
            raise

    async def _initialize_session(self) -> None:
        init_response = await self._request(
            "initialize",
            {
                "protocolVersion": BRIDGE_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": DEFAULT_BRIDGE_NAME, "version": DEFAULT_BRIDGE_VERSION},
            },
        )
        self._capabilities = init_response or {}
        await self._notify("notifications/initialized", {})

    async def _request(self, method: str, params: Dict[str, Any]) -> Dict[str, Any]:
        if not self.is_running or not self._writer:
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "memento bridge is not running")

        async with self._lock:
            self._id_seq += 1
            req_id = self._id_seq
            loop = asyncio.get_running_loop()
            future: asyncio.Future[Dict[str, Any]] = loop.create_future()
            self._pending[req_id] = future
            payload = {
                "jsonrpc": "2.0",
                "id": req_id,
                "method": method,
                "params": params,
            }
            message = json.dumps(payload) + "\n"
            self._writer.write(message.encode("utf-8"))
            await self._writer.drain()

        result = await future
        error = result.get("error") if isinstance(result, dict) else None
        if error:
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail=error)
        return result.get("result", result)

    async def _notify(self, method: str, params: Dict[str, Any]) -> None:
        if not self.is_running or not self._writer:
            return
        payload = {
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }
        message = json.dumps(payload) + "\n"
        self._writer.write(message.encode("utf-8"))
        await self._writer.drain()

    async def _listen_for_responses(self) -> None:
        assert self._reader
        reader = self._reader
        while True:
            line = await reader.readline()
            if not line:
                break
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line.decode("utf-8"))
            except json.JSONDecodeError:
                logger.warning("Failed to decode MCP message: %s", line)
                continue
            response_id = message.get("id")
            if response_id is not None:
                future = self._pending.pop(int(response_id), None)
                if future and not future.done():
                    future.set_result(message)
            else:
                logger.debug("Received MCP notification: %s", message)

    async def _drain_stream(self, stream: asyncio.StreamReader) -> None:
        while True:
            data = await stream.readline()
            if not data:
                break
            logger.info("memento stderr: %s", data.decode().rstrip())

    @property
    def is_running(self) -> bool:
        return self._proc is not None and self._proc.returncode is None

    def manifest(self) -> Dict[str, Any]:
        return {
            "name": DEFAULT_BRIDGE_NAME,
            "version": DEFAULT_BRIDGE_VERSION,
            "description": "HTTP bridge exposing the @iachilles/memento MCP memory server",
            "capabilities": self._capabilities.get("capabilities", {}),
        }


def _build_memento_env() -> Dict[str, str]:
    overrides: Dict[str, str] = {}
    default_db_path = os.environ.get("MEMENTO_DB_PATH", "/data/memento.db")
    overrides.setdefault("MEMORY_DB_DRIVER", os.environ.get("MEMENTO_DB_DRIVER", "sqlite"))
    overrides.setdefault("MEMORY_DB_PATH", default_db_path)

    passthrough_vars = [
        "MEMORY_DB_DRIVER",
        "MEMORY_DB_PATH",
        "MEMORY_DB_DSN",
        "DATABASE_URL",
        "SQLITE_VEC_PATH",
        "PGHOST",
        "PGPORT",
        "PGUSER",
        "PGPASSWORD",
        "PGDATABASE",
        "PGSSLMODE",
    ]
    for var in passthrough_vars:
        value = os.environ.get(var)
        if value:
            overrides[var] = value
    return overrides


bridge = MementoBridge(command=os.environ.get("MEMENTO_COMMAND", "memento"), env_overrides=_build_memento_env())
app = FastAPI(title=DEFAULT_BRIDGE_NAME, version=DEFAULT_BRIDGE_VERSION)


@app.on_event("startup")
async def startup_event() -> None:
    await bridge.start()


@app.on_event("shutdown")
async def shutdown_event() -> None:
    await bridge.stop()


@app.get("/health", response_model=BridgeStatus)
async def health() -> BridgeStatus:
    if not bridge.is_running:
        return BridgeStatus(status="error", detail="memento subprocess not running")
    db_path = bridge._env_overrides.get("MEMORY_DB_PATH")  # noqa: SLF001
    detail = f"db={db_path}" if db_path else None
    return BridgeStatus(status="ok", detail=detail)


@app.get("/.well-known/mcp.json")
async def manifest() -> Dict[str, Any]:
    return bridge.manifest()


@app.post("/invoke")
async def invoke(request: InvokeRequest) -> Dict[str, Any]:
    result = await bridge.invoke_tool(request.tool, request.arguments)
    return result


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("MEMENTO_BRIDGE_HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", str(DEFAULT_PORT)))
    uvicorn.run("main:app", host=host, port=port, reload=False)
