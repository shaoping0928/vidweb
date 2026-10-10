import os
import threading
import time
import uuid

from .. import config, db
from . import media_info

_jobs = {}
_lock = threading.Lock()
_MAX_AGE = 3600


def start_detect(ip: str = "") -> str:
    _prune()
    job_id = uuid.uuid4().hex[:12]
    job = {
        "id": job_id,
        "state": "running",
        "total": 0,
        "processed": 0,
        "broken": 0,
        "error": "",
        "cancel": False,
        "started_at": time.time(),
        "finished_at": 0,
    }
    with _lock:
        _jobs[job_id] = job
    try:
        db.create_task(job_id, "mediacheck", "损坏检测", "ffprobe 检测无法播放的视频", ip)
    except Exception:
        pass
    threading.Thread(target=_run, args=(job,), name="mediacheck-" + job_id, daemon=True).start()
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


def _probe_broken(path: str):
    if not os.path.exists(path):
        return None
    info = media_info.streams(path)
    if not info:
        return True
    suffix = os.path.splitext(path)[1].lstrip(".").lower()
    if suffix in config.AUDIO_EXTS:
        return not info.get("audio")
    return not info.get("video")


def _run(job: dict):
    try:
        if not config.ffprobe_path():
            raise RuntimeError("未检测到 ffprobe")
        files = db.files_with_ids()
        job["total"] = len(files)
        db.update_task(job["id"], state="running", total=job["total"])
        broken = 0
        for index, item in enumerate(files, 1):
            if job["cancel"]:
                job["state"] = "cancelled"
                db.finish_task(
                    job["id"], "cancelled", error="已取消", processed=index - 1, added=broken
                )
                return
            value = _probe_broken(item["path"])
            if value is not None:
                db.set_broken(item["id"], value)
                if value:
                    broken += 1
            job["processed"] = index
            job["broken"] = broken
            if index % 20 == 0 or index == len(files):
                db.update_task(job["id"], state="running", processed=index, added=broken)
        job["state"] = "done"
        db.update_task(job["id"], name=f"损坏检测：发现 {broken} 个")
        db.finish_task(job["id"], "done", processed=len(files), added=broken)
    except Exception as exc:
        job["state"] = "error"
        job["error"] = str(exc)
        db.finish_task(
            job["id"], "error", error=str(exc), processed=job["processed"], added=job["broken"]
        )
    finally:
        job["finished_at"] = time.time()


def _prune():
    now = time.time()
    for job_id in list(_jobs):
        job = _jobs[job_id]
        if job["finished_at"] and now - job["finished_at"] > _MAX_AGE:
            _jobs.pop(job_id, None)
