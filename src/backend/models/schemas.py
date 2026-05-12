from pydantic import BaseModel
from typing import Optional


class Chapter(BaseModel):
    chapter_id: str
    title: str
    page_start: int
    page_end: int
    content: str
    char_count: int


class Textbook(BaseModel):
    textbook_id: str
    filename: str
    title: str
    total_pages: int
    total_chars: int
    chapters: list[Chapter]


class KnowledgeNode(BaseModel):
    id: str
    name: str
    definition: str
    category: str
    chapter: str
    page: int
    textbook_id: str
    textbook_name: str
    frequency: int = 1


class KnowledgeEdge(BaseModel):
    source: str
    target: str
    relation_type: str
    description: str


class MergeDecision(BaseModel):
    decision_id: str
    action: str  # merge / keep / remove
    affected_nodes: list[str]
    result_node: Optional[str]
    reason: str
    confidence: float


class RAGCitation(BaseModel):
    textbook: str
    chapter: str
    page: int
    relevance_score: float
    chunk_text: str


class RAGResponse(BaseModel):
    answer: str
    citations: list[RAGCitation]


class ChatMessage(BaseModel):
    role: str  # user / assistant
    content: str


class ChatRequest(BaseModel):
    message: str
    session_id: str = "default"
