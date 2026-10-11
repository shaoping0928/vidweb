import os
from pathlib import Path

from .. import config
from .scan_cancel import ScanCancelled


def normalize_key(path) -> str:
    return os.path.normcase(os.path.normpath(os.path.abspath(str(path))))


def scan_videos(root, cancel_check=None) -> list:
    root = Path(root)
    found = []
    seen = set()
    checked = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort(key=str.lower)
        for filename in sorted(filenames, key=str.lower):
            checked += 1
            if cancel_check and checked % 200 == 0 and cancel_check():
                raise ScanCancelled()
            suffix = Path(filename).suffix.lstrip(".").lower()
            if suffix not in config.MEDIA_EXTS:
                continue
            full = str(Path(dirpath) / filename)
            key = normalize_key(full)
            if key in seen:
                continue
            seen.add(key)
            found.append(full)
    return found


def scan_media(
    root,
    dir_mtimes=None,
    file_sigs=None,
    incremental=True,
    cancel_check=None,
    on_progress=None,
    progress_every=200,
) -> dict:
    """BFS incremental media scan (breadth-first, one depth level at a time).

    For each visited directory a stat() is taken and compared against
    ``dir_mtimes`` (previous last-scan mtime keyed by ``normalize_key``):

    * mtime UNCHANGED  -> the directory's direct files are skipped entirely
      (no stat / no DB upsert / no thumbnail). Its sub-directories are still
      enqueued, because a change deep in the tree only bumps the mtime of the
      directory that directly contains it, never its ancestors -- so a subtree
      can never be pruned from an ancestor's mtime alone.
    * mtime CHANGED / unknown -> each media file is compared against
      ``file_sigs`` (path -> (mtime, size)); unchanged files are skipped, new
      or modified files are collected for import.

    When ``incremental`` is False the function behaves like a full scan: every
    directory is treated as changed and every media file is returned.

    Returns a dict::

        {
            "files": [abs_path, ...],             # new/changed files to import
            "dir_updates": [(dir_path, mtime)],   # directory mtimes to persist
            "stats": {"dirs_scanned", "found", "skipped", "pruned_dirs"},
        }
    """
    root = Path(root)
    dir_mtimes = dir_mtimes or {}
    file_sigs = file_sigs or {}

    files = []
    dir_updates = []
    seen_files = set()
    seen_dirs = set()
    dirs_scanned = 0
    found = 0
    skipped = 0
    pruned_dirs = 0

    queue = [str(root)]
    while queue:
        next_queue = []
        for dirpath in queue:
            key = normalize_key(dirpath)
            if key in seen_dirs:
                continue
            seen_dirs.add(key)
            dirs_scanned += 1
            if cancel_check and dirs_scanned % progress_every == 0 and cancel_check():
                raise ScanCancelled()

            try:
                dir_mtime = os.stat(dirpath).st_mtime
            except OSError:
                continue

            previous = dir_mtimes.get(key) if incremental else None
            changed = (
                (not incremental)
                or previous is None
                or abs(previous - dir_mtime) > 1e-6
            )
            if previous is None or abs(previous - dir_mtime) > 1e-6:
                dir_updates.append((dirpath, dir_mtime))

            try:
                entries = list(os.scandir(dirpath))
            except OSError:
                continue
            entries.sort(key=lambda entry: entry.name.lower())

            if changed:
                for entry in entries:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            next_queue.append(entry.path)
                            continue
                        if not entry.is_file(follow_symlinks=False):
                            continue
                    except OSError:
                        continue
                    suffix = Path(entry.name).suffix.lstrip(".").lower()
                    if suffix not in config.MEDIA_EXTS:
                        continue
                    file_key = normalize_key(entry.path)
                    if file_key in seen_files:
                        continue
                    seen_files.add(file_key)
                    if incremental:
                        try:
                            st = entry.stat()
                            sig = (int(st.st_mtime), st.st_size)
                        except OSError:
                            sig = None
                        if sig is not None and file_sigs.get(file_key) == sig:
                            skipped += 1
                            continue
                    files.append(entry.path)
                    found += 1
            else:
                pruned_dirs += 1
                for entry in entries:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            next_queue.append(entry.path)
                    except OSError:
                        continue

            if on_progress:
                on_progress(dirs_scanned, found)

        queue = next_queue

    return {
        "files": files,
        "dir_updates": dir_updates,
        "stats": {
            "dirs_scanned": dirs_scanned,
            "found": found,
            "skipped": skipped,
            "pruned_dirs": pruned_dirs,
        },
    }
