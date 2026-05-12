"""RAG query endpoints."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services.rag_service import get_index_status, query

router = APIRouter(prefix="/api/rag", tags=["rag"])


class QueryRequest(BaseModel):
    question: str
    textbook_ids: list[str] | None = None


@router.post("/query")
def rag_query(req: QueryRequest):
    if not req.question.strip():
        raise HTTPException(400, "Question cannot be empty")
    result = query(req.question, req.textbook_ids)
    return result.model_dump()


@router.get("/status")
def rag_status():
    return get_index_status()
