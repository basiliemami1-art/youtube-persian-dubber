#!/usr/bin/env python3
"""
Download Persian Piper voices into server/models/.

The catalogue lives in the rhasspy/piper-voices repository on Hugging Face.
Rather than hard-code file names that come and go, this reads voices.json and
picks whatever Persian voices it actually lists today.

Usage:
    python download_models.py                 # list what's on offer, download the default
    python download_models.py --list          # only list
    python download_models.py --voice fa_IR-amir-medium
    python download_models.py --all
    python download_models.py --quality high  # prefer higher quality when picking
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO = "https://huggingface.co/rhasspy/piper-voices/resolve/main"
CATALOGUE = f"{REPO}/voices.json"
MODELS_DIR = Path(__file__).resolve().parent / "models"
QUALITY_ORDER = {"x_low": 0, "low": 1, "medium": 2, "high": 3}


def fetch_catalogue() -> dict:
    print(f"reading catalogue from {CATALOGUE}")
    request = urllib.request.Request(CATALOGUE, headers={"User-Agent": "dub-setup/1.0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def persian_voices(catalogue: dict) -> list[dict]:
    out = []
    for key, entry in catalogue.items():
        language = entry.get("language") or {}
        code = str(language.get("code") or "")
        if not code.lower().startswith("fa"):
            continue
        out.append(
            {
                "key": key,
                "name": entry.get("name") or key,
                "quality": entry.get("quality") or "",
                "files": list((entry.get("files") or {}).keys()),
                "num_speakers": entry.get("num_speakers", 1),
            }
        )
    out.sort(key=lambda v: (-QUALITY_ORDER.get(v["quality"], 0), v["key"]))
    return out


def download(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".part")
    print(f"  -> {destination.name}")
    request = urllib.request.Request(url, headers={"User-Agent": "dub-setup/1.0"})
    with urllib.request.urlopen(request, timeout=300) as response, temporary.open("wb") as handle:
        total = int(response.headers.get("Content-Length") or 0)
        done = 0
        while True:
            chunk = response.read(262144)
            if not chunk:
                break
            handle.write(chunk)
            done += len(chunk)
            if total:
                percent = done * 100 // total
                print(f"     {percent:3d}%  {done / 1e6:.1f} / {total / 1e6:.1f} MB", end="\r")
    print(" " * 60, end="\r")
    temporary.replace(destination)


def install(voice: dict) -> None:
    """Fetch the .onnx and its .onnx.json for one voice."""
    model_files = [f for f in voice["files"] if f.endswith(".onnx")]
    config_files = [f for f in voice["files"] if f.endswith(".onnx.json")]
    if not model_files or not config_files:
        raise RuntimeError(f"catalogue entry for {voice['key']} is missing files")

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    model_target = MODELS_DIR / Path(model_files[0]).name
    config_target = MODELS_DIR / Path(config_files[0]).name

    if model_target.exists() and config_target.exists():
        print(f"{voice['key']} already installed, skipping")
        return

    print(f"installing {voice['key']} ({voice['quality']})")
    download(f"{REPO}/{model_files[0]}", model_target)
    download(f"{REPO}/{config_files[0]}", config_target)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", action="store_true", help="only show available voices")
    parser.add_argument("--voice", help="install one specific voice key")
    parser.add_argument("--all", action="store_true", help="install every Persian voice")
    parser.add_argument("--quality", default="medium", help="preferred quality when auto-picking")
    args = parser.parse_args()

    try:
        catalogue = fetch_catalogue()
    except urllib.error.URLError as exc:
        print(f"could not reach Hugging Face: {exc}", file=sys.stderr)
        print("check your connection or a proxy/VPN, then try again.", file=sys.stderr)
        return 1

    voices = persian_voices(catalogue)
    if not voices:
        print("no Persian voices are listed in the catalogue right now.", file=sys.stderr)
        return 1

    print(f"\n{len(voices)} Persian voice(s) available:\n")
    for voice in voices:
        print(f"  {voice['key']:<34} quality={voice['quality']:<7} speakers={voice['num_speakers']}")
    print()

    if args.list:
        return 0

    if args.all:
        targets = voices
    elif args.voice:
        targets = [v for v in voices if v["key"] == args.voice]
        if not targets:
            print(f"no voice named {args.voice}", file=sys.stderr)
            return 1
    else:
        preferred = [v for v in voices if v["quality"] == args.quality]
        targets = [(preferred or voices)[0]]

    for voice in targets:
        try:
            install(voice)
        except Exception as exc:  # noqa: BLE001
            print(f"failed to install {voice['key']}: {exc}", file=sys.stderr)

    installed = sorted(p.name for p in MODELS_DIR.glob("*.onnx"))
    print(f"\nmodels/ now contains: {', '.join(installed) or '(nothing)'}")

    if shutil.which("piper") is None:
        try:
            import piper  # noqa: F401
        except ImportError:
            print("\nreminder: pip install piper-tts   (needed by server.py)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
