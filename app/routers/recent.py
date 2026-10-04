from pathlib import Path

from fastapi import APIRouter

from .. import db
from ..services import thumbs

router = APIRouter(prefix="/api")


@router.get("/recent")
def recent(limit: int = 50):
    items = []
    for record in db.recent_files(limit):
        path = record["path"]
        p = Path(path)
        items.append(
            {
                "path": path,
                "name": p.name,
                "exists": p.exists(),
                "play_count": record["play_count"],
                "last_played_at": record["last_played_at"],
                "last_position_ms": record["last_position_ms"],
                "duration_ms": record["duration_ms"],
                "has_thumb": thumbs.cached(path) is not None,
            }
        )
    return {"items": items}


@router.post("/recent/clear")
def clear_recent():
    db.clear_recent()
    return {"ok": True}
