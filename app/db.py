import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

from . import config

DB_PATH = config.DATA_DIR / "media.db"


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

def ensure_tag(name: str) -> int:
    name = (name or "").strip()
    if not name:
        return -1
    with connection() as conn:
        row = conn.execute("SELECT id FROM tags WHERE name = ?", (name,)).fetchone()
        if row:
            return row["id"]
        cur = conn.execute(
            "INSERT INTO tags(name, created_at) VALUES(?,?)", (name, _now())
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


def all_tags() -> list:
    with connection() as conn:
        rows = conn.execute(
            "SELECT t.id, t.name, t.color,"
            " (SELECT COUNT(*) FROM file_tags ft WHERE ft.tag_id = t.id) AS file_count"
            " FROM tags t ORDER BY t.name"
        ).fetchall()
        return [dict(r) for r in rows]


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
                    "INSERT INTO tags(name, created_at) VALUES(?,?)", (name, _now())
                ).lastrowid
            conn.execute(
                "INSERT OR IGNORE INTO file_tags(file_id, tag_id) VALUES(?,?)",
                (file_id, tag_id),
            )
        return True


def files_for_tag(tag_id: int) -> list:
    if tag_id <= 0:
        return []
    with connection() as conn:
        rows = conn.execute(
            "SELECT f.path FROM files f JOIN file_tags ft ON ft.file_id = f.id"
            " WHERE ft.tag_id = ? ORDER BY f.name",
            (tag_id,),
        ).fetchall()
        return [r["path"] for r in rows]


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
            "SELECT DISTINCT f.path, t.name FROM files f"
            " JOIN file_tags ft ON ft.file_id = f.id"
            " JOIN tags t ON t.id = ft.tag_id"
            " WHERE t.name LIKE ? LIMIT ?",
            (pattern, limit),
        ):
            matches.setdefault(row["path"], []).append("标签: " + row["name"])
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
