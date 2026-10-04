import struct
import time
import uuid

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from .. import config, db

router = APIRouter(prefix="/api")

MAX_SIZE = 30 * 1024 * 1024


def _png_size(data: bytes):
    if len(data) >= 24 and data[:8] == b"\x89PNG\r\n\x1a\n":
        width, height = struct.unpack(">II", data[16:24])
        return width, height
    return 0, 0


@router.post("/screenshots")
async def create_screenshot(
    file: UploadFile = File(...),
    path: str = Form(""),
    position_ms: int = Form(0),
):
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="截图内容为空")
    if len(data) > MAX_SIZE:
        raise HTTPException(status_code=400, detail="截图文件过大")
    width, height = _png_size(data)
    filename = f"{int(time.time())}_{uuid.uuid4().hex[:8]}.png"
    config.SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
    (config.SCREENSHOT_DIR / filename).write_bytes(data)
    file_id = -1
    if path.strip():
        try:
            file_id = db.ensure_file(path)
        except Exception:
            file_id = -1
    screenshot_id = db.add_screenshot(
        file_id, path, position_ms, filename, width, height, len(data)
    )
    return db.screenshot_by_id(screenshot_id)


@router.get("/screenshots")
def list_screenshots(path: str = "", limit: int = 200):
    return {"items": db.list_screenshots(path, limit)}


@router.get("/screenshots/{screenshot_id}/image")
def screenshot_image(screenshot_id: int):
    record = db.screenshot_by_id(screenshot_id)
    if not record:
        raise HTTPException(status_code=404, detail="截图不存在")
    target = config.SCREENSHOT_DIR / record["filename"]
    if not target.exists():
        raise HTTPException(status_code=404, detail="截图文件缺失")
    return FileResponse(
        str(target),
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@router.delete("/screenshots/{screenshot_id}")
def delete_screenshot(screenshot_id: int):
    filename = db.remove_screenshot(screenshot_id)
    if not filename:
        raise HTTPException(status_code=404, detail="截图不存在")
    target = config.SCREENSHOT_DIR / filename
    try:
        if target.exists():
            target.unlink()
    except OSError:
        pass
    return {"ok": True}
