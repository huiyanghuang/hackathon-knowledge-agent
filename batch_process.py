"""
批量处理脚本：解析7本教材 → 提取知识点 → 建立 RAG 索引
结果保存到 data/processed/ 目录，供服务器启动时加载
运行方式：python batch_process.py
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src", "backend"))

from models.schemas import Chapter
from services.extractor import extract_textbook_knowledge
from services.parser import parse_pdf
from services.rag_service import index_textbook

DATA_DIR = os.path.join(os.path.dirname(__file__), "data", "textbooks")
OUT_DIR = os.path.join(os.path.dirname(__file__), "data", "processed")
os.makedirs(OUT_DIR, exist_ok=True)

TEXTBOOKS = [
    ("01_局部解剖学（第10版）.pdf", "jiepou",    "局部解剖学"),
    ("02_组织学与胚胎学.pdf",       "zuzhi",     "组织学与胚胎学"),
    ("03_生理学.pdf",               "shengli",   "生理学"),
    ("04_医学微生物学.pdf",         "weisheng",  "医学微生物学"),
    ("05_病理学.pdf",               "bingli",    "病理学"),
    ("06_传染病学（第10版）.pdf",   "chuanran",  "传染病学"),
    ("07_病理生理学（第10版）.pdf", "bingsheng", "病理生理学"),
]


def process_one(fname, tid, title):
    out_file = os.path.join(OUT_DIR, f"{tid}.json")

    # Fully cached
    if os.path.exists(out_file):
        with open(out_file, encoding="utf-8") as f:
            cached = json.load(f)
        if cached.get("n_chunks", 0) > 0:
            print(f"  [{title}] 已完全缓存，跳过")
            return cached
        # Extraction cached but RAG indexing failed — only redo indexing
        print(f"\n[{title}] 知识提取已缓存，补充 RAG 索引...")
        chapters = [Chapter(**c) for c in cached["chapters"]]
        t2 = time.time()
        n_chunks = index_textbook(tid, title, chapters)
        print(f"  索引 {n_chunks} 块，耗时{time.time()-t2:.1f}s")
        cached["n_chunks"] = n_chunks
        with open(out_file, "w", encoding="utf-8") as f:
            json.dump(cached, f, ensure_ascii=False, indent=2)
        return cached

    fpath = os.path.join(DATA_DIR, fname)
    print(f"\n[{title}] 解析 PDF...")
    t0 = time.time()
    tb = parse_pdf(fpath, tid)
    print(f"  {tb.total_pages}页 {tb.total_chars}字 {len(tb.chapters)}块，耗时{time.time()-t0:.1f}s")

    valid_count = sum(1 for c in tb.chapters if c.char_count >= 100)
    print(f"  提取知识点（{valid_count} 章并发 LLM 调用）...")
    t1 = time.time()
    def _on_progress(done, total, ch_title):
        print(f"    [{done:>3}/{total}] {ch_title[:30]}", flush=True)
    nodes, edges = extract_textbook_knowledge(tid, title, tb.chapters, progress_cb=_on_progress)
    print(f"  提取到 {len(nodes)} 节点，{len(edges)} 关系，耗时{time.time()-t1:.1f}s")

    # Save after extraction so re-runs skip LLM even if RAG indexing fails
    result = {
        "textbook_id": tid,
        "title": title,
        "filename": fname,
        "total_pages": tb.total_pages,
        "total_chars": tb.total_chars,
        "chapters": [c.model_dump() for c in tb.chapters],
        "nodes": [n.model_dump() for n in nodes],
        "edges": [e.model_dump() for e in edges],
        "n_chunks": 0,
    }
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(f"  建立 RAG 索引...")
    t2 = time.time()
    n_chunks = index_textbook(tid, title, tb.chapters)
    print(f"  索引 {n_chunks} 块，耗时{time.time()-t2:.1f}s")

    result["n_chunks"] = n_chunks
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    return result


def main():
    print("=" * 50)
    print("学科知识整合智能体 - 批量处理")
    print("=" * 50)

    all_results = []
    for fname, tid, title in TEXTBOOKS:
        try:
            r = process_one(fname, tid, title)
            all_results.append(r)
        except Exception as e:
            print(f"  ERROR [{title}]: {e}")

    # 汇总
    total_chars = sum(r["total_chars"] for r in all_results)
    total_nodes = sum(len(r["nodes"]) for r in all_results)
    total_edges = sum(len(r["edges"]) for r in all_results)
    total_chunks = sum(r["n_chunks"] for r in all_results)

    summary = {
        "processed": len(all_results),
        "total_chars": total_chars,
        "total_nodes": total_nodes,
        "total_edges": total_edges,
        "total_chunks": total_chunks,
        "textbooks": [{"id": r["textbook_id"], "title": r["title"], "chars": r["total_chars"]} for r in all_results],
    }
    with open(os.path.join(OUT_DIR, "summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    print("\n" + "=" * 50)
    print(f"完成！处理 {len(all_results)} 本教材")
    print(f"总字数: {total_chars:,}  节点: {total_nodes}  关系: {total_edges}  RAG块: {total_chunks}")
    print(f"结果保存在 data/processed/")


if __name__ == "__main__":
    sys.stdout.reconfigure(line_buffering=True)
    main()
