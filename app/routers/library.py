from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import config, db
from ..security import safe_path
from ..services import scanner

router = APIRouter(prefix="/api")


class PathBody(BaseModel):
    path: str


def _list_dirs() -> list:
    dirs = config.load_config().get("library_dirs") or []
    return [{"path": p, "exists": Path(p).exists()} for p in dirs]


@router.get("/library/dirs")
def list_dirs():
    return {"items": _list_dirs()}


@router.post("/library/dirs")
def add_dir(body: PathBody):
    real = safe_path(body.path)
    if not real.is_dir():
        raise HTTPException(status_code=400, detail="不是文件夹")
    cfg = config.load_config()
    dirs = [str(p) for p in (cfg.get("library_dirs") or [])]
    value = str(real)
    if value not in dirs:
        dirs.append(value)
        cfg["library_dirs"] = dirs
        config.save_config(cfg)
    return {"items": _list_dirs()}


@router.post("/library/dirs/remove")
def remove_dir(body: PathBody):
    cfg = config.load_config()
    value = str(Path(body.path))
    dirs = [str(p) for p in (cfg.get("library_dirs") or [])]
    cfg["library_dirs"] = [p for p in dirs if p != value and str(Path(p)) != value]
    config.save_config(cfg)
    return {"items": _list_dirs()}


@router.post("/scan")
def scan(body: PathBody):
    real = safe_path(body.path)
    if not real.is_dir():
        raise HTTPException(status_code=400, detail="不是文件夹")
    files = scanner.scan_videos(real)
    for path in files:
        db.ensure_file(path)
    return {"count": len(files), "files": files}
