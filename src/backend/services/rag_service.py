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

RAG_SYSTEM = """你是教材问答助手，基于下方"参考上下文"回答用户问题。

规则：
1. **不使用上下文之外的知识**——上下文没说的不要编造
2. **每个关键陈述附引用**，格式 `[教材名称, 第X章, 第X页]`
3. **灵活匹配**：用户的提问表述和教材原文表述常常不一致
   - 例：问"三个阶段"但教材讲的是"五个步骤" → **直接用教材的实际表述来回答**，并用一句话指出措辞差异让用户理解
   - 例：问"X 和 Y 的关系"但教材分别讲了 X 和 Y → 把两段都列出来，让用户自己看到关联
   - 只要主题在上下文里被提到过，**就给出基于上下文的回答**，不要直接说"找不到"
4. **真正找不到才拒答**：只有上下文里完全没提到该主题（不是表述不同），才回复"当前知识库中未找到相关信息"
5. **简洁直接**：先给核心信息（用 markdown 列表/加粗组织），再给引用；避免"基于上下文..."这类客套开头
"""


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
        elow = emsg.lower()
        if "timeout" in elow or "deadline" in elow or "524" in emsg or "499" in emsg or "cancel" in elow:
            answer = "⏱ AI 生成回答超时。可能上下文过长或 Gemini 当前繁忙。下方仍可看到检索到的原文，请稍后重试或换种问法。"
        elif "429" in emsg:
            answer = "🚦 触发 API 限速。请稍等几秒再试。"
        else:
            answer = f"❌ 生成回答失败：{emsg[:200]}"

    return RAGResponse(answer=answer, citations=citations)


def get_index_status() -> dict:
    store = get_store()
    count = store.total_chunks
    return {"total_chunks": count, "status": "ready" if count > 0 else "empty"}
