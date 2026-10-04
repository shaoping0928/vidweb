import os
from pathlib import Path

from .. import config


def normalize_key(path) -> str:
    return os.path.normcase(os.path.normpath(os.path.abspath(str(path))))


def scan_videos(root) -> list:
    root = Path(root)
    found = []
    seen = set()
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort(key=str.lower)
        for filename in sorted(filenames, key=str.lower):
            suffix = Path(filename).suffix.lstrip(".").lower()
            if suffix not in config.VIDEO_EXTS:
                continue
            full = str(Path(dirpath) / filename)
            key = normalize_key(full)
            if key in seen:
                continue
            seen.add(key)
            found.append(full)
    return found
