import React, { useEffect, useRef, useState } from 'react'
import { chat, getChatHistory } from '../api'

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
          content: `✅ 已执行操作: ${data.action}`,
        }])
      }
    } catch (e) {
      setMessages(prev => [...prev, { role: 'assistant', content: '请求失败：' + e.message }])
    }
    setLoading(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ fontWeight: 700, fontSize: 13, color: '#94a3b8', marginBottom: 8 }}>
        与整合助手对话（可修改整合决策）
      </div>

      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 10 }}>
        {messages.length === 0 && (
          <div style={{ color: '#334155', fontSize: 12, textAlign: 'center', marginTop: 20 }}>
            你可以问：<br/>
            "为什么把《生理学》里的炎症和《病理学》里的炎症反应合并了？"<br/>
            "请保留'免疫应答'知识点"
          </div>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '85%',
              background: m.role === 'user' ? '#4f46e5' : m.role === 'system' ? '#064e3b' : '#1e293b',
              borderRadius: m.role === 'user' ? '12px 12px 4px 12px' : '12px 12px 12px 4px',
              padding: '8px 12px',
              fontSize: 13,
              lineHeight: 1.6,
              color: m.role === 'system' ? '#6ee7b7' : '#e2e8f0',
              whiteSpace: 'pre-wrap',
            }}
          >
            {m.content}
          </div>
        ))}
        {loading && (
          <div style={{ alignSelf: 'flex-start', color: '#64748b', fontSize: 12 }}>思考中...</div>
        )}
        <div ref={bottomRef} />
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && !e.shiftKey && send()}
          placeholder="输入消息..."
          style={{
            flex: 1, background: '#1e293b', border: '1px solid #334155',
            borderRadius: 6, padding: '8px 12px', color: '#e2e8f0', fontSize: 13,
          }}
        />
        <button
          onClick={send}
          disabled={loading}
          style={{
            background: '#6366f1', color: '#fff', border: 'none',
            borderRadius: 6, padding: '8px 14px', cursor: 'pointer', fontSize: 13,
          }}
        >发送</button>
      </div>
    </div>
  )
}
