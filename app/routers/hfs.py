from fastapi import APIRouter, HTTPException

from ..services import hfs

router = APIRouter(prefix="/api")


@router.get("/hfs/status")
def hfs_status():
    return hfs.status()


@router.post("/hfs/start")
def hfs_start():
    try:
        return hfs.start()
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/hfs/stop")
def hfs_stop():
    return hfs.stop()
