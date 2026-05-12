"""Token / cost statistics endpoint."""
from fastapi import APIRouter

from core import stats

router = APIRouter(prefix="/api/stats", tags=["stats"])


@router.get("/")
def get_stats():
    return stats.snapshot()


@router.post("/reset")
def reset_stats():
    stats.reset()
    return {"ok": True}
