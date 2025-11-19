from __future__ import annotations

import base64
import os
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, File, UploadFile, Form, HTTPException
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

MOCK_FIELDS = [
    {
        "id": "mock-amount",
        "type": "amount",
        "label": "Amount",
        "value": "678.01",
        "confidence": 0.98,
        "bbox": None,
    },
    {
        "id": "mock-sender",
        "type": "sender",
        "label": "Sender",
        "value": "Chirawat K***",
        "confidence": 0.94,
        "bbox": None,
    },
    {
        "id": "mock-bank",
        "type": "bank",
        "label": "From Bank",
        "value": "Krungthai",
        "confidence": 0.9,
        "bbox": None,
    },
    {
        "id": "mock-account",
        "type": "account",
        "label": "From Account",
        "value": "XXX-X-X045-9",
        "confidence": 0.91,
        "bbox": None,
    },
    {
        "id": "mock-receiver",
        "type": "receiver",
        "label": "To",
        "value": "MWA-Water Tariffs-MOM (7338)",
        "confidence": 0.92,
        "bbox": None,
    },
    {
        "id": "mock-date",
        "type": "date",
        "label": "Transaction Date",
        "value": "22 Jul 2025",
        "confidence": 0.9,
        "bbox": None,
    },
    {
        "id": "mock-time",
        "type": "time",
        "label": "Transaction Time",
        "value": "19:25",
        "confidence": 0.9,
        "bbox": None,
    },
    {
        "id": "mock-reference",
        "type": "reference",
        "label": "Reference",
        "value": "20250722432028571",
        "confidence": 0.95,
        "bbox": None,
    },
    {
        "id": "mock-note",
        "type": "other",
        "label": "Note",
        "value": "NBA",
        "confidence": 0.7,
        "bbox": None,
    },
]

app = FastAPI(title="Mock Bank Slip MCP", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def encode_file_to_data_url(file: UploadFile) -> str:
    content = file.file.read()
    if not content:
        return ""
    mime = file.content_type or "application/octet-stream"
    data = base64.b64encode(content).decode("utf-8")
    return f"data:{mime};base64,{data}"


@app.get("/health")
async def health() -> Dict[str, Any]:
    return {"status": "ok", "provider": "mock"}


@app.post("/verify")
async def verify_slip(
    file: UploadFile = File(...),
    reference_id: Optional[str] = Form(None),
) -> JSONResponse:
    if not file:
        raise HTTPException(status_code=400, detail="file is required")

    preview = encode_file_to_data_url(file)
    mock_payload = {
        "fields": MOCK_FIELDS,
        "verification": {
            "reference_id": reference_id or "20250722432028571",
            "provider": "mock",
            "status": "ok",
        },
        "image": preview,
    }
    return JSONResponse(mock_payload)


@app.get("/")
async def root() -> Dict[str, Any]:
    return {"status": "ok", "message": "Mock bank slip MCP"}


def main() -> None:
    host = os.getenv("MCP_HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8002"))
    uvicorn.run("main:app", host=host, port=port, reload=False)


if __name__ == "__main__":
    main()
