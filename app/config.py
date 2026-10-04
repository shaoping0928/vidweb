import json
import os
import shutil
import string
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
STATIC_DIR = BASE_DIR / "static"
THUMB_DIR = DATA_DIR / "thumbs"
PLAYLIST_DIR = DATA_DIR / "playlists"
SCREENSHOT_DIR = DATA_DIR / "screenshots"
CONFIG_FILE = BASE_DIR / "config.json"

APP_NAME = "Media Web"
APP_VERSION = "1.0.0"

DEFAULTS = {
    "host": "127.0.0.1",
    "port": 8765,
    "allowed_roots": [],
    "library_dirs": [],
    "ffmpeg": "",
    "ffprobe": "",
}


def load_config() -> dict:
    cfg = dict(DEFAULTS)
    if CONFIG_FILE.exists():
        try:
            data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                cfg.update(data)
        except (OSError, ValueError):
            pass
    return cfg


def save_config(cfg: dict) -> None:
    CONFIG_FILE.write_text(
        json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def detect_roots() -> list:
    if os.name == "nt":
        roots = [f"{c}:\\" for c in string.ascii_uppercase if Path(f"{c}:\\").exists()]
    else:
        roots = ["/"]
    return roots or [str(Path.home())]


def allowed_roots() -> list:
    raw = [str(p) for p in (load_config().get("allowed_roots") or []) if str(p).strip()]
    if not raw:
        raw = detect_roots()
    return [Path(p) for p in raw]


def _resolve_tool(value: str, name: str):
    value = (value or "").strip()
    if value:
        path = Path(value)
        if path.is_dir():
            path = path / (name + (".exe" if os.name == "nt" else ""))
        return str(path) if path.exists() else value
    return shutil.which(name)


def ffmpeg_path():
    return _resolve_tool(load_config().get("ffmpeg", ""), "ffmpeg")


def ffprobe_path():
    return _resolve_tool(load_config().get("ffprobe", ""), "ffprobe")


VIDEO_EXTS = {"mp4", "avi", "mkv", "mov", "wmv", "flv", "m4v", "webm"}
SUBTITLE_EXTS = {"srt", "ass", "ssa", "vtt"}

MIME_TYPES = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
    ".mov": "video/quicktime",
    ".flv": "video/x-flv",
    ".wmv": "video/x-ms-wmv",
    ".mpg": "video/mpeg",
    ".mpeg": "video/mpeg",
    ".ts": "video/mp2t",
}
