from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import db

router = APIRouter(prefix="/api")


class CommentAddBody(BaseModel):
    path: str
    position_ms: int = 0
    text: str


class CommentUpdateBody(BaseModel):
    text: str


@router.get("/comments")
def list_comments(path: str):
    record = db.file_by_path(path)
    if not record:
        return {"items": []}
    return {"items": db.comments_for_file(record["id"])}


@router.post("/comments")
def add_comment(body: CommentAddBody):
    if not body.text.strip():
        raise HTTPException(status_code=400, detail="评论内容不能为空")
    file_id = db.ensure_file(body.path)
    if file_id <= 0:
        raise HTTPException(status_code=400, detail="文件入库失败")
    comment_id = db.add_comment(file_id, body.position_ms, body.text)
    if comment_id <= 0:
        raise HTTPException(status_code=400, detail="评论写入失败")
    return {"id": comment_id, "file_id": file_id}


@router.put("/comments/{comment_id}")
def update_comment(comment_id: int, body: CommentUpdateBody):
    if not db.update_comment(comment_id, body.text):
        raise HTTPException(status_code=400, detail="评论更新失败")
    return {"ok": True}


@router.delete("/comments/{comment_id}")
def delete_comment(comment_id: int):
    if not db.remove_comment(comment_id):
        raise HTTPException(status_code=404, detail="评论不存在")
    return {"ok": True}
