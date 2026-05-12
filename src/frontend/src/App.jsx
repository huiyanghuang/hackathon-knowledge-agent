import React, { useEffect, useRef, useState } from 'react'
import { getAlignStatus, getDecisions, getStats, startAlign } from './api'
import ChatPanel from './components/ChatPanel'
import GraphView from './components/GraphView'
import RAGPanel from './components/RAGPanel'
import ReportPanel from './components/ReportPanel'
import TextbookPanel from './components/TextbookPanel'
import TokenStatsBar from './components/TokenStatsBar'

const TABS = ['整合操作', 'RAG问答', '对话', '报告']

const styles = {
  root: {
    display: 'flex', height: '100vh', background: '#0f1117', color: '#e2e8f0', overflow: 'hidden',
  },
  left: {
    width: 240, borderRight: '1px solid #1e293b', padding: 16, display: 'flex', flexDirection: 'column', flexShrink: 0,
  },
  center: {
    flex: 1, display: 'flex', flexDirection: 'column', padding: 16, minWidth: 0,
  },
  right: {
    width: 360, borderLeft: '1px solid #1e293b', padding: 16, display: 'flex', flexDirection: 'column', flexShrink: 0,
  },
  tabBar: {
    display: 'flex', gap: 0, marginBottom: 12, borderBottom: '1px solid #1e293b',
  },
  tab: (active) => ({
    padding: '6px 16px', fontSize: 13, cursor: 'pointer', border: 'none',
    background: 'none', color: active ? '#e2e8f0' : '#64748b',
    borderBottom: active ? '2px solid #6366f1' : '2px solid transparent',
    fontWeight: active ? 600 : 400,
  }),
  header: {
    fontSize: 12, color: '#6366f1', fontWeight: 700, letterSpacing: 2, marginBottom: 8,
  },
}

export default function App() {
  const [activeTab, setActiveTab] = useState(0)
  const [selectedTextbookId, setSelectedTextbookId] = useState(null)
  const [graphMode, setGraphMode] = useState('single')

  return (
    <div style={styles.root}>
      {/* Left: textbook management */}
      <div style={styles.left}>
        <div style={{ flex: 1, minHeight: 0 }}>
          <TextbookPanel
            onGraphSelect={id => { setSelectedTextbookId(id); setGraphMode('single') }}
          />
        </div>
        <div style={{ marginTop: 12, flexShrink: 0 }}>
          <TokenStatsBar />
        </div>
      </div>

      {/* Center: knowledge graph */}
      <div style={styles.center}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexShrink: 0 }}>
          <div style={styles.header}>知识图谱</div>
          <button
            onClick={() => setGraphMode('single')}
            style={{
              ...styles.tab(graphMode === 'single'),
              borderBottom: 'none',
              borderRadius: 6,
              background: graphMode === 'single' ? '#1e293b' : 'none',
            }}
          >单本视图</button>
          <button
            onClick={() => setGraphMode('merged')}
            style={{
              ...styles.tab(graphMode === 'merged'),
              borderBottom: 'none',
              borderRadius: 6,
              background: graphMode === 'merged' ? '#1e293b' : 'none',
            }}
          >整合视图</button>
        </div>
        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          <GraphView selectedTextbookId={selectedTextbookId} mode={graphMode} />
        </div>
      </div>

      {/* Right: functional panels */}
      <div style={styles.right}>
        <div style={styles.tabBar}>
          {TABS.map((t, i) => (
            <button key={t} style={styles.tab(activeTab === i)} onClick={() => setActiveTab(i)}>{t}</button>
          ))}
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {activeTab === 0 && <DecisionPanel />}
          {activeTab === 1 && <RAGPanel />}
          {activeTab === 2 && <ChatPanel />}
          {activeTab === 3 && <ReportPanel />}
        </div>
      </div>
    </div>
  )
}

function DecisionPanel() {
  const [decisions, setDecisions] = useState([])
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(false)
  const [alignState, setAlignState] = useState({ running: false, progress: 0, message: '', error: null, done: false })
  const pollRef = useRef(null)

  const load = async () => {
    setLoading(true)
    try {
      const [d, s] = await Promise.all([getDecisions(), getStats()])
      setDecisions(d.data)
      setStats(s.data)
    } catch {}
    setLoading(false)
  }

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  const startPolling = () => {
    stopPolling()
    pollRef.current = setInterval(async () => {
      try {
        const { data } = await getAlignStatus()
        setAlignState(data)
        if (data.done || !data.running) {
          stopPolling()
          if (!data.error) {
            load()
            window.dispatchEvent(new CustomEvent('align-finished'))
          }
        }
      } catch {}
    }, 1500)
  }

  const runAlign = async () => {
    try {
      await startAlign()
      setAlignState({ running: true, progress: 0, message: '启动中...', error: null, done: false })
      startPolling()
    } catch (e) {
      alert('启动对齐失败：' + (e?.response?.data?.detail || e.message))
    }
  }

  useEffect(() => {
    load()
    // Check if alignment is already running on mount
    getAlignStatus().then(({ data }) => {
      setAlignState(data)
      if (data.running) startPolling()
    }).catch(() => {})
    // 手动合并/删除/撤销后 GraphView 会派发该事件，整合面板也跟着刷新
    const onUpdate = () => load()
    window.addEventListener('align-finished', onUpdate)
    return () => {
      stopPolling()
      window.removeEventListener('align-finished', onUpdate)
    }
  }, [])

  const isRunning = alignState.running
  const progress = alignState.progress || 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <button onClick={runAlign} disabled={isRunning} style={{
        background: isRunning ? '#334155' : '#4f46e5', border: 'none', borderRadius: 6,
        color: '#fff', padding: '8px 12px', cursor: isRunning ? 'default' : 'pointer',
        fontSize: 13, fontWeight: 600,
      }}>
        {isRunning ? `对齐中... ${progress}%` : '执行跨教材知识对齐'}
      </button>

      {/* Progress bar */}
      {(isRunning || alignState.done) && (
        <div style={{ background: '#1e293b', borderRadius: 8, padding: 12, fontSize: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, color: '#94a3b8' }}>
            <span>{alignState.message || '处理中...'}</span>
            <span style={{ color: progress === 100 ? '#22c55e' : '#6366f1', fontWeight: 700 }}>{progress}%</span>
          </div>
          <div style={{ background: '#0f1117', borderRadius: 4, height: 6, overflow: 'hidden' }}>
            <div style={{
              height: '100%', borderRadius: 4,
              background: alignState.error ? '#ef4444' : progress === 100 ? '#22c55e' : '#6366f1',
              width: `${progress}%`,
              transition: 'width 0.4s ease',
            }} />
          </div>
          {alignState.error && (
            <div style={{ marginTop: 6, color: '#ef4444', fontSize: 11 }}>错误：{alignState.error}</div>
          )}
        </div>
      )}

      {stats && (
        <div style={{ background: '#1e293b', borderRadius: 8, padding: 12, fontSize: 12 }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <span>合并 <b style={{ color: '#6366f1' }}>{stats.decisions_merge}</b></span>
            <span>保留 <b style={{ color: '#22c55e' }}>{stats.decisions_keep}</b></span>
            <span>原始字数 <b>{(stats.original_chars / 10000)?.toFixed(1)}万</b></span>
            <span>整合后 <b>{(stats.compressed_chars / 10000)?.toFixed(1)}万</b></span>
            <span style={{ color: stats.compression_ratio <= 0.3 ? '#22c55e' : '#f59e0b' }}>
              压缩比 <b>{(stats.compression_ratio * 100)?.toFixed(1)}%</b>
            </span>
          </div>
        </div>
      )}

      <button onClick={load} disabled={loading} style={{
        background: '#1e293b', border: '1px solid #334155', borderRadius: 6,
        color: '#94a3b8', padding: '6px 12px', cursor: 'pointer', fontSize: 12,
      }}>
        {loading ? '刷新中...' : '刷新决策列表'}
      </button>

      {decisions.map(d => (
        <div key={d.decision_id} style={{
          background: '#1e293b', borderRadius: 8, padding: 10, border: '1px solid #334155', fontSize: 12,
        }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{
              background: d.action === 'merge' ? '#4f46e5' : d.action === 'keep' ? '#065f46' : '#7f1d1d',
              color: '#fff', borderRadius: 4, padding: '1px 6px', fontSize: 10,
            }}>{d.action}</span>
            <span style={{ color: '#94a3b8' }}>{d.decision_id}</span>
            <span style={{ color: '#64748b', marginLeft: 'auto' }}>{(d.confidence * 100).toFixed(0)}%</span>
          </div>
          <div style={{ marginTop: 6, color: '#94a3b8', lineHeight: 1.5 }}>{d.reason}</div>
        </div>
      ))}
    </div>
  )
}
