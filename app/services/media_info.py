import json
import os
import struct
import subprocess

from .. import config


def _run(cmd: list, timeout: int = 20):
    kwargs = {"capture_output": True, "timeout": timeout}
    if os.name == "nt":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return subprocess.run(cmd, **kwargs)


def _probe_ffprobe(path: str):
    tool = config.ffprobe_path()
    if not tool:
        return None
    cmd = [
        tool, "-v", "error",
        "-show_entries", "stream=width,height:format=duration:format_tags=title",
        "-select_streams", "v:0",
        "-of", "json", path,
    ]
    try:
        proc = _run(cmd)
        if proc.returncode != 0:
            return None
        data = json.loads(proc.stdout.decode("utf-8", "replace") or "{}")
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
    info = {}
    streams = data.get("streams") or []
    if streams:
        width = streams[0].get("width") or 0
        height = streams[0].get("height") or 0
        if width:
            info["width"] = int(width)
        if height:
            info["height"] = int(height)
    fmt = data.get("format") or {}
    duration = fmt.get("duration")
    if duration:
        try:
            info["duration_ms"] = int(float(duration) * 1000)
        except ValueError:
            pass
    title = (fmt.get("tags") or {}).get("title")
    if title:
        info["title"] = str(title)
    return info or None


def _read_boxes(f, start: int, end: int):
    f.seek(start)
    while f.tell() + 8 <= end:
        pos = f.tell()
        header = f.read(8)
        if len(header) < 8:
            break
        size, typ = struct.unpack(">I4s", header)
        typ = typ.decode("latin1", "replace")
        header_size = 8
        if size == 1:
            large = f.read(8)
            if len(large) < 8:
                break
            size = struct.unpack(">Q", large)[0]
            header_size = 16
        elif size == 0:
            size = end - pos
        if size < header_size:
            break
        yield typ, pos + header_size, pos + size
        f.seek(pos + size)


def _probe_mp4(path: str):
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            file_end = f.tell()
            moov = None
            for typ, content_start, content_end in _read_boxes(f, 0, file_end):
                if typ == "moov":
                    moov = (content_start, content_end)
                    break
            if not moov:
                return None
            info = {}
            for typ, content_start, content_end in _read_boxes(f, *moov):
                if typ == "mvhd":
                    f.seek(content_start)
                    data = f.read(min(content_end - content_start, 120))
                    if len(data) < 20:
                        continue
                    if data[0] == 1 and len(data) >= 32:
                        timescale, duration = struct.unpack(">IQ", data[20:32])
                    else:
                        timescale, duration = struct.unpack(">II", data[12:20])
                    if timescale:
                        info["duration_ms"] = int(duration * 1000 / timescale)
                elif typ == "trak":
                    for sub, sub_start, sub_end in _read_boxes(f, content_start, content_end):
                        if sub != "tkhd":
                            continue
                        f.seek(sub_start)
                        data = f.read(min(sub_end - sub_start, 96))
                        if data[0] == 1:
                            if len(data) < 96:
                                continue
                            width, height = struct.unpack(">II", data[88:96])
                        else:
                            if len(data) < 84:
                                continue
                            width, height = struct.unpack(">II", data[76:84])
                        width >>= 16
                        height >>= 16
                        if width and height:
                            info.setdefault("width", width)
                            info.setdefault("height", height)
                        break
            return info or None
    except (OSError, struct.error, ValueError):
        return None


def probe(path: str):
    if not path or not os.path.exists(path):
        return None
    info = _probe_ffprobe(path)
    if info:
        return info
    return _probe_mp4(path)


def streams(path: str):
    tool = config.ffprobe_path()
    if not tool or not path or not os.path.exists(path):
        return None
    cmd = [
        tool, "-v", "error",
        "-show_entries", "stream=codec_type,codec_name,profile:format=format_name",
        "-of", "json", path,
    ]
    try:
        proc = _run(cmd)
        if proc.returncode != 0:
            return None
        data = json.loads(proc.stdout.decode("utf-8", "replace") or "{}")
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
    result = {"container": (data.get("format") or {}).get("format_name", ""), "video": "", "audio": "", "profile": ""}
    for stream in data.get("streams") or []:
        kind = stream.get("codec_type")
        if kind == "video" and not result["video"]:
            result["video"] = stream.get("codec_name", "")
            result["profile"] = stream.get("profile", "")
        elif kind == "audio" and not result["audio"]:
            result["audio"] = stream.get("codec_name", "")
    return result
