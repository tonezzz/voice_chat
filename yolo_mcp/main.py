from __future__ import annotations

import base64
import io
import os
from typing import List, Dict, Any

from mcp.server.fastmcp import FastMCP
from PIL import Image
from ultralytics import YOLO
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.status import HTTP_400_BAD_REQUEST
import uvicorn


# Initialize MCP server
mcp = FastMCP("YOLOv8n-Detection")


# Load YOLO model once at startup
YOLO_MODEL_ENV = os.getenv("YOLO_MODEL", "yolov8n.pt")
model = YOLO(YOLO_MODEL_ENV)


def _load_image_from_base64(data: str) -> Image.Image:
    """Decode base64-encoded image data into a PIL Image."""
    # Allow optional data URL prefix
    if data.startswith("data:image"):
        header, _, b64_data = data.partition(",")
    else:
        b64_data = data

    binary = base64.b64decode(b64_data)
    return Image.open(io.BytesIO(binary)).convert("RGB")


@mcp.tool()
def detect_objects(
    image_base64: str,
    confidence: float = 0.25,
) -> List[Dict[str, Any]]:
    """Run YOLOv8n object detection on a base64-encoded image.

    Args:
        image_base64: Image data as a base64 string. Data URLs are also accepted.
        confidence: Confidence threshold for detections (0.0 - 1.0).

    Returns:
        A list of detections with fields:
        - class_name: Detected class label
        - confidence: Confidence score
        - bbox: [x1, y1, x2, y2] in pixel coordinates
        - class_id: Numeric class id
    """
    img = _load_image_from_base64(image_base64)

    # Run inference
    results = model.predict(img, conf=confidence, verbose=False)

    detections: List[Dict[str, Any]] = []
    for r in results:
        boxes = r.boxes
        names = r.names
        if boxes is None:
            continue

        for box in boxes:
            xyxy = box.xyxy[0].tolist()  # [x1, y1, x2, y2]
            conf = float(box.conf[0].item()) if box.conf is not None else None
            cls_id = int(box.cls[0].item()) if box.cls is not None else None
            class_name = names.get(cls_id, str(cls_id)) if cls_id is not None else None

            detections.append(
                {
                    "class_name": class_name,
                    "confidence": conf,
                    "bbox": xyxy,
                    "class_id": cls_id,
                }
            )

    return detections


@mcp.custom_route("/detect", methods=["POST"])
async def detect_http(request: Request) -> JSONResponse:
    """Simple REST bridge so non-MCP clients can call detections."""

    try:
        payload = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid_json"}, status_code=HTTP_400_BAD_REQUEST)

    image_base64 = payload.get("image_base64") if isinstance(payload, dict) else None
    if not image_base64 or not isinstance(image_base64, str):
        return JSONResponse({"error": "image_base64 is required"}, status_code=HTTP_400_BAD_REQUEST)

    raw_conf = payload.get("confidence") if isinstance(payload, dict) else None
    try:
        confidence = float(raw_conf) if raw_conf is not None else 0.25
    except (ValueError, TypeError):
        return JSONResponse({"error": "confidence must be numeric"}, status_code=HTTP_400_BAD_REQUEST)

    confidence = max(0.0, min(1.0, confidence))

    detections = detect_objects(image_base64=image_base64, confidence=confidence)
    return JSONResponse({"detections": detections})


async def root(_: Request) -> JSONResponse:
    return JSONResponse({"status": "ok"})


def main() -> None:
    """Entry point for running the YOLO MCP HTTP bridge."""
    host = os.getenv("MCP_HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8000"))

    app = Starlette(routes=[
        Route("/", root, methods=["GET"]),
        Route("/detect", detect_http, methods=["POST"])
    ])

    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    main()
