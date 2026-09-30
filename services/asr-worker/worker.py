"""Turnnote ASR sidecar.

Protocol: docs/sidecar-protocol.md. stdout is reserved for JSON Lines responses;
diagnostics belong on stderr.

`--fake` skips model loading and returns fixed segments, for CI and machines
without a downloaded model.
"""

from __future__ import annotations

import json
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

LANGUAGES = {"en", "zh", "auto"}

FAKE_SEGMENTS = [
    (0, 2400, "Let's review the launch plan for this week."),
    (2400, 5200, "We agreed to ship the beta on Friday."),
    (5200, 8000, "Alex will prepare the release notes."),
]


def respond(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def error(request_id: Any, code: str, message: str) -> dict[str, Any]:
    return {"id": request_id, "type": "error", "code": code, "message": message}


def validate_transcribe(request: dict[str, Any]) -> str | None:
    for field in ("audioPath", "language", "modelPath"):
        if not isinstance(request.get(field), str) or not request[field]:
            return f"'{field}' must be a non-empty string."
    if request["language"] not in LANGUAGES:
        return "'language' must be one of: en, zh, auto."
    return None


def transcribe_fake(request_id: Any, language: str) -> Iterator[dict[str, Any]]:
    yield {"id": request_id, "type": "progress", "percent": 0}
    for start_ms, end_ms, text in FAKE_SEGMENTS:
        yield {
            "id": request_id,
            "type": "segment",
            "startMs": start_ms,
            "endMs": end_ms,
            "text": text,
        }
    yield {"id": request_id, "type": "progress", "percent": 100}
    yield {
        "id": request_id,
        "type": "done",
        "detectedLanguage": "en" if language == "auto" else language,
        "durationMs": FAKE_SEGMENTS[-1][1],
        "segmentCount": len(FAKE_SEGMENTS),
    }


def handle(request: dict[str, Any], fake: bool) -> Iterator[dict[str, Any]]:
    request_id = request.get("id")
    request_type = request.get("type")

    if request_type == "ping":
        yield {"id": request_id, "type": "pong", "status": "ok"}
        return

    if request_type == "transcribe":
        problem = validate_transcribe(request)
        if problem:
            yield error(request_id, "INVALID_REQUEST", problem)
            return
        if not Path(request["audioPath"]).is_file():
            yield error(request_id, "AUDIO_NOT_FOUND", "Audio file does not exist.")
            return
        if fake:
            yield from transcribe_fake(request_id, request["language"])
            return
        yield error(request_id, "NOT_IMPLEMENTED", "Transcription is not implemented yet.")
        return

    yield error(request_id, "UNKNOWN_REQUEST", "Unsupported sidecar request type.")


def main() -> None:
    fake = "--fake" in sys.argv[1:]
    for line in sys.stdin:
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("request must be an object")
        except (json.JSONDecodeError, ValueError) as exc:
            respond(error(None, "INVALID_JSON", str(exc)))
            continue
        if request.get("type") == "shutdown":
            return
        for response in handle(request, fake):
            respond(response)


if __name__ == "__main__":
    main()
