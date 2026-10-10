import os
import re
import threading
import time
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from .. import config, db
from ..security import safe_path
from ..services import scanjobs, thumbs

router = APIRouter(prefix="/api")


def _suffix(path: str) -> str:
    name = str(path or "")
    if "." not in name.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]:
        return ""
    return name.rsplit(".", 1)[-1].lower()


class PathBody(BaseModel):
    path: str


class JobBody(BaseModel):
    job_id: str


class ScanBody(BaseModel):
    path: str = ""
    dir_id: Optional[int] = None


class PlaylistBody(BaseModel):
    paths: list = []


class PlaylistQuery(BaseModel):
    offset: int = 0
    limit: int = 30
    search: str = ""
    status: str = "all"
    statuses: Optional[list] = None
    duration: str = "all"
    durations: Optional[list] = None
    media: str = "all"
    tag_ids: list = []
    tag_match_all: bool = False
    sort: str = "name"
    paths_only: bool = False
    tree: bool = False
    folder: Optional[str] = None


@router.post("/scan")
def scan(body: ScanBody, request: Request):
    ip = request.client.host if request.client else ""
    if body.dir_id:
        record = db.dir_by_id(body.dir_id)
        if not record:
            raise HTTPException(status_code=404, detail="路径库目录不存在")
        real = Path(record["path"])
        if not real.is_dir():
            raise HTTPException(status_code=400, detail="目录不存在或不是文件夹")
    else:
        if not body.path.strip():
            raise HTTPException(status_code=400, detail="缺少扫描路径")
        real = safe_path(body.path)
        if not real.is_dir():
            raise HTTPException(status_code=400, detail="不是文件夹")
    job_id = scanjobs.start_scan(str(real), ip=ip, dir_id=body.dir_id)
    return {"job_id": job_id}


@router.get("/scan/status")
def scan_status(job_id: str, include_files: int = 0):
    job = scanjobs.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="任务不存在")
    payload = {
        "job_id": job["id"],
        "path": job["path"],
        "state": job["state"],
        "total": job["total"],
        "processed": job["processed"],
        "added": job["added"],
        "playlist_added": job.get("playlist_added", 0),
        "error": job["error"],
        "elapsed": round((job["finished_at"] or time.time()) - job["started_at"], 1),
    }
    if include_files and job["state"] in ("done", "cancelled"):
        payload["files"] = job["files"]
    return payload


@router.post("/scan/cancel")
def scan_cancel(body: JobBody):
    return {"ok": scanjobs.cancel_job(body.job_id)}


@router.get("/playlist")
def get_playlist():
    return {"items": db.playlist_paths()}


@router.put("/playlist")
def put_playlist(body: PlaylistBody):
    paths = [str(p) for p in (body.paths or []) if str(p).strip()]
    db.playlist_set_paths(paths)
    return {"ok": True, "count": len(db.playlist_paths())}


def _chunks(items, size):
    for start in range(0, len(items), size):
        yield items[start : start + size]


_stats_cache = {}
_stats_lock = threading.Lock()
_STATS_TTL = 10.0


def _stat_path(raw: str):
    now = time.time()
    with _stats_lock:
        hit = _stats_cache.get(raw)
        if hit and now - hit[4] < _STATS_TTL:
            return hit[:4]
    try:
        st = os.stat(raw)
        value = (Path(raw).name, st.st_size, int(st.st_mtime), True)
    except OSError:
        value = (Path(raw).name, 0, 0, False)
    with _stats_lock:
        if len(_stats_cache) > 20000:
            _stats_cache.clear()
        _stats_cache[raw] = value + (now,)
    return value


def _load_playlist_entries(playlist_entries):
    paths = [entry["path"] for entry in playlist_entries]
    stats = {raw: _stat_path(raw) for raw in paths}
    records = {}
    tag_names = {}
    tag_ids = {}
    with db.connection() as conn:
        for chunk in _chunks(paths, 500):
            placeholders = ",".join("?" for _ in chunk)
            for row in conn.execute(
                f"SELECT * FROM files WHERE path IN ({placeholders})", chunk
            ):
                records[row["path"]] = dict(row)
        ids = [record["id"] for record in records.values()]
        for chunk in _chunks(ids, 500):
            placeholders = ",".join("?" for _ in chunk)
            for row in conn.execute(
                "SELECT ft.file_id, t.id AS tag_id, t.name FROM file_tags ft"
                " JOIN tags t ON t.id = ft.tag_id"
                f" WHERE ft.file_id IN ({placeholders}) ORDER BY t.name",
                chunk,
            ):
                tag_names.setdefault(row["file_id"], []).append(row["name"])
                tag_ids.setdefault(row["file_id"], set()).add(row["tag_id"])
    entries = []
    for base_entry in playlist_entries:
        raw = base_entry["path"]
        name, size, mtime, exists = stats[raw]
        record = records.get(raw)
        file_id = record["id"] if record else None
        entries.append(
            {
                "path": raw,
                "name": name,
                "size": size,
                "mtime": mtime,
                "exists": exists,
                "dir_id": base_entry["dir_id"],
                "rel_path": base_entry["rel_path"],
                "dir_path": base_entry["dir_path"],
                "duration_ms": record["duration_ms"] if record else 0,
                "last_position_ms": record["last_position_ms"] if record else 0,
                "play_count": record["play_count"] if record else 0,
                "last_played_at": record["last_played_at"] if record else 0,
                "broken": (record.get("broken") or 0) if record else 0,
                "tags": tag_names.get(file_id, []),
                "_tag_ids": tag_ids.get(file_id, set()),
            }
        )
    return entries


def _load_entries_db(playlist_entries, with_tags: bool = False):
    paths = [entry["path"] for entry in playlist_entries]
    records = {}
    tag_names = {}
    tag_ids = {}
    with db.connection() as conn:
        for chunk in _chunks(paths, 500):
            placeholders = ",".join("?" for _ in chunk)
            for row in conn.execute(
                f"SELECT * FROM files WHERE path IN ({placeholders})", chunk
            ):
                records[row["path"]] = dict(row)
        if with_tags:
            ids = [record["id"] for record in records.values()]
            for chunk in _chunks(ids, 500):
                placeholders = ",".join("?" for _ in chunk)
                for row in conn.execute(
                    "SELECT ft.file_id, t.id AS tag_id, t.name FROM file_tags ft"
                    " JOIN tags t ON t.id = ft.tag_id"
                    f" WHERE ft.file_id IN ({placeholders}) ORDER BY t.name",
                    chunk,
                ):
                    tag_names.setdefault(row["file_id"], []).append(row["name"])
                    tag_ids.setdefault(row["file_id"], set()).add(row["tag_id"])
    entries = []
    for base_entry in playlist_entries:
        raw = base_entry["path"]
        record = records.get(raw)
        file_id = record["id"] if record else None
        entries.append(
            {
                "path": raw,
                "name": Path(raw).name,
                "size": record["size"] if record else 0,
                "mtime": record["mtime"] if record else 0,
                "exists": True,
                "dir_id": base_entry["dir_id"],
                "rel_path": base_entry["rel_path"],
                "dir_path": base_entry["dir_path"],
                "duration_ms": record["duration_ms"] if record else 0,
                "last_position_ms": record["last_position_ms"] if record else 0,
                "play_count": record["play_count"] if record else 0,
                "last_played_at": record["last_played_at"] if record else 0,
                "broken": (record.get("broken") or 0) if record else 0,
                "tags": tag_names.get(file_id, []),
                "_tag_ids": tag_ids.get(file_id, set()),
            }
        )
    return entries


def _item_payload(entry: dict) -> dict:
    return {
        "path": entry["path"],
        "name": entry["name"],
        "size": entry["size"],
        "mtime": entry["mtime"],
        "exists": entry["exists"],
        "dir_id": entry["dir_id"],
        "rel_path": entry["rel_path"],
        "dir_path": entry["dir_path"],
        "duration_ms": entry["duration_ms"],
        "last_position_ms": entry["last_position_ms"],
        "play_count": entry["play_count"],
        "last_played_at": entry["last_played_at"],
        "broken": bool(entry.get("broken")),
        "kind": "audio" if _suffix(entry["path"]) in config.AUDIO_EXTS else "video",
        "tags": entry["tags"],
        "has_thumb": thumbs.cached(entry["path"]) is not None,
    }


def _split_parts(value: str) -> list:
    return [
        part
        for part in re.split(r"[\\/]+", value or "")
        if part not in ("", ".", "..")
    ]


def _build_tree(entries: list) -> list:
    nodes = {}

    def ensure(path: str, name: str) -> dict:
        node = nodes.get(path)
        if node is None:
            node = {"name": name, "path": path, "children": {}, "files": []}
            nodes[path] = node
        return node

    for entry in entries:
        dir_path = entry.get("dir_path")
        rel_path = entry.get("rel_path") or ""
        if entry.get("dir_id") and dir_path:
            root = os.path.normpath(dir_path)
            parts = _split_parts(rel_path) or [entry["name"]]
            ensure(root, os.path.basename(root) or root)
            current = root
            for part in parts[:-1]:
                current = os.path.normpath(os.path.join(current, part))
                ensure(current, part)
            nodes[current]["files"].append(entry)
        else:
            absolute = os.path.normpath(entry.get("path") or rel_path)
            parent = os.path.dirname(absolute)
            node = ensure(parent, os.path.basename(parent) or parent)
            node["files"].append(entry)

    def ensure_ancestors(path: str) -> None:
        drive, _ = os.path.splitdrive(path)
        stop = os.path.normcase(drive + os.sep) if drive else os.path.normcase(os.sep)
        current = path
        while True:
            parent = os.path.dirname(current)
            if not parent or parent == current:
                break
            if os.path.normcase(parent) == os.path.normcase(current):
                break
            if parent in nodes:
                break
            ensure(parent, os.path.basename(parent) or parent)
            if os.path.normcase(parent) == stop:
                break
            current = parent

    for path in list(nodes):
        ensure_ancestors(path)

    roots = []
    for path, node in nodes.items():
        parent = os.path.dirname(path)
        parent_node = nodes.get(parent)
        if parent_node is not None and parent != path:
            parent_node["children"][path] = node
        else:
            roots.append(node)

    def finalize(node: dict) -> dict:
        children = [
            finalize(child)
            for child in sorted(node["children"].values(), key=lambda item: item["name"].lower())
        ]
        count = len(node["files"]) + sum(child["count"] for child in children)
        return {
            "name": node["name"],
            "path": node["path"],
            "count": count,
            "children": children,
        }

    return [finalize(node) for node in sorted(roots, key=lambda item: item["name"].lower())]


def _filter_entries(entries: list, body: PlaylistQuery) -> list:
    keyword = (body.search or "").strip().lower()
    media = (body.media or "all").strip().lower()
    tag_sets = []
    if body.tag_ids:
        for tag_id in body.tag_ids:
            tag_sets.append(db.tag_subtree_ids(int(tag_id)))

    statuses = [str(item) for item in (body.statuses or []) if item]
    if not statuses:
        statuses = [body.status or "all"]

    def matches(entry, status: str) -> bool:
        if status == "missing":
            return not entry["exists"]
        if not entry["exists"]:
            return False
        if status == "broken":
            return bool(entry.get("broken"))
        if status == "new":
            return entry["play_count"] <= 0
        if status == "played":
            return entry["play_count"] > 0
        if status == "progress":
            return entry["last_position_ms"] > 0
        return True

    def keep_status(entry) -> bool:
        if "all" in statuses:
            return entry["exists"]
        return any(matches(entry, status) for status in statuses)

    durations = [str(item) for item in (body.durations or []) if item]
    if not durations:
        durations = [body.duration or "all"]

    def matches_duration(entry) -> bool:
        if "all" in durations:
            return True
        value = entry["duration_ms"]
        return any(
            (item == "unknown" and value <= 0)
            or (item == "short" and 0 < value <= 600000)
            or (item == "medium" and 600000 < value <= 1800000)
            or (item == "long" and value > 1800000)
            for item in durations
        )

    filtered = []
    for entry in entries:
        if keyword and keyword not in entry["name"].lower():
            continue
        if not keep_status(entry):
            continue
        if not matches_duration(entry):
            continue
        if media != "all":
            is_audio = _suffix(entry["path"]) in config.AUDIO_EXTS
            if media == "audio" and not is_audio:
                continue
            if media == "video" and is_audio:
                continue
        if tag_sets:
            own = entry["_tag_ids"]

            def matches_one(tag_set):
                return any(tag_id in tag_set for tag_id in own)

            ok = (
                all(matches_one(tag_set) for tag_set in tag_sets)
                if body.tag_match_all
                else any(matches_one(tag_set) for tag_set in tag_sets)
            )
            if not ok:
                continue
        filtered.append(entry)
    return filtered


def _sort_entries(entries: list, sort: str):
    sort = sort or "name"
    if sort == "name_desc":
        entries.sort(key=lambda e: e["name"].lower(), reverse=True)
    elif sort == "recent":
        entries.sort(key=lambda e: e["last_played_at"], reverse=True)
    elif sort == "plays":
        entries.sort(key=lambda e: e["play_count"], reverse=True)
    elif sort == "duration":
        entries.sort(key=lambda e: e["duration_ms"], reverse=True)
    elif sort == "size":
        entries.sort(key=lambda e: e["size"], reverse=True)
    elif sort == "mtime":
        entries.sort(key=lambda e: e["mtime"], reverse=True)
    else:
        entries.sort(key=lambda e: e["name"].lower())


@router.post("/playlist/query")
def query_playlist(body: PlaylistQuery):
    if body.folder is not None:
        folder = os.path.normpath(body.folder)
        subset = [
            entry
            for entry in db.playlist_entries()
            if os.path.normpath(os.path.dirname(os.path.normpath(entry["path"]))) == folder
        ]
        entries = _load_playlist_entries(subset)
        filtered = _filter_entries(entries, body)
        _sort_entries(filtered, body.sort)
        items = [_item_payload(entry) for entry in filtered]
        return {
            "items": items,
            "total": len(entries),
            "filtered": len(filtered),
            "folder": folder,
        }

    if body.tree:
        entries = _load_entries_db(db.playlist_entries())
        return {
            "tree": _build_tree(entries),
            "total": len(entries),
            "filtered": len(entries),
        }

    entries = _load_playlist_entries(db.playlist_entries())
    total = len(entries)
    filtered = _filter_entries(entries, body)
    _sort_entries(filtered, body.sort)

    count = len(filtered)
    if body.paths_only:
        return {"paths": [e["path"] for e in filtered], "total": total, "filtered": count}

    offset = max(0, int(body.offset))
    limit = min(500, max(1, int(body.limit)))
    items = [_item_payload(entry) for entry in filtered[offset : offset + limit]]
    return {"items": items, "total": total, "filtered": count, "offset": offset, "limit": limit}


@router.post("/playlist/add")
def playlist_add(body: PlaylistBody):
    added = db.playlist_add(body.paths)
    return {"added": added, "total": len(db.playlist_paths())}


@router.post("/playlist/remove")
def playlist_remove(body: PlaylistBody):
    removed = db.playlist_remove(body.paths)
    return {"removed": removed, "total": len(db.playlist_paths())}


@router.post("/playlist/clean")
def playlist_clean():
    removed = db.playlist_clean()
    return {"removed": removed, "total": len(db.playlist_paths())}


@router.post("/playlist/restore")
def playlist_restore():
    added = db.playlist_restore()
    return {"added": added, "total": len(db.playlist_paths())}


@router.delete("/playlist")
def playlist_clear():
    db.playlist_clear()
    return {"ok": True}
