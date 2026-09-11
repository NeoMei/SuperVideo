"""Narrow adapter for the audited OpenMontage tools."""

from __future__ import annotations

from dataclasses import asdict, is_dataclass
from pathlib import Path
from typing import Any


def execute(request: dict[str, Any]) -> dict[str, Any]:
    operation = request.get("operation")
    args = request.get("args")
    if operation not in {"subtitles", "mix", "tts"} or not isinstance(args, dict):
        return {"success": False, "error": "invalid bridge request", "artifacts": [], "data": {}}

    if operation == "subtitles":
        from tools.subtitle.subtitle_gen import SubtitleGen

        allowed = {"segments", "format", "max_chars_per_line", "max_words_per_cue", "highlight_style", "corrections", "output_path"}
        if not isinstance(args.get("segments"), list) or set(args) - allowed:
            return {"success": False, "error": "invalid subtitle arguments", "artifacts": [], "data": {}}
    elif operation == "tts":
        from tools.audio.elevenlabs_tts import ElevenLabsTTS

        allowed = {"text", "voice_id", "model_id", "stability", "similarity_boost", "style", "speed", "use_speaker_boost", "output_format", "output_path"}
        if not isinstance(args.get("text"), str) or not args["text"].strip() or set(args) - allowed or args.get("output_format") != "mp3_44100_128":
            return {"success": False, "error": "invalid TTS arguments", "artifacts": [], "data": {}}
    else:
        from tools.audio.audio_mixer import AudioMixer

        allowed = {"tracks", "ducking", "normalize", "loudnorm_target", "target_duration", "output_path"}
        if not isinstance(args.get("tracks"), list) or not args["tracks"] or set(args) - allowed:
            return {"success": False, "error": "invalid mix arguments", "artifacts": [], "data": {}}

    output = args.get("output_path")
    if not isinstance(output, str) or not output:
        return {"success": False, "error": "output_path is required", "artifacts": [], "data": {}}
    Path(output).parent.mkdir(parents=True, exist_ok=True)
    if operation == "subtitles":
        upstream = SubtitleGen().execute(args)
    elif operation == "tts":
        upstream = ElevenLabsTTS().execute(args)
    else:
        upstream = AudioMixer().execute({**args, "operation": "full_mix"})

    if is_dataclass(upstream):
        return asdict(upstream)
    return {
        "success": bool(getattr(upstream, "success", False)),
        "data": getattr(upstream, "data", {}) or {},
        "artifacts": getattr(upstream, "artifacts", []) or [],
        "error": getattr(upstream, "error", None),
    }
