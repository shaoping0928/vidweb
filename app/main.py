from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from . import config, db
from .routers import browse, comments, files, library, recent, search, tags, thumbs

MINIMAL_HTML = """
<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>Media Web</title></head>
<body style="background:#20242a;color:#e8eaed;font-family:sans-serif">
<p>前端资源缺失：请确认 static/ 目录存在。</p>
</body></html>
"""


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    yield


app = FastAPI(
    title=config.APP_NAME,
    version=config.APP_VERSION,
    lifespan=lifespan,
)

app.include_router(browse.router)
app.include_router(library.router)
app.include_router(files.router)
app.include_router(tags.router)
app.include_router(comments.router)
app.include_router(search.router)
app.include_router(recent.router)
app.include_router(thumbs.router)


@app.get("/api/config")
def app_config():
    return {
        "name": config.APP_NAME,
        "version": config.APP_VERSION,
        "ffmpeg": bool(config.ffmpeg_path()),
        "ffprobe": bool(config.ffprobe_path()),
        "ffmpeg_path": config.ffmpeg_path() or "",
        "roots": [str(root) for root in config.allowed_roots()],
        "data_dir": str(config.DATA_DIR),
        "default_m3u": str(config.PLAYLIST_DIR / "playlist.m3u"),
        "default_thumb_batch": True,
        "video_exts": sorted(config.VIDEO_EXTS),
    }


if config.STATIC_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(config.STATIC_DIR), html=True), name="static")
else:
    from fastapi.responses import HTMLResponse

    @app.get("/", response_class=HTMLResponse)
    def index():
        return MINIMAL_HTML
