import React, { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { ragQuery, ragStatus } from '../api'

const STORAGE_KEY = 'rag_history_v1'
const HISTORY_MAX = 50  // 最多保留 50 条问答，超出截掉最旧的

const MD_COMPONENTS = {
  p: ({ node, ...p }) => <p style={{ margin: '0.4em 0' }} {...p} />,
  ul: ({ node, ...p }) => <ul style={{ margin: '0.3em 0', paddingLeft: 22 }} {...p} />,
  ol: ({ node, ...p }) => <ol style={{ margin: '0.3em 0', paddingLeft: 22 }} {...p} />,
  li: ({ node, ...p }) => <li style={{ margin: '0.15em 0' }} {...p} />,
  h1: ({ node, ...p }) => <h3 style={{ margin: '0.5em 0', fontSize: 15 }} {...p} />,
  h2: ({ node, ...p }) => <h4 style={{ margin: '0.5em 0', fontSize: 14 }} {...p} />,
  h3: ({ node, ...p }) => <h4 style={{ margin: '0.5em 0', fontSize: 13 }} {...p} />,
  strong: ({ node, ...p }) => <strong style={{ color: '#fbbf24', fontWeight: 800 }} {...p} />,
  em: ({ node, ...p }) => <em style={{ color: '#a5b4fc', fontStyle: 'italic' }} {...p} />,
  code: ({ inline, ...p }) =>
    inline ? (
      <code style={{ background: '#0f172a', padding: '1px 6px', borderRadius: 4, fontSize: 12, color: '#fbbf24' }} {...p} />
    ) : (
      <code style={{ display: 'block', background: '#0f172a', padding: 10, borderRadius: 6, fontSize: 12, color: '#e2e8f0', overflow: 'auto' }} {...p} />
    ),
  blockquote: ({ node, ...p }) => (
    <blockquote style={{ borderLeft: '3px solid #6366f1', margin: '0.5em 0', padding: '0.2em 0.8em', color: '#cbd5e1', background: '#0f172a55' }} {...p} />
  ),
  table: ({ node, ...p }) => <table style={{ borderCollapse: 'collapse', margin: '0.5em 0' }} {...p} />,
  th: ({ node, ...p }) => <th style={{ border: '1px solid #334155', padding: '4px 8px', background: '#0f172a' }} {...p} />,
  td: ({ node, ...p }) => <td style={{ border: '1px solid #334155', padding: '4px 8px' }} {...p} />,
}

export default function RAGPanel() {
  const [question, setQuestion] = useState('')
  const [history, setHistory] = useState([])  // [{q, answer, citations, ts}]
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState(null)
  const [expandedCitation, setExpandedCitation] = useState(null)  // `${entryIdx}-${citationIdx}`
  const bottomRef = useRef()

  // 启动时从 localStorage 恢复
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
      if (Array.isArray(saved)) setHistory(saved)
    } catch { /* ignore */ }
    ragStatus().then(r => setStatus(r.data)).catch(() => {})
  }, [])

  // 每次 history 变化都同步到 localStorage 并滚到底
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(history)) } catch {}
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [history])

  const handleQuery = async () => {
    const q = question.trim()
    if (!q || loading) return
    setLoading(true)
    setQuestion('')
    try {
      const { data } = await ragQuery(q)
      setHistory(prev => [...prev, {
        q, answer: data.answer, citations: data.citations || [], ts: Date.now(),
      }].slice(-HISTORY_MAX))
    } catch (e) {
      setHistory(prev => [...prev, {
        q, answer: '查询失败：' + e.message, citations: [], ts: Date.now(),
      }].slice(-HISTORY_MAX))
    }
    setLoading(false)
  }

  const clearHistory = () => {
    if (!history.length) return
    if (!confirm(`确定清空 ${history.length} 条问答历史？`)) return
    setHistory([])
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 10 }}>
      {/* 顶部状态 + 操作 */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
        {status && (
          <div style={{ color: '#64748b', background: '#1e293b', borderRadius: 6, padding: '4px 10px' }}>
            已索引 {status.total_chunks} 块 · {status.status === 'ready' ? '✅ 就绪' : '⏳ 空'}
          </div>
        )}
        <div style={{ color: '#475569' }}>· 历史 {history.length} 条</div>
        {history.length > 0 && (
          <button onClick={clearHistory} style={{
            marginLeft: 'auto', background: '#1e293b', border: '1px solid #334155',
            borderRadius: 6, color: '#94a3b8', padding: '3px 10px', fontSize: 11, cursor: 'pointer',
          }}>清空历史</button>
        )}
      </div>

      {/* 历史 feed */}
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {history.length === 0 && !loading && (
          <div style={{ color: '#334155', fontSize: 12, textAlign: 'center', marginTop: 30, lineHeight: 1.8 }}>
            提问示例：<br/>
            "什么是动作电位？"<br/>
            "淋巴细胞和血液的关系？"<br/>
            "炎症反应的三个阶段"
          </div>
        )}

        {history.map((entry, i) => (
          <div key={entry.ts + '-' + i} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {/* 用户问题气泡（右对齐） */}
            <div style={{
              alignSelf: 'flex-end', maxWidth: '85%',
              background: '#4f46e5', color: '#fff',
              borderRadius: '12px 12px 4px 12px',
              padding: '8px 12px', fontSize: 13, lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
            }}>{entry.q}</div>

            {/* 答案卡片 */}
            <div style={{ background: '#1e293b', borderRadius: 8, padding: 12, border: '1px solid #334155' }}>
              <div style={{ fontSize: 11, color: '#6366f1', marginBottom: 6, fontWeight: 600 }}>
                📖 回答
              </div>
              <div className="rag-md" style={{ fontSize: 13, lineHeight: 1.75, color: '#e2e8f0' }}>
                <ReactMarkdown
                  remarkPlugins={[remarkGfm, remarkMath]}
                  rehypePlugins={[rehypeKatex]}
                  components={MD_COMPONENTS}
                >
                  {entry.answer}
                </ReactMarkdown>
              </div>
            </div>

            {/* 引用列表 */}
            {entry.citations?.length > 0 && (
              <div>
                <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>引用来源（{entry.citations.length}）</div>
                {entry.citations.map((c, j) => {
                  const key = `${i}-${j}`
                  return (
                    <div
                      key={j}
                      style={{ background: '#1e293b', borderRadius: 6, padding: '8px 10px',
                        border: '1px solid #334155', marginBottom: 4, cursor: 'pointer', fontSize: 12 }}
                      onClick={() => setExpandedCitation(expandedCitation === key ? null : key)}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                          <span style={{ color: '#6366f1', fontWeight: 600 }}>《{c.textbook}》</span>
                          <span style={{ color: '#94a3b8' }}> · {c.chapter} · 第{c.page}页</span>
                        </div>
                        <div style={{ fontSize: 10, color: '#22c55e' }}>
                          {(c.relevance_score * 100).toFixed(0)}%
                        </div>
                      </div>
                      {expandedCitation === key && (
                        <div style={{ marginTop: 6, fontSize: 11, color: '#64748b',
                          lineHeight: 1.6, borderTop: '1px solid #334155', paddingTop: 6 }}>
                          {c.chunk_text}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        ))}

        {loading && (
          <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8,
            padding: '10px 14px', color: '#64748b', fontSize: 12 }}>
            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
              background: '#6366f1', marginRight: 8 }} />
            检索 + 生成中...
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* 输入框 */}
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          value={question}
          onChange={e => setQuestion(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleQuery()}
          placeholder="输入问题，例如：什么是动作电位？"
          disabled={loading}
          style={{
            flex: 1, background: '#1e293b', border: '1px solid #334155',
            borderRadius: 6, padding: '8px 12px', color: '#e2e8f0', fontSize: 13,
            opacity: loading ? 0.6 : 1,
          }}
        />
        <button
          onClick={handleQuery}
          disabled={loading}
          style={{
            background: loading ? '#334155' : '#6366f1',
            color: '#fff', border: 'none', borderRadius: 6,
            padding: '8px 16px', cursor: loading ? 'default' : 'pointer', fontSize: 13,
          }}
        >
          {loading ? '...' : '提问'}
        </button>
      </div>
    </div>
  )
}
