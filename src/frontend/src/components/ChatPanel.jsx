import React, { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { chat, clearChatHistory, getChatHistory } from '../api'

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
  a: ({ node, ...p }) => <a style={{ color: '#22d3ee' }} target="_blank" rel="noreferrer" {...p} />,
}

// 历史消息从后端取回时是 google-generative-ai 的格式 {role: 'user'|'model', parts: [str]}
// 也兼容前端自己 push 的 {role: 'user'|'assistant'|'system', content: str}
const messageText = (m) => m.content ?? (Array.isArray(m.parts) ? m.parts.join('') : '')
const messageKind = (m) => {
  if (m.role === 'user') return 'user'
  if (m.role === 'system') return 'system'
  return 'assistant'  // 'model' 或 'assistant'
}

export default function ChatPanel() {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef()

  useEffect(() => {
    getChatHistory('default').then(r => setMessages(r.data || []))
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const send = async () => {
    if (!input.trim() || loading) return
    const userMsg = { role: 'user', content: input }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setLoading(true)
    try {
      const { data } = await chat(input)
      setMessages(prev => [...prev, { role: 'assistant', content: data.reply }])
      if (data.action) {
        setMessages(prev => [...prev, {
          role: 'system',
          content: `✅ 已执行操作: \`${data.action}\``,
        }])
      }
    } catch (e) {
      setMessages(prev => [...prev, { role: 'assistant', content: '⚠️ 请求失败：' + e.message }])
    }
    setLoading(false)
  }

  const handleClear = async () => {
    if (!messages.length) return
    const turns = messages.filter(m => (m.role === 'user' || m.role === 'assistant' || m.role === 'model')).length
    if (!confirm(`确定清空 ${turns} 条对话历史？`)) return
    try { await clearChatHistory('default') } catch { /* ignore */ }
    setMessages([])
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 13, color: '#94a3b8' }}>
          与整合助手对话（可修改整合决策）
        </div>
        {messages.length > 0 && (
          <button onClick={handleClear} style={{
            background: '#1e293b', border: '1px solid #334155', borderRadius: 6,
            color: '#94a3b8', padding: '3px 10px', fontSize: 11, cursor: 'pointer',
          }}>清空历史</button>
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 10 }}>
        {messages.length === 0 && (
          <div style={{ color: '#334155', fontSize: 12, textAlign: 'center', marginTop: 20, lineHeight: 1.8 }}>
            你可以问：<br/>
            "为什么把《生理学》里的炎症和《病理学》里的炎症反应合并了？"<br/>
            "请保留'免疫应答'知识点"<br/>
            "dec_0001 涉及哪些教材？"
          </div>
        )}
        {messages.map((m, i) => {
          const kind = messageKind(m)
          const text = messageText(m)
          const isUser = kind === 'user'
          const isSystem = kind === 'system'
          return (
            <div
              key={i}
              style={{
                alignSelf: isUser ? 'flex-end' : 'stretch',
                maxWidth: isUser ? '85%' : '100%',
                background: isUser ? '#4f46e5' : isSystem ? '#064e3b' : '#1e293b',
                border: isUser ? 'none' : '1px solid ' + (isSystem ? '#10b981' : '#334155'),
                borderRadius: isUser ? '12px 12px 4px 12px' : 8,
                padding: isUser ? '8px 12px' : '10px 14px',
                fontSize: 13,
                lineHeight: 1.7,
                color: isUser ? '#fff' : isSystem ? '#a7f3d0' : '#e2e8f0',
              }}
            >
              {isUser ? (
                <span style={{ whiteSpace: 'pre-wrap' }}>{text}</span>
              ) : (
                <>
                  {!isSystem && (
                    <div style={{ fontSize: 11, color: '#6366f1', marginBottom: 6, fontWeight: 600 }}>
                      🤖 整合助手
                    </div>
                  )}
                  <div className="rag-md">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm, remarkMath]}
                      rehypePlugins={[rehypeKatex]}
                      components={MD_COMPONENTS}
                    >
                      {text}
                    </ReactMarkdown>
                  </div>
                </>
              )}
            </div>
          )
        })}
        {loading && (
          <div style={{
            alignSelf: 'stretch', maxWidth: '100%',
            background: '#1e293b', border: '1px solid #334155',
            borderRadius: 8, padding: '10px 14px',
            color: '#64748b', fontSize: 12,
          }}>
            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#6366f1', marginRight: 8, animation: 'pulse 1s infinite' }} />
            思考中...
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && !e.shiftKey && send()}
          placeholder="输入消息..."
          disabled={loading}
          style={{
            flex: 1, background: '#1e293b', border: '1px solid #334155',
            borderRadius: 6, padding: '8px 12px', color: '#e2e8f0', fontSize: 13,
            opacity: loading ? 0.6 : 1,
          }}
        />
        <button
          onClick={send}
          disabled={loading}
          style={{
            background: loading ? '#334155' : '#6366f1', color: '#fff', border: 'none',
            borderRadius: 6, padding: '8px 14px', cursor: loading ? 'default' : 'pointer', fontSize: 13,
          }}
        >{loading ? '...' : '发送'}</button>
      </div>
    </div>
  )
}
