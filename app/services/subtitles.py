import re
from pathlib import Path

from ..utils import decode_bytes

_TAG_RE = re.compile(r"\{\\[^}]*\}")


def _parse_time(value: str) -> int:
    text = (value or "").strip().replace(",", ".")
    parts = text.split(":")
    if len(parts) < 2:
        return -1
    try:
        seconds = float(parts[-1])
    except ValueError:
        return -1
    total = int(seconds * 1000 + 0.5)
    try:
        total += int(parts[-2]) * 60000
        if len(parts) >= 3:
            total += int(parts[-3]) * 3600000
    except ValueError:
        return -1
    return total


def _parse_srt_vtt(lines: list) -> list:
    cues = []
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if not line or line.startswith("WEBVTT") or line.startswith("NOTE") or "-->" not in line:
            i += 1
            continue
        parts = line.split("-->")
        if len(parts) != 2:
            i += 1
            continue
        start = _parse_time(parts[0])
        end = _parse_time(parts[1].strip().split(" ")[0])
        i += 1
        text_lines = []
        while i < len(lines) and lines[i].strip():
            text_lines.append(lines[i].strip())
            i += 1
        text = "\n".join(text_lines)
        if end > start and text:
            cues.append({"start": start, "end": end, "text": text})
    return cues


def _parse_ass(lines: list) -> list:
    cues = []
    for line in lines:
        if not line.startswith("Dialogue:"):
            continue
        parts = line[9:].split(",")
        if len(parts) < 10:
            continue
        start = _parse_time(parts[1])
        end = _parse_time(parts[2])
        content = ",".join(parts[9:])
        content = _TAG_RE.sub("", content)
        content = content.replace("\\N", "\n").replace("\\n", "\n").strip()
        if end > start and content:
            cues.append({"start": start, "end": end, "text": content})
    return cues


def parse_bytes(data: bytes, suffix: str = "") -> list:
    text = decode_bytes(data)
    lines = [line[:-1] if line.endswith("\r") else line for line in text.split("\n")]
    if suffix.lower() in ("ass", "ssa"):
        return _parse_ass(lines)
    return _parse_srt_vtt(lines)


def parse_file(path) -> list:
    data = Path(path).read_bytes()
    return parse_bytes(data, Path(path).suffix.lstrip("."))


def find_for_video(video_path: str):
    video = Path(video_path)
    for ext in ("srt", "ass", "vtt"):
        candidate = video.with_suffix("." + ext)
        if candidate.exists():
            return candidate
    return None
