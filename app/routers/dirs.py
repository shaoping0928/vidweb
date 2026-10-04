from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import db
from ..security import safe_path

router = APIRouter(prefix="/api")


class DirBody(BaseModel):
    path: str


@router.get("/dirs")
def list_dirs():
    return {"items": db.dirs_list()}


@router.post("/dirs")
def add_dir(body: DirBody):
    real = safe_path(body.path)
    if not real.is_dir():
        raise HTTPException(status_code=400, detail="不是文件夹")
    dir_id = db.dir_add(str(real))
    return {"id": dir_id, "items": db.dirs_list()}


@router.put("/dirs/{dir_id}")
def update_dir(dir_id: int, body: DirBody):
    record = db.dir_by_id(dir_id)
    if not record:
        raise HTTPException(status_code=404, detail="目录不存在")
    real = safe_path(body.path, must_exist=False)
    if not Path(real).is_dir():
        raise HTTPException(status_code=400, detail="新路径不存在或不是文件夹")
    moved = db.dir_update_path(dir_id, str(real))
    return {"ok": True, "moved_files": moved, "items": db.dirs_list()}


@router.delete("/dirs/{dir_id}")
def delete_dir(dir_id: int):
    if not db.dir_by_id(dir_id):
        raise HTTPException(status_code=404, detail="目录不存在")
    detached = db.dir_remove(dir_id)
    return {"ok": True, "detached": detached, "items": db.dirs_list()}
