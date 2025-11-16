from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse
from faster_whisper import WhisperModel
import tempfile
import os
from typing import Dict

MODEL_SIZE = os.getenv("WHISPER_MODEL", "tiny")
DEVICE = os.getenv("WHISPER_DEVICE", "cpu")

app = FastAPI()

_models_cache: Dict[str, WhisperModel] = {}


def get_model(size: str) -> WhisperModel:
    """Get (or lazily load) a WhisperModel for the given size."""
    size_key = size or MODEL_SIZE
    if size_key not in _models_cache:
        _models_cache[size_key] = WhisperModel(size_key, device=DEVICE)
    return _models_cache[size_key]


@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    whisper_model: str | None = Form(None),
):
    try:
        suffix = os.path.splitext(file.filename)[1] or ".webm"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            contents = await file.read()
            tmp.write(contents)
            tmp_path = tmp.name

        model = get_model(whisper_model or MODEL_SIZE)
        segments, info = model.transcribe(tmp_path)
        text = "".join(seg.text for seg in segments).strip()

        os.remove(tmp_path)

        return JSONResponse({"text": text, "model": whisper_model or MODEL_SIZE})
    except Exception as e:
        return JSONResponse(
            {"error": "transcription_failed", "detail": str(e)}, status_code=500
        )
