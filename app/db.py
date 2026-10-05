import json
import os
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

from . import config

DB_PATH = config.DATA_DIR / "media.db"
DEFAULT_ROOT_TAG = "全部标签"


def _now() -> int:
    return int(time.time())


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


@contextmanager
def connection():
    conn = _connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    config.THUMB_DIR.mkdir(parents=True, exist_ok=True)
    config.PLAYLIST_DIR.mkdir(parents=True, exist_ok=True)
    config.SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
    schema_file = Path(__file__).resolve().parent / "schema.sql"
    conn = _connect()
    try:
        conn.execute("PRAGMA journal_mode = WAL")
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        if version < 1:
            conn.executescript(schema_file.read_text(encoding="utf-8"))
            conn.execute("PRAGMA user_version = 1")
            version = 1
        if version < 2:
            conn.execute("ALTER TABLE files ADD COLUMN thumbnail TEXT DEFAULT ''")
            conn.execute("PRAGMA user_version = 2")
            version = 2
        if version < 3:
            conn.execute(
                "ALTER TABLE tags ADD COLUMN parent_id INTEGER REFERENCES tags(id) ON DELETE SET NULL"
            )
            conn.execute("PRAGMA user_version = 3")
            version = 3
        if version < 4:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS tasks ("
                "  id INTEGER PRIMARY KEY,"
                "  job_id TEXT UNIQUE,"
                "  type TEXT,"
                "  name TEXT,"
                "  description TEXT,"
                "  ip TEXT,"
                "  state TEXT,"
                "  total INTEGER DEFAULT 0,"
                "  processed INTEGER DEFAULT 0,"
                "  added INTEGER DEFAULT 0,"
                "  error TEXT,"
                "  created_at INTEGER DEFAULT 0,"
                "  updated_at INTEGER DEFAULT 0,"
                "  finished_at INTEGER DEFAULT 0"
                ")"
            )
            conn.execute("PRAGMA user_version = 4")
            version = 4
        if version < 5:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS app_state ("
                "  key TEXT PRIMARY KEY,"
                "  value TEXT"
                ")"
            )
            conn.execute("PRAGMA user_version = 5")
            version = 5
        if version < 6:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS dirs ("
                "  id INTEGER PRIMARY KEY,"
                "  path TEXT UNIQUE"
                ")"
            )
            conn.execute(
                "CREATE TABLE IF NOT EXISTS playlist ("
                "  id INTEGER PRIMARY KEY,"
                "  dir_id INTEGER,"
                "  rel_path TEXT,"
                "  UNIQUE(dir_id, rel_path)"
                ")"
            )
            conn.execute("ALTER TABLE files ADD COLUMN dir_id INTEGER")
            conn.execute("ALTER TABLE files ADD COLUMN rel_path TEXT")
            try:
                configured = config.load_config().get("library_dirs") or []
            except Exception:
                configured = []
            for item in configured:
                item = str(item).strip()
                if item:
                    conn.execute(
                        "INSERT OR IGNORE INTO dirs(path) VALUES(?)",
                        (os.path.abspath(item),),
                    )
            dir_rows = [
                {"id": row["id"], "path": row["path"]}
                for row in conn.execute("SELECT id, path FROM dirs")
            ]
            if dir_rows:
                for row in conn.execute(
                    "SELECT id, path FROM files WHERE dir_id IS NULL"
                ).fetchall():
                    dir_id, rel = _match_dir(row["path"], dir_rows)
                    if dir_id:
                        conn.execute(
                            "UPDATE files SET dir_id = ?, rel_path = ? WHERE id = ?",
                            (dir_id, rel, row["id"]),
                        )
            state_row = conn.execute(
                "SELECT value FROM app_state WHERE key = 'playlist'"
            ).fetchone()
            if state_row and state_row["value"]:
                try:
                    legacy_paths = json.loads(state_row["value"])
                except ValueError:
                    legacy_paths = []
                if isinstance(legacy_paths, list):
                    for item in legacy_paths:
                        item = str(item)
                        if not item.strip():
                            continue
                        dir_id, rel = _match_dir(item, dir_rows)
                        conn.execute(
                            "INSERT OR IGNORE INTO playlist(dir_id, rel_path) VALUES(?,?)",
                            (dir_id, rel),
                        )
                conn.execute(
                    "UPDATE app_state SET value = '[]' WHERE key = 'playlist'"
                )
            conn.execute("PRAGMA user_version = 6")
            version = 6
        if version < 7:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS screenshots ("
                "  id INTEGER PRIMARY KEY,"
                "  file_id INTEGER,"
                "  video_path TEXT,"
                "  position_ms INTEGER DEFAULT 0,"
                "  filename TEXT,"
                "  width INTEGER DEFAULT 0,"
                "  height INTEGER DEFAULT 0,"
                "  size INTEGER DEFAULT 0,"
                "  created_at INTEGER DEFAULT 0"
                ")"
            )
            conn.execute("PRAGMA user_version = 7")
            version = 7
        if version < 8:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS collections ("
                "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
                "  name TEXT NOT NULL,"
                "  filters TEXT NOT NULL,"
                "  created_at INTEGER NOT NULL"
                ")"
            )
            conn.execute("PRAGMA user_version = 8")
            version = 8
        if version < 9:
            row = conn.execute(
                "SELECT id FROM tags WHERE name = ?", (DEFAULT_ROOT_TAG,)
            ).fetchone()
            if row:
                root_id = row["id"]
            else:
                cursor = conn.execute(
                    "INSERT INTO tags(name, color, created_at, parent_id) VALUES(?,?,?,NULL)",
                    (DEFAULT_ROOT_TAG, None, _now()),
                )
                root_id = cursor.lastrowid
            conn.execute(
                "UPDATE tags SET parent_id = ? WHERE parent_id IS NULL AND id != ?",
                (root_id, root_id),
            )
            conn.execute("PRAGMA user_version = 9")
        if version < 10:
            conn.execute("ALTER TABLE files ADD COLUMN broken INTEGER DEFAULT 0")
            conn.execute("PRAGMA user_version = 10")
        conn.commit()
    finally:
        conn.close()


def _file_dict(row) -> dict:
    return dict(row) if row is not None else None


# ---------------------------------------------------------------- files

def ensure_file(path: str) -> int:
    if not path:
        return -1
    p = Path(path)
    try:
        st = p.stat()
        name, size, mtime = p.name, st.st_size, int(st.st_mtime)
    except OSError:
        name, size, mtime = p.name, 0, 0
    with connection() as conn:
        row = conn.execute("SELECT id FROM files WHERE path = ?", (path,)).fetchone()
        if row:
            conn.execute(
                "UPDATE files SET name = ?, size = ?, mtime = ? WHERE id = ?",
                (name, size, mtime, row["id"]),
            )
            return row["id"]
        cur = conn.execute(
            "INSERT INTO files(path, name, size, mtime, added_at) VALUES(?,?,?,?,?)",
            (path, name, size, mtime, _now()),
        )
        return cur.lastrowid


def ensure_files_batch(paths) -> int:
    added = 0
    with connection() as conn:
        for path in paths:
            p = Path(path)
            try:
                st = p.stat()
                name, size, mtime = p.name, st.st_size, int(st.st_mtime)
            except OSError:
                name, size, mtime = p.name, 0, 0
            row = conn.execute("SELECT id FROM files WHERE path = ?", (path,)).fetchone()
            if row:
                conn.execute(
                    "UPDATE files SET name = ?, size = ?, mtime = ? WHERE id = ?",
                    (name, size, mtime, row["id"]),
                )
            else:
                conn.execute(
                    "INSERT INTO files(path, name, size, mtime, added_at) VALUES(?,?,?,?,?)",
                    (path, name, size, mtime, _now()),
                )
                added += 1
    return added


def file_by_path(path: str):
    with connection() as conn:
        row = conn.execute("SELECT * FROM files WHERE path = ?", (path,)).fetchone()
        return _file_dict(row)


def file_by_id(file_id: int):
    with connection() as conn:
        row = conn.execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone()
        return _file_dict(row)


def update_media_info(file_id: int, duration_ms: int, width: int, height: int, title: str = "") -> None:
    if file_id <= 0:
        return
    with connection() as conn:
        if title:
            conn.execute(
                "UPDATE files SET duration_ms = ?, width = ?, height = ?, title = ? WHERE id = ?",
                (duration_ms, width, height, title, file_id),
            )
        else:
            conn.execute(
                "UPDATE files SET duration_ms = ?, width = ?, height = ? WHERE id = ?",
                (duration_ms, width, height, file_id),
            )


def set_thumbnail(file_id: int, thumbnail: str) -> None:
    if file_id <= 0:
        return
    with connection() as conn:
        conn.execute("UPDATE files SET thumbnail = ? WHERE id = ?", (thumbnail, file_id))


def set_broken(file_id: int, broken: bool) -> None:
    if file_id <= 0:
        return
    with connection() as conn:
        conn.execute(
            "UPDATE files SET broken = ? WHERE id = ?",
            (1 if broken else 0, file_id),
        )


def save_position(file_id: int, position_ms: int) -> None:
    if file_id <= 0:
        return
    with connection() as conn:
        conn.execute(
            "UPDATE files SET last_position_ms = ? WHERE id = ?",
            (max(0, int(position_ms)), file_id),
        )


def record_play(file_id: int) -> None:
    if file_id <= 0:
        return
    with connection() as conn:
        conn.execute(
            "UPDATE files SET play_count = play_count + 1, last_played_at = ? WHERE id = ?",
            (_now(), file_id),
        )


def recent_files(limit: int = 50) -> list:
    with connection() as conn:
        rows = conn.execute(
            "SELECT * FROM files WHERE last_played_at > 0 ORDER BY last_played_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]


def clear_recent() -> None:
    with connection() as conn:
        conn.execute("UPDATE files SET last_played_at = 0")


# ---------------------------------------------------------------- tags

def _tag_subtree_ids(conn, tag_id: int) -> set:
    rows = conn.execute("SELECT id, parent_id FROM tags").fetchall()
    children = {}
    for row in rows:
        children.setdefault(row["parent_id"] or 0, []).append(row["id"])
    result = set()
    stack = [tag_id]
    while stack:
        current = stack.pop()
        if current in result:
            continue
        result.add(current)
        stack.extend(children.get(current, []))
    return result


def _files_for_tag_ids(conn, tag_ids) -> list:
    ids = [int(t) for t in tag_ids]
    if not ids:
        return []
    placeholders = ",".join("?" for _ in ids)
    rows = conn.execute(
        "SELECT DISTINCT f.path FROM files f JOIN file_tags ft ON ft.file_id = f.id"
        f" WHERE ft.tag_id IN ({placeholders}) ORDER BY f.name",
        ids,
    ).fetchall()
    return [r["path"] for r in rows]


def ensure_tag(name: str, parent_id=None) -> int:
    name = (name or "").strip()
    if not name:
        return -1
    if parent_id is not None and int(parent_id) <= 0:
        parent_id = None
    with connection() as conn:
        row = conn.execute("SELECT id FROM tags WHERE name = ?", (name,)).fetchone()
        if row:
            return row["id"]
        if parent_id is None:
            root = conn.execute(
                "SELECT id FROM tags WHERE name = ?", (DEFAULT_ROOT_TAG,)
            ).fetchone()
            if root:
                parent_id = root["id"]
            else:
                cur = conn.execute(
                    "INSERT INTO tags(name, color, parent_id, created_at) VALUES(?,?,?,?)",
                    (DEFAULT_ROOT_TAG, None, None, _now()),
                )
                parent_id = cur.lastrowid
        cur = conn.execute(
            "INSERT INTO tags(name, color, parent_id, created_at) VALUES(?,?,?,?)",
            (name, None, parent_id, _now()),
        )
        return cur.lastrowid


def remove_tag(tag_id: int) -> bool:
    if tag_id <= 0:
        return False
    with connection() as conn:
        conn.execute("DELETE FROM tags WHERE id = ?", (tag_id,))
        return True


def rename_tag(tag_id: int, name: str) -> bool:
    name = (name or "").strip()
    if tag_id <= 0 or not name:
        return False
    try:
        with connection() as conn:
            conn.execute("UPDATE tags SET name = ? WHERE id = ?", (name, tag_id))
        return True
    except sqlite3.IntegrityError:
        return False


def set_tag_color(tag_id: int, color: str) -> bool:
    if tag_id <= 0:
        return False
    with connection() as conn:
        conn.execute("UPDATE tags SET color = ? WHERE id = ?", (color, tag_id))
        return True


def set_tag_parent(tag_id: int, parent_id) -> bool:
    if tag_id <= 0:
        return False
    if parent_id is not None and int(parent_id) <= 0:
        parent_id = None
    with connection() as conn:
        if parent_id is not None:
            exists = conn.execute("SELECT id FROM tags WHERE id = ?", (parent_id,)).fetchone()
            if not exists:
                return False
            if int(parent_id) == tag_id or int(parent_id) in _tag_subtree_ids(conn, tag_id):
                return False
        conn.execute("UPDATE tags SET parent_id = ? WHERE id = ?", (parent_id, tag_id))
        return True


def all_tags() -> list:
    with connection() as conn:
        rows = [dict(r) for r in conn.execute("SELECT id, name, color, parent_id FROM tags")]
        links = conn.execute("SELECT file_id, tag_id FROM file_tags").fetchall()
        by_tag = {}
        for link in links:
            by_tag.setdefault(link["tag_id"], set()).add(link["file_id"])
        children = {}
        for row in rows:
            children.setdefault(row["parent_id"] or 0, []).append(row)
        for group in children.values():
            group.sort(key=lambda r: r["name"].lower())
        ordered = []

        def walk(node):
            subtree_files = set()
            stack = [node["id"]]
            seen = set()
            while stack:
                current = stack.pop()
                if current in seen:
                    continue
                seen.add(current)
                subtree_files |= by_tag.get(current, set())
                for child in children.get(current, []):
                    stack.append(child["id"])
            item = dict(node)
            item["file_count"] = len(by_tag.get(node["id"], set()))
            item["subtree_count"] = len(subtree_files)
            ordered.append(item)
            for child in children.get(node["id"], []):
                walk(child)

        for root in children.get(0, []):
            walk(root)
        return ordered


def tags_for_file(file_id: int) -> list:
    if file_id <= 0:
        return []
    with connection() as conn:
        rows = conn.execute(
            "SELECT t.id, t.name, t.color FROM tags t"
            " JOIN file_tags ft ON ft.tag_id = t.id"
            " WHERE ft.file_id = ? ORDER BY t.name",
            (file_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def set_file_tags(file_id: int, tag_names: list) -> bool:
    if file_id <= 0:
        return False
    with connection() as conn:
        root = conn.execute(
            "SELECT id FROM tags WHERE name = ?", (DEFAULT_ROOT_TAG,)
        ).fetchone()
        root_id = root["id"] if root else None
        if root_id is None:
            root_id = conn.execute(
                "INSERT INTO tags(name, color, parent_id, created_at) VALUES(?,?,?,?)",
                (DEFAULT_ROOT_TAG, None, None, _now()),
            ).lastrowid
        conn.execute("DELETE FROM file_tags WHERE file_id = ?", (file_id,))
        for name in tag_names:
            name = (name or "").strip()
            if not name:
                continue
            row = conn.execute("SELECT id FROM tags WHERE name = ?", (name,)).fetchone()
            if row:
                tag_id = row["id"]
            else:
                tag_id = conn.execute(
                    "INSERT INTO tags(name, parent_id, created_at) VALUES(?,?,?)",
                    (name, root_id, _now()),
                ).lastrowid
            conn.execute(
                "INSERT OR IGNORE INTO file_tags(file_id, tag_id) VALUES(?,?)",
                (file_id, tag_id),
            )
        return True


def files_for_tag(tag_id: int, include_children: bool = True) -> list:
    if tag_id <= 0:
        return []
    with connection() as conn:
        ids = _tag_subtree_ids(conn, tag_id) if include_children else {tag_id}
        return _files_for_tag_ids(conn, ids)


def search(keyword: str, limit: int = 200) -> list:
    keyword = (keyword or "").strip()
    if not keyword or limit <= 0:
        return []
    pattern = f"%{keyword}%"
    matches = {}
    with connection() as conn:
        for row in conn.execute(
            "SELECT path FROM files WHERE name LIKE ? LIMIT ?", (pattern, limit)
        ):
            matches.setdefault(row["path"], []).append("文件名")
        for row in conn.execute(
            "SELECT id, name FROM tags WHERE name LIKE ? LIMIT ?", (pattern, limit)
        ).fetchall():
            for path in _files_for_tag_ids(conn, _tag_subtree_ids(conn, row["id"])):
                matches.setdefault(path, []).append("标签: " + row["name"])
        for row in conn.execute(
            "SELECT DISTINCT f.path, c.text FROM files f"
            " JOIN comments c ON c.file_id = f.id"
            " WHERE c.text LIKE ? LIMIT ?",
            (pattern, limit),
        ):
            excerpt = " ".join((row["text"] or "").split())
            if len(excerpt) > 30:
                excerpt = excerpt[:30] + "…"
            matches.setdefault(row["path"], []).append("评论: " + excerpt)
    results = [
        {"path": path, "reason": " / ".join(reasons)}
        for path, reasons in sorted(matches.items())
    ]
    return results[:limit]


# ---------------------------------------------------------------- comments

def add_comment(file_id: int, position_ms: int, text: str) -> int:
    text = (text or "").strip()
    if file_id <= 0 or not text:
        return -1
    with connection() as conn:
        cur = conn.execute(
            "INSERT INTO comments(file_id, position_ms, text, created_at, updated_at)"
            " VALUES(?,?,?,?,?)",
            (file_id, max(0, int(position_ms)), text, _now(), _now()),
        )
        return cur.lastrowid


def update_comment(comment_id: int, text: str) -> bool:
    text = (text or "").strip()
    if comment_id <= 0 or not text:
        return False
    with connection() as conn:
        conn.execute(
            "UPDATE comments SET text = ?, updated_at = ? WHERE id = ?",
            (text, _now(), comment_id),
        )
        return True


def remove_comment(comment_id: int) -> bool:
    if comment_id <= 0:
        return False
    with connection() as conn:
        conn.execute("DELETE FROM comments WHERE id = ?", (comment_id,))
        return True


def comments_for_file(file_id: int) -> list:
    if file_id <= 0:
        return []
    with connection() as conn:
        rows = conn.execute(
            "SELECT id, file_id, position_ms, text, created_at, updated_at"
            " FROM comments WHERE file_id = ? ORDER BY position_ms, id",
            (file_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def comment_count(file_id: int) -> int:
    if file_id <= 0:
        return 0
    with connection() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM comments WHERE file_id = ?", (file_id,)
        ).fetchone()
        return row["n"]

# ---------------------------------------------------------------- tasks

_TASK_FIELDS = {"state", "total", "processed", "added", "error", "description", "name"}


def create_task(job_id: str, task_type: str, name: str, description: str, ip: str) -> int:
    with connection() as conn:
        cur = conn.execute(
            "INSERT INTO tasks(job_id, type, name, description, ip, state,"
            " created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)",
            (job_id, task_type, name, description, ip, "walking", _now(), _now()),
        )
        return cur.lastrowid


def update_task(job_id: str, **fields) -> None:
    updates = {k: v for k, v in fields.items() if k in _TASK_FIELDS}
    if not updates:
        return
    sets = ", ".join(f"{key} = ?" for key in updates)
    values = list(updates.values()) + [_now(), job_id]
    with connection() as conn:
        conn.execute(f"UPDATE tasks SET {sets}, updated_at = ? WHERE job_id = ?", values)


def finish_task(job_id: str, state: str, error: str = "", processed=None, added=None) -> None:
    now = _now()
    with connection() as conn:
        conn.execute(
            "UPDATE tasks SET state = ?, error = ?, processed = COALESCE(?, processed),"
            " added = COALESCE(?, added), updated_at = ?, finished_at = ? WHERE job_id = ?",
            (state, error, processed, added, now, now, job_id),
        )


def list_tasks(limit: int = 100) -> list:
    with connection() as conn:
        rows = conn.execute(
            "SELECT * FROM tasks ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(r) for r in rows]


def remove_task(task_id: int) -> bool:
    if task_id <= 0:
        return False
    with connection() as conn:
        conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
        return True


# ---------------------------------------------------------------- app state

def get_state(key: str):
    with connection() as conn:
        row = conn.execute("SELECT value FROM app_state WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None


def set_state(key: str, value: str) -> None:
    with connection() as conn:
        conn.execute(
            "INSERT INTO app_state(key, value) VALUES(?, ?)"
            " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )


def set_state_many(items: dict) -> None:
    with connection() as conn:
        for key, value in items.items():
            conn.execute(
                "INSERT INTO app_state(key, value) VALUES(?, ?)"
                " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (str(key), str(value)),
            )


def get_all_state() -> dict:
    with connection() as conn:
        rows = conn.execute("SELECT key, value FROM app_state").fetchall()
        return {row["key"]: row["value"] for row in rows}


def remove_state(key: str) -> bool:
    with connection() as conn:
        conn.execute("DELETE FROM app_state WHERE key = ?", (key,))
        return True


def all_files(limit: int = 20000) -> list:
    with connection() as conn:
        rows = conn.execute(
            "SELECT path FROM files ORDER BY name LIMIT ?", (limit,)
        ).fetchall()
        return [r["path"] for r in rows]


def files_with_ids(limit: int = 200000) -> list:
    with connection() as conn:
        rows = conn.execute(
            "SELECT id, path FROM files ORDER BY id LIMIT ?", (limit,)
        ).fetchall()
        return [{"id": r["id"], "path": r["path"]} for r in rows]


def tag_subtree_ids(tag_id: int) -> set:
    if tag_id <= 0:
        return set()
    with connection() as conn:
        return _tag_subtree_ids(conn, tag_id)


# ---------------------------------------------------------------- dirs & playlist

def path_key(path: str) -> str:
    return os.path.normcase(os.path.normpath(os.path.abspath(str(path))))


def _match_dir(path: str, dirs: list):
    if not dirs:
        return None, str(path)
    target = os.path.abspath(str(path))
    norm = os.path.normcase(os.path.normpath(target))
    best = None
    best_len = -1
    for item in dirs:
        base = os.path.abspath(str(item["path"]))
        base_norm = os.path.normcase(os.path.normpath(base))
        if norm == base_norm:
            rel = ""
        elif norm.startswith(base_norm + os.sep):
            rel = os.path.relpath(target, base)
        else:
            continue
        if len(base_norm) > best_len:
            best = (int(item["id"]), rel)
            best_len = len(base_norm)
    return best if best else (None, str(path))


def dirs_list() -> list:
    with connection() as conn:
        rows = conn.execute("SELECT id, path FROM dirs ORDER BY path").fetchall()
        return [
            {"id": row["id"], "path": row["path"], "exists": os.path.isdir(row["path"])}
            for row in rows
        ]


def dir_by_id(dir_id: int):
    with connection() as conn:
        row = conn.execute("SELECT id, path FROM dirs WHERE id = ?", (dir_id,)).fetchone()
        if not row:
            return None
        return {"id": row["id"], "path": row["path"], "exists": os.path.isdir(row["path"])}


def dir_add(path: str) -> int:
    real = os.path.abspath(str(path))
    with connection() as conn:
        for row in conn.execute("SELECT id, path FROM dirs"):
            if os.path.normcase(row["path"]) == os.path.normcase(real):
                return row["id"]
        cur = conn.execute("INSERT INTO dirs(path) VALUES(?)", (real,))
        return cur.lastrowid


def dir_update_path(dir_id: int, new_path: str) -> int:
    new_abs = os.path.abspath(str(new_path))
    moved = 0
    with connection() as conn:
        row = conn.execute("SELECT path FROM dirs WHERE id = ?", (dir_id,)).fetchone()
        if not row:
            return 0
        conn.execute("UPDATE dirs SET path = ? WHERE id = ?", (new_abs, dir_id))
        for file_row in conn.execute(
            "SELECT id, rel_path FROM files WHERE dir_id = ?", (dir_id,)
        ).fetchall():
            rel = file_row["rel_path"] or ""
            target = os.path.normpath(os.path.join(new_abs, rel)) if rel else new_abs
            conflict = conn.execute(
                "SELECT id FROM files WHERE path = ? AND id <> ?",
                (target, file_row["id"]),
            ).fetchone()
            if conflict:
                conn.execute("DELETE FROM files WHERE id = ?", (file_row["id"],))
                continue
            conn.execute(
                "UPDATE files SET path = ? WHERE id = ?", (target, file_row["id"])
            )
            moved += 1
    return moved


def dir_remove(dir_id: int) -> int:
    detached = 0
    with connection() as conn:
        row = conn.execute("SELECT path FROM dirs WHERE id = ?", (dir_id,)).fetchone()
        base = row["path"] if row else None
        for entry in conn.execute(
            "SELECT id, rel_path FROM playlist WHERE dir_id = ?", (dir_id,)
        ).fetchall():
            rel = entry["rel_path"] or ""
            abs_path = os.path.normpath(os.path.join(base, rel)) if base and rel else rel
            conn.execute(
                "UPDATE playlist SET dir_id = NULL, rel_path = ? WHERE id = ?",
                (abs_path, entry["id"]),
            )
            detached += 1
        conn.execute("UPDATE files SET dir_id = NULL WHERE dir_id = ?", (dir_id,))
        conn.execute("DELETE FROM dirs WHERE id = ?", (dir_id,))
    return detached


def backfill_file_dirs() -> int:
    dir_list = dirs_list()
    if not dir_list:
        return 0
    updated = 0
    with connection() as conn:
        rows = conn.execute(
            "SELECT id, path FROM files WHERE dir_id IS NULL"
        ).fetchall()
        for row in rows:
            dir_id, rel = _match_dir(row["path"], dir_list)
            if dir_id:
                conn.execute(
                    "UPDATE files SET dir_id = ?, rel_path = ? WHERE id = ?",
                    (dir_id, rel, row["id"]),
                )
                updated += 1
    return updated


def ensure_files_rel_batch(dir_id, rel_paths) -> int:
    base = None
    if dir_id:
        record = dir_by_id(dir_id)
        base = record["path"] if record else None
    added = 0
    with connection() as conn:
        for rel in rel_paths:
            rel = str(rel)
            abs_path = os.path.normpath(os.path.join(base, rel)) if base and rel else rel
            p = Path(abs_path)
            try:
                st = p.stat()
                name, size, mtime = p.name, st.st_size, int(st.st_mtime)
            except OSError:
                name, size, mtime = p.name, 0, 0
            row = conn.execute("SELECT id FROM files WHERE path = ?", (abs_path,)).fetchone()
            if row:
                conn.execute(
                    "UPDATE files SET name = ?, size = ?, mtime = ?, dir_id = ?, rel_path = ?"
                    " WHERE id = ?",
                    (name, size, mtime, dir_id, rel, row["id"]),
                )
            else:
                conn.execute(
                    "INSERT INTO files(path, name, size, mtime, added_at, dir_id, rel_path)"
                    " VALUES(?,?,?,?,?,?,?)",
                    (abs_path, name, size, mtime, _now(), dir_id, rel),
                )
                added += 1
    return added


def _entry_resolved(row) -> str:
    if row["dir_id"] and row["dir_path"]:
        rel = row["rel_path"] or ""
        return os.path.normpath(os.path.join(row["dir_path"], rel)) if rel else row["dir_path"]
    return row["rel_path"] or ""


def playlist_entries() -> list:
    with connection() as conn:
        rows = conn.execute(
            "SELECT p.id, p.dir_id, p.rel_path, d.path AS dir_path FROM playlist p"
            " LEFT JOIN dirs d ON d.id = p.dir_id ORDER BY p.id"
        ).fetchall()
        return [
            {
                "id": row["id"],
                "dir_id": row["dir_id"],
                "rel_path": row["rel_path"] or "",
                "dir_path": row["dir_path"],
                "path": _entry_resolved(row),
            }
            for row in rows
        ]


def playlist_paths() -> list:
    return [entry["path"] for entry in playlist_entries()]


def playlist_add(paths: list) -> int:
    dir_list = dirs_list()
    added = 0
    with connection() as conn:
        existing = set()
        for row in conn.execute("SELECT dir_id, rel_path FROM playlist"):
            existing.add((row["dir_id"], os.path.normcase(row["rel_path"] or "")))
        for path in paths or []:
            path = str(path)
            if not path.strip():
                continue
            dir_id, rel = _match_dir(path, dir_list)
            key = (dir_id, os.path.normcase(rel))
            if key in existing:
                continue
            existing.add(key)
            conn.execute(
                "INSERT INTO playlist(dir_id, rel_path) VALUES(?,?)", (dir_id, rel)
            )
            added += 1
    return added


def playlist_remove(paths: list) -> int:
    target = {path_key(p) for p in paths or []}
    if not target:
        return 0
    removed = 0
    with connection() as conn:
        for entry in playlist_entries():
            if path_key(entry["path"]) in target:
                conn.execute("DELETE FROM playlist WHERE id = ?", (entry["id"],))
                removed += 1
    return removed


def playlist_clean() -> int:
    removed = 0
    with connection() as conn:
        for entry in playlist_entries():
            if not os.path.exists(entry["path"]):
                conn.execute("DELETE FROM playlist WHERE id = ?", (entry["id"],))
                removed += 1
    return removed


def playlist_restore() -> int:
    added = 0
    with connection() as conn:
        existing = set()
        for row in conn.execute("SELECT dir_id, rel_path FROM playlist"):
            existing.add((row["dir_id"], os.path.normcase(row["rel_path"] or "")))
        for row in conn.execute("SELECT dir_id, rel_path, path FROM files"):
            if row["dir_id"]:
                dir_id, rel = row["dir_id"], row["rel_path"] or ""
            else:
                dir_id, rel = None, row["path"]
            key = (dir_id, os.path.normcase(rel))
            if key in existing:
                continue
            existing.add(key)
            conn.execute(
                "INSERT INTO playlist(dir_id, rel_path) VALUES(?,?)", (dir_id, rel)
            )
            added += 1
    return added


def playlist_clear() -> None:
    with connection() as conn:
        conn.execute("DELETE FROM playlist")


def playlist_set_paths(paths: list) -> None:
    playlist_clear()
    playlist_add(paths)


# ---------------------------------------------------------------- screenshots

def add_screenshot(
    file_id, video_path, position_ms, filename, width, height, size
) -> int:
    with connection() as conn:
        cur = conn.execute(
            "INSERT INTO screenshots(file_id, video_path, position_ms, filename,"
            " width, height, size, created_at) VALUES(?,?,?,?,?,?,?,?)",
            (
                file_id if file_id and file_id > 0 else None,
                str(video_path or ""),
                max(0, int(position_ms or 0)),
                str(filename),
                int(width or 0),
                int(height or 0),
                int(size or 0),
                _now(),
            ),
        )
        return cur.lastrowid


def list_screenshots(video_path: str = "", limit: int = 200) -> list:
    with connection() as conn:
        if video_path:
            rows = conn.execute(
                "SELECT * FROM screenshots WHERE video_path = ?"
                " ORDER BY id DESC LIMIT ?",
                (str(video_path), limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM screenshots ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
        return [dict(row) for row in rows]


def screenshot_by_id(screenshot_id: int):
    with connection() as conn:
        row = conn.execute(
            "SELECT * FROM screenshots WHERE id = ?", (screenshot_id,)
        ).fetchone()
        return dict(row) if row else None


def remove_screenshot(screenshot_id: int):
    with connection() as conn:
        row = conn.execute(
            "SELECT filename FROM screenshots WHERE id = ?", (screenshot_id,)
        ).fetchone()
        if not row:
            return None
        conn.execute("DELETE FROM screenshots WHERE id = ?", (screenshot_id,))
        return row["filename"]


# ---------------------------------------------------------------- collections

def _collection_dict(row) -> dict:
    try:
        filters = json.loads(row["filters"]) if row["filters"] else {}
    except ValueError:
        filters = {}
    if not isinstance(filters, dict):
        filters = {}
    return {
        "id": row["id"],
        "name": row["name"],
        "filters": filters,
        "created_at": row["created_at"],
    }


def collections_list() -> list:
    with connection() as conn:
        rows = conn.execute(
            "SELECT id, name, filters, created_at FROM collections ORDER BY id"
        ).fetchall()
        return [_collection_dict(row) for row in rows]


def collection_by_id(cid: int):
    with connection() as conn:
        row = conn.execute(
            "SELECT id, name, filters, created_at FROM collections WHERE id = ?",
            (int(cid),),
        ).fetchone()
        return _collection_dict(row) if row else None


def collection_add(name: str, filters: dict) -> dict:
    with connection() as conn:
        cur = conn.execute(
            "INSERT INTO collections(name, filters, created_at) VALUES(?,?,?)",
            (str(name), json.dumps(filters or {}, ensure_ascii=False), _now()),
        )
        row = conn.execute(
            "SELECT id, name, filters, created_at FROM collections WHERE id = ?",
            (cur.lastrowid,),
        ).fetchone()
        return _collection_dict(row)


def collection_update(cid: int, name=None, filters=None):
    sets = []
    values = []
    if name is not None:
        sets.append("name = ?")
        values.append(str(name))
    if filters is not None:
        sets.append("filters = ?")
        values.append(json.dumps(filters, ensure_ascii=False))
    with connection() as conn:
        if sets:
            values.append(int(cid))
            cur = conn.execute(
                f"UPDATE collections SET {', '.join(sets)} WHERE id = ?", values
            )
            if cur.rowcount <= 0:
                return None
        row = conn.execute(
            "SELECT id, name, filters, created_at FROM collections WHERE id = ?",
            (int(cid),),
        ).fetchone()
        return _collection_dict(row) if row else None


def collection_delete(cid: int) -> bool:
    with connection() as conn:
        cur = conn.execute("DELETE FROM collections WHERE id = ?", (int(cid),))
        return cur.rowcount > 0
