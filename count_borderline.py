"""估算跨教材对齐中需要 LLM 判断的 borderline 对总数。
独立于正在运行的 alignment——只用 embed API。"""
import json, os, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src", "backend"))
os.chdir(os.path.dirname(__file__))

from models.schemas import KnowledgeNode
from core.config import settings
import google.generativeai as genai
genai.configure(api_key=settings.gemini_api_key)
from services.vector_store import _embed_texts

PROCESSED_DIR = "data/processed"
nodes = []
for fname in sorted(os.listdir(PROCESSED_DIR)):
    if not fname.endswith(".json") or fname == "summary.json":
        continue
    with open(os.path.join(PROCESSED_DIR, fname), encoding="utf-8") as f:
        d = json.load(f)
    for n in d.get("nodes", []):
        nodes.append(KnowledgeNode(**n))

n = len(nodes)
print(f"节点总数: {n}")
texts = [f"{x.name}。{x.definition}" for x in nodes]

print(f"嵌入 {n} 个节点（约 {n//20+1} 批 × 4-5s）...")
t0 = time.time()
def cb(done, total):
    print(f"  批次 {done}/{total}")
emb = _embed_texts(texts, _on_batch=cb)
print(f"嵌入耗时 {time.time()-t0:.1f}s")

import numpy as np
sim = emb @ emb.T

H = settings.align_threshold_high  # 0.88
L = settings.align_threshold_low   # 0.70

direct = 0
borderline = 0
ignored = 0
for i in range(n):
    for j in range(i+1, n):
        if nodes[i].textbook_id == nodes[j].textbook_id:
            continue
        s = float(sim[i, j])
        if s >= H:
            direct += 1
        elif s >= L:
            borderline += 1
        else:
            ignored += 1

print()
print(f"=== 跨教材对统计 ===")
print(f"  ≥ {H} (直接合并): {direct}")
print(f"  {L}–{H} (LLM 判断): {borderline}  ← 这个数才是 LLM 要跑的对数")
print(f"  < {L} (忽略): {ignored}")
print(f"  合计: {direct + borderline + ignored}")
