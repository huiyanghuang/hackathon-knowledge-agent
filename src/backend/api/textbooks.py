"""Textbook upload, parse, and knowledge extraction endpoints."""
import json
import os
import uuid
from pathlib import Path

import aiofiles
from fastapi import APIRouter, BackgroundTasks, HTTPException, UploadFile, File
from fastapi.responses import JSONResponse

from core.config import settings
from services.extractor import extract_textbook_knowledge
from services.parser import parse_file
from services.rag_service import index_textbook
from services.vector_store import get_store

router = APIRouter(prefix="/api/textbooks", tags=["textbooks"])

# In-memory store
_textbooks: dict = {}
_graphs: dict = {}
_parse_status: dict = {}

# 启动时加载 batch_process.py 的离线处理结果
_PROCESSED_DIR = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "data", "processed")
)


def _load_preprocessed():
    """Load results from batch_process.py if available."""
    if not os.path.exists(_PROCESSED_DIR):
        return
    for fname in os.listdir(_PROCESSED_DIR):
        if not fname.endswith(".json") or fname == "summary.json":
            continue
        fpath = os.path.join(_PROCESSED_DIR, fname)
        try:
            with open(fpath, encoding="utf-8") as f:
                data = json.load(f)
            tid = data["textbook_id"]
            _textbooks[tid] = {
                "textbook_id": tid,
                "filename": data.get("filename", ""),
                "title": data.get("title", ""),
                "total_pages": data.get("total_pages", 0),
                "total_chars": data.get("total_chars", 0),
                "chapters": data.get("chapters", []),
            }
            _graphs[tid] = {
                "nodes": data.get("nodes", []),
                "edges": data.get("edges", []),
            }
            _parse_status[tid] = "done"
        except Exception as e:
            print(f"[load_preprocessed] Failed to load {fname}: {e}")
    if _textbooks:
        print(f"[startup] Loaded {len(_textbooks)} preprocessed textbooks from {_PROCESSED_DIR}")


_load_preprocessed()


def _get_store_path(filename: str) -> str:
    os.makedirs(settings.upload_path, exist_ok=True)
    return os.path.join(settings.upload_path, filename)


async def _process_textbook(textbook_id: str, file_path: str, original_name: str):
    try:
        _parse_status[textbook_id] = "parsing"
        textbook = parse_file(file_path, textbook_id)
        _textbooks[textbook_id] = textbook.model_dump()
        _parse_status[textbook_id] = "extracting"

        nodes, edges = extract_textbook_knowledge(
            textbook_id, textbook.title, textbook.chapters
        )
        _graphs[textbook_id] = {
            "nodes": [n.model_dump() for n in nodes],
            "edges": [e.model_dump() for e in edges],
        }

        index_textbook(textbook_id, textbook.title, textbook.chapters)
        _parse_status[textbook_id] = "done"
    except Exception as e:
        _parse_status[textbook_id] = f"error: {e}"
        print(f"[textbooks] Error processing {textbook_id}: {e}")


@router.post("/upload")
async def upload_textbook(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
):
    ext = Path(file.filename).suffix.lower()
    if ext not in {".pdf", ".md", ".txt", ".markdown", ".docx"}:
        raise HTTPException(400, f"Unsupported format: {ext}")

    textbook_id = str(uuid.uuid4())[:8]
    safe_name = f"{textbook_id}{ext}"
    file_path = _get_store_path(safe_name)

    async with aiofiles.open(file_path, "wb") as f:
        content = await file.read()
        await f.write(content)

    _parse_status[textbook_id] = "queued"
    background_tasks.add_task(_process_textbook, textbook_id, file_path, file.filename)

    return {"textbook_id": textbook_id, "filename": file.filename, "status": "queued"}


@router.get("/")
def list_textbooks():
    result = []
    for tid, tb in _textbooks.items():
        result.append({
            "textbook_id": tid,
            "filename": tb.get("filename"),
            "title": tb.get("title"),
            "total_pages": tb.get("total_pages"),
            "total_chars": tb.get("total_chars"),
            "status": _parse_status.get(tid, "unknown"),
        })
    # Also include ones still being processed
    for tid, status in _parse_status.items():
        if tid not in _textbooks:
            result.append({"textbook_id": tid, "status": status})
    return result


@router.get("/{textbook_id}/status")
def get_status(textbook_id: str):
    return {"textbook_id": textbook_id, "status": _parse_status.get(textbook_id, "not_found")}


@router.get("/{textbook_id}/graph")
def get_graph(textbook_id: str):
    if textbook_id not in _graphs:
        raise HTTPException(404, "Graph not ready yet")
    return _graphs[textbook_id]


@router.delete("/{textbook_id}")
def delete_textbook(textbook_id: str):
    _textbooks.pop(textbook_id, None)
    _graphs.pop(textbook_id, None)
    _parse_status.pop(textbook_id, None)
    try:
        get_store().delete_by_textbook(textbook_id)
    except Exception as e:
        print(f"[textbooks] Failed to clean vector store for {textbook_id}: {e}")
    return {"deleted": textbook_id}


def get_all_graphs() -> dict:
    return _graphs


def get_all_textbooks() -> dict:
    return _textbooks
