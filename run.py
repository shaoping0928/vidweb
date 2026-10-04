import logging

import uvicorn

from app import config


def main():
    cfg = config.load_config()
    host = str(cfg.get("host") or "127.0.0.1")
    port = int(cfg.get("port") or 8765)
    print(f"{config.APP_NAME} {config.APP_VERSION} -> http://{host}:{port}")
    if not config.ffmpeg_path():
        print("提示: 未检测到 ffmpeg，缩略图与媒体信息探测将不可用。")
    logging.getLogger("uvicorn.access").disabled = not bool(cfg.get("access_log"))
    uvicorn.run("app.main:app", host=host, port=port, reload=False, access_log=True)


if __name__ == "__main__":
    main()
