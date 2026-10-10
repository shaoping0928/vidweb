import os
import shutil
import subprocess
import sys
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import config
from ..security import safe_path

router = APIRouter(prefix="/api")


class PathBody(BaseModel):
    path: str


def _entry(child: Path) -> dict:
    try:
        is_dir = child.is_dir()
        st = child.stat()
        size, mtime = st.st_size, int(st.st_mtime)
    except OSError:
        return None
    suffix = child.suffix.lstrip(".").lower()
    return {
        "name": child.name,
        "path": str(child),
        "isdir": is_dir,
        "is_video": (not is_dir) and suffix in config.VIDEO_EXTS,
        "is_audio": (not is_dir) and suffix in config.AUDIO_EXTS,
        "is_media": (not is_dir) and suffix in config.MEDIA_EXTS,
        "size": size,
        "mtime": mtime,
        "has_thumb": False,
    }


@router.get("/browse")
def browse(path: str = "", filter: str = "", only_video: bool = False, sort: int = 0):
    if path.strip():
        target = safe_path(path)
    else:
        target = config.allowed_roots()[0]
    if not target.is_dir():
        raise HTTPException(status_code=400, detail="不是文件夹")
    keyword = filter.strip().lower()
    entries = []
    try:
        children = list(target.iterdir())
    except OSError as exc:
        raise HTTPException(status_code=403, detail=f"无法读取目录: {exc}")
    for child in children:
        entry = _entry(child)
        if entry is None:
            continue
        if keyword and keyword not in entry["name"].lower():
            continue
        if only_video and not entry["isdir"] and not entry["is_video"]:
            continue
        entries.append(entry)

    from ..services import thumbs
    for entry in entries:
        if entry["is_video"]:
            entry["has_thumb"] = thumbs.cached(entry["path"]) is not None

    names = [e for e in entries if e["isdir"]]
    files = [e for e in entries if not e["isdir"]]
    if sort in (2, 3):
        key = lambda e: e["size"]
    elif sort in (4, 5):
        key = lambda e: e["mtime"]
    else:
        key = lambda e: e["name"].lower()
    reverse = sort % 2 == 1
    names.sort(key=key, reverse=reverse)
    files.sort(key=key, reverse=reverse)
    return {"path": str(target), "parent": str(target.parent), "entries": names + files}


@router.get("/drives")
def drives():
    roots = []
    for root in config.allowed_roots():
        value = str(root)
        item = {"path": value, "name": value, "total": 0, "free": 0}
        try:
            usage = shutil.disk_usage(value)
            item["total"] = usage.total
            item["free"] = usage.free
        except OSError:
            pass
        roots.append(item)
    return {"roots": roots}


@router.post("/explore")
def explore(body: PathBody):
    target = safe_path(body.path)
    try:
        if os.name == "nt":
            subprocess.Popen(["explorer.exe", "/select,", str(target)])
        elif sys.platform == "darwin":
            subprocess.Popen(["open", "-R", str(target)])
        else:
            subprocess.Popen(["xdg-open", str(target if target.is_dir() else target.parent)])
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"无法打开资源管理器: {exc}")
    return {"ok": True}
