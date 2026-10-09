import os
import shlex
import socket
import subprocess
import threading
from pathlib import Path

from .. import config

_lock = threading.Lock()
_proc = None


def exe_path():
    raw = (config.load_config().get("hfs_exe") or "").strip()
    if not raw:
        return None
    path = Path(raw)
    if path.is_dir():
        path = path / ("hfs.exe" if os.name == "nt" else "hfs")
    return str(path) if path.exists() else None


def _ini_values() -> dict:
    exe = exe_path()
    if not exe:
        return {}
    ini = Path(exe).parent / "hfs.ini"
    values = {}
    if ini.exists():
        try:
            for line in ini.read_text(encoding="utf-8", errors="replace").splitlines():
                if "=" not in line or line.startswith("["):
                    continue
                key, _, value = line.partition("=")
                values[key.strip().lower()] = value.strip()
        except OSError:
            pass
    return values


def _host_port():
    ini = _ini_values()
    try:
        port = int(ini.get("port") or 4323)
    except (TypeError, ValueError):
        port = 4323
    ip = (ini.get("ip") or "").strip()
    host = ip if ip and ip not in ("0.0.0.0", "127.0.0.1") else "127.0.0.1"
    return host, port


def _reachable(host: str, port: int, timeout: float = 0.6) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def url() -> str:
    explicit = (config.load_config().get("hfs_url") or "").strip()
    if explicit:
        return explicit
    host, port = _host_port()
    return f"http://{host}:{port}/"


def status() -> dict:
    cfg = config.load_config()
    exe = exe_path()
    host, port = _host_port()
    proc_running = _proc is not None and _proc.poll() is None
    listening = _reachable(host, port) if exe else False
    return {
        "configured": bool(exe),
        "exe": exe or (cfg.get("hfs_exe") or ""),
        "running": proc_running or listening,
        "managed": proc_running,
        "host": host,
        "port": port,
        "url": url(),
        "vfs": (cfg.get("hfs_vfs") or "").strip(),
    }


def start() -> dict:
    global _proc
    exe = exe_path()
    if not exe:
        raise RuntimeError("未配置 hfs_exe（请在 config.json 中指定 hfs.exe 路径）")
    with _lock:
        if _proc is not None and _proc.poll() is None:
            return status()
        args = [exe]
        cfg = config.load_config()
        vfs = (cfg.get("hfs_vfs") or "").strip()
        if vfs:
            args.append(vfs)
        extra = (cfg.get("hfs_args") or "").strip()
        if extra:
            args += shlex.split(extra, posix=False)
        _proc = subprocess.Popen(
            args,
            cwd=str(Path(exe).parent),
            close_fds=True,
        )
    return status()


def stop() -> dict:
    global _proc
    with _lock:
        proc = _proc
        _proc = None
    if proc is not None and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
    return status()


def autostart() -> None:
    cfg = config.load_config()
    if not cfg.get("hfs_autostart"):
        return
    if not exe_path():
        return
    try:
        start()
    except Exception:
        pass
