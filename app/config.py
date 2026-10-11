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
    "host": "0.0.0.0",
    "port": 8765,
    "allowed_roots": [],
    "library_dirs": [],
    "ffmpeg": "",
    "ffprobe": "",
    "transcode": False,
    "transcode_encoder": "auto",
    "scan_incremental": True,
    "access_log": False,
    "hfs_exe": "",
    "hfs_url": "",
    "hfs_vfs": "",
    "hfs_args": "",
    "hfs_autostart": False,
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


VIDEO_EXTS = {
    "mp4", "m4v", "mkv", "webm", "avi", "mov", "wmv", "flv", "f4v", "ogv",
    "mpg", "mpeg", "mpe", "m2v", "ts", "m2ts", "mts", "tp", "trp",
    "vob", "rm", "rmvb", "3gp", "3g2", "asf", "divx", "mxf", "dv", "ogm", "iso",
}
AUDIO_EXTS = {
    "mp3", "flac", "wav", "wave", "aac", "m4a", "m4b", "ogg", "oga", "opus",
    "wma", "ape", "alac", "aiff", "aif", "ac3", "eac3", "dts", "mka", "amr",
    "wv", "tta",
}
MEDIA_EXTS = VIDEO_EXTS | AUDIO_EXTS
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
    ".mpe": "video/mpeg",
    ".m2v": "video/mpeg",
    ".ts": "video/mp2t",
    ".m2ts": "video/mp2t",
    ".mts": "video/mp2t",
    ".tp": "video/mp2t",
    ".trp": "video/mp2t",
    ".vob": "video/mpeg",
    ".rm": "application/vnd.rn-realmedia",
    ".rmvb": "application/vnd.rn-realmedia-vbr",
    ".3gp": "video/3gpp",
    ".3g2": "video/3gpp2",
    ".asf": "video/x-ms-asf",
    ".f4v": "video/x-f4v",
    ".ogv": "video/ogg",
    ".ogm": "video/ogg",
    ".divx": "video/divx",
    ".mxf": "application/mxf",
    ".dv": "video/dv",
    ".iso": "application/x-iso9660-image",
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac",
    ".wav": "audio/wav",
    ".wave": "audio/wav",
    ".aac": "audio/aac",
    ".m4a": "audio/mp4",
    ".m4b": "audio/mp4",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".opus": "audio/opus",
    ".wma": "audio/x-ms-wma",
    ".ape": "audio/x-ape",
    ".alac": "audio/mp4",
    ".aiff": "audio/aiff",
    ".aif": "audio/aiff",
    ".ac3": "audio/ac3",
    ".eac3": "audio/eac3",
    ".dts": "audio/vnd.dts",
    ".mka": "audio/x-matroska",
    ".amr": "audio/amr",
    ".wv": "audio/x-wavpack",
    ".tta": "audio/x-tta",
}
