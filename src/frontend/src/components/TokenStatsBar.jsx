import React, { useEffect, useRef, useState } from 'react'
import { getTokenStats, resetTokenStats } from '../api'

const fmt = (n) => {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return String(n)
}

export default function TokenStatsBar() {
  const [s, setS] = useState(null)
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  const refresh = () => getTokenStats().then(r => setS(r.data)).catch(() => {})

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 5000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (!open) return
    const onClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  if (!s) return null

  const reset = async () => {
    if (!confirm('清空 token 统计？')) return
    await resetTokenStats()
    refresh()
  }

  return (
    <div ref={ref} style={{
      background: '#1e293b', borderRadius: 8, border: '1px solid #334155',
      padding: '8px 10px', fontSize: 11, color: '#94a3b8',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
           onClick={() => setOpen(!open)}>
        <span style={{ color: '#94a3b8', letterSpacing: 1, fontWeight: 600 }}>API 用量</span>
        <span style={{ color: '#22c55e', fontWeight: 700 }}>${s.cost_total_usd.toFixed(4)}</span>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 4, fontSize: 10 }}>
        <span title="LLM 总 tokens">🧠 {fmt(s.llm_total_tokens)}</span>
        <span title="Embedding 总 tokens">🔢 {fmt(s.embed_tokens_est)}</span>
        <span title="LLM 调用次数" style={{ marginLeft: 'auto' }}>{s.llm_calls} 次</span>
      </div>
      {open && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #334155', display: 'grid', gridTemplateColumns: '1fr auto', gap: '2px 8px', fontSize: 10 }}>
          <span>LLM 输入</span><span style={{ textAlign: 'right' }}>{fmt(s.llm_input_tokens)}</span>
          <span>LLM 输出</span><span style={{ textAlign: 'right' }}>{fmt(s.llm_output_tokens)}</span>
          <span>LLM 成本</span><span style={{ textAlign: 'right', color: '#22c55e' }}>${s.cost_llm_usd.toFixed(4)}</span>
          <span>Embed 调用</span><span style={{ textAlign: 'right' }}>{s.embed_calls} 次</span>
          <span>Embed chunks</span><span style={{ textAlign: 'right' }}>{fmt(s.embed_chunks)}</span>
          <span>Embed 成本</span><span style={{ textAlign: 'right', color: '#22c55e' }}>${s.cost_embed_usd.toFixed(4)}</span>
          <button onClick={reset} style={{
            gridColumn: '1 / span 2', marginTop: 6,
            background: 'none', border: '1px solid #334155', borderRadius: 4,
            color: '#64748b', padding: '3px 8px', cursor: 'pointer', fontSize: 10,
          }}>清空统计</button>
        </div>
      )}
    </div>
  )
}
