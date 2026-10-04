from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import db
from .library import PlaylistQuery, _filter_entries, _load_entries_db

router = APIRouter(prefix="/api")


class CollectionCreate(BaseModel):
    name: str = ""
    filters: object = {}


class CollectionUpdate(BaseModel):
    name: Optional[str] = None
    filters: Optional[object] = None


def _clean_name(value) -> str:
    name = (value or "").strip()
    if not name or len(name) > 60:
        raise HTTPException(status_code=400, detail="合集名称需为 1-60 个字符")
    return name


@router.get("/collections")
def list_collections():
    return {"items": db.collections_list()}


@router.get("/collections/counts")
def collection_counts():
    tag_map = {t["name"]: t["id"] for t in db.all_tags()}
    entries = _load_entries_db(db.playlist_entries(), with_tags=True)
    counts = {}
    for item in db.collections_list():
        filters = item.get("filters") or {}
        tag_ids = []
        for name in filters.get("tagNames") or []:
            tag_id = tag_map.get(str(name))
            if tag_id is not None:
                tag_ids.append(tag_id)
        query = PlaylistQuery(
            search=str(filters.get("search") or ""),
            status=str(filters.get("status") or "all"),
            duration=str(filters.get("duration") or "all"),
            tag_ids=tag_ids,
            tag_match_all=filters.get("tagMode") == "all",
            sort=str(filters.get("sort") or "name"),
        )
        counts[str(item["id"])] = len(_filter_entries(entries, query))
    return {"counts": counts}


@router.post("/collections")
def create_collection(body: CollectionCreate):
    name = _clean_name(body.name)
    if not isinstance(body.filters, dict):
        raise HTTPException(status_code=400, detail="筛选条件格式无效")
    return {"item": db.collection_add(name, body.filters)}


@router.put("/collections/{cid}")
def update_collection(cid: int, body: CollectionUpdate):
    if not db.collection_by_id(cid):
        raise HTTPException(status_code=404, detail="合集不存在")
    name = None
    if body.name is not None:
        name = _clean_name(body.name)
    filters = None
    if body.filters is not None:
        if not isinstance(body.filters, dict):
            raise HTTPException(status_code=400, detail="筛选条件格式无效")
        filters = body.filters
    item = db.collection_update(cid, name=name, filters=filters)
    if not item:
        raise HTTPException(status_code=404, detail="合集不存在")
    return {"item": item}


@router.delete("/collections/{cid}")
def delete_collection(cid: int):
    if not db.collection_delete(cid):
        raise HTTPException(status_code=404, detail="合集不存在")
    return {"ok": True}
