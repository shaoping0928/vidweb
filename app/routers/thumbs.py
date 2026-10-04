from fastapi import APIRouter
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from ..security import safe_path
from ..services import thumbs

router = APIRouter(prefix="/api")


class PathsBody(BaseModel):
    paths: list = []


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
