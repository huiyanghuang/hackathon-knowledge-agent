# 学科知识整合智能体

> 浙江大学未来学习中心 · 第一届 AI 全栈极速黑客松

将多本同学科教材自动解析、抽取知识点、跨教材去重整合，并提供带原文引用的 RAG 问答与多轮对话调整。以 7 本临床医学本科教材（解剖、组胚、生理、微生物、病理、传染、病理生理）为示范数据。

## 主要功能

| 模块 | 说明 |
| --- | --- |
| 多格式解析 | PDF / Markdown / TXT / DOCX，PDF 按 25 页分组以提高鲁棒性 |
| 知识点抽取 | 每章一次 Gemini 调用，输出结构化节点（含 `category`）+ 4 类关系 |
| 跨教材对齐 | 双阶段：Embedding ≥ 0.88 直接合并；0.70–0.88 交 LLM 二次判定 |
| 30% 压缩 | 按 (frequency↓, definition 长度↓) 排序，强制保留至少 20 个节点 |
| RAG 问答 | 600 字 chunk + 100 字 overlap，向量 0.7 + BM25 0.3 混合重排，附引用 |
| 多轮对话 | 教师可直接修改/锁定整合决策（`ACTION:KEEP:dec_xxx`）|
| 可视化 | ECharts 力导向图，按教材染色、按出现频次缩放节点 |

## 目录结构

```
.
├── batch_process.py           # 离线批量预处理（解析 + 抽取 + 索引）
├── generate_report.py         # 输出 report/整合报告.md
├── requirements.txt
├── start.bat                  # Windows 一键启动（前后端）
├── data/
│   ├── textbooks/             # 原始 PDF（不入仓库）
│   ├── processed/             # 预处理后的 JSON 缓存
│   └── chroma/                # 向量索引（vectors.npz + metadata.json）
├── docs/
│   ├── 需求分析.md
│   ├── 系统设计.md
│   └── Agent架构说明.md
├── report/
│   └── 整合报告.md
└── src/
    ├── backend/               # FastAPI
    │   ├── main.py
    │   ├── core/              # config + llm 封装
    │   ├── api/               # textbooks / graph / rag / chat
    │   ├── services/          # parser / extractor / aligner / rag_service / vector_store
    │   └── models/schemas.py
    └── frontend/              # React + Vite + ECharts
        ├── src/components/    # TextbookPanel / GraphView / RAGPanel / ChatPanel
        └── vite.config.js
```

## 环境依赖

- Python 3.11+
- Node.js 18+
- Google Gemini API Key（[申请地址](https://aistudio.google.com/apikey)）

依赖固定版本见 `requirements.txt` / `src/frontend/package.json`。

## 安装

```bash
# 1) 后端
pip install -r requirements.txt

# 2) 前端
cd src/frontend
npm install
cd ../..
```

## 配置

复制示例并填入自己的 key：

```bash
cp .env.example .env
# 编辑 .env，填入 GEMINI_API_KEY
```

`.env` 字段（与 `src/backend/core/config.py` 对应）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `GEMINI_API_KEY` | — | Google AI Studio 的 API Key |
| `LLM_MODEL` | `gemini-3.1-flash-lite` | 用于抽取、对齐复核、RAG 生成、对话 |
| `CHROMA_PATH` | `./data/chroma` | 向量索引持久化目录 |
| `UPLOAD_PATH` | `./data/textbooks` | 上传教材的存放目录 |
| `COMPRESSION_RATIO` | `0.30` | 整合后字数上限相对原始字数的比例 |
| `ALIGN_THRESHOLD_HIGH` | `0.88` | 直接合并的相似度阈值 |
| `ALIGN_THRESHOLD_LOW` | `0.70` | 进入 LLM 复核的相似度下限 |

## 启动

### 方式 A：本地开发（前后端分离，热更新）

```bash
# Terminal 1 — 后端
cd src/backend
uvicorn main:app --host 0.0.0.0 --port 8000 --reload

# Terminal 2 — 前端
cd src/frontend
npm run dev
```

打开 <http://localhost:5173>。`/api/*` 由 Vite 代理到后端 8000。

Windows 用户可直接双击 `start.bat`（已修复端口配置）。

### 方式 B：单端口部署（生产）

```bash
cd src/frontend && npm run build && cd ../..
cd src/backend && uvicorn main:app --host 0.0.0.0 --port 8000
```

`main.py` 会自动挂载 `src/frontend/dist`，浏览器访问 <http://localhost:8000> 即可。

### 方式 C：Docker 一键部署（推荐评审复现）

需要 Docker 20+ 与 Docker Compose v2。

```bash
# 1) 准备 .env（同上）
cp .env.example .env  # 填入 GEMINI_API_KEY

# 2) 一键启动
docker compose up -d --build

# 3) 浏览器访问
open http://localhost:8000
```

镜像采用多阶段构建：先用 `node:20-alpine` 打包前端 → 再装入 `python:3.11-slim` 跑 FastAPI 并直接 serve 已构建的 SPA，**单端口 8000 完成所有功能**。`./data` 以 volume 形式挂载，预处理缓存与向量索引在容器重建后保留。

```bash
docker compose down            # 停止
docker compose logs -f app     # 查看日志
docker compose up -d --build   # 改了代码后重建
```

## 离线预处理（推荐先跑一遍）

赛方的 7 本教材体量较大，建议在启动 Web 前一次性跑完抽取与索引，结果会写入 `data/processed/*.json` 和 `data/chroma/`，后端启动时自动加载，无需在前端等待。

```bash
# 把 7 本教材放到 data/textbooks/，文件名见 batch_process.py 顶部 TEXTBOOKS 列表
python batch_process.py

# 生成整合报告
python generate_report.py
```

参考产出（基于赛方教材）：

| 教材 | 字数 |
| --- | --- |
| 局部解剖学 | 356,786 |
| 组织学与胚胎学 | 353,281 |
| 生理学 | 676,259 |
| 医学微生物学 | 579,109 |
| 病理学 | 593,559 |
| 传染病学 | 651,121 |
| 病理生理学 | 435,110 |
| **合计** | **3,645,225** |

抽取后约 1164 节点 / 728 关系，索引 7320 个 RAG chunk；对齐阈值 0.80 跑出约 95 条 merge 决策，压缩比 ~31%。

## API 一览

| 方法 | 路径 | 功能 |
| --- | --- | --- |
| `GET` | `/health` | 健康检查 |
| `POST` | `/api/textbooks/upload` | 上传教材（异步处理） |
| `GET` | `/api/textbooks/` | 列出教材及处理状态 |
| `GET` | `/api/textbooks/{id}/graph` | 单本教材的知识图谱 |
| `DELETE` | `/api/textbooks/{id}` | 删除（同时清向量库） |
| `POST` | `/api/graph/align/start` | 启动跨教材对齐 |
| `GET` | `/api/graph/align/status` | 对齐进度（轮询） |
| `GET` | `/api/graph/merged` | 整合后的图谱 + 统计 |
| `GET` | `/api/graph/decisions` | 整合决策列表 |
| `PATCH` | `/api/graph/decisions/{id}` | 修改某条决策 |
| `POST` | `/api/rag/query` | RAG 问答（带引用） |
| `GET` | `/api/rag/status` | 索引状态 |
| `POST` | `/api/chat/` | 多轮对话（可触发 ACTION） |
| `GET` | `/api/stats/` | 累计 LLM / Embedding token & 成本 |
| `POST` | `/api/stats/reset` | 清零统计 |

完整 OpenAPI 文档：启动后访问 <http://localhost:8000/docs>。

## 引用的开源项目

- [FastAPI](https://github.com/tiangolo/fastapi)
- [pypdf](https://github.com/py-pdf/pypdf) / [python-docx](https://github.com/python-openxml/python-docx)
- [Google generative-ai-python](https://github.com/google/generative-ai-python)（Gemini LLM + Embedding）
- [rank-bm25](https://github.com/dorianbrown/rank_bm25) + [jieba](https://github.com/fxsjy/jieba)
- [React](https://react.dev/) + [Vite](https://vitejs.dev/) + [ECharts](https://echarts.apache.org/)

核心算法（章节分组、双阶段对齐、混合检索、压缩策略）均自研实现。
