from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from .. import config
from ..security import safe_path
from ..services import transcode

router = APIRouter(prefix="/api")


class TranscodeBody(BaseModel):
    path: str


class JobBody(BaseModel):
    job_id: str


@router.post("/transcode")
def start_transcode(body: TranscodeBody, request: Request):
    if not config.load_config().get("transcode"):
        raise HTTPException(status_code=400, detail="未开启服务端转码")
    real = safe_path(body.path)
    if real.is_dir():
        raise HTTPException(status_code=400, detail="不能转码文件夹")
    ip = request.client.host if request.client else ""
    job_id = transcode.start(str(real), ip=ip)
    return {"job_id": job_id}


@router.get("/transcode/status")
def transcode_status(job_id: str):
    job = transcode.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="任务不存在")
    return {
        "job_id": job["id"],
        "state": job["state"],
        "progress": round(job["progress"], 1),
        "duration_ms": job["duration_ms"],
        "output": job["output"],
        "error": job["error"],
    }


@router.post("/transcode/cancel")
def transcode_cancel(body: JobBody):
    return {"ok": transcode.cancel_job(body.job_id)}


@router.get("/transcode/cache")
def transcode_cache(path: str):
    real = safe_path(path)
    target = transcode.cached(str(real))
    return {"cached": bool(target), "path": target or ""}
