from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel

from .. import db

router = APIRouter(prefix="/api")


class StatePut(BaseModel):
    key: Optional[str] = None
    value: Optional[str] = None
    items: Optional[dict] = None


@router.get("/state")
def get_state():
    return {"items": db.get_all_state()}


@router.put("/state")
def put_state(body: StatePut):
    if body.items:
        db.set_state_many({str(k): str(v) for k, v in body.items.items()})
    elif body.key is not None:
        db.set_state(str(body.key), str(body.value if body.value is not None else ""))
    return {"ok": True}


@router.delete("/state/{key:path}")
def delete_state(key: str):
    db.remove_state(key)
    return {"ok": True}
