"""
生成整合报告：从 data/processed/ 读取所有教材数据，
调用跨教材对齐，输出 report/整合报告.md
"""
import json
import os
import sys
from datetime import date

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src", "backend"))

ROOT = os.path.dirname(__file__)
PROCESSED_DIR = os.path.join(ROOT, "data", "processed")
REPORT_DIR = os.path.join(ROOT, "report")
os.makedirs(REPORT_DIR, exist_ok=True)

from models.schemas import KnowledgeEdge, KnowledgeNode
from services.aligner import align_nodes, compress_nodes, rebuild_edges


def load_all():
    textbooks = []
    all_nodes = []
    all_edges = []
    for fname in sorted(os.listdir(PROCESSED_DIR)):
        if not fname.endswith(".json") or fname == "summary.json":
            continue
        with open(os.path.join(PROCESSED_DIR, fname), encoding="utf-8") as f:
            d = json.load(f)
        textbooks.append(d)
        for n in d.get("nodes", []):
            all_nodes.append(KnowledgeNode(**n))
        for e in d.get("edges", []):
            all_edges.append(KnowledgeEdge(**e))
    return textbooks, all_nodes, all_edges


def main():
    print("加载处理结果...")
    textbooks, raw_nodes, raw_edges = load_all()
    if not textbooks:
        print("没有找到已处理的教材，请先运行 batch_process.py")
        return

    print(f"共 {len(textbooks)} 本教材，{len(raw_nodes)} 个原始节点，{len(raw_edges)} 条关系")

    print("执行跨教材对齐...")
    merged, decisions = align_nodes(raw_nodes)

    decision_map = {}
    for d in decisions:
        if d.result_node:
            for old_id in d.affected_nodes:
                decision_map[old_id] = d.result_node

    kept_ids = {n.id for n in merged}
    remapped_edges = rebuild_edges(raw_edges, kept_ids, decision_map)

    original_chars = sum(len(n.name) + len(n.definition) for n in raw_nodes)
    compressed = compress_nodes(merged, original_chars)
    compressed_ids = {n.id for n in compressed}
    final_edges = [e for e in remapped_edges if e.source in compressed_ids and e.target in compressed_ids]
    compressed_chars = sum(len(n.name) + len(n.definition) for n in compressed)

    merge_decisions = [d for d in decisions if d.action == "merge"]
    keep_decisions = [d for d in decisions if d.action == "keep"]

    ratio = round(compressed_chars / original_chars * 100, 1) if original_chars else 0

    print("生成报告...")

    lines = [
        "# 学科知识整合报告",
        "",
        f"**生成日期**：{date.today().isoformat()}",
        "",
        "---",
        "",
        "## 一、处理概况",
        "",
        f"本次整合共处理 **{len(textbooks)}** 本医学教材：",
        "",
    ]

    total_pages = sum(t.get("total_pages", 0) for t in textbooks)
    total_chars = sum(t.get("total_chars", 0) for t in textbooks)
    total_chunks = sum(t.get("n_chunks", 0) for t in textbooks)

    lines += [
        "| 教材名称 | 页数 | 字数 | 知识节点 | 关系数 | RAG块数 |",
        "|----------|------|------|----------|--------|--------|",
    ]
    for t in textbooks:
        lines.append(
            f"| {t['title']} | {t.get('total_pages',0)} | "
            f"{t.get('total_chars',0):,} | {len(t.get('nodes',[]))} | "
            f"{len(t.get('edges',[]))} | {t.get('n_chunks',0)} |"
        )
    lines += [
        f"| **合计** | **{total_pages}** | **{total_chars:,}** | "
        f"**{len(raw_nodes)}** | **{len(raw_edges)}** | **{total_chunks}** |",
        "",
    ]

    lines += [
        "## 二、跨教材知识整合统计",
        "",
        f"- 原始知识节点总数：**{len(raw_nodes)}**",
        f"- 跨教材合并操作：**{len(merge_decisions)}** 次",
        f"- 保留独立节点：**{len(keep_decisions)}** 个",
        f"- 合并后节点数：**{len(merged)}**",
        f"- 压缩后节点数：**{len(compressed)}**（保留 {len(compressed)/len(raw_nodes)*100:.1f}% 节点）",
        f"- 原始知识字数：**{original_chars:,}**",
        f"- 整合后字数：**{compressed_chars:,}**（压缩至 **{ratio}%**）",
        f"- 最终关系数：**{len(final_edges)}**",
        "",
    ]

    lines += [
        "## 三、合并决策详情（前30条）",
        "",
        "以下为跨教材知识点合并的典型案例：",
        "",
        "| 决策ID | 操作 | 涉及节点 | 结果节点 | 置信度 | 原因 |",
        "|--------|------|----------|----------|--------|------|",
    ]
    for d in merge_decisions[:30]:
        affected = "、".join(d.affected_nodes[:3])
        if len(d.affected_nodes) > 3:
            affected += f"…(共{len(d.affected_nodes)})"
        lines.append(
            f"| {d.decision_id} | 合并 | {affected} | {d.result_node} | "
            f"{d.confidence:.2f} | {d.reason[:50]}… |"
        )
    lines.append("")

    lines += [
        "## 四、整合后知识图谱概览",
        "",
        f"整合后共保留 **{len(compressed)}** 个核心知识节点，"
        f"**{len(final_edges)}** 条知识关系。",
        "",
        "按重要度分布（前20个高频知识点）：",
        "",
        "| 知识点 | 出现教材数 | 类别 | 定义摘要 |",
        "|--------|-----------|------|----------|",
    ]
    top_nodes = sorted(compressed, key=lambda n: (-n.frequency, -len(n.definition)))[:20]
    for n in top_nodes:
        definition_summary = n.definition[:40] + "…" if len(n.definition) > 40 else n.definition
        lines.append(
            f"| {n.name} | {n.frequency} | {n.category} | {definition_summary} |"
        )
    lines.append("")

    lines += [
        "## 五、RAG 检索系统",
        "",
        f"共建立 **{total_chunks}** 个文本检索块（每块约600字，100字重叠）。",
        "采用 Gemini Embedding（gemini-embedding-001）向量化，",
        "结合 BM25 关键词检索进行混合重排（向量权重0.7，BM25权重0.3）。",
        "",
        "## 六、方法说明",
        "",
        "### 知识提取",
        "对每个文本块（约25页）调用 Gemini LLM，",
        "以结构化 JSON 格式提取知识节点（名称、定义、重要度1-5）",
        "和知识关系（包含、前提、并列、对立、应用）。",
        "",
        "### 跨教材对齐",
        "使用两阶段策略：",
        "1. Gemini Embedding 余弦相似度 ≥ 0.88 → 直接合并",
        "2. 0.70–0.88 之间 → LLM 二次判定是否为同义概念",
        "",
        "合并时保留定义最长的版本（信息量最大），",
        "`frequency` 字段记录该概念在几本教材中出现。",
        "",
        "### 知识压缩",
        "按 (frequency DESC, definition长度 DESC) 排序，",
        f"保留总字数不超过原始字数 30% 的节点集合（实际压缩至 {ratio}%）。",
        "",
        "---",
        f"*本报告由学科知识整合智能体自动生成，日期：{date.today().isoformat()}*",
    ]

    report_path = os.path.join(REPORT_DIR, "整合报告.md")
    with open(report_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    print(f"\n报告已保存至：{report_path}")
    print(f"整合后：{len(compressed)} 节点，{len(final_edges)} 关系，压缩率 {ratio}%")


if __name__ == "__main__":
    main()
