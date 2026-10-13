"""Download a pinned tiny model for packaging validation, never for the app bundle."""

from __future__ import annotations

import argparse
from pathlib import Path

from huggingface_hub import snapshot_download

MODEL_REPO = "Systran/faster-whisper-tiny"
MODEL_REVISION = "d90ca5fe260221311c53c58e660288d3deb8d356"
MODEL_FILES = ("config.json", "model.bin", "tokenizer.json", "vocabulary.txt")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="Directory outside the packaged application")
    args = parser.parse_args()

    snapshot_download(
        MODEL_REPO,
        revision=MODEL_REVISION,
        allow_patterns=MODEL_FILES,
        local_dir=args.output,
    )
    if not all((args.output / name).is_file() for name in MODEL_FILES):
        raise RuntimeError("The validation model is incomplete")
    print(f"Validation model ready: {MODEL_REPO}@{MODEL_REVISION}")


if __name__ == "__main__":
    main()
