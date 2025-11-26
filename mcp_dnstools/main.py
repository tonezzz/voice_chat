from __future__ import annotations

import asyncio
import ipaddress
import logging
import os
import re
from typing import Any, Dict, List, Optional, Tuple

import dns.exception
import dns.rdataclass
import dns.rdata
import dns.rdatatype
import dns.resolver
import dns.reversename
import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

APP_NAME = "mcp-dnstools"
APP_VERSION = "0.1.0"

logging.basicConfig(level=os.getenv("DNSTOOLS_LOG_LEVEL", "INFO"))
LOGGER = logging.getLogger(APP_NAME)


def _bool(value: Optional[str], *, default: bool) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _rdap_url(domain: str) -> str:
    suffix = domain.rsplit(".", 1)[-1].lower() if "." in domain else domain.lower()
    template = RDAP_TLD_ENDPOINTS.get(suffix, RDAP_ENDPOINT_TEMPLATE)
    if not template:
        raise HTTPException(status_code=503, detail="rdap_unconfigured")
    return template.format(domain=domain.upper())


def _rdap_entity_name(entity: Dict[str, Any]) -> Optional[str]:
    vcard = entity.get("vcardArray") if isinstance(entity, dict) else None
    if not isinstance(vcard, list) or len(vcard) < 2:
        return entity.get("handle") if isinstance(entity, dict) else None
    for item in vcard[1]:
        if isinstance(item, list) and len(item) >= 4 and item[0] == "fn":
            return item[3]
    return entity.get("handle") if isinstance(entity, dict) else None


def _rdap_events(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    events = []
    for entry in payload.get("events", []) or []:
        action = entry.get("eventAction")
        date = entry.get("eventDate")
        if action and date:
            events.append({"action": action, "date": date})
    return events


def _split_csv(value: Optional[str]) -> List[str]:
    if not value:
        return []
    return [item.strip() for item in value.split(",") if item.strip()]


DEFAULT_NAMESERVERS = _split_csv(os.getenv("DNSTOOLS_NAMESERVERS", "1.1.1.1,8.8.8.8"))
RESOLVER_TIMEOUT = float(os.getenv("DNSTOOLS_TIMEOUT_SECONDS", "5"))
DOH_ENDPOINT = os.getenv("DNSTOOLS_DOH_ENDPOINT", "https://dns.google/resolve").strip()
DOH_TIMEOUT = float(os.getenv("DNSTOOLS_DOH_TIMEOUT_SECONDS", "5"))
DOH_ENABLED = _bool(os.getenv("DNSTOOLS_ENABLE_DOH", "true"), default=True)
SUMMARY_RECORD_TYPES = [rtype.upper() for rtype in _split_csv(os.getenv("DNSTOOLS_SUMMARY_TYPES", "A,AAAA,CNAME,MX,TXT,NS,SOA"))]
if not SUMMARY_RECORD_TYPES:
    SUMMARY_RECORD_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SOA"]
HEALTH_DOMAIN = os.getenv("DNSTOOLS_HEALTH_DOMAIN", "example.com").strip() or "example.com"
PROVIDER_NAME = os.getenv("DNSTOOLS_PROVIDER_NAME", "dnstools")
RDAP_ENDPOINT_TEMPLATE = (os.getenv("DNSTOOLS_RDAP_ENDPOINT") or "https://rdap.org/domain/{domain}").strip()
RDAP_TIMEOUT = float(os.getenv("DNSTOOLS_RDAP_TIMEOUT_SECONDS", "8"))
RDAP_TLD_ENDPOINTS = {
    "com": "https://rdap.verisign.com/com/v1/domain/{domain}",
    "net": "https://rdap.verisign.com/net/v1/domain/{domain}",
    "org": "https://rdap.publicinterestregistry.net/rdap/org/domain/{domain}",
}

DOMAIN_RE = re.compile(
    r"^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$"
)
SUPPORTED_RECORD_TYPES = {
    "A",
    "AAAA",
    "CAA",
    "CNAME",
    "MX",
    "NS",
    "PTR",
    "SOA",
    "SRV",
    "TXT",
}


class InvokeRequest(BaseModel):
    tool: str = Field(..., description="Tool name exposed via MCP")
    arguments: Dict[str, Any] = Field(default_factory=dict)


class HealthResponse(BaseModel):
    status: str
    detail: Optional[str] = None


def _validate_domain(value: Any) -> str:
    if not isinstance(value, str):
        raise HTTPException(status_code=400, detail="domain must be a string")
    cleaned = value.strip().rstrip(".")
    if not cleaned:
        raise HTTPException(status_code=400, detail="domain is required")
    if len(cleaned) > 253:
        raise HTTPException(status_code=400, detail="domain is too long")
    if cleaned.count(".") == 0:
        raise HTTPException(status_code=400, detail="domain must contain at least one dot")
    if not DOMAIN_RE.match(cleaned):
        raise HTTPException(status_code=400, detail="domain contains invalid characters")
    return cleaned


def _strip_trailing_dot(value: str) -> str:
    return value[:-1] if value.endswith(".") else value


def _parse_nameservers(value: Any) -> List[str]:
    if value is None:
        return []
    if isinstance(value, list):
        result = [str(item).strip() for item in value if str(item).strip()]
    elif isinstance(value, str):
        result = _split_csv(value)
    else:
        raise HTTPException(status_code=400, detail="nameservers must be an array or comma-delimited string")
    return result


def _serialize_txt(rdata: Any) -> Dict[str, Any]:
    chunks = []
    for chunk in getattr(rdata, "strings", []):
        try:
            chunks.append(chunk.decode("utf-8"))
        except Exception:  # noqa: BLE001
            chunks.append(chunk.decode("utf-8", errors="replace"))
    value = "".join(chunks) if chunks else str(rdata)
    return {"value": value, "chunks": chunks}


def _serialize_soa(rdata: Any) -> Dict[str, Any]:
    payload = {
        "mname": _strip_trailing_dot(rdata.mname.to_text()),
        "rname": _strip_trailing_dot(rdata.rname.to_text()),
        "serial": int(getattr(rdata, "serial", 0)),
        "refresh": int(getattr(rdata, "refresh", 0)),
        "retry": int(getattr(rdata, "retry", 0)),
        "expire": int(getattr(rdata, "expire", 0)),
        "minimum": int(getattr(rdata, "minimum", 0)),
    }
    payload["value"] = f"{payload['mname']} contact:{payload['rname']}"
    return payload


def _serialize_rdata(record_type: str, rdata: Any, ttl: Optional[int], source: str) -> Dict[str, Any]:
    record: Dict[str, Any] = {"type": record_type, "source": source}
    if ttl is not None:
        record["ttl"] = int(ttl)

    if record_type in {"A", "AAAA"}:
        record["value"] = getattr(rdata, "address", str(rdata))
    elif record_type == "MX":
        exchange = _strip_trailing_dot(rdata.exchange.to_text()) if hasattr(rdata, "exchange") else str(rdata)
        record.update({
            "value": exchange,
            "exchange": exchange,
            "preference": int(getattr(rdata, "preference", 0)),
        })
    elif record_type == "TXT":
        record.update(_serialize_txt(rdata))
    elif record_type in {"NS", "CNAME", "PTR"}:
        target = getattr(rdata, "target", None) or getattr(rdata, "name", None)
        record["value"] = _strip_trailing_dot(target.to_text()) if target else _strip_trailing_dot(str(rdata))
    elif record_type == "SOA":
        record.update(_serialize_soa(rdata))
    elif record_type == "SRV":
        record.update(
            {
                "priority": int(getattr(rdata, "priority", 0)),
                "weight": int(getattr(rdata, "weight", 0)),
                "port": int(getattr(rdata, "port", 0)),
                "target": _strip_trailing_dot(rdata.target.to_text()),
            }
        )
        record["value"] = record["target"]
    elif record_type == "CAA":
        record.update(
            {
                "flags": int(getattr(rdata, "flags", 0)),
                "tag": getattr(rdata, "tag", ""),
                "value": getattr(rdata, "value", ""),
            }
        )
    else:
        record["value"] = str(rdata)

    return record


def _build_resolver(nameserver_override: List[str]) -> dns.resolver.Resolver:
    resolver = dns.resolver.Resolver(configure=True)
    servers = nameserver_override or DEFAULT_NAMESERVERS
    if servers:
        resolver.nameservers = servers
    resolver.lifetime = RESOLVER_TIMEOUT
    resolver.timeout = RESOLVER_TIMEOUT
    return resolver


def _query_with_resolver(domain: str, record_type: str, nameservers: List[str]) -> List[Dict[str, Any]]:
    resolver = _build_resolver(nameservers)
    answers = resolver.resolve(domain, record_type, raise_on_no_answer=False)
    ttl = answers.rrset.ttl if answers.rrset else None
    return [_serialize_rdata(record_type, rdata, ttl, "resolver") for rdata in answers]


async def _query_with_doh(domain: str, record_type: str) -> List[Dict[str, Any]]:
    if not DOH_ENDPOINT:
        return []
    params = {"name": domain, "type": record_type}
    async with httpx.AsyncClient(timeout=DOH_TIMEOUT) as client:
        response = await client.get(DOH_ENDPOINT, params=params)
        response.raise_for_status()
        payload = response.json()
    answers = payload.get("Answer") or []
    records: List[Dict[str, Any]] = []
    for answer in answers:
        data = answer.get("data")
        if not data:
            continue
        try:
            rdtype = dns.rdatatype.from_text(record_type)
            rdata = dns.rdata.from_text(dns.rdataclass.IN, rdtype, data)
        except Exception as exc:  # noqa: BLE001
            LOGGER.debug("Failed to parse DoH answer for %s %s: %s", domain, record_type, exc)
            continue
        ttl = answer.get("TTL")
        records.append(_serialize_rdata(record_type, rdata, ttl, "doh"))
    return records


async def _fetch_records(domain: str, record_type: str, nameservers: List[str]) -> Tuple[List[Dict[str, Any]], List[str]]:
    warnings: List[str] = []
    records: List[Dict[str, Any]] = []
    try:
        records.extend(_query_with_resolver(domain, record_type, nameservers))
    except dns.exception.DNSException as exc:
        warnings.append(f"resolver:{exc}")
    if not records and DOH_ENABLED:
        try:
            records.extend(await _query_with_doh(domain, record_type))
        except httpx.HTTPError as exc:
            warnings.append(f"doh:{exc}")
    return records, warnings


async def _fetch_rdap(domain: str) -> Tuple[Dict[str, Any], str]:
    url = _rdap_url(domain)
    try:
        async with httpx.AsyncClient(timeout=RDAP_TIMEOUT) as client:
            response = await client.get(url, headers={"Accept": "application/rdap+json, application/json"})
    except httpx.RequestError as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"rdap_unreachable:{exc}") from exc
    if response.status_code >= 400:
        raise HTTPException(status_code=404, detail="rdap_not_found")
    try:
        payload: Dict[str, Any] = response.json()
    except ValueError as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail="rdap_invalid_json") from exc
    return payload, url


def _require_record_type(value: Any) -> str:
    if value is None:
        return "A"
    if not isinstance(value, str):
        raise HTTPException(status_code=400, detail="record_type must be a string")
    record_type = value.strip().upper()
    if record_type not in SUPPORTED_RECORD_TYPES:
        raise HTTPException(status_code=400, detail=f"Unsupported record_type '{record_type}'")
    return record_type


def _require_ip(value: Any) -> str:
    if not isinstance(value, str):
        raise HTTPException(status_code=400, detail="ip must be a string")
    candidate = value.strip()
    if not candidate:
        raise HTTPException(status_code=400, detail="ip is required")
    try:
        ipaddress.ip_address(candidate)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="invalid_ip") from exc
    return candidate


async def tool_lookup_record(arguments: Dict[str, Any]) -> Dict[str, Any]:
    domain = _validate_domain(arguments.get("domain"))
    record_type = _require_record_type(arguments.get("record_type"))
    nameservers = _parse_nameservers(arguments.get("nameservers"))
    records, warnings = await _fetch_records(domain, record_type, nameservers)
    if not records:
        raise HTTPException(status_code=404, detail={"error": "record_not_found", "warnings": warnings})
    return {
        "domain": domain,
        "record_type": record_type,
        "records": records,
        "warnings": warnings,
    }


async def tool_dns_summary(arguments: Dict[str, Any]) -> Dict[str, Any]:
    domain = _validate_domain(arguments.get("domain"))
    record_types_arg = arguments.get("record_types")
    if record_types_arg is None:
        record_types = SUMMARY_RECORD_TYPES
    elif isinstance(record_types_arg, list):
        record_types = [_require_record_type(item) for item in record_types_arg]
    else:
        raise HTTPException(status_code=400, detail="record_types must be an array of strings")
    nameservers = _parse_nameservers(arguments.get("nameservers"))

    summary: Dict[str, Any] = {}
    for record_type in record_types:
        records, warnings = await _fetch_records(domain, record_type, nameservers)
        summary[record_type] = {
            "records": records,
            "warnings": warnings,
            "status": "ok" if records else "empty",
        }
    return {"domain": domain, "summary": summary}


async def tool_mx_health(arguments: Dict[str, Any]) -> Dict[str, Any]:
    domain = _validate_domain(arguments.get("domain"))
    nameservers = _parse_nameservers(arguments.get("nameservers"))
    mx_records, mx_warnings = await _fetch_records(domain, "MX", nameservers)
    if not mx_records:
        raise HTTPException(status_code=404, detail={"error": "mx_not_found", "warnings": mx_warnings})

    hosts: List[Dict[str, Any]] = []
    for record in mx_records:
        host = record.get("exchange") or record.get("value")
        ipv4, warn_v4 = await _fetch_records(host, "A", nameservers)
        ipv6, warn_v6 = await _fetch_records(host, "AAAA", nameservers)
        hosts.append(
            {
                "host": host,
                "preference": record.get("preference"),
                "ipv4": [entry["value"] for entry in ipv4],
                "ipv6": [entry["value"] for entry in ipv6],
                "warnings": warn_v4 + warn_v6,
            }
        )

    return {"domain": domain, "mx": hosts, "warnings": mx_warnings}


async def tool_spf_inspect(arguments: Dict[str, Any]) -> Dict[str, Any]:
    domain = _validate_domain(arguments.get("domain"))
    nameservers = _parse_nameservers(arguments.get("nameservers"))
    txt_records, warnings = await _fetch_records(domain, "TXT", nameservers)
    spf_entries: List[Dict[str, Any]] = []
    for record in txt_records:
        value = record.get("value", "").lower()
        if not value.startswith("v=spf1"):
            continue
        tokens = record.get("value", "").split()
        includes = [token.split(":", 1)[1] for token in tokens if token.startswith("include:")]
        ip4 = [token.split(":", 1)[1] for token in tokens if token.startswith("ip4:")]
        ip6 = [token.split(":", 1)[1] for token in tokens if token.startswith("ip6:")]
        all_mechanism = next((token for token in tokens if token.endswith("all")), None)
        spf_entries.append(
            {
                "raw": record.get("value"),
                "includes": includes,
                "ip4": ip4,
                "ip6": ip6,
                "all": all_mechanism,
            }
        )
    if not spf_entries:
        raise HTTPException(status_code=404, detail={"error": "spf_not_found", "warnings": warnings})
    return {"domain": domain, "records": spf_entries, "warnings": warnings}


async def tool_reverse_lookup(arguments: Dict[str, Any]) -> Dict[str, Any]:
    ip_value = _require_ip(arguments.get("ip"))
    nameservers = _parse_nameservers(arguments.get("nameservers"))
    pointer = dns.reversename.from_address(ip_value).to_text()
    records, warnings = await _fetch_records(pointer.rstrip("."), "PTR", nameservers)
    if not records:
        raise HTTPException(status_code=404, detail={"error": "ptr_not_found", "warnings": warnings})
    return {
        "ip": ip_value,
        "ptr_name": pointer,
        "records": records,
        "warnings": warnings,
    }


async def tool_dnssec_status(arguments: Dict[str, Any]) -> Dict[str, Any]:
    domain = _validate_domain(arguments.get("domain"))
    nameservers = _parse_nameservers(arguments.get("nameservers"))
    records, warnings = await _fetch_records(domain, "DS", nameservers)
    return {
        "domain": domain,
        "dnssec_enabled": bool(records),
        "records": records,
        "warnings": warnings,
    }


async def tool_ns_health(arguments: Dict[str, Any]) -> Dict[str, Any]:
    domain = _validate_domain(arguments.get("domain"))
    nameservers = _parse_nameservers(arguments.get("nameservers"))
    ns_records, warnings = await _fetch_records(domain, "NS", nameservers)
    if not ns_records:
        raise HTTPException(status_code=404, detail={"error": "ns_not_found", "warnings": warnings})
    hosts: List[Dict[str, Any]] = []
    for record in ns_records:
        host = record.get("value")
        ipv4, warn_v4 = await _fetch_records(host, "A", nameservers)
        ipv6, warn_v6 = await _fetch_records(host, "AAAA", nameservers)
        hosts.append(
            {
                "host": host,
                "ipv4": [entry.get("value") for entry in ipv4],
                "ipv6": [entry.get("value") for entry in ipv6],
                "warnings": warn_v4 + warn_v6,
            }
        )
    return {
        "domain": domain,
        "nameservers": hosts,
        "warnings": warnings,
    }


async def tool_registrar_lookup(arguments: Dict[str, Any]) -> Dict[str, Any]:
    domain = _validate_domain(arguments.get("domain"))
    payload, url = await _fetch_rdap(domain)
    registrars: List[Dict[str, Any]] = []
    for entity in payload.get("entities", []) or []:
        roles = [role.lower() for role in (entity.get("roles") or [])]
        if "registrar" in roles:
            registrars.append(
                {
                    "handle": entity.get("handle"),
                    "name": _rdap_entity_name(entity),
                    "roles": roles,
                }
            )
    return {
        "domain": domain,
        "rdap_url": url,
        "registrars": registrars,
        "statuses": payload.get("status", []),
        "events": _rdap_events(payload),
    }


tool_registry = {
    "lookup_record": tool_lookup_record,
    "dns_summary": tool_dns_summary,
    "mx_health": tool_mx_health,
    "spf_inspect": tool_spf_inspect,
    "reverse_lookup": tool_reverse_lookup,
    "dnssec_status": tool_dnssec_status,
    "ns_health": tool_ns_health,
    "registrar_lookup": tool_registrar_lookup,
}


tool_schemas: Dict[str, Dict[str, Any]] = {
    "lookup_record": {
        "name": "lookup_record",
        "description": "Perform a DNS lookup for a single record type using configurable nameservers.",
        "input_schema": {
            "type": "object",
            "required": ["domain"],
            "properties": {
                "domain": {"type": "string"},
                "record_type": {"type": "string", "enum": sorted(list(SUPPORTED_RECORD_TYPES))},
                "nameservers": {
                    "anyOf": [
                        {"type": "array", "items": {"type": "string"}},
                        {"type": "string"},
                    ]
                },
            },
        },
    },
    "dns_summary": {
        "name": "dns_summary",
        "description": "Collect a multi-record snapshot similar to MXToolbox SuperTool.",
        "input_schema": {
            "type": "object",
            "required": ["domain"],
            "properties": {
                "domain": {"type": "string"},
                "record_types": {"type": "array", "items": {"type": "string"}},
                "nameservers": {
                    "anyOf": [
                        {"type": "array", "items": {"type": "string"}},
                        {"type": "string"},
                    ]
                },
            },
        },
    },
    "mx_health": {
        "name": "mx_health",
        "description": "Inspect MX hosts and ensure they have reachable A/AAAA glue.",
        "input_schema": {
            "type": "object",
            "required": ["domain"],
            "properties": {
                "domain": {"type": "string"},
                "nameservers": {
                    "anyOf": [
                        {"type": "array", "items": {"type": "string"}},
                        {"type": "string"},
                    ]
                },
            },
        },
    },
    "spf_inspect": {
        "name": "spf_inspect",
        "description": "Parse SPF TXT records and highlight include/ip mechanisms.",
        "input_schema": {
            "type": "object",
            "required": ["domain"],
            "properties": {
                "domain": {"type": "string"},
                "nameservers": {
                    "anyOf": [
                        {"type": "array", "items": {"type": "string"}},
                        {"type": "string"},
                    ]
                },
            },
        },
    },
    "reverse_lookup": {
        "name": "reverse_lookup",
        "description": "Perform PTR lookup for an IPv4/IPv6 address.",
        "input_schema": {
            "type": "object",
            "required": ["ip"],
            "properties": {
                "ip": {"type": "string"},
                "nameservers": {
                    "anyOf": [
                        {"type": "array", "items": {"type": "string"}},
                        {"type": "string"},
                    ]
                },
            },
        },
    },
    "dnssec_status": {
        "name": "dnssec_status",
        "description": "Check whether DS records are published for a domain.",
        "input_schema": {
            "type": "object",
            "required": ["domain"],
            "properties": {
                "domain": {"type": "string"},
                "nameservers": {
                    "anyOf": [
                        {"type": "array", "items": {"type": "string"}},
                        {"type": "string"},
                    ]
                },
            },
        },
    },
    "ns_health": {
        "name": "ns_health",
        "description": "Resolve NS hosts and report their glue IPs.",
        "input_schema": {
            "type": "object",
            "required": ["domain"],
            "properties": {
                "domain": {"type": "string"},
                "nameservers": {
                    "anyOf": [
                        {"type": "array", "items": {"type": "string"}},
                        {"type": "string"},
                    ]
                },
            },
        },
    },
    "registrar_lookup": {
        "name": "registrar_lookup",
        "description": "Fetch registrar + status metadata via RDAP.",
        "input_schema": {
            "type": "object",
            "required": ["domain"],
            "properties": {
                "domain": {"type": "string"},
            },
        },
    },
}


app = FastAPI(title=APP_NAME, version=APP_VERSION)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    try:
        records, warnings = await _fetch_records(HEALTH_DOMAIN, "A", [])
    except Exception as exc:  # noqa: BLE001
        LOGGER.error("Health check failed: %s", exc)
        return HealthResponse(status="error", detail=str(exc))
    if not records:
        detail = ",".join(warnings) if warnings else "no A record"
        return HealthResponse(status="degraded", detail=detail or "No records returned")
    return HealthResponse(status="ok")


@app.post("/invoke")
async def invoke(request: InvokeRequest) -> Any:  # noqa: ANN401
    handler = tool_registry.get(request.tool)
    if not handler:
        raise HTTPException(status_code=404, detail=f"Unknown tool '{request.tool}'")
    return await handler(request.arguments)


@app.get("/.well-known/mcp.json")
async def manifest() -> Dict[str, Any]:
    return {
        "name": PROVIDER_NAME,
        "version": APP_VERSION,
        "description": "DNS toolbox MCP service (lookups, MX health, SPF reports).",
        "capabilities": {
            "tools": list(tool_schemas.values()),
        },
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host=os.getenv("MCP_HOST", "0.0.0.0"), port=int(os.getenv("PORT", "8018")))
