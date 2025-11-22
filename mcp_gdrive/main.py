from __future__ import annotations

import base64
import io
import os
from functools import lru_cache
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaIoBaseDownload, MediaIoBaseUpload
from pydantic import BaseModel, Field

APP_NAME = "mcp-gdrive"
APP_VERSION = "0.1.0"
DEFAULT_SCOPES = ["https://www.googleapis.com/auth/drive"]
DEFAULT_EXPORT_MIME = "application/pdf"


class InvokeRequest(BaseModel):
    tool: str = Field(..., description="Tool name exposed via MCP")
    arguments: Dict[str, Any] = Field(default_factory=dict)


class GDriveHealth(BaseModel):
    status: str
    detail: Optional[Dict[str, Any]] = None


class GoogleDriveClient:
    def __init__(self) -> None:
        self._creds = self._load_credentials()
        self._scopes = self._scopes_from_env()

    @staticmethod
    def _credential_path() -> str:
        path = (os.getenv("GDRIVE_SERVICE_ACCOUNT_JSON") or "/secrets/service_account.json").strip()
        if not path:
            raise RuntimeError("GDRIVE_SERVICE_ACCOUNT_JSON is not configured")
        if not os.path.exists(path):
            raise RuntimeError(f"Google service account file not found: {path}")
        return path

    @staticmethod
    def _scopes_from_env() -> List[str]:
        value = os.getenv("GDRIVE_SCOPES") or ""
        scopes = [scope.strip() for scope in value.split(",") if scope.strip()]
        return scopes or DEFAULT_SCOPES.copy()

    def _load_credentials(self):  # noqa: ANN001
        info = service_account.Credentials.from_service_account_file(self._credential_path(), scopes=self._scopes_from_env())
        return info

    @lru_cache(maxsize=1)
    def _build_service(self):  # noqa: ANN201
        return build("drive", "v3", credentials=self._creds, cache_discovery=False)

    def list_files(self, *, query: Optional[str], mime_types: Optional[List[str]], page_size: int) -> Dict[str, Any]:
        service = self._build_service()
        if mime_types:
            cleaned = [mime.strip() for mime in mime_types if isinstance(mime, str) and mime.strip()]
            if cleaned:
                mime_clause = " or ".join([f"mimeType='{mime}'" for mime in cleaned])
                query = f"{query} and ({mime_clause})" if query else f"({mime_clause})"
        request = (
            service.files()
            .list(
                q=query,
                pageSize=max(1, min(page_size, 200)),
                spaces="drive",
                fields="files(id,name,mimeType,modifiedTime,owners(displayName),size),nextPageToken",
            )
        )
        return request.execute()

    def get_file_metadata(self, file_id: str) -> Dict[str, Any]:
        service = self._build_service()
        request = service.files().get(
            fileId=file_id,
            fields="id,name,mimeType,modifiedTime,createdTime,size,owners(displayName,emailAddress),permissions",
        )
        return request.execute()

    def download_file(self, file_id: str, *, export_mime: Optional[str]) -> Dict[str, Any]:
        service = self._build_service()
        file_meta = service.files().get(fileId=file_id, fields="id,name,mimeType,size").execute()
        mime_type = file_meta.get("mimeType")
        stream = io.BytesIO()
        if mime_type and mime_type.startswith("application/vnd.google-apps"):
            mime = export_mime or DEFAULT_EXPORT_MIME
            downloader = MediaIoBaseDownload(stream, service.files().export_media(fileId=file_id, mimeType=mime))
        else:
            downloader = MediaIoBaseDownload(stream, service.files().get_media(fileId=file_id))
        done = False
        while not done:
            _, done = downloader.next_chunk()
        stream.seek(0)
        encoded = base64.b64encode(stream.read()).decode("utf-8")
        return {
            "file": file_meta,
            "mimeType": mime_type,
            "data": encoded,
        }

    def upload_file(
        self,
        *,
        name: str,
        parent_id: Optional[str],
        mime_type: Optional[str],
        data_base64: str,
    ) -> Dict[str, Any]:
        if not data_base64:
            raise HTTPException(status_code=400, detail="data_base64 is required")
        try:
            payload = base64.b64decode(data_base64)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=400, detail="data_base64 invalid") from exc

        stream = io.BytesIO(payload)
        media = MediaIoBaseUpload(stream, mimetype=mime_type or "application/octet-stream", resumable=False)
        metadata: Dict[str, Any] = {"name": name}
        if parent_id:
            metadata["parents"] = [parent_id]
        service = self._build_service()
        request = service.files().create(body=metadata, media_body=media, fields="id,name,mimeType,size,parents")
        return request.execute()

    def health(self) -> GDriveHealth:
        service = self._build_service()
        try:
            about = service.about().get(fields="user,storageQuota").execute()
        except HttpError as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=f"drive_unreachable: {exc}") from exc
        return GDriveHealth(status="ok", detail=about)


gdrive_client = GoogleDriveClient()
app = FastAPI(title=APP_NAME, version=APP_VERSION)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _require_str(payload: Dict[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise HTTPException(status_code=400, detail=f"{key} is required")
    return value.strip()


def _require_int(payload: Dict[str, Any], key: str, *, default: Optional[int] = None) -> int:
    if key not in payload or payload[key] is None:
        if default is None:
            raise HTTPException(status_code=400, detail=f"{key} is required")
        return default
    try:
        return int(payload[key])
    except (TypeError, ValueError) as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"{key} must be numeric") from exc


def tool_list_files(arguments: Dict[str, Any]) -> Dict[str, Any]:
    query = arguments.get("query")
    if query is not None and not isinstance(query, str):
        raise HTTPException(status_code=400, detail="query must be a string")
    mime_types = arguments.get("mime_types")
    if mime_types is not None:
        if not isinstance(mime_types, list) or any(not isinstance(item, str) for item in mime_types):
            raise HTTPException(status_code=400, detail="mime_types must be an array of strings")
    page_size = _require_int(arguments, "page_size", default=25)
    try:
        result = gdrive_client.list_files(query=query, mime_types=mime_types, page_size=page_size)
    except HttpError as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"drive_error: {exc}") from exc
    return result


def tool_get_file_metadata(arguments: Dict[str, Any]) -> Dict[str, Any]:
    file_id = _require_str(arguments, "file_id")
    try:
        return gdrive_client.get_file_metadata(file_id)
    except HttpError as exc:  # noqa: BLE001
        status = exc.status_code if hasattr(exc, "status_code") else 502
        raise HTTPException(status_code=status, detail=str(exc)) from exc


def tool_download_file(arguments: Dict[str, Any]) -> Dict[str, Any]:
    file_id = _require_str(arguments, "file_id")
    export_mime = arguments.get("export_mime")
    if export_mime is not None and not isinstance(export_mime, str):
        raise HTTPException(status_code=400, detail="export_mime must be a string")
    try:
        return gdrive_client.download_file(file_id, export_mime=export_mime)
    except HttpError as exc:  # noqa: BLE001
        status = exc.status_code if hasattr(exc, "status_code") else 502
        raise HTTPException(status_code=status, detail=str(exc)) from exc


def tool_upload_file(arguments: Dict[str, Any]) -> Dict[str, Any]:
    name = _require_str(arguments, "name")
    data_base64 = _require_str(arguments, "data_base64")
    parent_id = arguments.get("parent_id")
    if parent_id is not None and not isinstance(parent_id, str):
        raise HTTPException(status_code=400, detail="parent_id must be a string")
    mime_type = arguments.get("mime_type")
    if mime_type is not None and not isinstance(mime_type, str):
        raise HTTPException(status_code=400, detail="mime_type must be a string")
    return gdrive_client.upload_file(name=name, parent_id=parent_id, mime_type=mime_type, data_base64=data_base64)


TOOL_REGISTRY = {
    "list_files": tool_list_files,
    "get_file_metadata": tool_get_file_metadata,
    "download_file": tool_download_file,
    "upload_file": tool_upload_file,
}

TOOL_SCHEMAS: Dict[str, Dict[str, Any]] = {
    "list_files": {
        "name": "list_files",
        "description": "List Drive files with optional query and mimeType filters.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "mime_types": {"type": "array", "items": {"type": "string"}},
                "page_size": {"type": "integer", "minimum": 1, "maximum": 200},
            },
        },
    },
    "get_file_metadata": {
        "name": "get_file_metadata",
        "description": "Fetch metadata (name, owners, permissions) for a Drive file.",
        "input_schema": {
            "type": "object",
            "required": ["file_id"],
            "properties": {
                "file_id": {"type": "string"},
            },
        },
    },
    "download_file": {
        "name": "download_file",
        "description": "Download file bytes as base64 (Google Docs are exported by default).",
        "input_schema": {
            "type": "object",
            "required": ["file_id"],
            "properties": {
                "file_id": {"type": "string"},
                "export_mime": {"type": "string", "description": "Optional export mime for Docs/Sheets/etc."},
            },
        },
    },
    "upload_file": {
        "name": "upload_file",
        "description": "Upload a new Drive file from a base64 payload.",
        "input_schema": {
            "type": "object",
            "required": ["name", "data_base64"],
            "properties": {
                "name": {"type": "string"},
                "data_base64": {"type": "string", "description": "Base64 encoded bytes"},
                "parent_id": {"type": "string"},
                "mime_type": {"type": "string"},
            },
        },
    },
}


@app.get("/health", response_model=GDriveHealth)
def health() -> GDriveHealth:
    return gdrive_client.health()


@app.post("/invoke")
def invoke(request: InvokeRequest) -> Any:  # noqa: ANN401
    handler = TOOL_REGISTRY.get(request.tool)
    if not handler:
        raise HTTPException(status_code=404, detail=f"Unknown tool '{request.tool}'")
    return handler(request.arguments)


@app.get("/.well-known/mcp.json")
def manifest() -> Dict[str, Any]:
    return {
        "name": APP_NAME,
        "version": APP_VERSION,
        "description": "Google Drive MCP bridge for listing, downloading, and uploading files.",
        "capabilities": {
            "tools": list(TOOL_SCHEMAS.values()),
        },
    }


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run("main:app", host=os.getenv("MCP_HOST", "0.0.0.0"), port=int(os.getenv("PORT", "8012")))
