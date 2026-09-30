"""Turnnote ASR sidecar protocol foundation.

The production transcription implementation will be added behind this protocol.
stdout is reserved for JSON Lines responses; diagnostics belong on stderr.
"""

from __future__ import annotations

import json
import sys
from typing import Any


def respond(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def handle(request: dict[str, Any]) -> dict[str, Any]:
    request_id = request.get("id")
    request_type = request.get("type")
    if request_type == "ping":
        return {"id": request_id, "type": "pong", "status": "ok"}
    if request_type == "transcribe":
        return {
            "id": request_id,
            "type": "error",
            "code": "NOT_IMPLEMENTED",
            "message": "Transcription worker is not implemented in the project foundation.",
        }
    return {
        "id": request_id,
        "type": "error",
        "code": "UNKNOWN_REQUEST",
        "message": "Unsupported sidecar request type.",
    }


for line in sys.stdin:
    try:
        request = json.loads(line)
        if not isinstance(request, dict):
            raise ValueError("request must be an object")
        respond(handle(request))
    except (json.JSONDecodeError, ValueError) as exc:
        respond({"id": None, "type": "error", "code": "INVALID_JSON", "message": str(exc)})
