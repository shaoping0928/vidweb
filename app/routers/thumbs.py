import hashlib
import os
import subprocess

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from .. import config
from ..security import safe_path
from ..services import thumbs

router = APIRouter(prefix="/api")


class PathsBody(BaseModel):
    paths: list = []


@router.get("/preview")
def preview(path: str, t: float = 0):
    real = safe_path(path)
    ffmpeg = config.ffmpeg_path()
    if not ffmpeg:
        raise HTTPException(status_code=404, detail="ffmpeg 不可用")
    try:
        seconds = max(0.0, float(t))
    except (TypeError, ValueError):
        seconds = 0.0
    bucket = int(seconds // 10) * 10
    key = hashlib.md5(os.path.abspath(str(real)).encode("utf-8")).hexdigest()
    cache_dir = config.DATA_DIR / "thumbs" / "preview"
    cache_dir.mkdir(parents=True, exist_ok=True)
    out = cache_dir / f"{key}_{bucket}.jpg"
    if not out.exists() or out.stat().st_size <= 0:
        cmd = [
            ffmpeg, "-ss", f"{bucket + 0.5:.3f}", "-i", str(real),
            "-frames:v", "1", "-vf", "scale=176:-2", "-y", str(out),
        ]
        kwargs = {"capture_output": True, "timeout": 20}
        if os.name == "nt":
            kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        try:
            proc = subprocess.run(cmd, **kwargs)
        except (OSError, subprocess.SubprocessError):
            raise HTTPException(status_code=404, detail="取帧失败")
        if proc.returncode != 0 or not out.exists() or out.stat().st_size <= 0:
            raise HTTPException(status_code=404, detail="取帧失败")
    return FileResponse(
        str(out),
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@router.get("/thumbnail")
def thumbnail(path: str):
    real = safe_path(path)
    thumb = thumbs.cached(str(real))
    if thumb:
        return FileResponse(
            thumb,
            media_type="image/jpeg",
            headers={"Cache-Control": "public, max-age=86400"},
        )
    thumbs.request(str(real))
    return JSONResponse(
        status_code=404,
        content={"status": thumbs.status(str(real))},
        headers={"Cache-Control": "no-store"},
    )


@router.post("/thumbs")
def request_thumbs(body: PathsBody):
    paths = []
    for raw in body.paths or []:
        try:
            paths.append(str(safe_path(raw)))
        except Exception:
            continue
    thumbs.request_batch(paths)
    return {"queued": len(paths)}


@router.get("/thumbs/status")
def thumbs_status(path: str):
    try:
        real = str(safe_path(path))
    except Exception:
        return {"status": "invalid"}
    return {"status": thumbs.status(real), "cached": thumbs.cached(real)}
