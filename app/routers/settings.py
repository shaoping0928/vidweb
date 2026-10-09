import logging
import os
import shutil
import subprocess
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import config

router = APIRouter(prefix="/api")


class SettingsBody(BaseModel):
    host: Optional[str] = None
    port: Optional[int] = None
    allowed_roots: Optional[list] = None
    ffmpeg: Optional[str] = None
    ffprobe: Optional[str] = None
    transcode: Optional[bool] = None
    transcode_encoder: Optional[str] = None
    access_log: Optional[bool] = None
    hfs_exe: Optional[str] = None
    hfs_url: Optional[str] = None
    hfs_vfs: Optional[str] = None
    hfs_args: Optional[str] = None
    hfs_autostart: Optional[bool] = None


class TestToolBody(BaseModel):
    path: str
    tool: str = "ffmpeg"


def _resolve_tool(value: str, name: str):
    value = (value or "").strip()
    if not value:
        return None
    path = Path(value)
    if path.is_dir():
        candidate = path / (name + (".exe" if os.name == "nt" else ""))
        return str(candidate) if candidate.exists() else None
    if path.exists():
        return str(path)
    return shutil.which(value)


def _settings_payload() -> dict:
    cfg = config.load_config()
    return {
        "host": cfg.get("host") or "0.0.0.0",
        "port": int(cfg.get("port") or 8765),
        "allowed_roots": [str(p) for p in (cfg.get("allowed_roots") or [])],
        "effective_roots": [str(p) for p in config.allowed_roots()],
        "ffmpeg": cfg.get("ffmpeg") or "",
        "ffprobe": cfg.get("ffprobe") or "",
        "transcode": bool(cfg.get("transcode")),
        "transcode_encoder": (cfg.get("transcode_encoder") or "auto").lower(),
        "access_log": bool(cfg.get("access_log")),
        "hfs_exe": cfg.get("hfs_exe") or "",
        "hfs_url": cfg.get("hfs_url") or "",
        "hfs_vfs": cfg.get("hfs_vfs") or "",
        "hfs_args": cfg.get("hfs_args") or "",
        "hfs_autostart": bool(cfg.get("hfs_autostart")),
        "ffmpeg_resolved": config.ffmpeg_path() or "",
        "ffprobe_resolved": config.ffprobe_path() or "",
        "data_dir": str(config.DATA_DIR),
        "config_file": str(config.CONFIG_FILE),
        "playlist_dir": str(config.PLAYLIST_DIR),
    }


@router.get("/settings")
def get_settings():
    return _settings_payload()


@router.put("/settings")
def update_settings(body: SettingsBody):
    cfg = config.load_config()
    restart_required = False

    if body.host is not None:
        host = body.host.strip() or "0.0.0.0"
        if host != (cfg.get("host") or ""):
            restart_required = True
        cfg["host"] = host

    if body.port is not None:
        port = int(body.port)
        if not 1 <= port <= 65535:
            raise HTTPException(status_code=400, detail="端口必须在 1-65535 之间")
        if port != int(cfg.get("port") or 0):
            restart_required = True
        cfg["port"] = port

    if body.allowed_roots is not None:
        roots = []
        for raw in body.allowed_roots:
            raw = str(raw or "").strip()
            if not raw:
                continue
            path = Path(raw)
            if not path.is_absolute():
                raise HTTPException(status_code=400, detail=f"根目录必须是绝对路径: {raw}")
            if not path.exists() or not path.is_dir():
                raise HTTPException(status_code=400, detail=f"目录不存在: {raw}")
            value = str(path.resolve())
            if value not in roots:
                roots.append(value)
        cfg["allowed_roots"] = roots

    if body.ffmpeg is not None:
        cfg["ffmpeg"] = body.ffmpeg.strip()
    if body.ffprobe is not None:
        cfg["ffprobe"] = body.ffprobe.strip()
    if body.transcode is not None:
        cfg["transcode"] = bool(body.transcode)
    if body.transcode_encoder is not None:
        encoder = body.transcode_encoder.strip().lower() or "auto"
        if encoder not in ("auto", "nvenc", "qsv", "amf", "cpu"):
            raise HTTPException(status_code=400, detail="转码硬件取值无效")
        cfg["transcode_encoder"] = encoder
    if body.access_log is not None:
        cfg["access_log"] = bool(body.access_log)
        logging.getLogger("uvicorn.access").disabled = not cfg["access_log"]

    if body.hfs_exe is not None:
        value = body.hfs_exe.strip()
        if value and not _resolve_tool(value, "hfs"):
            raise HTTPException(status_code=400, detail=f"未找到 hfs 可执行文件: {value}")
        cfg["hfs_exe"] = value
    if body.hfs_url is not None:
        cfg["hfs_url"] = body.hfs_url.strip()
    if body.hfs_vfs is not None:
        cfg["hfs_vfs"] = body.hfs_vfs.strip()
    if body.hfs_args is not None:
        cfg["hfs_args"] = body.hfs_args.strip()
    if body.hfs_autostart is not None:
        cfg["hfs_autostart"] = bool(body.hfs_autostart)

    config.save_config(cfg)
    return {
        "ok": True,
        "restart_required": restart_required,
        "ffmpeg": bool(config.ffmpeg_path()),
        "ffprobe": bool(config.ffprobe_path()),
    }


@router.post("/settings/test-tool")
def test_tool(body: TestToolBody):
    tool = "ffprobe" if body.tool == "ffprobe" else "ffmpeg"
    resolved = _resolve_tool(body.path, tool) or shutil.which(body.path.strip())
    if not resolved:
        raise HTTPException(status_code=400, detail=f"未找到 {tool} 可执行文件")
    kwargs = {"capture_output": True, "timeout": 15}
    if os.name == "nt":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        proc = subprocess.run([resolved, "-version"], **kwargs)
    except (OSError, subprocess.SubprocessError) as exc:
        raise HTTPException(status_code=400, detail=f"执行失败: {exc}")
    if proc.returncode != 0:
        raise HTTPException(status_code=400, detail=f"执行失败，返回码 {proc.returncode}")
    lines = (proc.stdout or b"").decode("utf-8", "replace").splitlines()
    return {
        "ok": True,
        "resolved": resolved,
        "version": lines[0] if lines else "OK",
    }
