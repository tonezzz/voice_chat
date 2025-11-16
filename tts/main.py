import io
import os
import threading
import wave
from pathlib import Path
from typing import Optional

import numpy as np
import requests
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel
from piper import PiperVoice

DEFAULT_MODEL_URL = (
    "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US-lessac-medium.onnx"
)
DEFAULT_CONFIG_URL = (
    "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US-lessac-medium.onnx.json"
)

MODEL_PATH = Path(os.environ.get("PIPER_MODEL_PATH", "/app/models/en_US-lessac-medium.onnx"))
CONFIG_PATH = Path(os.environ.get("PIPER_CONFIG_PATH", f"{MODEL_PATH}.json"))
MODEL_URL = os.environ.get("PIPER_MODEL_URL", DEFAULT_MODEL_URL)
CONFIG_URL = os.environ.get("PIPER_CONFIG_URL", DEFAULT_CONFIG_URL)
SAMPLE_RATE_OVERRIDE = os.environ.get("PIPER_SAMPLE_RATE")

app = FastAPI(title="Local Piper TTS", version="1.0.0")

_voice_lock = threading.Lock()
_voice_instance: Optional[PiperVoice] = None


def _ensure_asset(path: Path, url: Optional[str]) -> None:
    if path.exists():
        return
    if not url:
        raise RuntimeError(f"No download URL configured for {path.name}")

    path.parent.mkdir(parents=True, exist_ok=True)
    with requests.get(url, stream=True, timeout=60) as response:
        response.raise_for_status()
        with open(path, "wb") as handle:
            for chunk in response.iter_content(chunk_size=1 << 20):
                if chunk:
                    handle.write(chunk)


def _load_voice() -> PiperVoice:
    global _voice_instance
    with _voice_lock:
        if _voice_instance is None:
            _ensure_asset(MODEL_PATH, MODEL_URL)
            _ensure_asset(CONFIG_PATH, CONFIG_URL)
            _voice_instance = PiperVoice.load(str(MODEL_PATH), config_path=str(CONFIG_PATH))
        return _voice_instance


class TtsRequest(BaseModel):
    text: str
    length_scale: Optional[float] = None
    noise_scale: Optional[float] = None
    noise_w: Optional[float] = None
    speaker_id: Optional[int] = None


def _infer_sample_rate(voice: PiperVoice) -> int:
    if SAMPLE_RATE_OVERRIDE:
        return int(SAMPLE_RATE_OVERRIDE)

    sample_rate = getattr(voice, "sample_rate", None)
    if sample_rate:
        return int(sample_rate)

    config = getattr(voice, "config", None)
    if config is not None:
        for attr in ("sample_rate", "sampleRate"):
            value = getattr(config, attr, None)
            if value:
                return int(value)

    return 22050


def _audio_to_wav_bytes(audio, sample_rate: int) -> bytes:
    data = np.asarray(audio)
    if data.dtype != np.int16:
        data = np.clip(data, -1.0, 1.0)
        data = (data * 32767).astype(np.int16)

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(data.tobytes())

    buffer.seek(0)
    return buffer.read()


@app.get("/health")
def health():
    info = {
        "model": str(MODEL_PATH),
        "config": str(CONFIG_PATH),
    }
    try:
        voice = _load_voice()
        info["sampleRate"] = _infer_sample_rate(voice)
    except Exception as exc:  # noqa: BLE001
        info["error"] = str(exc)
    return info


@app.post("/synthesize")
def synthesize(request: TtsRequest):
    text = request.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")

    voice = _load_voice()
    kwargs = {}
    if request.length_scale is not None:
        kwargs["length_scale"] = request.length_scale
    if request.noise_scale is not None:
        kwargs["noise_scale"] = request.noise_scale
    if request.noise_w is not None:
        kwargs["noise_w"] = request.noise_w
    if request.speaker_id is not None:
        kwargs["speaker_id"] = request.speaker_id

    try:
        audio = voice.synthesize(text, **kwargs)
        wav_bytes = _audio_to_wav_bytes(audio, _infer_sample_rate(voice))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"synthesis_failed: {exc}") from exc

    return Response(content=wav_bytes, media_type="audio/wav")


@app.get("/")
def root():
    return {"status": "ok"}
