import os
import re
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

from .. import config, db
from ..security import safe_path
from ..services import media_info, subtitles, thumbs
from ..utils import decode_bytes

router = APIRouter(prefix="/api")

CHUNK_SIZE = 1024 * 1024


class MediaInfoBody(BaseModel):
    path: str
    duration_ms: int = 0
    width: int = 0
    height: int = 0
    title: str = ""


class PathBody(BaseModel):
    path: str


class ProgressBody(BaseModel):
    path: str
    position_ms: int = 0


class PathsBody(BaseModel):
    paths: list = []


class M3uSaveBody(BaseModel):
    file: str
    paths: list = []


class M3uLoadBody(BaseModel):
    file: str


@router.api_route("/stream", methods=["GET", "HEAD"])
def stream(path: str, request: Request):
    real = safe_path(path)
    if real.is_dir():
        raise HTTPException(status_code=400, detail="不能播放文件夹")
    size = real.stat().st_size
    media_type = config.MIME_TYPES.get(real.suffix.lower(), "application/octet-stream")

    start, end = 0, max(0, size - 1)
    status_code = 200
    headers = {"Accept-Ranges": "bytes", "Cache-Control": "no-store"}
    range_header = request.headers.get("range")
    if range_header:
        match = re.match(r"bytes=(\d*)-(\d*)", range_header)
        if match:
            if match.group(1):
                start = int(match.group(1))
            if match.group(2):
                end = int(match.group(2))
            if not match.group(1) and match.group(2):
                start = max(0, size - int(match.group(2)))
            if start >= size:
                return Response(
                    status_code=416, headers={"Content-Range": f"bytes */{size}"}
                )
            end = min(end, size - 1)
            if end < start:
                end = size - 1
            status_code = 206
            headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    length = end - start + 1
    headers["Content-Length"] = str(length)

    if request.method == "HEAD":
        return Response(status_code=status_code, headers=headers, media_type=media_type)

    def iterator():
        with open(real, "rb") as handle:
            handle.seek(start)
            remaining = length
            while remaining > 0:
                data = handle.read(min(CHUNK_SIZE, remaining))
                if not data:
                    break
                remaining -= len(data)
                yield data

    return StreamingResponse(
        iterator(), status_code=status_code, headers=headers, media_type=media_type
    )


@router.get("/files/detail")
def detail(path: str):
    real = safe_path(path)
    st = real.stat()
    record = db.file_by_path(str(real))
    if record and not record["duration_ms"]:
        info = media_info.probe(str(real))
        if info and info.get("duration_ms"):
            db.update_media_info(
                record["id"],
                info.get("duration_ms", 0),
                info.get("width", 0),
                info.get("height", 0),
                info.get("title", ""),
            )
            record = db.file_by_id(record["id"])

    result = {
        "exists": True,
        "path": str(real),
        "name": real.name,
        "size": st.st_size,
        "mtime": int(st.st_mtime),
        "record": record,
        "tags": [],
        "comment_count": 0,
        "thumbnail": None,
    }
    if record:
        result["tags"] = db.tags_for_file(record["id"])
        result["comment_count"] = db.comment_count(record["id"])
    thumb = thumbs.cached(str(real))
    if thumb:
        result["thumbnail"] = thumb
        if record and record["thumbnail"] != thumb:
            db.set_thumbnail(record["id"], thumb)
    return result


@router.post("/files/media_info")
def media_info_update(body: MediaInfoBody):
    file_id = db.ensure_file(body.path)
    if file_id <= 0:
        raise HTTPException(status_code=400, detail="文件入库失败")
    db.update_media_info(
        file_id, body.duration_ms, body.width, body.height, body.title
    )
    return {"ok": True, "file_id": file_id}


@router.post("/files/progress")
def save_progress(body: ProgressBody):
    file_id = db.ensure_file(body.path)
    if file_id <= 0:
        raise HTTPException(status_code=400, detail="文件入库失败")
    db.save_position(file_id, body.position_ms)
    return {"ok": True}


@router.post("/files/played")
def mark_played(body: PathBody):
    file_id = db.ensure_file(body.path)
    if file_id <= 0:
        raise HTTPException(status_code=400, detail="文件入库失败")
    db.record_play(file_id)
    return {"ok": True, "file_id": file_id}


@router.get("/files/all")
def files_all(limit: int = 20000):
    return {"items": db.all_files(limit)}


@router.post("/files/info")
def files_info(body: PathsBody):
    paths = [str(raw) for raw in (body.paths or []) if str(raw).strip()]
    stats = {}
    for raw in paths:
        p = Path(raw)
        try:
            st = p.stat()
            stats[raw] = (p.name, st.st_size, int(st.st_mtime), True)
        except OSError:
            stats[raw] = (p.name, 0, 0, False)

    records = {}
    tag_map = {}
    if paths:
        with db.connection() as conn:
            for start in range(0, len(paths), 500):
                chunk = paths[start : start + 500]
                placeholders = ",".join("?" for _ in chunk)
                for row in conn.execute(
                    f"SELECT * FROM files WHERE path IN ({placeholders})", chunk
                ):
                    records[row["path"]] = dict(row)
            ids = [record["id"] for record in records.values()]
            for start in range(0, len(ids), 500):
                chunk = ids[start : start + 500]
                placeholders = ",".join("?" for _ in chunk)
                for row in conn.execute(
                    "SELECT ft.file_id, t.name FROM file_tags ft"
                    " JOIN tags t ON t.id = ft.tag_id"
                    f" WHERE ft.file_id IN ({placeholders}) ORDER BY t.name",
                    chunk,
                ):
                    tag_map.setdefault(row["file_id"], []).append(row["name"])

    items = []
    for raw in paths:
        name, size, mtime, exists = stats[raw]
        record = records.get(raw)
        item = {
            "path": raw,
            "name": name,
            "exists": exists,
            "has_thumb": thumbs.cached(raw) is not None,
            "duration_ms": 0,
            "last_position_ms": 0,
            "play_count": 0,
            "last_played_at": 0,
            "size": size,
            "mtime": mtime,
            "tags": [],
        }
        if record:
            item["duration_ms"] = record["duration_ms"]
            item["last_position_ms"] = record["last_position_ms"]
            item["play_count"] = record["play_count"]
            item["last_played_at"] = record["last_played_at"]
            item["tags"] = tag_map.get(record["id"], [])
        items.append(item)
    return {"items": items}


@router.post("/playlist/save")
def playlist_save(body: M3uSaveBody):
    real = safe_path(body.file, must_exist=False, for_write=True)
    real.parent.mkdir(parents=True, exist_ok=True)
    lines = ["#EXTM3U"] + [str(p) for p in (body.paths or [])]
    real.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return {"ok": True, "file": str(real)}


@router.post("/playlist/load")
def playlist_load(body: M3uLoadBody):
    real = safe_path(body.file)
    if not real.is_file():
        raise HTTPException(status_code=400, detail="不是文件")
    text = decode_bytes(real.read_bytes())
    paths = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        candidate = Path(line)
        if not candidate.is_absolute():
            candidate = real.parent / candidate
        paths.append(str(candidate.resolve()))
    return {"paths": paths}


@router.get("/subtitles")
def subtitles_for_video(path: str):
    real = safe_path(path)
    sub = subtitles.find_for_video(str(real))
    if not sub:
        return {"name": None, "cues": []}
    try:
        cues = subtitles.parse_file(sub)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"字幕读取失败: {exc}")
    return {"name": sub.name, "cues": cues}


@router.post("/subtitles/parse")
async def parse_subtitle(file: UploadFile = File(...)):
    data = await file.read()
    name = file.filename or "subtitle"
    suffix = Path(name).suffix.lstrip(".")
    cues = subtitles.parse_bytes(data, suffix)
    return {"name": name, "cues": cues}
