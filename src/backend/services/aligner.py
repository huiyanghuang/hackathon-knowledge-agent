"""
Cross-textbook knowledge alignment.
Three-phase:
  1. Lexical exact-match pre-merge (cheap, captures normalized identical names)
  2. Embedding similarity → direct merge above HIGH threshold
  3. LLM verification for borderline cases (LOW <= sim < HIGH), parallel
"""
import json
import re
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np

from core.config import settings
from core.llm import chat
from models.schemas import KnowledgeEdge, KnowledgeNode, MergeDecision
from services.vector_store import _embed_texts as _embed_batch

LLM_CONCURRENCY = 32

# 标准化用：去掉空白/标点/全半角括号，转小写
_NORM_RE = re.compile(r"[\s\(\)（）\[\]【】《》、，,。.;；:：·\-_/]+")


def _norm_name(name: str) -> str:
    return _NORM_RE.sub("", name.strip().lower())


JUDGE_PROMPT = """判断以下两个知识点是否描述同一概念。

知识点A：{name_a}
定义A：{def_a}

知识点B：{name_b}
定义B：{def_b}

请只回答JSON：{{"is_same": true或false, "reason": "一句话理由"}}"""


def _llm_judge(node_a: KnowledgeNode, node_b: KnowledgeNode) -> tuple[bool, str]:
    prompt = JUDGE_PROMPT.format(
        name_a=node_a.name, def_a=node_a.definition,
        name_b=node_b.name, def_b=node_b.definition,
    )
    try:
        raw = chat(prompt)
        if "```" in raw:
            raw = raw.split("```")[1].split("```")[0].strip()
            if raw.startswith("json"):
                raw = raw[4:].strip()
        data = json.loads(raw)
        return data.get("is_same", False), data.get("reason", "")
    except Exception:
        return False, ""


def _pick_best(group: list[KnowledgeNode]) -> KnowledgeNode:
    return max(group, key=lambda n: len(n.definition))


def align_nodes(
    all_nodes: list[KnowledgeNode],
    progress_cb=None,
) -> tuple[list[KnowledgeNode], list[MergeDecision]]:
    if not all_nodes:
        return [], []

    n = len(all_nodes)

    # Phase 0: lexical exact-match pre-merge (cross-textbook only)
    if progress_cb:
        progress_cb(1, "lexical 预合并...")

    norm_groups: dict[str, list[int]] = {}
    for i, node in enumerate(all_nodes):
        norm_groups.setdefault(_norm_name(node.name), []).append(i)

    lexical_pairs: list[tuple[int, int]] = []
    for key, idx_list in norm_groups.items():
        if len(idx_list) <= 1:
            continue
        for a in range(len(idx_list)):
            for b in range(a + 1, len(idx_list)):
                i, j = idx_list[a], idx_list[b]
                if all_nodes[i].textbook_id != all_nodes[j].textbook_id:
                    lexical_pairs.append((i, j))

    texts = [f"{x.name}。{x.definition}" for x in all_nodes]

    if progress_cb:
        progress_cb(2, f"lexical 命中 {len(lexical_pairs)} 对，嵌入 {len(texts)} 个节点...")

    def _on_embed_batch(done, total):
        if progress_cb:
            pct = 2 + int(done / total * 55)
            progress_cb(pct, f"嵌入中 {done}/{total} 批次...")

    embeddings = _embed_batch(texts, _on_batch=_on_embed_batch)
    sim = embeddings @ embeddings.T

    H = settings.align_threshold_high
    L = settings.align_threshold_low

    # Phase 1: collect cross-textbook pairs, split into direct-merge vs borderline.
    # Skip pairs already merged by lexical phase to avoid duplicate LLM calls.
    if progress_cb:
        progress_cb(58, "相似度计算完成，分类对...")

    lexical_set = set(lexical_pairs) | {(j, i) for i, j in lexical_pairs}
    direct_pairs: list[tuple[int, int]] = []
    borderline_pairs: list[tuple[int, int]] = []
    for i in range(n):
        ti = all_nodes[i].textbook_id
        for j in range(i + 1, n):
            if all_nodes[j].textbook_id == ti:
                continue
            if (i, j) in lexical_set:
                continue
            s = float(sim[i, j])
            if s >= H:
                direct_pairs.append((i, j))
            elif s >= L:
                borderline_pairs.append((i, j))

    total_borderline = len(borderline_pairs)
    if progress_cb:
        progress_cb(60, f"待 LLM 判断 {total_borderline} 对，开始并发判断 ({LLM_CONCURRENCY} 路)...")

    # Phase 2: parallel LLM judge on borderline pairs.
    same_set: set[tuple[int, int]] = set()
    if total_borderline:
        done_count = 0
        with ThreadPoolExecutor(max_workers=LLM_CONCURRENCY) as ex:
            future_to_pair = {
                ex.submit(_llm_judge, all_nodes[i], all_nodes[j]): (i, j)
                for i, j in borderline_pairs
            }
            for fut in as_completed(future_to_pair):
                i, j = future_to_pair[fut]
                try:
                    is_same, _ = fut.result()
                except Exception:
                    is_same = False
                if is_same:
                    same_set.add((i, j))
                done_count += 1
                if progress_cb and (done_count % 20 == 0 or done_count == total_borderline):
                    pct = 60 + int(done_count / total_borderline * 28)  # 60 → 88
                    progress_cb(pct, f"LLM判断中 {done_count}/{total_borderline} 对")

    # Phase 3: union-find groups using direct + LLM-confirmed pairs.
    parent = list(range(n))
    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    for i, j in lexical_pairs:
        union(i, j)
    for i, j in direct_pairs:
        union(i, j)
    for i, j in same_set:
        union(i, j)

    groups_dict: dict[int, list[int]] = {}
    for k in range(n):
        r = find(k)
        groups_dict.setdefault(r, []).append(k)
    groups = list(groups_dict.values())

    if progress_cb:
        progress_cb(90, "生成整合决策...")

    merged_nodes: list[KnowledgeNode] = []
    decisions: list[MergeDecision] = []

    for idx, group in enumerate(groups):
        members = [all_nodes[i] for i in group]
        best = _pick_best(members)

        if len(members) == 1:
            merged_nodes.append(best)
            decisions.append(MergeDecision(
                decision_id=f"dec_{idx:04d}",
                action="keep",
                affected_nodes=[best.id],
                result_node=best.id,
                reason="该知识点在其他教材中无对应，保留原版本",
                confidence=1.0,
            ))
        else:
            merged_id = f"merged_{uuid.uuid4().hex[:8]}"
            best = best.model_copy(update={"id": merged_id, "frequency": len(members)})
            merged_nodes.append(best)
            textbook_names = list({m.textbook_name for m in members})
            decisions.append(MergeDecision(
                decision_id=f"dec_{idx:04d}",
                action="merge",
                affected_nodes=[m.id for m in members],
                result_node=merged_id,
                reason=f"在{len(textbook_names)}本教材（{'、'.join(textbook_names)}）中共{len(members)}处提及，保留《{best.textbook_name}》版本因其描述最完整",
                confidence=0.9,
            ))

    return merged_nodes, decisions


def compress_nodes(
    nodes: list[KnowledgeNode],
    original_chars: int,
    ratio: float = 0.30,
) -> list[KnowledgeNode]:
    target = int(original_chars * ratio)
    sorted_nodes = sorted(nodes, key=lambda n: (-n.frequency, -len(n.definition)))
    kept: list[KnowledgeNode] = []
    total = 0
    for node in sorted_nodes:
        node_chars = len(node.name) + len(node.definition)
        if total + node_chars <= target:
            kept.append(node)
            total += node_chars
        else:
            if len(kept) < 20:
                kept.append(node)
                total += node_chars
            else:
                break
    return kept


def rebuild_edges(
    edges: list[KnowledgeEdge],
    kept_ids: set[str],
    decision_map: dict[str, str],
) -> list[KnowledgeEdge]:
    result: list[KnowledgeEdge] = []
    seen: set[tuple[str, str]] = set()

    for e in edges:
        src = decision_map.get(e.source, e.source)
        tgt = decision_map.get(e.target, e.target)
        if src not in kept_ids or tgt not in kept_ids or src == tgt:
            continue
        key = (src, tgt)
        if key in seen:
            continue
        seen.add(key)
        result.append(KnowledgeEdge(
            source=src,
            target=tgt,
            relation_type=e.relation_type,
            description=e.description,
        ))
    return result
