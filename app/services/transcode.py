import hashlib
import os
import subprocess
import threading
import time
import uuid
from pathlib import Path

from .. import config, db
from . import media_info

_jobs = {}
_lock = threading.Lock()
_MAX_AGE = 3600
TRANSCODE_DIR = config.DATA_DIR / "transcode"


class TranscodeCancelled(Exception):
    pass


def cache_path_for(path: str) -> Path:
    source = Path(path)
    try:
        stat = source.stat()
        stamp = f"{os.path.abspath(path)}|{stat.st_size}|{int(stat.st_mtime)}"
    except OSError:
        stamp = os.path.abspath(path)
    key = hashlib.md5(stamp.encode("utf-8")).hexdigest()
    return TRANSCODE_DIR / (key + ".mp4")


def cached(path: str):
    target = cache_path_for(path)
    return str(target) if target.exists() and target.stat().st_size > 0 else None


def _prune():
    now = time.time()
    for job_id in list(_jobs):
        job = _jobs[job_id]
        if job["finished_at"] and now - job["finished_at"] > _MAX_AGE:
            _jobs.pop(job_id, None)


def start(path: str, ip: str = "") -> str:
    _prune()
    job_id = uuid.uuid4().hex[:12]
    job = {
        "id": job_id,
        "path": path,
        "ip": ip,
        "state": "running",
        "progress": 0.0,
        "duration_ms": 0,
        "output": "",
        "error": "",
        "cancel": False,
        "started_at": time.time(),
        "finished_at": 0,
    }
    with _lock:
        _jobs[job_id] = job
    try:
        db.create_task(job_id, "transcode", "转码", path, ip)
    except Exception:
        pass
    threading.Thread(target=_run, args=(job,), name="transcode-" + job_id, daemon=True).start()
    return job_id


def get_job(job_id: str):
    with _lock:
        return _jobs.get(job_id)


def cancel_job(job_id: str) -> bool:
    job = get_job(job_id)
    if not job or job["finished_at"]:
        return False
    job["cancel"] = True
    return True


def _run(job: dict):
    output = cache_path_for(job["path"])
    temp = output.with_suffix(".part.mp4")
    try:
        ffmpeg = config.ffmpeg_path()
        if not ffmpeg:
            raise RuntimeError("未检测到 ffmpeg")
        info = media_info.probe(job["path"]) or {}
        job["duration_ms"] = info.get("duration_ms") or 0
        db.update_task(job["id"], state="running", total=job["duration_ms"])
        TRANSCODE_DIR.mkdir(parents=True, exist_ok=True)
        cmd = [
            ffmpeg, "-hide_banner", "-y", "-i", job["path"],
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
            "-c:a", "aac", "-b:a", "160k",
            "-movflags", "+faststart",
            "-progress", "pipe:1", "-nostats",
            str(temp),
        ]
        kwargs = {"stdout": subprocess.PIPE, "stderr": subprocess.DEVNULL}
        if os.name == "nt":
            kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        proc = subprocess.Popen(cmd, **kwargs)
        try:
            for raw in proc.stdout:
                if job["cancel"]:
                    raise TranscodeCancelled()
                line = raw.decode("utf-8", "replace").strip()
                if line.startswith("out_time_us="):
                    try:
                        out_ms = int(line.split("=", 1)[1]) // 1000
                    except ValueError:
                        continue
                    if job["duration_ms"]:
                        job["progress"] = min(100.0, out_ms * 100.0 / job["duration_ms"])
                        db.update_task(
                            job["id"], state="running",
                            processed=out_ms, total=job["duration_ms"],
                        )
            proc.wait()
        finally:
            if proc.poll() is None:
                proc.kill()
        if job["cancel"]:
            raise TranscodeCancelled()
        if proc.returncode != 0 or not temp.exists() or temp.stat().st_size <= 0:
            raise RuntimeError("ffmpeg 转码失败")
        os.replace(temp, output)
        job["output"] = str(output)
        job["progress"] = 100.0
        job["state"] = "done"
        db.finish_task(job["id"], "done", processed=job["duration_ms"], added=1)
    except TranscodeCancelled:
        job["state"] = "cancelled"
        job["error"] = "已取消"
        db.finish_task(job["id"], "cancelled", error="已取消")
    except Exception as exc:
        job["state"] = "error"
        job["error"] = str(exc)
        db.finish_task(job["id"], "error", error=str(exc))
    finally:
        try:
            if temp.exists():
                temp.unlink()
        except OSError:
            pass
        job["finished_at"] = time.time()
