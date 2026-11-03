"""Exercise a frozen sidecar without Python on PATH, including real local ASR."""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any


def run_worker(worker: Path, requests: list[dict[str, Any]], fake: bool) -> list[dict[str, Any]]:
    env = os.environ.copy()
    for name in ("PYTHONHOME", "PYTHONPATH", "VIRTUAL_ENV"):
        env.pop(name, None)
    with tempfile.TemporaryDirectory(prefix="turnnote-frozen-worker-") as cwd:
        env["PATH"] = cwd
        if any(shutil.which(name, path=env["PATH"]) for name in ("python", "python3", "py")):
            raise RuntimeError("Python is still available on the frozen worker PATH")
        result = subprocess.run(
            [str(worker), *(["--fake"] if fake else [])],
            input="".join(json.dumps(request) + "\n" for request in requests),
            text=True,
            capture_output=True,
            cwd=cwd,
            env=env,
            timeout=240,
            check=False,
        )
    if result.returncode != 0:
        raise RuntimeError(f"Frozen worker exited with code {result.returncode}")
    try:
        return [json.loads(line) for line in result.stdout.splitlines()]
    except json.JSONDecodeError as exc:
        raise RuntimeError("Frozen worker emitted non-JSON output") from exc


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worker", required=True, type=Path)
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--audio", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    args = parser.parse_args()

    worker = args.worker.resolve(strict=True)
    model = args.model.resolve(strict=True)
    audio = args.audio.resolve(strict=True)
    required_model = ("config.json", "model.bin", "tokenizer.json")
    if not all((model / name).is_file() for name in required_model):
        raise RuntimeError("The local model is incomplete")

    ping = run_worker(worker, [{"id": "ping-1", "type": "ping"}], fake=False)
    if ping != [{"id": "ping-1", "type": "pong", "status": "ok"}]:
        raise RuntimeError("Frozen worker ping failed")

    request = {
        "id": "asr-1",
        "type": "transcribe",
        "audioPath": str(audio),
        "language": "en",
        "modelPath": str(model),
    }
    fake = run_worker(worker, [request], fake=True)
    if not fake or fake[-1].get("type") != "done" or fake[-1].get("segmentCount") != 3:
        raise RuntimeError("Frozen worker fake mode failed")

    real = run_worker(worker, [request], fake=False)
    segments = [response for response in real if response.get("type") == "segment"]
    done = real[-1] if real else {}
    if (
        done.get("type") != "done"
        or done.get("segmentCount") != len(segments)
        or not segments
        or any(response.get("id") != "asr-1" for response in real)
        or any(not segment.get("text", "").strip() for segment in segments)
    ):
        raise RuntimeError("Frozen worker real-model transcription failed")

    report = {
        "platform": platform.system(),
        "architecture": platform.machine(),
        "pythonOnWorkerPath": False,
        "ping": "ok",
        "fake": "ok",
        "realModel": "ok",
        "detectedLanguage": done.get("detectedLanguage"),
        "durationMs": done.get("durationMs"),
        "segmentCount": len(segments),
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
