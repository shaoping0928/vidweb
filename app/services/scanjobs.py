import os
import threading
import time
import uuid

from .. import db
from . import scanner, thumbs
from .scan_cancel import ScanCancelled

_jobs = {}
_lock = threading.Lock()
_MAX_AGE = 3600
_BATCH = 200


def _prune():
    now = time.time()
    for job_id in list(_jobs):
        job = _jobs[job_id]
        if job["finished_at"] and now - job["finished_at"] > _MAX_AGE:
            _jobs.pop(job_id, None)


def start_scan(root: str, ip: str = "", dir_id=None) -> str:
    _prune()
    job_id = uuid.uuid4().hex[:12]
    job = {
        "id": job_id,
        "path": root,
        "dir_id": int(dir_id) if dir_id else None,
        "ip": ip,
        "state": "walking",
        "total": 0,
        "processed": 0,
        "added": 0,
        "playlist_added": 0,
        "error": "",
        "files": [],
        "cancel": False,
        "started_at": time.time(),
        "finished_at": 0,
    }
    with _lock:
        _jobs[job_id] = job
    try:
        db.create_task(job_id, "scan", "扫描入库", root, ip)
    except Exception:
        pass
    threading.Thread(target=_run, args=(job,), name="scan-" + job_id, daemon=True).start()
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
    try:
        files = scanner.scan_videos(job["path"], cancel_check=lambda: job["cancel"])
        if job["cancel"]:
            raise ScanCancelled()
        job["files"] = files
        job["total"] = len(files)
        job["state"] = "importing"
        db.update_task(job["id"], state="importing", total=job["total"])
        batch = []
        processed = 0
        dir_id = job.get("dir_id")
        root = job["path"]
        for path in files:
            if job["cancel"]:
                raise ScanCancelled()
            if dir_id:
                rel = os.path.relpath(path, root)
                batch.append(rel)
            else:
                batch.append(path)
            if len(batch) >= _BATCH:
                if dir_id:
                    job["added"] += db.ensure_files_rel_batch(dir_id, batch)
                    thumbs.request_batch([os.path.join(root, rel) for rel in batch])
                else:
                    job["added"] += db.ensure_files_batch(batch)
                    thumbs.request_batch(batch)
                processed += len(batch)
                job["processed"] = processed
                batch = []
                db.update_task(
                    job["id"], state="importing", processed=processed, added=job["added"]
                )
        if batch:
            if dir_id:
                job["added"] += db.ensure_files_rel_batch(dir_id, batch)
                thumbs.request_batch([os.path.join(root, rel) for rel in batch])
            else:
                job["added"] += db.ensure_files_batch(batch)
                thumbs.request_batch(batch)
            processed += len(batch)
            job["processed"] = processed
        if not dir_id:
            db.backfill_file_dirs()
        job["playlist_added"] = db.playlist_add(files)
        job["state"] = "done"
        db.finish_task(job["id"], "done", processed=job["processed"], added=job["added"])
    except ScanCancelled:
        job["state"] = "cancelled"
        job["error"] = "已取消"
        db.finish_task(job["id"], "cancelled", error="已取消", processed=job["processed"], added=job["added"])
    except Exception as exc:
        job["state"] = "error"
        job["error"] = str(exc)
        db.finish_task(job["id"], "error", error=str(exc), processed=job["processed"], added=job["added"])
    finally:
        job["finished_at"] = time.time()
