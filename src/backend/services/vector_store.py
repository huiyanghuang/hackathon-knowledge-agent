"""
Lightweight numpy-based vector store using Gemini Embedding API.
No local model download needed — uses gemini-embedding-001.
Persists to disk as .npz + .json.
"""
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from pathlib import Path
from threading import Lock

import google.generativeai as genai
import numpy as np

from core import stats
from core.config import settings

EMBED_MODEL = "models/gemini-embedding-001"
EMBED_BATCH = 20      # API request size
EMBED_CONCURRENCY = 16  # Gemini Embedding 限速 3K RPM，16 并发约 480 RPM 安全


def _embed_one_batch(batch: list[str]) -> list[list[float]]:
    for attempt in range(6):
        try:
            result = genai.embed_content(
                model=EMBED_MODEL,
                content=batch,
                task_type="RETRIEVAL_DOCUMENT",
            )
            stats.record_embed(batch)
            return result["embedding"]
        except Exception as e:
            msg = str(e)
            if ("429" in msg or "504" in msg or "503" in msg) and attempt < 5:
                wait = 2 ** attempt  # 1, 2, 4, 8, 16, 32 s
                print(f"  [vector_store] embed API {msg[:50]}, retry in {wait}s ({attempt+1}/6)")
                time.sleep(wait)
            else:
                raise
    raise RuntimeError("embed batch failed after 6 retries")


def _embed_texts(texts: list[str], _on_batch=None) -> np.ndarray:
    """Embed a list of texts in parallel batches."""
    n_batches = max(1, -(-len(texts) // EMBED_BATCH))  # ceil div
    batches = [texts[i * EMBED_BATCH: (i + 1) * EMBED_BATCH] for i in range(n_batches)]

    results: dict[int, list[list[float]]] = {}
    done_lock = Lock()
    done = [0]

    def _worker(idx: int, batch: list[str]):
        emb = _embed_one_batch(batch)
        with done_lock:
            results[idx] = emb
            done[0] += 1
            if _on_batch:
                _on_batch(done[0], n_batches)

    with ThreadPoolExecutor(max_workers=EMBED_CONCURRENCY) as ex:
        futures = [ex.submit(_worker, i, b) for i, b in enumerate(batches)]
        for fut in as_completed(futures):
            fut.result()  # propagate exceptions

    all_embeddings: list[list[float]] = []
    for i in range(n_batches):
        all_embeddings.extend(results[i])

    arr = np.array(all_embeddings, dtype=np.float32)
    norms = np.linalg.norm(arr, axis=1, keepdims=True)
    norms = np.where(norms == 0, 1, norms)
    return arr / norms


def _embed_query(text: str) -> np.ndarray:
    last_err: Exception | None = None
    for attempt in range(4):
        try:
            result = genai.embed_content(
                model=EMBED_MODEL,
                content=text,
                task_type="RETRIEVAL_QUERY",
            )
            stats.record_embed([text])
            arr = np.array(result["embedding"], dtype=np.float32)
            norm = np.linalg.norm(arr)
            return arr / norm if norm > 0 else arr
        except Exception as e:
            last_err = e
            msg = str(e)
            if ("429" in msg or "504" in msg or "503" in msg) and attempt < 3:
                time.sleep(2 ** attempt)
            else:
                raise
    raise RuntimeError(f"Embedding query failed after retries: {last_err}")


@dataclass
class VectorEntry:
    chunk_id: str
    text: str
    textbook_id: str
    textbook_name: str
    chapter_title: str
    page_start: int


class VectorStore:
    def __init__(self, persist_dir: str):
        self.persist_dir = Path(persist_dir)
        self.persist_dir.mkdir(parents=True, exist_ok=True)
        self._embeddings: np.ndarray | None = None
        self._entries: list[VectorEntry] = []
        self._load()

    def _vec_path(self) -> Path:
        return self.persist_dir / "vectors.npz"

    def _meta_path(self) -> Path:
        return self.persist_dir / "metadata.json"

    def _load(self):
        if self._vec_path().exists() and self._meta_path().exists():
            data = np.load(str(self._vec_path()))
            self._embeddings = data["embeddings"]
            with open(self._meta_path(), encoding="utf-8") as f:
                raw = json.load(f)
            self._entries = [VectorEntry(**r) for r in raw]

    def _save(self):
        if self._embeddings is not None and len(self._embeddings):
            np.savez_compressed(str(self._vec_path()), embeddings=self._embeddings)
        with open(self._meta_path(), "w", encoding="utf-8") as f:
            json.dump([asdict(e) for e in self._entries], f, ensure_ascii=False)

    def delete_by_textbook(self, textbook_id: str):
        if not self._entries:
            return
        keep_idx = [i for i, e in enumerate(self._entries) if e.textbook_id != textbook_id]
        self._embeddings = self._embeddings[keep_idx] if keep_idx else None
        self._entries = [self._entries[i] for i in keep_idx]
        self._save()

    def add(self, entries: list[VectorEntry], texts: list[str]):
        print(f"  [vector_store] embedding {len(texts)} chunks...")
        new_emb = _embed_texts(texts)
        self._embeddings = np.vstack([self._embeddings, new_emb]) if self._embeddings is not None and len(self._embeddings) else new_emb
        self._entries.extend(entries)
        self._save()

    def search(
        self,
        query: str,
        top_k: int = 5,
        textbook_ids: list[str] | None = None,
    ) -> list[tuple[VectorEntry, float]]:
        if self._embeddings is None or len(self._entries) == 0:
            return []
        q_emb = _embed_query(query)
        scores = self._embeddings @ q_emb

        if textbook_ids:
            tid_set = set(textbook_ids)
            for i, e in enumerate(self._entries):
                if e.textbook_id not in tid_set:
                    scores[i] = -1.0

        top_idx = np.argsort(scores)[::-1][:top_k]
        return [(self._entries[i], float(scores[i])) for i in top_idx if scores[i] > 0]

    @property
    def total_chunks(self) -> int:
        return len(self._entries)


_store: VectorStore | None = None


def get_store() -> VectorStore:
    global _store
    if _store is None:
        _store = VectorStore(settings.chroma_path)
    return _store
