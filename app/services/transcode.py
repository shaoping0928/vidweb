import os
import subprocess
import threading
from pathlib import Path

from .. import config
from . import media_info

ENCODER_LABELS = {
    "nvenc": "NVIDIA NVENC",
    "qsv": "Intel QuickSync",
    "amf": "AMD AMF",
    "cpu": "CPU (libx264)",
}
ENCODER_KEYS = ("nvenc", "qsv", "amf", "cpu")
REMUX_VIDEO_CODECS = {"h264", "vp9", "av1"}

_detect_lock = threading.Lock()
_detected = None


def _encoder_args(key: str):
    if key == "nvenc":
        return ["-c:v", "h264_nvenc", "-preset", "p4", "-tune", "ll", "-rc", "vbr", "-cq", "23", "-b:v", "0"]
    if key == "qsv":
        return ["-c:v", "h264_qsv", "-preset", "veryfast", "-global_quality", "23"]
    if key == "amf":
        return ["-c:v", "h264_amf", "-quality", "speed", "-rc", "cqp", "-qp_i", "23", "-qp_p", "23"]
    if key == "cpu":
        return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "22"]
    return None


def _run_kwargs():
    if os.name == "nt":
        return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}
    return {}


def _test_encoder(ffmpeg: str, key: str) -> bool:
    args = _encoder_args(key)
    if not args:
        return False
    cmd = [
        ffmpeg, "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc=duration=0.2:size=256x144:rate=10",
        "-an", *args, "-f", "null", "-",
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=15, **_run_kwargs())
    except (OSError, subprocess.SubprocessError):
        return False
    return proc.returncode == 0


def available_encoders():
    global _detected
    if _detected is not None:
        return _detected
    with _detect_lock:
        if _detected is not None:
            return _detected
        ffmpeg = config.ffmpeg_path()
        if not ffmpeg:
            _detected = []
            return _detected
        found = [key for key in ("nvenc", "qsv", "amf") if _test_encoder(ffmpeg, key)]
        found.append("cpu")
        _detected = found
        return _detected


def resolve_encoder() -> str:
    selected = (config.load_config().get("transcode_encoder") or "auto").lower()
    available = available_encoders()
    if selected in available:
        return selected
    for key in ("nvenc", "qsv", "amf"):
        if key in available:
            return key
    return "cpu"


def info() -> dict:
    cfg = config.load_config()
    enabled = bool(cfg.get("transcode"))
    result = {
        "enabled": enabled,
        "selected": (cfg.get("transcode_encoder") or "auto").lower(),
        "available": [],
        "encoder": "",
        "encoder_label": "",
    }
    if not enabled or not config.ffmpeg_path():
        return result
    available = available_encoders()
    result["available"] = [{"key": key, "label": ENCODER_LABELS[key]} for key in available]
    encoder = resolve_encoder()
    result["encoder"] = encoder
    result["encoder_label"] = ENCODER_LABELS.get(encoder, encoder)
    return result


def plan(path: str) -> dict:
    probed = media_info.streams(path) or {}
    video = probed.get("video", "")
    audio = probed.get("audio", "")
    return {
        "mode": "remux" if video in REMUX_VIDEO_CODECS else "transcode",
        "video": video,
        "audio": audio,
    }


def stream(path: str, start_ms: int = 0, plan_info: dict = None):
    ffmpeg = config.ffmpeg_path()
    if not ffmpeg:
        raise RuntimeError("未检测到 ffmpeg")
    probed = plan_info or plan(path)
    audio = probed.get("audio", "")
    remux = probed.get("mode") == "remux"
    start_s = max(0, int(start_ms)) / 1000.0
    cmd = [
        ffmpeg, "-hide_banner", "-loglevel", "error",
        "-fflags", "+discardcorrupt+genpts",
        "-err_detect", "ignore_err",
        "-ss", f"{start_s:.3f}",
        "-i", path,
    ]
    if remux:
        cmd += ["-c:v", "copy"]
    else:
        cmd += [*_encoder_args(resolve_encoder()), "-pix_fmt", "yuv420p", "-g", "48"]
    if audio == "aac":
        cmd += ["-c:a", "copy"]
    else:
        cmd += ["-c:a", "aac", "-b:a", "160k"]
    cmd += [
        "-max_interleave_delta", "0",
        "-movflags", "frag_keyframe+empty_moov+default_base_moof",
        "-f", "mp4", "pipe:1",
    ]
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        bufsize=0,
        **_run_kwargs(),
    )

    def generate():
        try:
            while True:
                chunk = proc.stdout.read(16384)
                if not chunk:
                    break
                yield chunk
        finally:
            try:
                if proc.poll() is None:
                    proc.kill()
            except OSError:
                pass
            try:
                proc.stdout.close()
            except OSError:
                pass
            proc.wait()

    return generate()
