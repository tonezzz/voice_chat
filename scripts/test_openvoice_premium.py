from __future__ import annotations

import argparse
import json
import pathlib
import sys
import urllib.error
import urllib.request

VOICES = [
    "openvoice-v2-en-studio",
    "openvoice-v2-en-tony",
    "openvoice-v2-th-aurora",
    "openvoice-v2-th-tony",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Smoke test OpenVoice premium voices")
    parser.add_argument(
        "--url",
        default="http://localhost:8100/synthesize",
        help="OpenVoice synthesize endpoint (default: %(default)s)",
    )
    parser.add_argument(
        "--output-dir",
        default="openvoice_synth",
        help="Directory to store output WAVs (default: %(default)s)",
    )
    return parser.parse_args()


def run(synth_url: str, output_dir: pathlib.Path) -> int:
    output_dir.mkdir(parents=True, exist_ok=True)
    success = True

    for voice in VOICES:
        payload = json.dumps({
            "text": f"Premium voice smoke test using {voice}.",
            "voice": voice,
        }).encode("utf-8")

        request = urllib.request.Request(
            synth_url,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                audio_bytes = response.read()
                sample_rate = response.headers.get("X-Sample-Rate", "unknown")

            output_path = output_dir / f"{voice}.wav"
            output_path.write_bytes(audio_bytes)
            print(f"[OK] {voice} bytes={len(audio_bytes)} sample_rate={sample_rate}")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "ignore")
            print(f"[HTTP ERROR] {voice} status={exc.code} detail={detail}")
            success = False
        except Exception as exc:  # noqa: BLE001
            print(f"[ERROR] {voice} error={exc}")
            success = False

    return 0 if success else 1


if __name__ == "__main__":
    args = parse_args()
    sys.exit(run(args.url, pathlib.Path(args.output_dir)))
