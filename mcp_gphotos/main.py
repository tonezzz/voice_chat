from __future__ import annotations

import base64
import os
from typing import Any, Dict, List, Optional

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from pydantic import BaseModel, Field

APP_NAME = "mcp-gphotos"
APP_VERSION = "0.1.0"
UPLOAD_ENDPOINT = "https://photoslibrary.googleapis.com/v1/uploads"
DEFAULT_SCOPES = ["https://www.googleapis.com/auth/photoslibrary.readonly"]


class InvokeRequest(BaseModel):
    tool: str = Field(..., description="Tool name exposed via MCP")
    arguments: Dict[str, Any] = Field(default_factory=dict)


class GooglePhotosHealth(BaseModel):
    status: str
    last_checked_album: Optional[str] = None


class GooglePhotosClient:
    def __init__(self) -> None:
        self._client_id = (os.getenv("GPHOTOS_CLIENT_ID") or "").strip()
        self._client_secret = (os.getenv("GPHOTOS_CLIENT_SECRET") or "").strip()
        self._refresh_token = (os.getenv("GPHOTOS_REFRESH_TOKEN") or "").strip()
        if not (self._client_id and self._client_secret and self._refresh_token):
            raise RuntimeError("Google Photos OAuth credentials are not fully configured")
        self._scopes = self._parse_scopes()
        self._token_uri = os.getenv("GPHOTOS_TOKEN_URI", "https://oauth2.googleapis.com/token")
        self._credentials = Credentials(
            token=None,
            refresh_token=self._refresh_token,
            token_uri=self._token_uri,
            client_id=self._client_id,
            client_secret=self._client_secret,
            scopes=self._scopes,
        )

    @staticmethod
    def _parse_scopes() -> List[str]:
        raw = os.getenv("GPHOTOS_SCOPES") or ""
        scopes = [scope.strip() for scope in raw.split(",") if scope.strip()]
        return scopes or DEFAULT_SCOPES.copy()

    def _ensure_tokens(self) -> None:
        if not self._credentials.valid:
            request = Request()
            self._credentials.refresh(request)

    def _service(self):  # noqa: ANN201
        self._ensure_tokens()
        return build("photoslibrary", "v1", credentials=self._credentials, cache_discovery=False)

    def list_albums(self, *, page_size: int, page_token: Optional[str]) -> Dict[str, Any]:
        service = self._service()
        request = service.albums().list(pageSize=page_size, pageToken=page_token)
        return request.execute()

    def list_media_items(
        self,
        *,
        page_size: int,
        page_token: Optional[str],
        album_id: Optional[str],
    ) -> Dict[str, Any]:
        service = self._service()
        request = service.mediaItems().search(
            body={
                key: value
                for key, value in {
                    "pageSize": page_size,
                    "pageToken": page_token,
                    "albumId": album_id,
                }.items()
                if value is not None
            }
        )
        return request.execute()

    def upload_media_item(
        self,
        *,
        filename: str,
        data_base64: str,
        description: Optional[str],
        album_id: Optional[str],
    ) -> Dict[str, Any]:
        self._ensure_tokens()
        try:
            data = base64.b64decode(data_base64)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=400, detail="data_base64 invalid") from exc

        headers = {
            "Authorization": f"Bearer {self._credentials.token}",
            "Content-type": "application/octet-stream",
            "X-Goog-Upload-File-Name": filename,
            "X-Goog-Upload-Protocol": "raw",
        }
        response = httpx.post(UPLOAD_ENDPOINT, headers=headers, content=data, timeout=30.0)
        if response.status_code >= 400:
            raise HTTPException(status_code=response.status_code, detail=f"upload_failed:{response.text}")
        upload_token = response.text.strip()
        service = self._service()
        create_body: Dict[str, Any] = {
            "newMediaItems": [
                {
                    "description": description or filename,
                    "simpleMediaItem": {
                        "uploadToken": upload_token,
                    },
                }
            ]
        }
        if album_id:
            create_body["albumId"] = album_id
        request = service.mediaItems().batchCreate(body=create_body)
        return request.execute()

    def healthcheck(self) -> GooglePhotosHealth:
        service = self._service()
        try:
            payload = service.albums().list(pageSize=1).execute()
        except HttpError as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=f"gphotos_unreachable: {exc}") from exc
        album_title = None
        albums = payload.get("albums") or []
        if albums:
            album_title = albums[0].get("title")
        return GooglePhotosHealth(status="ok", last_checked_album=album_title)


gphotos_client = GooglePhotosClient()
app = FastAPI(title=APP_NAME, version=APP_VERSION)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _coerce_page_size(value: Any, *, default: int = 25, maximum: int = 100) -> int:
    if value is None:
        return default
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="page_size must be numeric") from exc
    return max(1, min(parsed, maximum))


def tool_list_albums(arguments: Dict[str, Any]) -> Dict[str, Any]:
    page_size = _coerce_page_size(arguments.get("page_size"), default=25)
    page_token = arguments.get("page_token")
    if page_token is not None and not isinstance(page_token, str):
        raise HTTPException(status_code=400, detail="page_token must be a string")
    try:
        return gphotos_client.list_albums(page_size=page_size, page_token=page_token)
    except HttpError as exc:  # noqa: BLE001
        raise HTTPException(status_code=exc.status_code or 502, detail=str(exc)) from exc


def tool_list_media_items(arguments: Dict[str, Any]) -> Dict[str, Any]:
    page_size = _coerce_page_size(arguments.get("page_size"), default=25)
    page_token = arguments.get("page_token")
    if page_token is not None and not isinstance(page_token, str):
        raise HTTPException(status_code=400, detail="page_token must be a string")
    album_id = arguments.get("album_id")
    if album_id is not None and not isinstance(album_id, str):
        raise HTTPException(status_code=400, detail="album_id must be a string")
    try:
        return gphotos_client.list_media_items(page_size=page_size, page_token=page_token, album_id=album_id)
    except HttpError as exc:  # noqa: BLE001
        raise HTTPException(status_code=exc.status_code or 502, detail=str(exc)) from exc


def tool_upload_media_item(arguments: Dict[str, Any]) -> Dict[str, Any]:
    filename = arguments.get("filename")
    data_base64 = arguments.get("data_base64")
    if not isinstance(filename, str) or not filename.strip():
        raise HTTPException(status_code=400, detail="filename is required")
    if not isinstance(data_base64, str) or not data_base64.strip():
        raise HTTPException(status_code=400, detail="data_base64 is required")
    description = arguments.get("description")
    if description is not None and not isinstance(description, str):
        raise HTTPException(status_code=400, detail="description must be a string")
    album_id = arguments.get("album_id")
    if album_id is not None and not isinstance(album_id, str):
        raise HTTPException(status_code=400, detail="album_id must be a string")
    return gphotos_client.upload_media_item(
        filename=filename.strip(),
        data_base64=data_base64.strip(),
        description=description.strip() if isinstance(description, str) else None,
        album_id=album_id.strip() if isinstance(album_id, str) else None,
    )


TOOL_REGISTRY = {
    "list_albums": tool_list_albums,
    "list_media_items": tool_list_media_items,
    "upload_media_item": tool_upload_media_item,
}

TOOL_SCHEMAS: Dict[str, Dict[str, Any]] = {
    "list_albums": {
        "name": "list_albums",
        "description": "List Google Photos albums accessible to the authenticated user.",
        "input_schema": {
            "type": "object",
            "properties": {
                "page_size": {"type": "integer", "minimum": 1, "maximum": 100},
                "page_token": {"type": "string"},
            },
        },
    },
    "list_media_items": {
        "name": "list_media_items",
        "description": "List media items, optionally scoped to an album.",
        "input_schema": {
            "type": "object",
            "properties": {
                "page_size": {"type": "integer", "minimum": 1, "maximum": 100},
                "page_token": {"type": "string"},
                "album_id": {"type": "string"},
            },
        },
    },
    "upload_media_item": {
        "name": "upload_media_item",
        "description": "Upload a base64-encoded media item and optionally attach it to an album.",
        "input_schema": {
            "type": "object",
            "required": ["filename", "data_base64"],
            "properties": {
                "filename": {"type": "string"},
                "data_base64": {"type": "string"},
                "description": {"type": "string"},
                "album_id": {"type": "string"},
            },
        },
    },
}


@app.get("/health", response_model=GooglePhotosHealth)
def health() -> GooglePhotosHealth:
    return gphotos_client.healthcheck()


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
        "description": "Google Photos MCP bridge for listing albums/media items and uploading new assets.",
        "capabilities": {
            "tools": list(TOOL_SCHEMAS.values()),
        },
    }


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run("main:app", host=os.getenv("MCP_HOST", "0.0.0.0"), port=int(os.getenv("PORT", "8013")))
