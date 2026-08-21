#!/usr/bin/env python3
"""
Local helper for the YouTube Persian Dubber extension.

Serves two things over plain HTTP on localhost:

  POST /tts        text -> WAV, rendered by a Piper neural voice
  POST /translate  English sentences -> Persian, via Ollama or Argos Translate
  GET  /health     which voices and which translation backend are available

Nothing here talks to the internet except the optional Ollama backend, which
is itself local. Deliberately built on the standard library so that `pip
install piper-tts` is the only thing that can fail.

Usage:
    python server.py                       # 127.0.0.1:8760
    python server.py --port 9000
    python server.py --translator ollama --ollama-model qwen2.5:7b
"""

from __future__ import annotations

import argparse
import array
import io
import json
import logging
import math
import os
import re
import sys
import threading
import urllib.error
import urllib.request
import wave
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Iterable

MODELS_DIR = Path(__file__).resolve().parent / "models"
MAX_BODY_BYTES = 2 * 1024 * 1024
TTS_CACHE_SIZE = 128

# --- voice consistency -----------------------------------------------------
#
# Piper's models are VITS, which samples a latent for every utterance. At the
# noise levels the published models ship with, rendering the *same* sentence
# twice gives waveforms with essentially zero correlation and durations that
# differ by more than half a second -- which is heard as the narrator's voice
# wandering from sentence to sentence. Sampling is what makes a single-speaker
# model sound expressive when reading a whole book; for dubbing, where every
# sentence has to sound like the same person, it is a defect.
#
# noise_scale controls timbre, noise_w_scale controls prosody and duration.
# Both are dialled well down from the model defaults (0.667 / 0.8).
DEFAULT_NOISE_SCALE = 0.25
DEFAULT_NOISE_W_SCALE = 0.25

# --- loudness --------------------------------------------------------------
#
# Piper normalises to *peak* by default, so one sharp consonant drags the rest
# of the sentence down and the dub audibly changes level line to line. Peak
# normalisation is switched off and replaced with a fixed RMS target, which is
# what actually corresponds to perceived loudness, with a ceiling so the result
# still cannot clip.
TARGET_RMS = 0.12
PEAK_CEILING = 0.95
MAX_GAIN = 6.0

# --- silence trimming ------------------------------------------------------
#
# Piper pads every utterance with a stretch of near-silence at each end. Left
# in, it costs twice: the voice starts noticeably after its cue (the padding is
# counted as speech by the planner) and consecutive sentences are separated by
# dead air that no real narrator would leave. Trimming it back to a short,
# deliberate margin is the single clearest gain in how tight the dub feels.
EDGE_FADE_SECONDS = 0.006  # slicing mid-waveform leaves a step, a step clicks

# Piper leaves a small pad of silence around every utterance. A couple hundred
# milliseconds at the tail sounds harmless in isolation, but dubbing is made
# from hundreds of short files: the pads become audible gaps and make the
# planner believe speech takes longer than it really does. Keep a little room
# so initial/final consonants are never clipped, and remove only the excess.
SILENCE_RELATIVE_THRESHOLD = 0.008  # about -42 dB from the utterance peak
SILENCE_ABSOLUTE_THRESHOLD = 64  # still works on unusually quiet raw output
LEADING_SILENCE_SECONDS = 0.015
TRAILING_SILENCE_SECONDS = 0.040

log = logging.getLogger("dubserver")


# ---------------------------------------------------------------------------
# Piper voices
# ---------------------------------------------------------------------------


class VoiceBank:
    """Loads every *.onnx in models/ and renders text through them.

    Piper's Python API changed shape between 1.2 and 1.3 (``length_scale``
    moved into a ``SynthesisConfig`` object, and ``synthesize`` went from
    writing into a wave file to yielding audio chunks). Rather than pin a
    version, each strategy is attempted in turn and the first one that works
    for the installed build is remembered.
    """

    def __init__(
        self,
        models_dir: Path,
        noise_scale: float = DEFAULT_NOISE_SCALE,
        noise_w_scale: float = DEFAULT_NOISE_W_SCALE,
    ) -> None:
        self.models_dir = models_dir
        self.noise_scale = noise_scale
        self.noise_w_scale = noise_w_scale
        self.voices: "OrderedDict[str, Any]" = OrderedDict()
        self.meta: "OrderedDict[str, dict]" = OrderedDict()
        self._strategy: Callable[[Any, str, float], bytes] | None = None
        self._lock = threading.Lock()
        self._cache: "OrderedDict[tuple, bytes]" = OrderedDict()
        self._load()

    # -- loading ----------------------------------------------------------

    def _load(self) -> None:
        if not self.models_dir.is_dir():
            log.warning("models directory %s does not exist", self.models_dir)
            return

        try:
            from piper import PiperVoice  # type: ignore
        except ImportError:
            log.warning(
                "piper-tts is not installed; /tts will be unavailable. "
                "Run: pip install piper-tts"
            )
            return

        for model_path in sorted(self.models_dir.glob("*.onnx")):
            config_path = Path(str(model_path) + ".json")
            if not config_path.exists():
                alt = model_path.with_suffix(".json")
                config_path = alt if alt.exists() else config_path
            if not config_path.exists():
                log.warning("skipping %s: no matching .json config", model_path.name)
                continue

            try:
                voice = PiperVoice.load(str(model_path), config_path=str(config_path))
            except Exception as exc:  # noqa: BLE001 - report and continue
                log.warning("failed to load %s: %s", model_path.name, exc)
                continue

            voice_id = model_path.stem
            self.voices[voice_id] = voice
            try:
                config = json.loads(config_path.read_text(encoding="utf-8"))
            except Exception:  # noqa: BLE001
                config = {}
            self.meta[voice_id] = {
                "id": voice_id,
                "name": config.get("dataset") or voice_id,
                "language": (config.get("language") or {}).get("code", ""),
                "sample_rate": self._sample_rate(voice),
            }
            log.info("loaded voice %s", voice_id)

        if not self.voices:
            log.warning("no Piper voices found in %s", self.models_dir)

    @staticmethod
    def _sample_rate(voice: Any) -> int:
        config = getattr(voice, "config", None)
        rate = getattr(config, "sample_rate", None)
        return int(rate) if rate else 22050

    # -- synthesis --------------------------------------------------------

    @staticmethod
    def _wrap_wav(pcm: bytes, sample_rate: int) -> bytes:
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(sample_rate)
            handle.writeframes(pcm)
        return buffer.getvalue()

    def _synth_config(self, length_scale: float):
        from piper import SynthesisConfig  # type: ignore

        kwargs = {"length_scale": length_scale}
        # Older builds do not accept these; fall back to whatever they take.
        for name, value in (
            ("noise_scale", self.noise_scale),
            ("noise_w_scale", self.noise_w_scale),
            ("normalize_audio", False),
        ):
            try:
                SynthesisConfig(**{**kwargs, name: value})
            except TypeError:
                continue
            kwargs[name] = value
        return SynthesisConfig(**kwargs)

    # -- loudness ---------------------------------------------------------

    @staticmethod
    def _trim_silence(wav_bytes: bytes) -> bytes:
        """Remove model padding while preserving a short, safe edge.

        Detection is relative to each utterance's peak because this runs before
        loudness normalisation. It works in complete sample frames, so stereo
        voices remain aligned if support for one is added later.
        """
        try:
            with wave.open(io.BytesIO(wav_bytes)) as handle:
                channels = handle.getnchannels()
                width = handle.getsampwidth()
                rate = handle.getframerate()
                frames = handle.readframes(handle.getnframes())
        except Exception:  # noqa: BLE001 - trimming must never break synthesis
            return wav_bytes

        if width != 2 or channels <= 0 or rate <= 0 or not frames:
            return wav_bytes

        samples = array.array("h")
        samples.frombytes(frames)
        frame_count = len(samples) // channels
        if frame_count <= 1:
            return wav_bytes

        peak = max(abs(value) for value in samples)
        threshold = max(
            SILENCE_ABSOLUTE_THRESHOLD,
            int(peak * SILENCE_RELATIVE_THRESHOLD),
        )

        first = None
        last = None
        for frame_index in range(frame_count):
            offset = frame_index * channels
            if any(abs(samples[offset + channel]) >= threshold for channel in range(channels)):
                if first is None:
                    first = frame_index
                last = frame_index

        if first is None or last is None:
            return wav_bytes

        keep_before = round(rate * LEADING_SILENCE_SECONDS)
        keep_after = round(rate * TRAILING_SILENCE_SECONDS)
        start_frame = max(0, first - keep_before)
        end_frame = min(frame_count, last + keep_after + 1)
        if start_frame == 0 and end_frame == frame_count:
            return wav_bytes

        start_sample = start_frame * channels
        end_sample = end_frame * channels
        kept = samples[start_sample:end_sample]

        # Cutting at an arbitrary sample leaves a step in the waveform, and a
        # step is heard as a click at the start of every sentence. Ramp across
        # the seam instead.
        fade_frames = min(round(rate * EDGE_FADE_SECONDS), (end_frame - start_frame) // 2)
        for i in range(fade_frames):
            factor = i / fade_frames
            head = i * channels
            tail = len(kept) - (i + 1) * channels
            for channel in range(channels):
                kept[head + channel] = int(kept[head + channel] * factor)
                kept[tail + channel] = int(kept[tail + channel] * factor)

        trimmed = kept.tobytes()

        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as handle:
            handle.setnchannels(channels)
            handle.setsampwidth(width)
            handle.setframerate(rate)
            handle.writeframes(trimmed)
        return buffer.getvalue()

    @staticmethod
    def _normalise(wav_bytes: bytes) -> bytes:
        """Bring a rendered sentence to a fixed perceived loudness.

        Works on the WAV container rather than the raw samples so it applies
        whichever synthesis strategy produced the audio.
        """
        try:
            with wave.open(io.BytesIO(wav_bytes)) as handle:
                channels = handle.getnchannels()
                width = handle.getsampwidth()
                rate = handle.getframerate()
                frames = handle.readframes(handle.getnframes())
        except Exception:  # noqa: BLE001 - never let levelling break playback
            return wav_bytes

        if width != 2 or not frames:
            return wav_bytes

        samples = array.array("h")
        samples.frombytes(frames)
        if not samples:
            return wav_bytes

        try:
            import numpy as np

            data = np.frombuffer(frames, dtype=np.int16).astype(np.float32)
            rms = float(np.sqrt(np.mean(data * data))) / 32768.0
            peak = float(np.max(np.abs(data))) / 32768.0
        except Exception:  # noqa: BLE001 - numpy is optional
            total = 0.0
            peak_raw = 0
            for value in samples:
                total += float(value) * value
                if abs(value) > peak_raw:
                    peak_raw = abs(value)
            rms = math.sqrt(total / len(samples)) / 32768.0
            peak = peak_raw / 32768.0
            data = None

        if rms <= 1e-6:
            return wav_bytes

        gain = min(TARGET_RMS / rms, MAX_GAIN)
        if peak > 0:
            gain = min(gain, PEAK_CEILING / peak)
        if abs(gain - 1.0) < 0.02:
            return wav_bytes

        if data is not None:
            scaled = np.clip(data * gain, -32768, 32767).astype(np.int16)
            out = scaled.tobytes()
        else:
            for i, value in enumerate(samples):
                samples[i] = max(-32768, min(32767, int(value * gain)))
            out = samples.tobytes()

        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as handle:
            handle.setnchannels(channels)
            handle.setsampwidth(width)
            handle.setframerate(rate)
            handle.writeframes(out)
        return buffer.getvalue()

    # Each strategy either returns WAV bytes or raises.

    def _try_synthesize_wav_new(self, voice: Any, text: str, ls: float) -> bytes:
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as handle:
            voice.synthesize_wav(text, handle, syn_config=self._synth_config(ls))
        return buffer.getvalue()

    def _try_chunks_new(self, voice: Any, text: str, ls: float) -> bytes:
        chunks: Iterable[Any] = voice.synthesize(text, syn_config=self._synth_config(ls))
        pcm = bytearray()
        rate = self._sample_rate(voice)
        for chunk in chunks:
            data = getattr(chunk, "audio_int16_bytes", None)
            if data is None:
                array = getattr(chunk, "audio_int16_array", None)
                data = array.tobytes() if array is not None else bytes(chunk)
            pcm += data
            rate = getattr(chunk, "sample_rate", rate) or rate
        if not pcm:
            raise RuntimeError("empty audio")
        return self._wrap_wav(bytes(pcm), rate)

    def _try_stream_raw(self, voice: Any, text: str, ls: float) -> bytes:
        pcm = bytearray()
        for block in voice.synthesize_stream_raw(text, length_scale=ls):
            pcm += block
        if not pcm:
            raise RuntimeError("empty audio")
        return self._wrap_wav(bytes(pcm), self._sample_rate(voice))

    def _try_synthesize_old(self, voice: Any, text: str, ls: float) -> bytes:
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as handle:
            voice.synthesize(text, handle, length_scale=ls)
        return buffer.getvalue()

    def synthesize(self, text: str, voice_id: str, length_scale: float) -> bytes:
        if not self.voices:
            raise RuntimeError("no Piper voices loaded")

        voice_id = voice_id if voice_id in self.voices else next(iter(self.voices))
        key = (voice_id, round(length_scale, 3), text)

        with self._lock:
            hit = self._cache.get(key)
            if hit is not None:
                self._cache.move_to_end(key)
                return hit

        voice = self.voices[voice_id]
        strategies = [
            self._try_synthesize_wav_new,
            self._try_chunks_new,
            self._try_stream_raw,
            self._try_synthesize_old,
        ]
        if self._strategy is not None:
            strategies.insert(0, self._strategy)

        errors = []
        for strategy in strategies:
            try:
                audio = strategy(voice, text, length_scale)
            except Exception as exc:  # noqa: BLE001 - try the next API shape
                errors.append(f"{strategy.__name__}: {exc}")
                continue
            if not audio or len(audio) <= 44:  # 44 bytes is a bare WAV header
                # Every strategy failing this way means the text produced no
                # phonemes at all -- almost always mangled encoding rather
                # than an API mismatch, so say so plainly.
                errors.append(f"{strategy.__name__}: no audio produced")
                continue
            self._strategy = strategy
            audio = self._trim_silence(audio)
            audio = self._normalise(audio)
            with self._lock:
                self._cache[key] = audio
                while len(self._cache) > TTS_CACHE_SIZE:
                    self._cache.popitem(last=False)
            return audio

        if all("no audio produced" in e for e in errors):
            raise RuntimeError(
                "Piper produced no audio for this text. The most likely cause is "
                "that the request body was not sent as UTF-8. -> " + " | ".join(errors)
            )
        raise RuntimeError("piper synthesis failed -> " + " | ".join(errors))

    def listing(self) -> list[dict]:
        return list(self.meta.values())


# ---------------------------------------------------------------------------
# Translation backends
# ---------------------------------------------------------------------------


class Translator:
    name = "none"

    def available(self) -> bool:
        return False

    def translate(
        self,
        texts: list[str],
        source: str,
        target: str,
        durations: list[float] | None = None,
    ) -> list[str]:
        return list(texts)


class ArgosTranslator(Translator):
    name = "argos"

    def __init__(self) -> None:
        self._module = None
        try:
            import argostranslate.translate as module  # type: ignore

            self._module = module
        except ImportError:
            log.info("argostranslate not installed")

    def available(self) -> bool:
        return self._module is not None

    def translate(
        self,
        texts: list[str],
        source: str,
        target: str,
        durations: list[float] | None = None,
    ) -> list[str]:
        if self._module is None:
            return list(texts)
        out = []
        for text in texts:
            try:
                out.append(self._module.translate(text, source, target))
            except Exception as exc:  # noqa: BLE001
                log.warning("argos failed on one sentence: %s", exc)
                out.append(text)
        return out


class OllamaTranslator(Translator):
    """Translate through a local Ollama model.

    Sentences go over in small numbered batches: enough context for the model
    to keep pronouns and tense consistent, small enough that a malformed reply
    costs little. If the reply does not line up one-to-one with the input, the
    batch is retried sentence by sentence rather than silently misaligning the
    subtitles.
    """

    name = "ollama"
    BATCH = 8

    SYSTEM = (
        "You are a professional subtitle translator. Translate each numbered "
        "line from {source} into natural, conversational Iranian {target} made "
        "to be spoken aloud in a video dub. Preserve meaning, names, tone and "
        "terminology, but avoid literal or stiff wording. Each line includes "
        "its speaking-time budget; be concise enough to fit it without dropping "
        "important meaning. Keep exactly the same number of lines and the same "
        "numbering. Do not add notes, explanations, transliteration, headings "
        "or quotation marks. Context lines, when present, are reference only: "
        "never output or renumber them."
    )

    def __init__(self, host: str, model: str) -> None:
        self.host = host.rstrip("/")
        self.model = model

    def available(self) -> bool:
        try:
            with urllib.request.urlopen(f"{self.host}/api/tags", timeout=3) as res:
                return res.status == 200
        except Exception:  # noqa: BLE001
            return False

    def _generate(self, prompt: str, system: str) -> str:
        payload = json.dumps(
            {
                "model": self.model,
                "prompt": prompt,
                "system": system,
                "stream": False,
                "options": {"temperature": 0.2, "num_ctx": 4096},
            }
        ).encode("utf-8")
        request = urllib.request.Request(
            f"{self.host}/api/generate",
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=180) as res:
            body = json.loads(res.read().decode("utf-8"))
        return str(body.get("response", "")).strip()

    @staticmethod
    def _parse(reply: str, expected: int) -> list[str] | None:
        lines = [ln.strip() for ln in reply.splitlines() if ln.strip()]
        parsed: dict[int, str] = {}
        for line in lines:
            match = re.match(r"^\[?(\d+)[\].:)\-]\s*(.+)$", line)
            if match:
                parsed[int(match.group(1))] = match.group(2).strip()
        if len(parsed) != expected:
            return None
        try:
            return [parsed[i + 1] for i in range(expected)]
        except KeyError:
            return None

    def _translate_batch(
        self,
        texts: list[str],
        source: str,
        target: str,
        durations: list[float] | None = None,
        context: list[tuple[str, str]] | None = None,
    ) -> list[str]:
        system = self.SYSTEM.format(source=source, target=target)
        prompt_parts = []
        if context:
            prompt_parts.append("Previous context (reference only, do not output):")
            for original, translated in context:
                prompt_parts.append(f"- {source}: {original}")
                prompt_parts.append(f"  {target}: {translated}")
            prompt_parts.append("")
        prompt_parts.append("Lines to translate:")
        for i, text in enumerate(texts):
            seconds = durations[i] if durations and i < len(durations) else 0
            budget = f" [{seconds:.1f}s]" if seconds > 0 else ""
            prompt_parts.append(f"{i + 1}.{budget} {text}")
        prompt = "\n".join(prompt_parts)
        try:
            reply = self._generate(prompt, system)
        except Exception as exc:  # noqa: BLE001
            log.warning("ollama batch failed: %s", exc)
            return list(texts)

        parsed = self._parse(reply, len(texts))
        if parsed is not None:
            return parsed

        log.info("ollama reply did not line up; falling back to one sentence at a time")
        out = []
        single_system = (
            f"Translate the following {source} subtitle into natural, conversational "
            f"Iranian {target} for spoken video dubbing. Preserve the meaning, name, "
            "tone and terminology, but avoid literal or stiff wording. Be concise "
            "enough for the stated speaking-time budget. Return only the translation, "
            "with no number, note, heading or quotation marks."
        )
        for i, text in enumerate(texts):
            try:
                seconds = durations[i] if durations and i < len(durations) else 0
                prompt = f"Speaking-time budget: {seconds:.1f}s\n{text}" if seconds > 0 else text
                single = self._generate(
                    prompt,
                    single_system,
                )
                out.append(single.splitlines()[0].strip() if single else text)
            except Exception:  # noqa: BLE001
                out.append(text)
        return out

    def translate(
        self,
        texts: list[str],
        source: str,
        target: str,
        durations: list[float] | None = None,
    ) -> list[str]:
        source_name = LANG_NAMES.get(source, source)
        target_name = LANG_NAMES.get(target, target)
        out: list[str] = []
        context: list[tuple[str, str]] = []
        for i in range(0, len(texts), self.BATCH):
            batch_texts = texts[i : i + self.BATCH]
            batch_durations = durations[i : i + self.BATCH] if durations else None
            translated = self._translate_batch(
                batch_texts,
                source_name,
                target_name,
                batch_durations,
                context,
            )
            out.extend(translated)
            context = (context + list(zip(batch_texts, translated)))[-2:]
        return out


LANG_NAMES = {"en": "English", "fa": "Persian (Farsi)", "auto": "the source language"}


# ---------------------------------------------------------------------------
# HTTP layer
# ---------------------------------------------------------------------------


class Handler(BaseHTTPRequestHandler):
    server_version = "DubServer/1.0"
    protocol_version = "HTTP/1.1"

    bank: VoiceBank
    translator: Translator

    # -- plumbing ---------------------------------------------------------

    def log_message(self, fmt: str, *args: Any) -> None:
        log.debug("%s - %s", self.address_string(), fmt % args)

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, payload: dict) -> None:
        self._send(status, json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > MAX_BODY_BYTES:
            raise ValueError("request body too large")
        return json.loads(self.rfile.read(length).decode("utf-8"))

    # -- routes -----------------------------------------------------------

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self.path.split("?")[0] != "/health":
            self._json(404, {"error": "not found"})
            return
        self._json(
            200,
            {
                "ok": True,
                "voices": self.bank.listing(),
                "translator": self.translator.name,
                "translatorReady": self.translator.available(),
            },
        )

    def do_POST(self) -> None:  # noqa: N802
        route = self.path.split("?")[0]
        try:
            body = self._read_json()
        except Exception as exc:  # noqa: BLE001
            self._json(400, {"error": f"bad request: {exc}"})
            return

        if route == "/tts":
            self._handle_tts(body)
        elif route == "/translate":
            self._handle_translate(body)
        else:
            self._json(404, {"error": "not found"})

    def _handle_tts(self, body: dict) -> None:
        text = str(body.get("text") or "").strip()
        if not text:
            self._json(400, {"error": "text is required"})
            return
        try:
            length_scale = float(body.get("length_scale") or 1.0)
        except (TypeError, ValueError):
            length_scale = 1.0
        length_scale = min(2.5, max(0.4, length_scale))

        try:
            audio = self.bank.synthesize(text, str(body.get("voice") or ""), length_scale)
        except Exception as exc:  # noqa: BLE001
            log.error("tts failed: %s", exc)
            self._json(500, {"error": str(exc)})
            return
        self._send(200, audio, "audio/wav")

    def _handle_translate(self, body: dict) -> None:
        texts = body.get("texts")
        if not isinstance(texts, list) or not all(isinstance(t, str) for t in texts):
            self._json(400, {"error": "texts must be a list of strings"})
            return
        source = str(body.get("source") or "en")
        target = str(body.get("target") or "fa")
        raw_durations = body.get("durations")
        durations = None
        if isinstance(raw_durations, list):
            durations = []
            for value in raw_durations[: len(texts)]:
                try:
                    durations.append(max(0.0, float(value)))
                except (TypeError, ValueError):
                    durations.append(0.0)
            if len(durations) < len(texts):
                durations.extend([0.0] * (len(texts) - len(durations)))

        if not self.translator.available():
            self._json(
                503,
                {"error": f"translation backend '{self.translator.name}' is not available"},
            )
            return

        try:
            translations = self.translator.translate(texts, source, target, durations)
        except Exception as exc:  # noqa: BLE001
            log.error("translate failed: %s", exc)
            self._json(500, {"error": str(exc)})
            return
        self._json(200, {"translations": translations})


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def build_translator(kind: str, ollama_host: str, ollama_model: str) -> Translator:
    if kind == "ollama":
        return OllamaTranslator(ollama_host, ollama_model)
    if kind == "argos":
        return ArgosTranslator()
    if kind == "auto":
        ollama = OllamaTranslator(ollama_host, ollama_model)
        if ollama.available():
            return ollama
        argos = ArgosTranslator()
        if argos.available():
            return argos
    return Translator()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8760)
    parser.add_argument("--models", default=str(MODELS_DIR))
    parser.add_argument(
        "--translator",
        default=os.environ.get("DUB_TRANSLATOR", "auto"),
        choices=["auto", "ollama", "argos", "none"],
    )
    parser.add_argument("--ollama-host", default=os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434"))
    parser.add_argument("--ollama-model", default=os.environ.get("DUB_OLLAMA_MODEL", "qwen2.5:7b"))
    parser.add_argument(
        "--noise-scale",
        type=float,
        default=DEFAULT_NOISE_SCALE,
        help="voice timbre variation; lower is more consistent (model default 0.667)",
    )
    parser.add_argument(
        "--noise-w",
        type=float,
        default=DEFAULT_NOISE_W_SCALE,
        help="prosody and duration variation; lower is more consistent (model default 0.8)",
    )
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s  %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )

    Handler.bank = VoiceBank(Path(args.models), args.noise_scale, args.noise_w)
    Handler.translator = build_translator(args.translator, args.ollama_host, args.ollama_model)

    log.info("voices     : %s", ", ".join(Handler.bank.voices) or "(none)")
    log.info(
        "voice       : noise_scale=%.3f noise_w=%.3f, RMS levelled to %.2f",
        args.noise_scale,
        args.noise_w,
        TARGET_RMS,
    )
    log.info(
        "translator : %s (%s)",
        Handler.translator.name,
        "ready" if Handler.translator.available() else "unavailable",
    )

    if not Handler.bank.voices:
        log.warning("run  python download_models.py  to fetch a Persian voice")

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    log.info("listening on http://%s:%d  (Ctrl+C to stop)", args.host, args.port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("shutting down")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
