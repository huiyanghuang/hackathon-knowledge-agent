"""
LLM-based knowledge extraction from textbook chapters.
One LLM call per chapter to avoid context length issues; chapters run in parallel.
"""
import json
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

from core.llm import chat
from models.schemas import Chapter, KnowledgeEdge, KnowledgeNode

# Gemini 3.1 Flash Lite 限速 4000 RPM。每章一次调用，每次 25-50s。
# 24 并发 × 1.5 req/min/线程 ≈ 36 RPM，远低于上限但保险。
EXTRACT_CONCURRENCY = 24

EXTRACT_PROMPT = """你是医学教材知识图谱构建专家。请从下面章节内容中提取**医学知识点**和它们之间的关系。

【强制要求 1：优先抽取基础公共概念】
如果章节内容**涉及**以下任何医学基础概念（哪怕只是简略提及），**必须**为其建立节点：
- 细胞与组织：细胞、细胞膜、细胞核、细胞器、上皮组织、结缔组织、肌组织、神经组织
- 分子生物学：DNA、RNA、蛋白质、酶、基因、染色体、抗原决定簇
- 免疫学：抗原、抗体、免疫、淋巴细胞、T细胞、B细胞、白细胞、巨噬细胞、补体、细胞因子
- 微生物：病毒、细菌、真菌、寄生虫、病原体
- 病理基础：炎症、坏死、凋亡、肿瘤、变性、增生、化生、肉芽肿
- 生理基础：动作电位、静息电位、循环、呼吸、消化、神经传导、内分泌、代谢、体温调节
- 解剖：器官、系统、血管、神经、骨骼、肌肉
- 病原与感染：感染、传播途径、潜伏期、免疫应答、抗原-抗体反应

【强制要求 2：禁止抽取以下非医学元信息】
明确排除：教材编写说明、出版社/编委/主编/副主编、序言、前言、目录、修订说明、新形态教材、数字资源、二维码、思政、课程思政、大健康理念、ISBN、版权、致谢、思考题、推荐阅读、规划教材、章末小结等。**如果章节内容主要是这类元信息（典型如序言/前言/目录），返回空 nodes 和空 edges**。

【输出格式】严格 JSON，不要 markdown 代码块包裹：
{{
  "nodes": [
    {{
      "name": "知识点名称（2-15字，使用规范术语）",
      "definition": "50-150字的简洁定义或说明",
      "category": "核心概念/疾病/结构/生理过程/病理机制/方法/治疗 中的一种"
    }}
  ],
  "edges": [
    {{
      "source_name": "节点A的name",
      "target_name": "节点B的name",
      "relation_type": "prerequisite/parallel/contains/applies_to 之一",
      "description": "一句话关系说明"
    }}
  ]
}}

【few-shot 示例】
基础概念：{{"name": "动作电位", "definition": "细胞受刺激后膜电位发生的快速可逆倒转，是神经信号传导的基础，包括去极化和复极化两个过程。", "category": "核心概念"}}
疾病：{{"name": "急性炎症", "definition": "机体对组织损伤或感染的早期防御反应，特征为血管扩张、血浆渗出、中性粒细胞浸润，临床表现为红、肿、热、痛、功能障碍。", "category": "疾病"}}
结构：{{"name": "细胞膜", "definition": "包围细胞的脂双层结构，由磷脂和膜蛋白组成，承担物质运输、信号传导和细胞识别功能。", "category": "结构"}}
关系：{{"source_name": "静息电位", "target_name": "动作电位", "relation_type": "prerequisite", "description": "理解动作电位需先掌握静息电位"}}

【要求】
- 优先抽出【强制要求 1】列表中本章节涉及的概念
- 然后补充本章特有的具体知识（疾病、机制、方法、术语）
- 每章节 8-20 个 node（基础概念 + 章节特色）
- 同一概念在不同章节都可以抽（后续会自动跨教材合并）
- edges 的 source_name 和 target_name 必须存在于 nodes
- 名称使用医学规范术语，简洁
- **遇到序言/前言/目录类章节，返回 {{"nodes": [], "edges": []}}**

【章节信息】
章节标题：{chapter_title}
章节内容：
{content}
"""


def _parse_json(raw: str) -> dict[str, Any]:
    raw = raw.strip()
    if "```json" in raw:
        raw = raw.split("```json")[1].split("```")[0].strip()
    elif "```" in raw:
        raw = raw.split("```")[1].split("```")[0].strip()
    return json.loads(raw)


# 元信息黑名单（节点名含其一就丢弃）
_NOISE_KEYWORDS = (
    "教材", "编委", "主编", "副主编", "出版", "出版社", "ISBN", "版权", "致谢",
    "前言", "序言", "目录", "导论", "修订", "数字资源", "二维码", "新形态",
    "思政", "课程思政", "大健康", "规划教材", "思考题", "推荐阅读", "章末",
    "章前", "参考文献", "卫生健康委员会", "卫健委", "学时", "本章小结",
    "学习目标", "教学大纲", "考纲",
)


def _is_noise(name: str) -> bool:
    if not name or len(name.strip()) < 2 or len(name) > 30:
        return True
    return any(kw in name for kw in _NOISE_KEYWORDS)


def extract_chapter_knowledge(
    chapter: Chapter,
    textbook_id: str,
    textbook_name: str,
) -> tuple[list[KnowledgeNode], list[KnowledgeEdge]]:
    content_excerpt = chapter.content[:3000]
    prompt = EXTRACT_PROMPT.format(
        chapter_title=chapter.title,
        content=content_excerpt,
    )

    try:
        raw = chat(prompt)
        data = _parse_json(raw)
    except Exception as e:
        print(f"[extractor] LLM call failed for {chapter.chapter_id}: {e}")
        return [], []

    name_to_id: dict[str, str] = {}
    nodes: list[KnowledgeNode] = []

    for item in data.get("nodes", []):
        name = (item.get("name") or "").strip()
        if _is_noise(name):
            continue
        nid = f"{textbook_id}_{chapter.chapter_id}_{uuid.uuid4().hex[:6]}"
        node = KnowledgeNode(
            id=nid,
            name=name,
            definition=item.get("definition", ""),
            category=item.get("category", "核心概念"),
            chapter=chapter.title,
            page=chapter.page_start,
            textbook_id=textbook_id,
            textbook_name=textbook_name,
        )
        nodes.append(node)
        name_to_id[name] = nid

    edges: list[KnowledgeEdge] = []
    for item in data.get("edges", []):
        src = name_to_id.get(item.get("source_name", ""))
        tgt = name_to_id.get(item.get("target_name", ""))
        if src and tgt:
            edges.append(KnowledgeEdge(
                source=src,
                target=tgt,
                relation_type=item.get("relation_type", "parallel"),
                description=item.get("description", ""),
            ))

    return nodes, edges


def extract_textbook_knowledge(
    textbook_id: str,
    textbook_name: str,
    chapters: list[Chapter],
    progress_cb=None,
) -> tuple[list[KnowledgeNode], list[KnowledgeEdge]]:
    """并发抽取每章。保持章节在结果中的原顺序（按 chapter.page_start 排序）。"""
    valid_chapters = [c for c in chapters if c.char_count >= 100]
    total = len(valid_chapters)
    if total == 0:
        return [], []

    # 按章节索引收集结果，最后按原顺序合并
    results: dict[int, tuple[list[KnowledgeNode], list[KnowledgeEdge]]] = {}
    done = [0]

    def _worker(idx: int, ch: Chapter):
        nodes, edges = extract_chapter_knowledge(ch, textbook_id, textbook_name)
        results[idx] = (nodes, edges)
        done[0] += 1
        if progress_cb:
            progress_cb(done[0], total, ch.title)

    with ThreadPoolExecutor(max_workers=EXTRACT_CONCURRENCY) as ex:
        futures = [ex.submit(_worker, i, c) for i, c in enumerate(valid_chapters)]
        for fut in as_completed(futures):
            try:
                fut.result()
            except Exception as e:
                print(f"[extractor] chapter worker failed: {e}")

    all_nodes: list[KnowledgeNode] = []
    all_edges: list[KnowledgeEdge] = []
    for i in range(total):
        if i in results:
            nodes, edges = results[i]
            all_nodes.extend(nodes)
            all_edges.extend(edges)
    return all_nodes, all_edges
