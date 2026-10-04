import os
from pathlib import Path

from fastapi import HTTPException

from . import config


def _inside(real: Path, root: Path) -> bool:
    try:
        common = os.path.commonpath([str(real).lower(), str(root).lower()])
    except ValueError:
        return False
    return common == str(root).lower()


def safe_path(raw: str, must_exist: bool = True, for_write: bool = False) -> Path:
    if raw is None or not str(raw).strip():
        raise HTTPException(status_code=400, detail="路径不能为空")
    path = Path(os.path.expandvars(str(raw).strip()))
    if not path.is_absolute():
        raise HTTPException(status_code=400, detail="必须使用绝对路径")
    real = path.resolve()
    roots = list(config.allowed_roots())
    if for_write:
        roots.append(config.DATA_DIR.resolve())
    if not any(_inside(real, root.resolve()) for root in roots):
        raise HTTPException(status_code=403, detail="路径不在允许访问的目录内")
    if must_exist and not real.exists():
        raise HTTPException(status_code=404, detail=f"路径不存在: {real}")
    return real
