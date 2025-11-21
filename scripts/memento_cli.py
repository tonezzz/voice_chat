#!/usr/bin/env python3
"""Lightweight helper to talk to the mcp-memento HTTP bridge using plain language."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import textwrap
import urllib.error
import urllib.request
from typing import Any, Dict, Optional, Tuple


DEFAULT_ENDPOINT = os.environ.get("MEMENTO_MCP_URL", "http://localhost:8005")
JSON_RPC_PATH = "/invoke"


class CommandError(Exception):
    """Raised when we cannot infer a tool/argument pair from the user's command."""


def _strip(text: str) -> str:
    return text.strip().strip('"').strip("'")


def _split_first(text: str, *separators: str) -> Optional[Tuple[str, str]]:
    for sep in separators:
        if sep in text:
            left, right = text.split(sep, 1)
            return _strip(left), _strip(right)
    return None


def interpret_command(command: str) -> Tuple[str, Dict[str, Any]]:
    lowered = command.lower().strip()

    if lowered.startswith("remember "):
        payload = command[len("remember "):].strip()
        parts = _split_first(payload, ":", " - ", " that ")
        if not parts:
            raise CommandError("Use 'remember <entity>: <note>'.")
        entity, note = parts
        if not entity or not note:
            raise CommandError("Both entity and note are required for remember commands.")
        return (
            "add_observations",
            {"observations": [{"entityName": entity, "contents": [note]}]},
        )

    if lowered.startswith("create entity"):
        pattern = r"create entity\s+(?P<name>.+?)\s+type\s+(?P<etype>\S+)(?:\s+note\s+(?P<note>.+))?"
        match = re.match(pattern, lowered)
        if not match:
            raise CommandError("Try 'create entity <name> type <type> note <optional note>'.")
        name_section = command[len("create entity"):].strip()
        name_part = name_section.split(" type ", 1)[0].strip()
        entity_name = _strip(name_part)
        entity_type = _strip(match.group("etype"))
        note = match.group("note")
        entity = {"name": entity_name, "entityType": entity_type}
        if note:
            entity["observations"] = [note.strip()]
        return ("create_entities", {"entities": [entity]})

    if lowered.startswith("relate ") or lowered.startswith("link "):
        pattern = r"(?:relate|link)\s+(?P<source>.+?)\s+to\s+(?P<target>.+?)\s+as\s+(?P<rtype>\S+)"
        match = re.match(pattern, lowered)
        if not match:
            raise CommandError("Try 'relate <from> to <to> as <relationType>'.")
        return (
            "create_relations",
            {
                "relations": [
                    {
                        "from": match.group("source").strip(),
                        "to": match.group("target").strip(),
                        "relationType": match.group("rtype").strip(),
                    }
                ]
            },
        )

    if lowered.startswith("search "):
        query = command[len("search "):].strip()
        if not query:
            raise CommandError("Provide a search query, e.g. 'search quarterly goals'.")
        return ("search_nodes", {"query": query, "topK": 8})

    if lowered.startswith("show ") or lowered.startswith("open "):
        parts = command.split(" ", 1)
        name = parts[1].strip() if len(parts) > 1 else ""
        if not name:
            raise CommandError("Usage: show <entity name>.")
        return ("open_nodes", {"names": [name]})

    if "read graph" in lowered or lowered == "graph":
        return ("read_graph", {})

    if lowered.startswith("set importance"):
        tokens = command.split()
        if len(tokens) < 4:
            raise CommandError("Usage: set importance <entity> <level>.")
        entity = tokens[2]
        level = tokens[3]
        return ("set_importance", {"entityName": entity, "importance": level})

    raise CommandError(
        "Could not infer intent. Try commands like 'remember Alice: prefers chai' or 'search onboarding checklist'."
    )


def invoke_tool(endpoint: str, tool: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
    payload = {
        "tool": tool,
        "arguments": arguments,
    }
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url=endpoint.rstrip("/") + JSON_RPC_PATH,
        data=data,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            body = response.read().decode("utf-8")
            return json.loads(body)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {detail}") from exc


def pretty_print(result: Dict[str, Any]) -> None:
    print(json.dumps(result, indent=2, ensure_ascii=False))


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Speak to mcp-memento with natural phrases.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent(
            """
            Examples:
              python scripts/memento_cli.py "remember Tony: loves espresso"
              python scripts/memento_cli.py "create entity Project Phoenix type initiative note kickoff Q1"
              python scripts/memento_cli.py "relate Tony to Project Phoenix as contributor"
              python scripts/memento_cli.py "search onboarding plan"
            """
        ),
    )
    parser.add_argument("command", help="Natural-language instruction (quoted)")
    parser.add_argument(
        "--endpoint",
        default=DEFAULT_ENDPOINT,
        help=f"Base URL for mcp-memento (default: {DEFAULT_ENDPOINT})",
    )
    parser.add_argument("--tool", help="Explicit tool name (overrides natural-language parser)")
    parser.add_argument("--arguments", help="JSON arguments when --tool is supplied")

    args = parser.parse_args(argv)

    if args.tool:
        if not args.arguments:
            parser.error("--arguments is required when --tool is provided")
        try:
            arguments = json.loads(args.arguments)
        except json.JSONDecodeError as exc:
            raise SystemExit(f"Invalid JSON for --arguments: {exc}") from exc
        tool = args.tool
    else:
        tool, arguments = interpret_command(args.command)

    try:
        response = invoke_tool(args.endpoint, tool, arguments)
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    pretty_print(response)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
