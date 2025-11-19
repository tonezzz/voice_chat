from __future__ import annotations

import base64
import io
import logging
import os
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from insightface.app import FaceAnalysis
from mcp.server.fastmcp import FastMCP
from PIL import Image, UnidentifiedImageError
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.status import HTTP_400_BAD_REQUEST
import uvicorn

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("mcp_idp")

mcp = FastMCP("IdentityDetectionProvider")

_IDP_REFERENCE_DIR = os.getenv("IDP_REFERENCE_DIR", "/app/reference_faces")
_IDP_MODEL_STORAGE = os.getenv("IDP_MODEL_STORAGE", "/app/models")
_IDP_DEVICE = os.getenv("IDP_DEVICE", "cpu").lower()
_IDP_DET_SIZE = int(os.getenv("IDP_DET_SIZE", "640"))
_IDP_MIN_DET_SCORE = float(os.getenv("IDP_MIN_DET_SCORE", "0.35"))
_IDP_MIN_IDENTITY_SCORE = float(os.getenv("IDP_MIN_IDENTITY_SCORE", "0.4"))
_IDP_ALLOWED_EXT = {".png", ".jpg", ".jpeg", ".webp"}

os.environ.setdefault("INSIGHTFACE_HOME", _IDP_MODEL_STORAGE)

_face_analyzer: Optional[FaceAnalysis] = None
_reference_faces: List["IdentityReference"] = []


@dataclass
class IdentityReference:
    label: str
    embedding: np.ndarray
    source: str
    bbox: Optional[Tuple[float, float, float, float]] = None

    def as_dict(self) -> Dict[str, Any]:
        return {
            "label": self.label,
            "source": self.source,
            "bbox": list(self.bbox) if self.bbox else None,
        }


def _prepare_face_analyzer() -> FaceAnalysis:
    global _face_analyzer
    if _face_analyzer is not None:
        return _face_analyzer

    ctx_id = 0 if _IDP_DEVICE.startswith("cuda") else -1
    logger.info("Initializing FaceAnalysis", extra={"ctx_id": ctx_id, "det_size": _IDP_DET_SIZE})
    analyzer = FaceAnalysis(name="buffalo_l")
    analyzer.prepare(ctx_id=ctx_id, det_size=(_IDP_DET_SIZE, _IDP_DET_SIZE))
    _face_analyzer = analyzer
    return analyzer


def _pil_to_bgr(image: Image.Image) -> np.ndarray:
    rgb = image.convert("RGB")
    array = np.asarray(rgb)
    # Convert RGB to BGR for InsightFace
    return array[:, :, ::-1].copy()


def _decode_base64_image(image_base64: str) -> Image.Image:
    if not isinstance(image_base64, str) or not image_base64.strip():
        raise ValueError("image_base64 is required")

    payload = image_base64.strip()
    if payload.startswith("data:image"):
        _, _, payload = payload.partition(",")

    try:
        raw = base64.b64decode(payload, validate=True)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("image_base64 is not valid base64 data") from exc

    try:
        return Image.open(io.BytesIO(raw)).convert("RGB")
    except UnidentifiedImageError as exc:
        raise ValueError("decoded data is not a valid image") from exc


def _normalize_embedding(embedding: np.ndarray) -> Optional[np.ndarray]:
    if embedding is None:
        return None
    norm = np.linalg.norm(embedding)
    if not norm:
        return None
    return embedding / norm


def _derive_label(path: str) -> str:
    base = os.path.splitext(os.path.basename(path))[0]
    parent = os.path.basename(os.path.dirname(path))
    if parent and parent not in (".", os.path.sep):
        return parent
    return base


def _load_reference_faces() -> List[IdentityReference]:
    analyzer = _prepare_face_analyzer()
    references: List[IdentityReference] = []

    if not os.path.isdir(_IDP_REFERENCE_DIR):
        logger.warning("Reference directory missing", extra={"dir": _IDP_REFERENCE_DIR})
        return references

    for root, _, files in os.walk(_IDP_REFERENCE_DIR):
        for filename in files:
            ext = os.path.splitext(filename)[1].lower()
            if ext not in _IDP_ALLOWED_EXT:
                continue
            path = os.path.join(root, filename)
            try:
                image = Image.open(path)
                bgr = _pil_to_bgr(image)
            except Exception as exc:  # noqa: BLE001
                logger.error("Failed to load reference image", extra={"path": path, "error": str(exc)})
                continue

            faces = analyzer.get(bgr)
            if not faces:
                logger.warning("No faces detected in reference", extra={"path": path})
                continue

            face = faces[0]
            embedding = _normalize_embedding(getattr(face, "normed_embedding", None) or getattr(face, "embedding", None))
            if embedding is None:
                logger.warning("Reference lacks embedding", extra={"path": path})
                continue

            references.append(
                IdentityReference(
                    label=_derive_label(path),
                    embedding=embedding,
                    source=os.path.relpath(path, _IDP_REFERENCE_DIR),
                    bbox=tuple(float(x) for x in face.bbox.tolist()) if getattr(face, "bbox", None) is not None else None,
                )
            )

    logger.info("Loaded identity references", extra={"count": len(references)})
    return references


def _ensure_references_loaded() -> None:
    global _reference_faces
    if _reference_faces:
        return
    _reference_faces = _load_reference_faces()


def _match_identity(embedding: np.ndarray, min_identity_score: float) -> Optional[Dict[str, Any]]:
    if embedding is None:
        return None
    if not _reference_faces:
        return None

    best_ref: Optional[IdentityReference] = None
    best_score = float("-inf")
    for ref in _reference_faces:
        score = float(np.dot(embedding, ref.embedding))
        if score > best_score:
            best_score = score
            best_ref = ref

    if best_ref is None or best_score < min_identity_score:
        return None

    return {
        "label": best_ref.label,
        "similarity": best_score,
        "source": best_ref.source,
    }


def _serialize_face(face, identity: Optional[Dict[str, Any]]) -> Dict[str, Any]:  # noqa: ANN001
    bbox = face.bbox.tolist() if getattr(face, "bbox", None) is not None else None
    return {
        "bbox": [float(x) for x in bbox] if bbox else None,
        "det_score": float(getattr(face, "det_score", 0.0) or 0.0),
        "identity": identity,
        "landmarks": face.landmark_2d_106.tolist() if getattr(face, "landmark_2d_106", None) is not None else None,
    }


@mcp.tool()
def identify_people(
    image_base64: str,
    min_detection_score: Optional[float] = None,
    min_identity_score: Optional[float] = None,
) -> Dict[str, Any]:
    """Detect faces in an image and try to match them against known references."""

    analyzer = _prepare_face_analyzer()
    _ensure_references_loaded()

    pil_image = _decode_base64_image(image_base64)
    bgr = _pil_to_bgr(pil_image)

    min_det = float(min_detection_score if min_detection_score is not None else _IDP_MIN_DET_SCORE)
    min_identity = float(min_identity_score if min_identity_score is not None else _IDP_MIN_IDENTITY_SCORE)

    faces = analyzer.get(bgr)
    detections = []
    for face in faces:
        det_score = float(getattr(face, "det_score", 0.0) or 0.0)
        if det_score < min_det:
            continue
        embedding = _normalize_embedding(getattr(face, "normed_embedding", None) or getattr(face, "embedding", None))
        identity = _match_identity(embedding, min_identity) if embedding is not None else None
        detections.append(_serialize_face(face, identity))

    return {
        "count": len(detections),
        "detections": detections,
        "references_loaded": len(_reference_faces),
        "accelerator": "gpu" if _IDP_DEVICE.startswith("cuda") else "cpu",
    }


@mcp.tool()
def list_identity_references() -> Dict[str, Any]:
    """Return metadata about the currently loaded identity references."""

    _ensure_references_loaded()
    return {
        "count": len(_reference_faces),
        "references": [ref.as_dict() for ref in _reference_faces],
        "directory": _IDP_REFERENCE_DIR,
    }


@mcp.tool()
def refresh_identity_references() -> Dict[str, Any]:
    """Force reload of identity reference embeddings from disk."""

    global _reference_faces
    _prepare_face_analyzer()
    _reference_faces = _load_reference_faces()
    return {
        "count": len(_reference_faces),
        "directory": _IDP_REFERENCE_DIR,
    }


async def identify_http(request: Request) -> JSONResponse:
    try:
        payload = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse({"error": "invalid_json"}, status_code=HTTP_400_BAD_REQUEST)

    if not isinstance(payload, dict):
        return JSONResponse({"error": "invalid_payload"}, status_code=HTTP_400_BAD_REQUEST)

    image_base64 = payload.get("image_base64")
    if not isinstance(image_base64, str):
        return JSONResponse({"error": "image_base64 is required"}, status_code=HTTP_400_BAD_REQUEST)

    try:
        result = identify_people(
            image_base64=image_base64,
            min_detection_score=payload.get("min_detection_score"),
            min_identity_score=payload.get("min_identity_score"),
        )
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=HTTP_400_BAD_REQUEST)
    except Exception as exc:  # noqa: BLE001
        logger.exception("identify_http failed")
        return JSONResponse({"error": "identification_failed", "detail": str(exc)}, status_code=500)

    return JSONResponse(result)


async def root(_: Request) -> JSONResponse:
    return JSONResponse(
        {
            "status": "ok",
            "references_loaded": len(_reference_faces),
            "reference_dir": _IDP_REFERENCE_DIR,
            "accelerator": "gpu" if _IDP_DEVICE.startswith("cuda") else "cpu",
        }
    )


def main() -> None:
    host = os.getenv("MCP_HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8004"))

    app = Starlette(
        routes=[
            Route("/", root, methods=["GET"]),
            Route("/health", root, methods=["GET"]),
            Route("/identify", identify_http, methods=["POST"]),
        ]
    )

    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    main()
