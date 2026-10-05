import hashlib
import os
import queue
import subprocess
import threading
from pathlib import Path

from .. import config, db
from . import media_info

_queue: "queue.Queue[str]" = queue.Queue()
_failed: set = set()
_failed_lock = threading.Lock()
_worker_started = False
_worker_lock = threading.Lock()
_WORKERS = 3


def cache_path_for(path: str) -> Path:
    key = hashlib.md5(os.path.abspath(path).encode("utf-8")).hexdigest()
    return config.THUMB_DIR / (key + ".jpg")


def cached(path: str):
    thumb = cache_path_for(path)
    return str(thumb) if thumb.exists() and thumb.stat().st_size > 0 else None


def cached_keys() -> set:
    try:
        return {
            entry.name
            for entry in os.scandir(config.THUMB_DIR)
            if entry.is_file()
        }
    except OSError:
        return set()


def request(path: str) -> None:
    if not path or cached(path):
        return
    with _failed_lock:
        if path in _failed:
            return
    _start_worker()
    _queue.put(path)


def request_batch(paths: list) -> None:
    for path in paths:
        request(path)


def status(path: str) -> str:
    if cached(path):
        return "ready"
    with _failed_lock:
        if path in _failed:
            return "failed"
    return "pending" if config.ffmpeg_path() else "unavailable"


def _start_worker() -> None:
    global _worker_started
    with _worker_lock:
        if _worker_started:
            return
        _worker_started = True
        for index in range(_WORKERS):
            thread = threading.Thread(
                target=_worker_loop, name=f"thumbnailer-{index}", daemon=True
            )
            thread.start()


def _worker_loop() -> None:
    while True:
        path = _queue.get()
        try:
            _generate(path)
        except Exception:
            with _failed_lock:
                _failed.add(path)
        finally:
            _queue.task_done()


def _generate(path: str) -> None:
    ffmpeg = config.ffmpeg_path()
    if not ffmpeg:
        raise RuntimeError("ffmpeg not found")
    info = media_info.probe(path) or {}
    duration = info.get("duration_ms") or 0
    if duration > 0:
        seek = min(3.0, duration / 10000.0)
        seek = max(0.1, min(seek, max(0.1, duration / 1000.0 - 0.1)))
    else:
        seek = 3.0
    out = cache_path_for(path)
    out.parent.mkdir(parents=True, exist_ok=True)

    def run(seek_seconds: float, output: Path) -> bool:
        cmd = [
            ffmpeg, "-ss", f"{seek_seconds:.3f}", "-i", path,
            "-frames:v", "1", "-vf", "scale=320:-2", "-y", str(output),
        ]
        kwargs = {"capture_output": True, "timeout": 60}
        if os.name == "nt":
            kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        proc = subprocess.run(cmd, **kwargs)
        return output.exists() and output.stat().st_size > 0

    if not run(seek, out) and seek > 0.15:
        run(0.1, out)
    file_id = db.ensure_file(path)
    if not out.exists() or out.stat().st_size <= 0:
        db.set_broken(file_id, True)
        raise RuntimeError("ffmpeg produced no frame")
    db.set_broken(file_id, False)
    db.set_thumbnail(file_id, str(out))
