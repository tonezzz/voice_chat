from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import shlex
import sys
from typing import Any, Dict, Optional

from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, status
from pydantic import BaseModel, Field

logger = logging.getLogger("mcp_vms_bridge")
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))

BRIDGE_PROTOCOL_VERSION = "2024-11-05"
DEFAULT_BRIDGE_NAME = "mcp-vms-bridge"
DEFAULT_BRIDGE_VERSION = "0.1.0"
DEFAULT_PORT = int(os.environ.get("PORT", "8006"))


class BridgeStatus(BaseModel):
    status: str
    detail: Optional[str] = None


class InvokeRequest(BaseModel):
    tool: str = Field(..., description="Tool exposed by mcp_vms.py")
    arguments: Dict[str, Any] = Field(default_factory=dict)


def _split_args(raw: Optional[str]) -> list[str]:
    if not raw:
        return []
    return shlex.split(raw, posix=False if os.name == "nt" else True)


def _resolve_command_and_args() -> tuple[str, list[str]]:
    command = os.environ.get("VMS_COMMAND")
    args = _split_args(os.environ.get("VMS_ARGS"))
    if command:
        return command, args
    script = os.environ.get("VMS_SCRIPT", "upstream/mcp_vms.py")
    return sys.executable, [script]


class McpProcessBridge:
    def __init__(self, command: str, args: Optional[list[str]] = None, env_overrides: Optional[Dict[str, str]] = None):
        self._command = command
        self._args = args or []
        self._env = os.environ.copy()
        if env_overrides:
            self._env.update(env_overrides)
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

        logger.info("Starting MCP process via %s %s", self._command, " ".join(self._args))
        self._proc = await asyncio.create_subprocess_exec(
            self._command,
            *self._args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=self._env,
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
        logger.info("Stopping MCP process")
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
        response = await self._request("tools.invoke", params)
        return response

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
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "vms bridge is not running")

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
            logger.info("mcp stderr: %s", data.decode().rstrip())

    @property
    def is_running(self) -> bool:
        return self._proc is not None and self._proc.returncode is None

    def manifest(self) -> Dict[str, Any]:
        return {
            "name": DEFAULT_BRIDGE_NAME,
            "version": DEFAULT_BRIDGE_VERSION,
            "description": "HTTP bridge exposing the jyjune/mcp_vms MCP server",
            "capabilities": self._capabilities.get("capabilities", {}),
        }


def _build_vms_env() -> Dict[str, str]:
    env = {}
    # Pass through every VMS_* variable along with PATH/PYTHONPATH customizations.
    for key, value in os.environ.items():
        if key.startswith("VMS_"):
            env[key] = value
    python_path = os.environ.get("PYTHONPATH")
    if python_path:
        env["PYTHONPATH"] = python_path
    return env


command, args = _resolve_command_and_args()
bridge = McpProcessBridge(command=command, args=args, env_overrides=_build_vms_env())


@asynccontextmanager
async def lifespan(_: FastAPI):
    await bridge.start()
    try:
        yield
    finally:
        await bridge.stop()


app = FastAPI(title=DEFAULT_BRIDGE_NAME, version=DEFAULT_BRIDGE_VERSION, lifespan=lifespan)


@app.get("/health", response_model=BridgeStatus)
async def health() -> BridgeStatus:
    status_value = "ok" if bridge.is_running else "error"
    detail = f"cmd={command} args={' '.join(args)}"
    return BridgeStatus(status=status_value, detail=detail)


@app.get("/.well-known/mcp.json")
async def manifest() -> Dict[str, Any]:
    return bridge.manifest()


@app.post("/invoke")
async def invoke(request: InvokeRequest) -> Dict[str, Any]:
    result = await bridge.invoke_tool(request.tool, request.arguments)
    return result


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("VMS_BRIDGE_HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", str(DEFAULT_PORT)))
    uvicorn.run("main:app", host=host, port=port, reload=False)
