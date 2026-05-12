# Agent 架构说明

## 1. 整体思路

本项目将"学科知识整合"建模为一个**多阶段 Agentic Pipeline**，每个阶段均通过 LLM 完成原本需要人工判断的任务，最终形成可审查、可交互的知识整合结果。

```
教材文本
  └─▶ [提取 Agent]  结构化知识点（节点+关系）
         └─▶ [对齐 Agent]  跨教材去重与合并
                └─▶ [压缩 Agent]  按重要度精简
                       └─▶ [RAG Agent]  问答与引用生成
                              └─▶ [对话 Agent]  多轮交互调整
```

## 2. 各 Agent 说明

### 2.1 提取 Agent（Extractor）

**文件**：`services/extractor.py`

**职责**：对每个文本块（≈25页）调用 Gemini LLM，以结构化 JSON 格式提取知识点。

**Prompt 设计**（精简版，完整 prompt 见 `services/extractor.py:EXTRACT_PROMPT`）：

```
你是医学教材知识点提取专家。从以下章节中提取核心知识点。
要求：每章 5-15 个，JSON 格式：
{
  "nodes": [{"name": "...", "definition": "(50-150字)", "category": "核心概念/定理/方法/现象/原理"}],
  "edges": [{"source_name": "...", "target_name": "...",
             "relation_type": "prerequisite/parallel/contains/applies_to",
             "description": "..."}]
}
```

**关键决策**：
- 每章独立提取，避免超长上下文导致遗漏
- `category` 而非数字打分：LLM 对 1-5 评分稳定性差，分类标签更可靠
- 压缩阶段以 `frequency`（跨教材出现次数）+ 定义长度作为排序键
- 关系类型枚举：prerequisite / parallel / contains / applies_to（覆盖赛题要求的至少 3 种）

### 2.2 对齐 Agent（Aligner）

**文件**：`services/aligner.py`

**职责**：识别并合并不同教材中对同一概念的重复描述。

**两阶段策略**：

```
Phase 1: Embedding 相似度过滤
  - 将所有节点的"名称+定义"向量化
  - 计算跨教材节点对的余弦相似度
  - score ≥ 0.88 → 直接判定为同一概念（合并）
  - 0.70 ≤ score < 0.88 → 进入 Phase 2

Phase 2: LLM 二次判定（仅对边界值）
  - Prompt：给出两个知识点的名称和定义，判断是否同一概念
  - 输出 JSON：{"is_same": true/false, "reason": "..."}
  - is_same=true → 合并；false → 保留各自独立
```

**合并策略**：
- 保留定义最长的版本（信息量最大）
- frequency 字段记录在几本教材中出现
- 生成 MergeDecision 供用户审查

**设计权衡**：
- 高阈值 (0.88) 直接合并：避免频繁 LLM 调用浪费
- 低阈值 (0.70) 人工复核：不漏掉语义相似但表述不同的同义词
- 同一教材内节点不做合并（同书重复属正常引用）

### 2.3 压缩 Agent

**文件**：`services/aligner.py::compress_nodes()`

**职责**：将合并后的全量知识点压缩到原始字数的 30% 以内。

**策略**：按 (frequency DESC, definition长度 DESC) 排序，保留前 N 个节点直到达到字数上限；强制保留至少 20 个节点。

### 2.4 RAG Agent

**文件**：`services/rag_service.py`

**职责**：混合检索相关文本块，生成带原文引用的答案。

**检索策略**：

```python
# 双路检索
vector_hits = vector_store.search(query, top_k=10)   # 语义相似
bm25_hits   = bm25_index.search(query, top_k=10)     # 关键词匹配

# 混合 rerank
for chunk:
    score = vec_score * 0.7 + bm25_score * 0.3

# 取 top-5 作为上下文
```

**生成 Prompt**：

```
根据以下参考资料回答问题。每段资料后有[来源：教材名 第X章]。
回答时请引用相关来源。

[资料1] ...内容... [来源：生理学 第3章]
[资料2] ...内容... [来源：病理学 第5章]

问题：{query}
```

### 2.5 对话 Agent（Dialogue Teacher）

**文件**：`api/chat.py`

**职责**：以"AI教师"身份进行多轮对话，回答整合策略相关问题。

**System Prompt**：

```
你是一位经验丰富的医学教育专家，正在帮助学生整合多本医学教材的知识。
你已经处理了{n}本教材，提取了{nodes}个知识点，完成了{merges}次跨教材合并。
请根据学生的问题，解释整合决策，指出不同教材的表述差异，并给出学习建议。
```

**多轮实现**：维护 `messages[]` 历史，每轮追加 user/model 消息，通过 Gemini Chat API 发送。

## 3. Agent 间协作关系

```
┌─────────────────────────────────────────────────────────────────┐
│                        数据状态机                                │
│                                                                 │
│  raw_text  →[提取]→  nodes+edges  →[对齐]→  merged_graph       │
│                                          →[压缩]→  compact_graph│
│                                                                 │
│  raw_chunks →[索引]→  vector_store+bm25                        │
│                           ↑                                     │
│  user_query →[RAG]→  retrieved_chunks → answer+citations       │
│                                                                 │
│  user_message →[对话]→  history → teacher_response             │
└─────────────────────────────────────────────────────────────────┘
```

## 4. 错误处理与鲁棒性

| 场景 | 处理方式 |
|------|----------|
| LLM 返回非 JSON | 正则/split 提取 JSON 块，失败则返回空结果，不中断流程 |
| Embedding API 限速 | batch=20，批间 sleep 0.3s |
| PDF 解析失败 | 页级 try/except，跳过损坏页继续 |
| 处理结果缓存 | 已处理教材写 `data/processed/{tid}.json`，重启不重复调用 |
| 向量维度不匹配 | 重新嵌入整个索引（自动检测）|

## 5. 可扩展性

- **替换 LLM**：修改 `core/llm.py` 中的 `chat()` 函数即可切换到 OpenAI/本地模型
- **替换 Embedding**：修改 `vector_store.py` 中的 `_embed_texts()` 函数
- **替换向量库**：将 numpy 实现替换为 Faiss/Milvus，接口不变
- **新增文件格式**：在 `services/parser.py` 中扩展 `parse_pdf()` 的分支
