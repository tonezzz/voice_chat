from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
from contextlib import asynccontextmanager
from typing import Any, Dict, Optional

import httpx
from fastapi import FastAPI, HTTPException, status
from pydantic import BaseModel, Field

logger = logging.getLogger("mcp_memory")
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))


class ToolInvokeRequest(BaseModel):
    tool: str
    arguments: Dict[str, Any] = Field(default_factory=dict)


class BridgeStatus(BaseModel):
    status: str
    detail: Optional[str] = None


class MemoryBridge:
    def __init__(self, binary: Optional[str] = None) -> None:
        self._binary = binary or os.environ.get("MEMORY_BINARY", "mcp-server-memory")
        self._proc: asyncio.subprocess.Process | None = None
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._pending: Dict[int, asyncio.Future[Dict[str, Any]]] = {}
        self._lock = asyncio.Lock()
        self._id_seq = 0
        self._manifest: Dict[str, Any] = {}

    async def start(self) -> None:
        if self.is_running:
            return

        logger.info("Starting memory MCP bridge")
        subprocess_env = os.environ.copy()
        memory_file_path = os.environ.get("MEMORY_FILE_PATH")
        if memory_file_path:
            subprocess_env["MEMORY_FILE_PATH"] = memory_file_path

        self._proc = await asyncio.create_subprocess_exec(
            self._binary,
            "stdio",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=subprocess_env,
        )
        assert self._proc.stdin and self._proc.stdout
        self._writer = self._proc.stdin
        self._reader = self._proc.stdout

        if self._proc.stderr:
            self._stderr_task = asyncio.create_task(self._drain_stream(self._proc.stderr, "STDERR"))
        self._reader_task = asyncio.create_task(self._listen_for_responses())

        await self._initialize_session()

    async def stop(self) -> None:
        if not self._proc:
            return
        logger.info("Stopping memory MCP bridge")
        self._proc.terminate()
        try:
            await asyncio.wait_for(self._proc.wait(), timeout=5)
        except asyncio.TimeoutError:
            self._proc.kill()
        if self._reader_task:
            self._reader_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._reader_task
        if self._stderr_task:
            self._stderr_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._stderr_task
        self._proc = None
        self._reader = None
        self._writer = None
        self._reader_task = None
        self._stderr_task = None
        self._pending.clear()

    async def invoke_tool(self, tool: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        payload = {
            "name": tool,
            "arguments": arguments,
        }
        response = await self._request("tools.invoke", payload)
        return response

    async def _initialize_session(self) -> None:
        response = await self._request(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "mcp-memory-bridge", "version": "0.1.0"},
            },
        )
        self._manifest = response or {}
        await self._notify("notifications/initialized", {})

    async def _request(self, method: str, params: Dict[str, Any]) -> Dict[str, Any]:
        if not self.is_running or not self._writer:
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "memory bridge not running")

        async with self._lock:
            self._id_seq += 1
            req_id = self._id_seq
            loop = asyncio.get_running_loop()
            future: asyncio.Future[Dict[str, Any]] = loop.create_future()
            self._pending[req_id] = future
            payload = {"jsonrpc": "2.0", "id": req_id, "method": method, "params": params}
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
        payload = {"jsonrpc": "2.0", "method": method, "params": params}
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
                logger.warning("Failed to decode memory server message: %s", line)
                continue
            response_id = message.get("id")
            if response_id is not None:
                future = self._pending.pop(int(response_id), None)
                if future and not future.done():
                    future.set_result(message)
            else:
                logger.debug("Received notification: %s", message)

    async def _drain_stream(self, stream: asyncio.StreamReader, label: str) -> None:
        while True:
            data = await stream.readline()
            if not data:
                break
            logger.info("memory %s: %s", label, data.decode().rstrip())

    @property
    def is_running(self) -> bool:
        return self._proc is not None and self._proc.returncode is None

    def manifest(self) -> Dict[str, Any]:
        return self._manifest


bridge = MemoryBridge()

PORT = int(os.environ.get("PORT", "8020"))
PROVIDER_NAME = os.environ.get("MEMORY_PROVIDER_NAME", "memory")
DEFAULT_TOOLS = [
    tool.strip()
    for tool in os.environ.get(
        "MEMORY_DEFAULT_TOOLS",
        "create_entities,create_relations,add_observations,delete_entities,delete_observations,delete_relations,read_graph,search_nodes,open_nodes",
    ).split(",")
    if tool.strip()
]
MCP0_URL = os.environ.get("MCP0_URL")
MCP0_ADMIN_TOKEN = os.environ.get("MCP0_ADMIN_TOKEN")
MEMORY_BASE_URL = os.environ.get("MEMORY_BASE_URL", f"http://mcp-memory:{PORT}")


async def register_with_mcp0() -> None:
    if not MCP0_URL or not MCP0_ADMIN_TOKEN:
        logger.info("Skipping mcp0 registration (missing MCP0_URL or MCP0_ADMIN_TOKEN)")
        return
    payload = {
        "descriptor": {
            "name": PROVIDER_NAME,
            "base_url": MEMORY_BASE_URL,
            "health_path": "/health",
            "capabilities_path": "/.well-known/mcp.json",
            "default_tools": DEFAULT_TOOLS,
        }
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                f"{MCP0_URL.rstrip('/')}/admin/providers",
                json=payload,
                headers={"Authorization": f"Bearer {MCP0_ADMIN_TOKEN}"},
            )
            response.raise_for_status()
            logger.info("Registered %s provider with mcp0", PROVIDER_NAME)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to register provider with mcp0: %s", exc)


@asynccontextmanager
async def lifespan(_: FastAPI):
    await bridge.start()
    await register_with_mcp0()
    try:
        yield
    finally:
        await bridge.stop()


app = FastAPI(title="mcp-memory-bridge", version="0.1.0", lifespan=lifespan)


@app.get("/health", response_model=BridgeStatus)
async def health() -> BridgeStatus:
    if not bridge.is_running:
        return BridgeStatus(status="error", detail="bridge process not running")
    return BridgeStatus(status="ok")


@app.get("/.well-known/mcp.json")
async def manifest() -> Dict[str, Any]:
    return bridge.manifest() or {
        "name": PROVIDER_NAME,
        "version": "0.0",
        "capabilities": {"tools": []},
    }


@app.post("/invoke")
async def invoke(request: ToolInvokeRequest) -> Dict[str, Any]:
    if not bridge.is_running:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "bridge not running")
    return await bridge.invoke_tool(request.tool, request.arguments)
