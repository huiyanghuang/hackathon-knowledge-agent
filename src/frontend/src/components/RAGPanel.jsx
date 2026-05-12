import React, { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { ragQuery, ragStatus } from '../api'

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
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState(null)
  const [expandedCitation, setExpandedCitation] = useState(null)

  useEffect(() => {
    ragStatus().then(r => setStatus(r.data))
  }, [])

  const handleQuery = async () => {
    if (!question.trim()) return
    setLoading(true)
    setResult(null)
    try {
      const { data } = await ragQuery(question)
      setResult(data)
    } catch (e) {
      setResult({ answer: '查询失败：' + e.message, citations: [] })
    }
    setLoading(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 12 }}>
      {/* Status */}
      {status && (
        <div style={{ fontSize: 12, color: '#64748b', background: '#1e293b', borderRadius: 6, padding: '6px 12px' }}>
          已索引 {status.total_chunks} 个知识块 · {status.status === 'ready' ? '✅ 就绪' : '⏳ 空'}
        </div>
      )}

      {/* Query input */}
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          value={question}
          onChange={e => setQuestion(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleQuery()}
          placeholder="输入问题，例如：什么是动作电位？"
          style={{
            flex: 1, background: '#1e293b', border: '1px solid #334155',
            borderRadius: 6, padding: '8px 12px', color: '#e2e8f0', fontSize: 13,
          }}
        />
        <button
          onClick={handleQuery}
          disabled={loading}
          style={{
            background: loading ? '#334155' : '#6366f1',
            color: '#fff', border: 'none', borderRadius: 6,
            padding: '8px 16px', cursor: 'pointer', fontSize: 13,
          }}
        >
          {loading ? '检索中...' : '提问'}
        </button>
      </div>

      {/* Result */}
      {result && (
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Answer */}
          <div style={{ background: '#1e293b', borderRadius: 8, padding: 14, border: '1px solid #334155' }}>
            <div style={{ fontSize: 12, color: '#6366f1', marginBottom: 8, fontWeight: 600 }}>回答</div>
            <div className="rag-md" style={{ fontSize: 13, lineHeight: 1.8, color: '#e2e8f0' }}>
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkMath]}
                rehypePlugins={[rehypeKatex]}
                components={MD_COMPONENTS}
              >
                {result.answer}
              </ReactMarkdown>
            </div>
          </div>

          {/* Citations */}
          {result.citations?.length > 0 && (
            <div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 6 }}>引用来源</div>
              {result.citations.map((c, i) => (
                <div
                  key={i}
                  style={{ background: '#1e293b', borderRadius: 8, padding: 10, border: '1px solid #334155', marginBottom: 6, cursor: 'pointer' }}
                  onClick={() => setExpandedCitation(expandedCitation === i ? null : i)}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontSize: 12 }}>
                      <span style={{ color: '#6366f1', fontWeight: 600 }}>《{c.textbook}》</span>
                      <span style={{ color: '#94a3b8' }}> · {c.chapter} · 第{c.page}页</span>
                    </div>
                    <div style={{ fontSize: 11, color: '#22c55e' }}>
                      相关度 {(c.relevance_score * 100).toFixed(0)}%
                    </div>
                  </div>
                  {expandedCitation === i && (
                    <div style={{ marginTop: 8, fontSize: 11, color: '#64748b', lineHeight: 1.6, borderTop: '1px solid #334155', paddingTop: 8 }}>
                      {c.chunk_text}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
