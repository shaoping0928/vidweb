from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from .. import config
from ..security import safe_path
from ..services import transcode

router = APIRouter(prefix="/api")


@router.get("/transcode/info")
def transcode_info():
    return transcode.info()


@router.get("/transcode/stream")
def transcode_stream(path: str, start: int = 0):
    if not config.load_config().get("transcode"):
        raise HTTPException(status_code=400, detail="未开启服务端转码")
    real = safe_path(path)
    if real.is_dir():
        raise HTTPException(status_code=400, detail="不能转码文件夹")
    if not config.ffmpeg_path():
        raise HTTPException(status_code=400, detail="未检测到 ffmpeg")
    generator = transcode.stream(str(real), start)
    return StreamingResponse(
        generator,
        media_type="video/mp4",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )
