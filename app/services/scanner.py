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
