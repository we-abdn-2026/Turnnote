"""Turnnote ASR sidecar.

Protocol: docs/sidecar-protocol.md. stdout is reserved for JSON Lines responses;
diagnostics belong on stderr.

`--fake` skips model loading and returns fixed segments, for CI and machines
without a downloaded model.
"""

from __future__ import annotations

import json
import os
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import IO, Any

LANGUAGES = {"en", "zh", "auto"}
AUDIO_EXTENSIONS = {".wav", ".mp3", ".m4a"}
MODEL_FILES = ("model.bin", "config.json", "tokenizer.json")
SAMPLE_RATE = 16000

FAKE_SEGMENTS = [
    (0, 2400, "Let's review the launch plan for this week."),
    (2400, 5200, "We agreed to ship the beta on Friday."),
    (5200, 8000, "Alex will prepare the release notes."),
]

_out: IO[str] = sys.stdout


def respond(payload: dict[str, Any]) -> None:
    _out.write(json.dumps(payload, ensure_ascii=False) + "\n")
    _out.flush()


def reserve_stdout() -> IO[str]:
    """Keep fd 1 for the protocol and point it at stderr for everything else.

    Native libraries (CTranslate2, PyAV) may write to fd 1 directly; this keeps
    such output out of the JSON Lines stream.
    """
    sys.stdout.flush()
    protocol_fd = os.dup(1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    return os.fdopen(protocol_fd, "w", encoding="utf-8", newline="\n")


def diagnose(stage: str, exc: BaseException) -> None:
    # Exception text can contain the audio/model path (e.g. PyAV InvalidDataError),
    # which must not reach logs (docs/technical-solution.md §6); log the type only.
    print(f"[asr-worker] {stage} failed: {type(exc).__name__}", file=sys.stderr)


def decode_audio(path: str) -> Any:
    """Decode to 16 kHz mono float32.

    faster_whisper.decode_audio 1.2.1 passes `metadata_errors` to av.open, which
    PyAV 19 (pinned in requirements.txt) rejects, so decode with PyAV directly.
    """
    import av
    import numpy as np

    resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
    chunks = []
    with av.open(path, mode="r") as container:
        stream = next(s for s in container.streams if s.type == "audio")
        for frame in container.decode(stream):
            for resampled in resampler.resample(frame):
                chunks.append(resampled.to_ndarray().reshape(-1))
        for resampled in resampler.resample(None):
            chunks.append(resampled.to_ndarray().reshape(-1))
    if not chunks:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(chunks).astype(np.float32) / 32768.0


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


def transcribe_real(
    request_id: Any, audio_path: str, language: str, model_path: str
) -> Iterator[dict[str, Any]]:
    if Path(audio_path).suffix.lower() not in AUDIO_EXTENSIONS:
        yield error(request_id, "AUDIO_DECODE_FAILED", "Unsupported audio format.")
        return

    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        diagnose("import", exc)
        yield error(request_id, "MODEL_LOAD_FAILED", "faster-whisper is not installed.")
        return

    yield {"id": request_id, "type": "progress", "percent": 0}

    # Decode first so a bad file is reported as such, not as a transcription error
    try:
        audio = decode_audio(audio_path)
    except Exception as exc:
        diagnose("decode", exc)
        yield error(request_id, "AUDIO_DECODE_FAILED", "Audio file could not be decoded.")
        return
    if audio.size == 0:
        yield error(request_id, "AUDIO_DECODE_FAILED", "Audio file contains no samples.")
        return

    # The sidecar stays offline. A bare model name makes faster-whisper download the
    # model, and a missing tokenizer.json makes it call Tokenizer.from_pretrained,
    # which ignores local_files_only. Require every asset before loading.
    if not Path(model_path).is_dir():
        yield error(request_id, "MODEL_LOAD_FAILED", "Model directory does not exist.")
        return
    if not all((Path(model_path) / name).is_file() for name in MODEL_FILES):
        yield error(request_id, "MODEL_LOAD_FAILED", "Model files are incomplete.")
        return
    try:
        model = WhisperModel(model_path, device="cpu", compute_type="int8", local_files_only=True)
    except Exception as exc:
        diagnose("model load", exc)
        yield error(request_id, "MODEL_LOAD_FAILED", "Model could not be loaded.")
        return

    duration_ms = round(audio.size * 1000 / SAMPLE_RATE)
    count = 0
    try:
        segments, info = model.transcribe(
            audio,
            language=None if language == "auto" else language,
            vad_filter=True,
        )
        for segment in segments:
            text = segment.text.strip()
            if not text:
                continue
            # Whisper timestamps can overshoot the end of the audio. Clamp to the
            # audio, then drop segments that end up with no duration (entirely past
            # the end, zero-length, or collapsed by rounding): the shared
            # transcriptSegmentsSchema requires endMs > startMs.
            start_ms = max(0, min(round(segment.start * 1000), duration_ms))
            end_ms = max(0, min(round(segment.end * 1000), duration_ms))
            if end_ms <= start_ms:
                continue
            count += 1
            yield {
                "id": request_id,
                "type": "segment",
                "startMs": start_ms,
                "endMs": end_ms,
                "text": text,
            }
            percent = min(99, end_ms * 100 // duration_ms) if duration_ms else 99
            yield {"id": request_id, "type": "progress", "percent": percent}
    except Exception as exc:
        diagnose("transcribe", exc)
        yield error(request_id, "TRANSCRIBE_FAILED", "Transcription failed.")
        return

    yield {"id": request_id, "type": "progress", "percent": 100}
    yield {
        "id": request_id,
        "type": "done",
        "detectedLanguage": info.language,
        "durationMs": duration_ms,
        "segmentCount": count,
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
        yield from transcribe_real(
            request_id, request["audioPath"], request["language"], request["modelPath"]
        )
        return

    yield error(request_id, "UNKNOWN_REQUEST", "Unsupported sidecar request type.")


def main() -> None:
    global _out
    _out = reserve_stdout()
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
