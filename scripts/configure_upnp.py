#!/usr/bin/env python3
"""Simple helper for forwarding ports to the KK1 container via UPnP."""

from __future__ import annotations

import argparse
import socket
import sys
from typing import Iterable

import miniupnpc


def get_lan_ip() -> str:
    """Return the LAN IP for this host using a UDP socket trick."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
        except OSError:
            return socket.gethostbyname(socket.gethostname())


def configure_ports(ports: Iterable[int], local_ip: str, local_port: int, description: str, remove: bool) -> None:
    upnp = miniupnpc.UPnP()
    upnp.discoverdelay = 200
    discovered = upnp.discover()
    if discovered == 0:
        raise RuntimeError("No UPnP-enabled gateway discovered. Ensure UPnP is enabled on the router.")

    upnp.selectigd()

    for external_port in ports:
        if remove:
            try:
                upnp.deleteportmapping(external_port, "TCP")
                print(f"Removed mapping TCP {external_port} -> {local_ip}:{local_port}")
            except Exception as exc:  # noqa: BLE001
                print(f"Failed to remove mapping on port {external_port}: {exc}")
            continue

        # Remove any existing mapping to avoid conflicts
        try:
            upnp.deleteportmapping(external_port, "TCP")
        except Exception:
            pass

        if upnp.addportmapping(external_port, "TCP", local_ip, local_port, description, ""):
            print(f"Forwarded TCP {external_port} -> {local_ip}:{local_port}")
        else:
            raise RuntimeError(f"Router rejected mapping for port {external_port}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Configure UPnP port forwards for KK1")
    parser.add_argument("--local-port", type=int, default=4173, help="Port the KK1 container listens on (default: 4173)")
    parser.add_argument("--external-ports", type=int, nargs="+", default=[80, 443], help="External ports to forward (default: 80 443)")
    parser.add_argument("--description", default="KK1 reverse proxy", help="Description shown in the router UI")
    parser.add_argument("--local-ip", default=None, help="Override LAN IP (auto-detected by default)")
    parser.add_argument("--remove", action="store_true", help="Remove the mappings instead of adding them")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    local_ip = args.local_ip or get_lan_ip()
    try:
        configure_ports(args.external_ports, local_ip, args.local_port, args.description, args.remove)
    except Exception as exc:  # noqa: BLE001
        print(f"Error: {exc}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
