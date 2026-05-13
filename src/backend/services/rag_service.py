"""
RAG pipeline: chunk → embed → store (numpy) → retrieve → generate with citations.

Chunk size: 600 chars with 100-char overlap.
Rationale: Chinese text is ~2x denser than English per character, so 600 chars
covers a semantic unit equivalent to ~800-word English chunks, while staying
small enough for precise retrieval.
"""
import uuid

from rank_bm25 import BM25Okapi
import jieba

from core.llm import chat
from models.schemas import Chapter, RAGCitation, RAGResponse
from services.vector_store import VectorEntry, get_store

CHUNK_SIZE = 600
CHUNK_OVERLAP = 100
TOP_K = 5

RAG_SYSTEM = (
    "你是一个严谨的教材问答助手。请严格基于提供的上下文回答问题，"
    "不要使用上下文之外的知识。每个关键陈述必须附带来源引用，"
    "格式为[教材名称, 第X章, 第X页]。"
    "如果上下文中找不到答案，回复'当前知识库中未找到相关信息'。"
)


def _chunk_text(text: str) -> list[str]:
    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = min(start + CHUNK_SIZE, len(text))
        chunks.append(text[start:end])
        if end == len(text):
            break
        start += CHUNK_SIZE - CHUNK_OVERLAP
    return chunks


def index_textbook(
    textbook_id: str,
    textbook_name: str,
    chapters: list[Chapter],
) -> int:
    store = get_store()
    store.delete_by_textbook(textbook_id)

    entries: list[VectorEntry] = []
    texts: list[str] = []

    for chapter in chapters:
        for c in _chunk_text(chapter.content):
            entries.append(VectorEntry(
                chunk_id=str(uuid.uuid4()),
                text=c,
                textbook_id=textbook_id,
                textbook_name=textbook_name,
                chapter_title=chapter.title,
                page_start=chapter.page_start,
            ))
            texts.append(c)

    if entries:
        store.add(entries, texts)
    return len(entries)


def _bm25_rerank(query: str, items: list[tuple[VectorEntry, float]]) -> list[tuple[VectorEntry, float]]:
    if len(items) <= 1:
        return items
    tokenized = [list(jieba.cut(e.text)) for e, _ in items]
    bm25 = BM25Okapi(tokenized)
    q_tokens = list(jieba.cut(query))
    bm25_scores = bm25.get_scores(q_tokens)
    max_bm25 = max(bm25_scores) or 1
    combined = [
        (entry, 0.7 * vscore + 0.3 * (bm25_scores[i] / max_bm25))
        for i, (entry, vscore) in enumerate(items)
    ]
    return sorted(combined, key=lambda x: x[1], reverse=True)


def query(question: str, textbook_ids: list[str] | None = None) -> RAGResponse:
    store = get_store()
    raw_results = store.search(question, top_k=TOP_K, textbook_ids=textbook_ids)

    if not raw_results:
        return RAGResponse(answer="当前知识库中未找到相关信息", citations=[])

    reranked = _bm25_rerank(question, raw_results)

    context_parts: list[str] = []
    citations: list[RAGCitation] = []

    for i, (entry, score) in enumerate(reranked):
        context_parts.append(
            f"[来源{i+1}] 《{entry.textbook_name}》{entry.chapter_title} 第{entry.page_start}页\n{entry.text}"
        )
        citations.append(RAGCitation(
            textbook=entry.textbook_name,
            chapter=entry.chapter_title,
            page=entry.page_start,
            relevance_score=round(score, 3),
            chunk_text=entry.text,
        ))

    context = "\n\n".join(context_parts)
    prompt = f"{RAG_SYSTEM}\n\n问题：{question}\n\n参考上下文：\n{context}"

    try:
        answer = chat(prompt)
    except Exception as e:
        emsg = str(e)
        if "timeout" in emsg.lower() or "deadline" in emsg.lower() or "524" in emsg:
            answer = "⏱ AI 生成回答超时。可能上下文过长或 Gemini 当前繁忙。下方仍可看到检索到的原文，请稍后重试或换种问法。"
        elif "429" in emsg:
            answer = "🚦 触发 API 限速（48 次/分钟）。请稍等几秒再试。"
        else:
            answer = f"❌ 生成回答失败：{emsg[:200]}"

    return RAGResponse(answer=answer, citations=citations)


def get_index_status() -> dict:
    store = get_store()
    count = store.total_chunks
    return {"total_chunks": count, "status": "ready" if count > 0 else "empty"}
