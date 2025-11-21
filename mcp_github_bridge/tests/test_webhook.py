from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import unittest

from mcp_github_bridge import main as bridge_main


class SignatureValidationTests(unittest.TestCase):
    def test_signature_valid(self) -> None:
        secret = "topsecret"
        body = b"{\"event\":\"push\"}"
        digest = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
        header = f"sha256={digest}"
        self.assertTrue(bridge_main._signature_valid(secret, body, header))

    def test_signature_invalid_when_mismatch(self) -> None:
        secret = "topsecret"
        body = b"something"
        header = "sha256=deadbeef"
        self.assertFalse(bridge_main._signature_valid(secret, body, header))

    def test_signature_invalid_when_missing_prefix(self) -> None:
        secret = "topsecret"
        body = b"{}"
        header = "md5=deadbeef"
        self.assertFalse(bridge_main._signature_valid(secret, body, header))


class ToolResolutionTests(unittest.TestCase):
    def test_resolve_tool_prefers_event_specific_mapping(self) -> None:
        original_map = bridge_main.WEBHOOK_TOOL_MAP.copy()
        bridge_main.WEBHOOK_TOOL_MAP["push"] = "custom_tool"
        try:
            self.assertEqual(bridge_main._resolve_tool("push"), "custom_tool")
        finally:
            bridge_main.WEBHOOK_TOOL_MAP = original_map

    def test_resolve_tool_falls_back_to_default(self) -> None:
        original_map = bridge_main.WEBHOOK_TOOL_MAP
        original_default = bridge_main.WEBHOOK_DEFAULT_TOOL
        bridge_main.WEBHOOK_TOOL_MAP = {}
        bridge_main.WEBHOOK_DEFAULT_TOOL = "run_space"
        try:
            self.assertEqual(bridge_main._resolve_tool("unknown"), "run_space")
        finally:
            bridge_main.WEBHOOK_TOOL_MAP = original_map
            bridge_main.WEBHOOK_DEFAULT_TOOL = original_default


class DispatchWebhookTests(unittest.IsolatedAsyncioTestCase):
    async def test_dispatch_invokes_bridge_tool(self) -> None:
        class DummyBridge:
            def __init__(self) -> None:
                self.invocations: list[tuple[str, dict]] = []
                self.running = True

            @property
            def is_running(self) -> bool:
                return self.running

            async def invoke_tool(self, tool: str, args: dict) -> dict:
                self.invocations.append((tool, args))
                return {"status": "ok"}

        dummy = DummyBridge()
        original_bridge = bridge_main.bridge
        original_map = bridge_main.WEBHOOK_TOOL_MAP
        bridge_main.bridge = dummy
        bridge_main.WEBHOOK_TOOL_MAP = {"push": "run_space"}
        try:
            payload = {"action": "synchronize", "repository": {"full_name": "tonezzz/voice_chat"}}
            await bridge_main._dispatch_webhook_event("push", "abc-123", payload)
            self.assertEqual(len(dummy.invocations), 1)
            tool, args = dummy.invocations[0]
            self.assertEqual(tool, "run_space")
            self.assertEqual(args["event"], "push")
            self.assertEqual(args["delivery"], "abc-123")
            self.assertEqual(args["repository"], "tonezzz/voice_chat")
            self.assertEqual(args["payload"], payload)
        finally:
            bridge_main.bridge = original_bridge
            bridge_main.WEBHOOK_TOOL_MAP = original_map

    async def test_dispatch_noop_when_bridge_not_running(self) -> None:
        class StoppedBridge:
            def __init__(self) -> None:
                self.invocations: list[tuple[str, dict]] = []

            @property
            def is_running(self) -> bool:
                return False

            async def invoke_tool(self, tool: str, args: dict) -> dict:
                raise RuntimeError("should not run")

        stopped = StoppedBridge()
        original_bridge = bridge_main.bridge
        bridge_main.bridge = stopped
        try:
            await bridge_main._dispatch_webhook_event("push", "delivery", {})
            self.assertEqual(len(stopped.invocations), 0)
        finally:
            bridge_main.bridge = original_bridge
