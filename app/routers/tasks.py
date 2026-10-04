from fastapi import APIRouter, HTTPException

from .. import db

router = APIRouter(prefix="/api")


@router.get("/tasks")
def list_tasks(limit: int = 100):
    return {"items": db.list_tasks(limit)}


@router.delete("/tasks/{task_id}")
def delete_task(task_id: int):
    if not db.remove_task(task_id):
        raise HTTPException(status_code=404, detail="任务不存在")
    return {"ok": True}
