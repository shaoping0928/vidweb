from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import db

router = APIRouter(prefix="/api")


class TagCreate(BaseModel):
    name: str
    parent_id: Optional[int] = None


class TagUpdate(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    parent_id: Optional[int] = None


class FileTagsBody(BaseModel):
    path: str
    tags: list = []


class PathsBody(BaseModel):
    paths: list = []


class TagsBatchBody(BaseModel):
    paths: list = []
    tags: list = []


class FilterBody(BaseModel):
    paths: list = []
    tag_ids: list = []
    match_all: bool = False


@router.get("/tags")
def list_tags():
    return {"items": db.all_tags()}


@router.post("/tags")
def create_tag(body: TagCreate):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="标签名不能为空")
    tag_id = db.ensure_tag(name, body.parent_id)
    if tag_id <= 0:
        raise HTTPException(status_code=400, detail="标签创建失败")
    if body.parent_id:
        if not db.set_tag_parent(tag_id, body.parent_id):
            raise HTTPException(status_code=400, detail="父标签无效")
    return {"id": tag_id, "name": name}


@router.put("/tags/{tag_id}")
def update_tag(tag_id: int, body: TagUpdate):
    if body.name is not None:
        if not db.rename_tag(tag_id, body.name):
            raise HTTPException(status_code=400, detail="重命名失败（可能重名或为空）")
    if body.color is not None:
        db.set_tag_color(tag_id, body.color)
    if "parent_id" in body.model_fields_set:
        if not db.set_tag_parent(tag_id, body.parent_id):
            raise HTTPException(status_code=400, detail="移动失败：不能移动到自身或其子标签下")
    return {"ok": True}


@router.delete("/tags/{tag_id}")
def delete_tag(tag_id: int):
    if not db.remove_tag(tag_id):
        raise HTTPException(status_code=404, detail="标签不存在")
    return {"ok": True}


@router.get("/tags/{tag_id}/files")
def tag_files(tag_id: int):
    return {"paths": db.files_for_tag(tag_id)}


@router.get("/files/tags")
def file_tags(path: str):
    record = db.file_by_path(path)
    if not record:
        return {"tags": []}
    return {"tags": db.tags_for_file(record["id"])}


@router.put("/files/tags")
def set_file_tags(body: FileTagsBody):
    file_id = db.ensure_file(body.path)
    if file_id <= 0:
        raise HTTPException(status_code=400, detail="文件入库失败")
    db.set_file_tags(file_id, body.tags or [])
    return {"tags": db.tags_for_file(file_id)}


@router.post("/files/tags/common")
def common_tags(body: PathsBody):
    paths = body.paths or []
    if not paths:
        return {"tags": [], "counts": {}}
    counts = {}
    for path in paths:
        file_id = db.ensure_file(path)
        for tag in db.tags_for_file(file_id):
            counts[tag["name"]] = counts.get(tag["name"], 0) + 1
    return {"tags": db.all_tags(), "counts": counts}


@router.post("/files/tags/batch")
def set_tags_batch(body: TagsBatchBody):
    paths = body.paths or []
    checked = [t.strip() for t in (body.tags or []) if t and t.strip()]
    if not paths:
        return {"ok": True}
    file_ids = [db.ensure_file(path) for path in paths]
    file_ids = [fid for fid in file_ids if fid > 0]
    if not file_ids:
        return {"ok": True}
    counts = {}
    for file_id in file_ids:
        for tag in db.tags_for_file(file_id):
            counts[tag["name"]] = counts.get(tag["name"], 0) + 1
    checked_lower = {name.lower() for name in checked}
    common_unchecked = [
        name
        for name, count in counts.items()
        if count == len(file_ids) and name.lower() not in checked_lower
    ]
    common_unchecked_lower = {name.lower() for name in common_unchecked}
    for file_id in file_ids:
        names = [tag["name"] for tag in db.tags_for_file(file_id)]
        names_lower = {name.lower() for name in names}
        for name in checked:
            if name.lower() not in names_lower:
                names.append(name)
                names_lower.add(name.lower())
        names = [n for n in names if n.lower() not in common_unchecked_lower]
        db.set_file_tags(file_id, names)
    return {"ok": True}


@router.post("/playlist/filter")
def filter_playlist(body: FilterBody):
    paths = body.paths or []
    tag_ids = [int(t) for t in (body.tag_ids or []) if int(t) > 0]
    if not tag_ids:
        return {"items": paths}
    matched = None
    for tag_id in tag_ids:
        tag_set = set(db.files_for_tag(tag_id))
        if matched is None:
            matched = tag_set
        elif body.match_all:
            matched &= tag_set
        else:
            matched |= tag_set
    if matched is None:
        matched = set()
    return {"items": [p for p in paths if p in matched]}
