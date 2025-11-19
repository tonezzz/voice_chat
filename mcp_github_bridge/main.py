from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
from typing import Any, Dict, Optional

from fastapi import FastAPI, HTTPException, status
from pydantic import BaseModel, Field

logger = logging.getLogger("mcp_github_bridge")
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))


class BridgeStatus(BaseModel):
    status: str
    detail: Optional[str] = None


class InvokeRequest(BaseModel):
    tool: str = Field(..., description="Tool name to invoke via the MCP server")
    arguments: Dict[str, Any] = Field(default_factory=dict)


class GithubMCPBridge:
    def __init__(self, token: str, binary: Optional[str] = None) -> None:
        self._token = token
        self._binary = binary or os.environ.get("GITHUB_MCP_BINARY", "server")
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
        env.setdefault("GITHUB_PERSONAL_ACCESS_TOKEN", self._token)

        logger.info("Starting github-mcp-server stdio bridge")
        self._proc = await asyncio.create_subprocess_exec(
            self._binary,
            "stdio",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        assert self._proc.stdout and self._proc.stdin
        self._writer = self._proc.stdin
        self._reader = self._proc.stdout

        if self._proc.stderr:
            self._stderr_task = asyncio.create_task(self._drain_stream(self._proc.stderr, "STDERR"))
        self._reader_task = asyncio.create_task(self._listen_for_responses())

        await self._initialize_session()

    async def stop(self) -> None:
        if not self._proc:
            return
        logger.info("Stopping github-mcp-server bridge")
        self._proc.terminate()
        try:
            await asyncio.wait_for(self._proc.wait(), timeout=5)
        except asyncio.TimeoutError:
            logger.warning("Bridge process did not terminate in time, killing")
            self._proc.kill()
        if self._reader_task:
            self._reader_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._reader_task
            self._reader_task = None
        if self._stderr_task:
            self._stderr_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._stderr_task
            self._stderr_task = None
        self._pending.clear()
        self._proc = None
        self._writer = None
        self._reader = None

    async def invoke_tool(self, tool: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        params = {
            "tool": tool,
            "arguments": arguments,
        }
        response = await self._request("tools.invoke", params)
        return response

    async def _initialize_session(self) -> None:
        init_response = await self._request(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "mcp-github-bridge", "version": "0.1.0"},
            },
        )
        self._capabilities = init_response or {}
        await self._notify("notifications/initialized", {})

    async def _request(self, method: str, params: Dict[str, Any]) -> Dict[str, Any]:
        if not self.is_running or not self._writer:
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "GitHub MCP bridge not running")

        async with self._lock:
            self._id_seq += 1
            req_id = self._id_seq
            future: asyncio.Future[Dict[str, Any]] = asyncio.get_running_loop().create_future()
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
                logger.debug("Received notification: %s", message)

    async def _drain_stream(self, stream: asyncio.StreamReader, label: str) -> None:
        while True:
            data = await stream.readline()
            if not data:
                break
            logger.info("mcp %s: %s", label, data.decode().rstrip())

    @property
    def is_running(self) -> bool:
        return self._proc is not None and self._proc.returncode is None

    def manifest(self) -> Dict[str, Any]:
        return {
            "name": "github-mcp-bridge",
            "version": "0.1.0",
            "description": "HTTP bridge for GitHub MCP server",
            "capabilities": self._capabilities.get("capabilities", {}),
        }


TOKEN = os.environ.get("GITHUB_PERSONAL_TOKEN") or os.environ.get("GITHUB_PERSONAL_ACCESS_TOKEN")
if not TOKEN:
    logger.warning("GITHUB_PERSONAL_TOKEN is not set. GitHub bridge will report degraded health.")

bridge = GithubMCPBridge(TOKEN or "")
app = FastAPI(title="mcp-github-bridge", version="0.1.0")


@app.on_event("startup")
async def startup_event() -> None:
    if not TOKEN:
        logger.error("GITHUB_PERSONAL_TOKEN missing; github bridge cannot start")
        return
    await bridge.start()


@app.on_event("shutdown")
async def shutdown_event() -> None:
    await bridge.stop()


@app.get("/health", response_model=BridgeStatus)
async def health() -> BridgeStatus:
    if not TOKEN:
        return BridgeStatus(status="error", detail="GITHUB_PERSONAL_TOKEN not configured")
    if not bridge.is_running:
        return BridgeStatus(status="error", detail="bridge process not running")
    return BridgeStatus(status="ok")


@app.get("/.well-known/mcp.json")
async def manifest() -> Dict[str, Any]:
    return bridge.manifest()


@app.post("/invoke")
async def invoke(request: InvokeRequest) -> Dict[str, Any]:
    if not TOKEN:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "GITHUB_PERSONAL_TOKEN not configured")
    result = await bridge.invoke_tool(request.tool, request.arguments)
    return result
