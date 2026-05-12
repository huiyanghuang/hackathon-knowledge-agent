"""Cross-textbook graph alignment and compression endpoints."""
import json
import os
import threading
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException

from core.config import settings
from models.schemas import KnowledgeEdge, KnowledgeNode, MergeDecision
from services.aligner import align_nodes, compress_nodes, rebuild_edges

router = APIRouter(prefix="/api/graph", tags=["graph"])

_ALIGN_FILE = os.path.join(os.path.dirname(settings.upload_path), "processed", "align_result.json")

_merged_nodes: list[KnowledgeNode] = []
_merged_edges: list[KnowledgeEdge] = []
_decisions: list[MergeDecision] = []
_stats: dict = {}


def _persist_alignment():
    try:
        os.makedirs(os.path.dirname(_ALIGN_FILE), exist_ok=True)
        with open(_ALIGN_FILE, "w", encoding="utf-8") as f:
            json.dump({
                "nodes": [n.model_dump() for n in _merged_nodes],
                "edges": [e.model_dump() for e in _merged_edges],
                "decisions": [d.model_dump() for d in _decisions],
                "stats": _stats,
            }, f, ensure_ascii=False)
    except Exception as e:
        print(f"[graph] persist failed: {e}")


def _load_alignment():
    global _merged_nodes, _merged_edges, _decisions, _stats
    if not os.path.exists(_ALIGN_FILE):
        return
    try:
        with open(_ALIGN_FILE, encoding="utf-8") as f:
            d = json.load(f)
        _merged_nodes = [KnowledgeNode(**n) for n in d.get("nodes", [])]
        _merged_edges = [KnowledgeEdge(**e) for e in d.get("edges", [])]
        _decisions = [MergeDecision(**x) for x in d.get("decisions", [])]
        _stats = d.get("stats", {})
        print(f"[graph] restored alignment: {len(_merged_nodes)} nodes, {len(_decisions)} decisions")
    except Exception as e:
        print(f"[graph] load failed: {e}")


_load_alignment()

_align_state: dict[str, Any] = {
    "running": False,
    "progress": 0,
    "message": "",
    "error": None,
    "done": False,
}


def _run_alignment():
    global _merged_nodes, _merged_edges, _decisions, _stats, _align_state

    def progress_cb(pct: int, msg: str):
        _align_state["progress"] = pct
        _align_state["message"] = msg

    try:
        from api.textbooks import get_all_graphs

        all_graphs = get_all_graphs()
        if len(all_graphs) < 1:
            _align_state["error"] = "没有可用的知识图谱，请先上传并处理教材"
            _align_state["done"] = True
            _align_state["running"] = False
            return

        raw_nodes: list[KnowledgeNode] = []
        raw_edges: list[KnowledgeEdge] = []
        for tid, g in all_graphs.items():
            for n in g.get("nodes", []):
                raw_nodes.append(KnowledgeNode(**n))
            for e in g.get("edges", []):
                raw_edges.append(KnowledgeEdge(**e))

        if not raw_nodes:
            _align_state["error"] = "所有教材的知识图谱均为空（节点数为0），请检查教材是否已完成知识抽取（后端日志可查看LLM调用是否报错）"
            _align_state["done"] = True
            _align_state["running"] = False
            return

        original_chars = sum(len(n.name) + len(n.definition) for n in raw_nodes)

        progress_cb(1, f"准备对齐 {len(raw_nodes)} 个节点...")
        merged, decisions = align_nodes(raw_nodes, progress_cb=progress_cb)

        progress_cb(92, "重建边关系...")
        decision_map: dict[str, str] = {}
        for d in decisions:
            if d.result_node:
                for old_id in d.affected_nodes:
                    decision_map[old_id] = d.result_node

        kept_ids = {n.id for n in merged}
        remapped_edges = rebuild_edges(raw_edges, kept_ids, decision_map)

        progress_cb(96, "压缩节点至30%...")
        compressed = compress_nodes(merged, original_chars)
        compressed_ids = {n.id for n in compressed}
        final_edges = [e for e in remapped_edges if e.source in compressed_ids and e.target in compressed_ids]

        compressed_chars = sum(len(n.name) + len(n.definition) for n in compressed)
        ratio = round(compressed_chars / original_chars, 3) if original_chars > 0 else 0

        _merged_nodes = compressed
        _merged_edges = final_edges
        _decisions = decisions
        _stats = {
            "original_nodes": len(raw_nodes),
            "merged_nodes": len(merged),
            "compressed_nodes": len(compressed),
            "original_chars": original_chars,
            "compressed_chars": compressed_chars,
            "compression_ratio": ratio,
            "decisions_merge": sum(1 for d in decisions if d.action == "merge"),
            "decisions_keep": sum(1 for d in decisions if d.action == "keep"),
            "decisions_remove": len(decisions) - len(compressed),
        }

        _persist_alignment()
        progress_cb(100, "对齐完成！")
        _align_state["done"] = True

    except Exception as e:
        _align_state["error"] = str(e)
        _align_state["done"] = True
    finally:
        _align_state["running"] = False


@router.post("/align/start")
def start_align():
    global _align_state
    if _align_state["running"]:
        return {"status": "already_running", "progress": _align_state["progress"]}
    _align_state = {"running": True, "progress": 0, "message": "启动中...", "error": None, "done": False}
    t = threading.Thread(target=_run_alignment, daemon=True)
    t.start()
    return {"status": "started"}


@router.get("/align/status")
def get_align_status():
    return _align_state


@router.get("/merged")
def get_merged_graph():
    return {
        "nodes": [n.model_dump() for n in _merged_nodes],
        "edges": [e.model_dump() for e in _merged_edges],
        "stats": _stats,
    }


@router.get("/decisions")
def get_decisions():
    return [d.model_dump() for d in _decisions]


@router.patch("/decisions/{decision_id}")
def override_decision(decision_id: str, body: dict):
    """Teacher overrides a merge decision."""
    action = body.get("action")
    for d in _decisions:
        if d.decision_id == decision_id:
            d.action = action or d.action
            d.reason = body.get("reason", d.reason)
            _persist_alignment()
            return {"updated": decision_id, "decision": d.model_dump()}
    raise HTTPException(404, "Decision not found")


@router.get("/stats")
def get_stats():
    return _stats


# ============ 手动决策操作 + 撤销栈 ============

_undo_stack: list[dict] = []
_UNDO_MAX = 20


def _push_undo(description: str):
    snapshot = {
        "description": description,
        "nodes": [n.model_dump() for n in _merged_nodes],
        "edges": [e.model_dump() for e in _merged_edges],
        "decisions": [d.model_dump() for d in _decisions],
        "stats": dict(_stats),
    }
    _undo_stack.append(snapshot)
    while len(_undo_stack) > _UNDO_MAX:
        _undo_stack.pop(0)


def _recompute_stats():
    if not _stats.get("original_chars"):
        return
    _stats["compressed_nodes"] = len(_merged_nodes)
    _stats["compressed_chars"] = sum(
        len(n.name) + len(n.definition) for n in _merged_nodes
    )
    _stats["compression_ratio"] = round(
        _stats["compressed_chars"] / _stats["original_chars"], 3
    )
    _stats["decisions_merge"] = sum(1 for d in _decisions if d.action == "merge")
    _stats["decisions_keep"] = sum(1 for d in _decisions if d.action == "keep")
    _stats["decisions_remove"] = sum(1 for d in _decisions if d.action == "remove")


def _dedupe_edges():
    seen: set[tuple[str, str, str]] = set()
    uniq: list[KnowledgeEdge] = []
    for e in _merged_edges:
        if e.source == e.target:
            continue
        key = (e.source, e.target, e.relation_type)
        if key in seen:
            continue
        seen.add(key)
        uniq.append(e)
    _merged_edges[:] = uniq


@router.post("/manual-merge")
def manual_merge(body: dict):
    """教师手动合并两个节点：把 source 合并到 target，保留信息量较大的那个。"""
    source_id = body.get("source_id")
    target_id = body.get("target_id")
    if not source_id or not target_id or source_id == target_id:
        raise HTTPException(400, "需要两个不同的节点 ID")

    a = next((n for n in _merged_nodes if n.id == source_id), None)
    b = next((n for n in _merged_nodes if n.id == target_id), None)
    if not a or not b:
        raise HTTPException(404, "节点不存在或已被删除")

    _push_undo(f"合并「{a.name}」与「{b.name}」")

    # 保留定义更长的作为代表，frequency 累加
    kept, dropped = (a, b) if len(a.definition) >= len(b.definition) else (b, a)
    kept.frequency = (kept.frequency or 1) + (dropped.frequency or 1)

    # 移除被丢弃节点
    _merged_nodes[:] = [n for n in _merged_nodes if n.id != dropped.id]

    # 边重映射
    for e in _merged_edges:
        if e.source == dropped.id:
            e.source = kept.id
        if e.target == dropped.id:
            e.target = kept.id
    _dedupe_edges()

    new_dec = MergeDecision(
        decision_id=f"manual_{uuid.uuid4().hex[:8]}",
        action="merge",
        affected_nodes=[a.id, b.id],
        result_node=kept.id,
        reason=f"教师手动合并：「{a.name}」与「{b.name}」→ 保留《{kept.textbook_name}》版本",
        confidence=1.0,
    )
    _decisions.append(new_dec)

    _recompute_stats()
    _persist_alignment()
    return {"merged_into": kept.id, "decision": new_dec.model_dump()}


@router.post("/manual-remove")
def manual_remove(body: dict):
    """教师手动删除一个节点。"""
    nid = body.get("node_id")
    target = next((n for n in _merged_nodes if n.id == nid), None)
    if not target:
        raise HTTPException(404, "节点不存在")

    _push_undo(f"删除「{target.name}」")

    _merged_nodes[:] = [n for n in _merged_nodes if n.id != nid]
    _merged_edges[:] = [
        e for e in _merged_edges if e.source != nid and e.target != nid
    ]

    new_dec = MergeDecision(
        decision_id=f"manual_{uuid.uuid4().hex[:8]}",
        action="remove",
        affected_nodes=[nid],
        result_node="",
        reason=f"教师手动删除：「{target.name}」",
        confidence=1.0,
    )
    _decisions.append(new_dec)

    _recompute_stats()
    _persist_alignment()
    return {"removed": nid, "decision": new_dec.model_dump()}


@router.post("/undo")
def undo_last():
    """撤销上一步手动操作。"""
    global _merged_nodes, _merged_edges, _decisions, _stats
    if not _undo_stack:
        raise HTTPException(400, "没有可撤销的操作")
    snap = _undo_stack.pop()
    _merged_nodes = [KnowledgeNode(**n) for n in snap["nodes"]]
    _merged_edges = [KnowledgeEdge(**e) for e in snap["edges"]]
    _decisions = [MergeDecision(**d) for d in snap["decisions"]]
    _stats = snap["stats"]
    _persist_alignment()
    return {
        "undone": snap["description"],
        "remaining": len(_undo_stack),
    }


@router.get("/undo-history")
def undo_history():
    return {
        "available": len(_undo_stack),
        "items": [s["description"] for s in _undo_stack],
    }
