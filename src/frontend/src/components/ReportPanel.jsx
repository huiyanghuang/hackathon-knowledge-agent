import React, { useEffect, useState } from 'react'
import { getDecisions, getStats, getTokenStats, listTextbooks } from '../api'

export default function ReportPanel() {
  const [stats, setStats] = useState(null)
  const [decisions, setDecisions] = useState([])
  const [textbooks, setTextbooks] = useState([])
  const [tokenStats, setTokenStats] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([getStats(), getDecisions(), listTextbooks(), getTokenStats()])
      .then(([s, d, t, ts]) => {
        setStats(s.data)
        setDecisions(d.data)
        setTextbooks(t.data)
        setTokenStats(ts.data)
      })
      .finally(() => setLoading(false))
  }, [])

  const exportPdf = () => window.print()

  const exportMarkdown = () => {
    const md = buildMarkdown(stats, decisions, textbooks, tokenStats)
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = '整合报告.md'
    a.click()
    URL.revokeObjectURL(url)
  }

  if (loading) return <div style={{ color: '#64748b', fontSize: 12, padding: 20 }}>加载中...</div>

  const totalChars = textbooks.reduce((s, t) => s + (t.total_chars || 0), 0)
  const mergeCases = decisions.filter(d => d.action === 'merge').sort((a, b) => b.confidence - a.confidence).slice(0, 5)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8 }} className="no-print">
        <button onClick={exportPdf} style={btnPrimary}>📄 导出 PDF</button>
        <button onClick={exportMarkdown} style={btnSecondary}>⬇ 导出 Markdown</button>
      </div>

      <div id="report-content" style={{
        background: '#1e293b', borderRadius: 8, padding: 16, fontSize: 12,
        color: '#e2e8f0', lineHeight: 1.7, border: '1px solid #334155',
      }}>
        <h2 style={h2}>学科知识整合报告</h2>
        <div style={meta}>生成时间：{new Date().toLocaleString('zh-CN')}</div>

        <h3 style={h3}>1. 整合概览</h3>
        <ul style={ul}>
          <li>原始教材数量：<b>{textbooks.length}</b> 本</li>
          <li>原始总字数：<b>{totalChars.toLocaleString()}</b> 字</li>
          {stats && <>
            <li>知识点抽取（节点定义）总字符：<b>{stats.original_chars?.toLocaleString()}</b></li>
            <li>整合后字符：<b>{stats.compressed_chars?.toLocaleString()}</b></li>
            <li>压缩比：<b style={{ color: stats.compression_ratio <= 0.3 ? '#22c55e' : '#f59e0b' }}>{(stats.compression_ratio * 100).toFixed(1)}%</b>（目标 ≤30%）</li>
          </>}
        </ul>

        <h3 style={h3}>2. 教材清单</h3>
        <table style={table}>
          <thead><tr><th style={th}>教材</th><th style={th}>字数</th><th style={th}>状态</th></tr></thead>
          <tbody>
            {textbooks.map(t => (
              <tr key={t.textbook_id}>
                <td style={td}>{t.title || t.filename}</td>
                <td style={tdRight}>{(t.total_chars || 0).toLocaleString()}</td>
                <td style={td}>{t.status}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {stats && <>
          <h3 style={h3}>3. 整合决策摘要</h3>
          <ul style={ul}>
            <li>合并 (merge)：<b style={{ color: '#6366f1' }}>{stats.decisions_merge}</b> 项</li>
            <li>保留 (keep)：<b style={{ color: '#22c55e' }}>{stats.decisions_keep}</b> 项</li>
            <li>删除 (remove)：<b style={{ color: '#ef4444' }}>{stats.decisions_remove}</b> 项</li>
          </ul>

          <h3 style={h3}>4. 知识图谱统计</h3>
          <ul style={ul}>
            <li>整合前节点数：<b>{stats.original_nodes}</b></li>
            <li>合并去重后节点数：<b>{stats.merged_nodes}</b></li>
            <li>压缩后节点数：<b>{stats.compressed_nodes}</b></li>
            <li>节点缩减比：<b>{((1 - stats.compressed_nodes / stats.original_nodes) * 100).toFixed(1)}%</b></li>
          </ul>
        </>}

        {mergeCases.length > 0 && <>
          <h3 style={h3}>5. 重点整合案例</h3>
          {mergeCases.map((d, i) => (
            <div key={d.decision_id} style={caseBox}>
              <div style={caseTitle}>案例 {i + 1}（置信度 {(d.confidence * 100).toFixed(0)}%）</div>
              <div style={{ color: '#cbd5e1', marginTop: 4 }}>{d.reason}</div>
              <div style={{ color: '#64748b', marginTop: 4, fontSize: 11 }}>
                影响节点：{d.affected_nodes?.length || 0} 个 → 合并为 {d.result_node}
              </div>
            </div>
          ))}
        </>}

        <h3 style={h3}>6. 教学完整性说明</h3>
        <p style={p}>
          整合策略以"语义对齐 + LLM 复核"双重机制为基础，仅合并被多数证据支持等价的概念，单独教材独有概念全部保留为 keep。
          边（关系）在合并节点时通过 union-find 自动重映射并去重，保证教学逻辑链路（前置依赖 / 包含 / 应用）不断裂。
          压缩比控制在 {stats ? (stats.compression_ratio * 100).toFixed(1) : '?'}%，{stats?.compression_ratio <= 0.3 ? '满足' : '略高于'}赛题 30% 目标。
          后续可通过对话面板对单个决策进行人工修正。
        </p>

        {tokenStats && <>
          <h3 style={h3}>7. 资源消耗</h3>
          <ul style={ul}>
            <li>LLM 调用：<b>{tokenStats.llm_calls}</b> 次，输入 {tokenStats.llm_input_tokens.toLocaleString()} tokens / 输出 {tokenStats.llm_output_tokens.toLocaleString()} tokens</li>
            <li>Embedding 调用：<b>{tokenStats.embed_calls}</b> 次，覆盖 {tokenStats.embed_chunks.toLocaleString()} chunks</li>
            <li>累计成本：<b style={{ color: '#22c55e' }}>${tokenStats.cost_total_usd}</b></li>
          </ul>
        </>}
      </div>
    </div>
  )
}

function buildMarkdown(stats, decisions, textbooks, ts) {
  const total = textbooks.reduce((s, t) => s + (t.total_chars || 0), 0)
  const merges = decisions.filter(d => d.action === 'merge').sort((a, b) => b.confidence - a.confidence).slice(0, 5)
  const lines = [
    '# 学科知识整合报告',
    '',
    `> 生成时间：${new Date().toLocaleString('zh-CN')}`,
    '',
    '## 1. 整合概览',
    '',
    `- 原始教材数量：**${textbooks.length}** 本`,
    `- 原始总字数：**${total.toLocaleString()}** 字`,
  ]
  if (stats) {
    lines.push(
      `- 知识点抽取总字符：**${stats.original_chars.toLocaleString()}**`,
      `- 整合后字符：**${stats.compressed_chars.toLocaleString()}**`,
      `- **压缩比：${(stats.compression_ratio * 100).toFixed(1)}%**（目标 ≤30%）`,
    )
  }
  lines.push('', '## 2. 教材清单', '', '| 教材 | 字数 | 状态 |', '|---|---:|---|')
  textbooks.forEach(t => lines.push(`| ${t.title || t.filename} | ${(t.total_chars || 0).toLocaleString()} | ${t.status} |`))
  if (stats) {
    lines.push(
      '', '## 3. 整合决策摘要', '',
      `- 合并 merge：**${stats.decisions_merge}** 项`,
      `- 保留 keep：**${stats.decisions_keep}** 项`,
      `- 删除 remove：**${stats.decisions_remove}** 项`,
      '', '## 4. 知识图谱统计', '',
      `- 整合前节点：**${stats.original_nodes}**`,
      `- 合并去重后：**${stats.merged_nodes}**`,
      `- 压缩后：**${stats.compressed_nodes}**`,
      `- 节点缩减比：**${((1 - stats.compressed_nodes / stats.original_nodes) * 100).toFixed(1)}%**`,
    )
  }
  if (merges.length) {
    lines.push('', '## 5. 重点整合案例', '')
    merges.forEach((d, i) => lines.push(
      `### 案例 ${i + 1}（置信度 ${(d.confidence * 100).toFixed(0)}%）`,
      '',
      d.reason,
      '',
      `> 影响节点：${d.affected_nodes?.length || 0} 个 → 合并为 \`${d.result_node}\``,
      '',
    ))
  }
  lines.push(
    '', '## 6. 教学完整性说明', '',
    `整合策略以"语义对齐 + LLM 复核"双重机制为基础，仅合并被多数证据支持等价的概念，单独教材独有概念全部保留为 keep。边（关系）在合并节点时通过 union-find 自动重映射并去重，保证教学逻辑链路（前置依赖 / 包含 / 应用）不断裂。压缩比控制在 ${stats ? (stats.compression_ratio * 100).toFixed(1) : '?'}%，${stats?.compression_ratio <= 0.3 ? '满足' : '略高于'}赛题 30% 目标。`,
  )
  if (ts) {
    lines.push(
      '', '## 7. 资源消耗', '',
      `- LLM 调用：**${ts.llm_calls}** 次（输入 ${ts.llm_input_tokens.toLocaleString()} / 输出 ${ts.llm_output_tokens.toLocaleString()} tokens）`,
      `- Embedding：**${ts.embed_calls}** 次，覆盖 ${ts.embed_chunks.toLocaleString()} chunks`,
      `- 累计成本：**$${ts.cost_total_usd}**`,
    )
  }
  return lines.join('\n')
}

const btnPrimary = { background: '#6366f1', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 14px', cursor: 'pointer', fontSize: 12, fontWeight: 600 }
const btnSecondary = { background: '#1e293b', color: '#94a3b8', border: '1px solid #334155', borderRadius: 6, padding: '8px 14px', cursor: 'pointer', fontSize: 12 }
const h2 = { fontSize: 18, color: '#f1f5f9', margin: '0 0 4px 0', fontWeight: 700 }
const meta = { fontSize: 11, color: '#64748b', marginBottom: 12 }
const h3 = { fontSize: 14, color: '#a5b4fc', margin: '16px 0 6px 0', fontWeight: 600 }
const ul = { paddingLeft: 20, margin: '4px 0' }
const p = { margin: '4px 0', color: '#cbd5e1' }
const table = { borderCollapse: 'collapse', width: '100%', fontSize: 11, margin: '6px 0' }
const th = { border: '1px solid #334155', padding: '4px 8px', background: '#0f172a', textAlign: 'left' }
const td = { border: '1px solid #334155', padding: '4px 8px' }
const tdRight = { ...td, textAlign: 'right' }
const caseBox = { background: '#0f172a', border: '1px solid #334155', borderRadius: 6, padding: 10, margin: '6px 0' }
const caseTitle = { color: '#fbbf24', fontWeight: 600, fontSize: 12 }
