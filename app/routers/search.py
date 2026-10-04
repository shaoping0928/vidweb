from pathlib import Path

from fastapi import APIRouter

from .. import db
from ..services import thumbs

router = APIRouter(prefix="/api")


@router.get("/search")
def search(q: str = "", limit: int = 200):
    results = db.search(q, limit)
    for item in results:
        path = item["path"]
        item["name"] = Path(path).name
        item["exists"] = Path(path).exists()
        item["has_thumb"] = thumbs.cached(path) is not None
    return {"items": results}
