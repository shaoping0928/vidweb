import os
from pathlib import Path

from .. import config


def scan_videos(root) -> list:
    root = Path(root)
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort(key=str.lower)
        for filename in sorted(filenames, key=str.lower):
            suffix = Path(filename).suffix.lstrip(".").lower()
            if suffix in config.VIDEO_EXTS:
                found.append(str(Path(dirpath) / filename))
    return found
