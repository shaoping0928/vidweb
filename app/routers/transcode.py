from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from .. import config
from ..security import safe_path
from ..services import transcode

router = APIRouter(prefix="/api")


@router.get("/transcode/info")
def transcode_info():
    return transcode.info()


@router.get("/transcode/plan")
def transcode_plan(path: str):
    if not config.load_config().get("transcode"):
        raise HTTPException(status_code=400, detail="未开启服务端转码")
    real = safe_path(path)
    if real.is_dir():
        raise HTTPException(status_code=400, detail="不能转码文件夹")
    result = transcode.plan(str(real))
    if result["mode"] == "remux":
        result["encoder"] = "copy"
        result["encoder_label"] = "直通（仅重封装）"
    elif result["mode"] == "audio":
        result["encoder"] = "audio"
        result["encoder_label"] = "音频转码（AAC）"
    else:
        encoder = transcode.resolve_encoder()
        result["encoder"] = encoder
        result["encoder_label"] = transcode.ENCODER_LABELS.get(encoder, encoder)
    return result


@router.get("/transcode/stream")
def transcode_stream(path: str, start: int = 0):
    if not config.load_config().get("transcode"):
        raise HTTPException(status_code=400, detail="未开启服务端转码")
    real = safe_path(path)
    if real.is_dir():
        raise HTTPException(status_code=400, detail="不能转码文件夹")
    if not config.ffmpeg_path():
        raise HTTPException(status_code=400, detail="未检测到 ffmpeg")
    plan_info = transcode.plan(str(real))
    generator = transcode.stream(str(real), start, plan_info)
    media_type = "audio/mp4" if plan_info["mode"] == "audio" else "video/mp4"
    return StreamingResponse(
        generator,
        media_type=media_type,
        headers={
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
            "X-Transcode-Mode": plan_info["mode"],
        },
    )
