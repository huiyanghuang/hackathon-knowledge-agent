import React, { useEffect, useRef, useState } from 'react'
import * as echarts from 'echarts'
import { getMergedGraph, getTextbookGraph } from '../api'

const TEXTBOOK_COLORS = ['#6366f1','#22d3ee','#f59e0b','#10b981','#f43f5e','#a78bfa','#fb923c']

const RELATION_COLORS = {
  prerequisite: '#ef4444',
  parallel: '#6366f1',
  contains: '#22c55e',
  applies_to: '#f59e0b',
}

export default function GraphView({ selectedTextbookId, mode }) {
  const chartRef = useRef()
  const chartInstance = useRef()
  const [selected, setSelected] = useState(null)
  const [stats, setStats] = useState(null)
  const [searchQ, setSearchQ] = useState('')
  const [graphLoading, setGraphLoading] = useState(false)
  const [nodeCount, setNodeCount] = useState(-1) // -1 = 未加载, 0 = 空, >0 = 有数据

  useEffect(() => {
    if (!chartRef.current) return
    chartInstance.current = echarts.init(chartRef.current)
    chartInstance.current.on('click', params => {
      if (params.dataType === 'node') setSelected(params.data)
    })
    const ro = new ResizeObserver(() => chartInstance.current?.resize())
    ro.observe(chartRef.current)
    // Defensive: resize once after mount in case container measured 0 initially
    setTimeout(() => chartInstance.current?.resize(), 50)
    return () => {
      ro.disconnect()
      chartInstance.current?.dispose()
    }
  }, [])

  useEffect(() => {
    if (mode === 'merged') {
      loadMerged()
    } else if (selectedTextbookId) {
      loadSingle(selectedTextbookId)
    } else {
      setNodeCount(-1)
    }
  }, [selectedTextbookId, mode])

  useEffect(() => {
    const onFinished = () => { if (mode === 'merged') loadMerged() }
    window.addEventListener('align-finished', onFinished)
    return () => window.removeEventListener('align-finished', onFinished)
  }, [mode])

  const loadSingle = async (tid) => {
    setGraphLoading(true)
    setSelected(null)
    setStats(null)
    try {
      const { data } = await getTextbookGraph(tid)
      renderGraph(data.nodes, data.edges, false)
      setNodeCount(data.nodes.length)
    } catch (e) {
      console.error('loadSingle failed:', e)
      setNodeCount(0)
    } finally {
      setGraphLoading(false)
    }
  }

  const loadMerged = async () => {
    setGraphLoading(true)
    setSelected(null)
    try {
      const { data } = await getMergedGraph()
      renderGraph(data.nodes, data.edges, true)
      setStats(data.stats)
      setNodeCount(data.nodes.length)
    } catch (e) {
      console.error('loadMerged failed:', e)
      setNodeCount(0)
    } finally {
      setGraphLoading(false)
    }
  }

  const renderGraph = (nodes, edges, isMerged) => {
    console.log('[GraphView] renderGraph', { nodes: nodes.length, edges: edges.length, isMerged, hasChart: !!chartInstance.current })
    if (!chartInstance.current) {
      console.warn('[GraphView] chart instance not ready, will retry on next tick')
      requestAnimationFrame(() => renderGraph(nodes, edges, isMerged))
      return
    }
    const tbIds = [...new Set(nodes.map(n => n.textbook_id))]
    const colorMap = {}
    tbIds.forEach((id, i) => { colorMap[id] = TEXTBOOK_COLORS[i % TEXTBOOK_COLORS.length] })

    const maxFreq = Math.max(...nodes.map(n => n.frequency || 1), 1)

    const chartNodes = nodes.map(n => ({
      id: n.id,
      name: n.name,
      value: n.frequency || 1,
      symbolSize: 12 + ((n.frequency || 1) / maxFreq) * 30,
      itemStyle: { color: colorMap[n.textbook_id] || '#6366f1' },
      label: { show: true, fontSize: 10, color: '#e2e8f0' },
      definition: n.definition,
      category: n.category,
      chapter: n.chapter,
      page: n.page,
      textbook_name: n.textbook_name,
      frequency: n.frequency,
    }))

    const chartEdges = edges.map(e => ({
      source: e.source,
      target: e.target,
      lineStyle: { color: RELATION_COLORS[e.relation_type] || '#475569', width: 1.5, opacity: 0.7 },
      label: { show: false, formatter: e.relation_type },
    }))

    const option = {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'item',
        formatter: p => p.dataType === 'node'
          ? `<b>${p.data.name}</b><br/>${p.data.chapter}<br/>出现频次: ${p.data.frequency || 1}`
          : p.data.relation_type,
      },
      legend: [],
      series: [{
        type: 'graph',
        layout: 'force',
        data: chartNodes,
        edges: chartEdges,
        roam: true,
        draggable: true,
        force: { repulsion: 200, gravity: 0.05, edgeLength: [80, 200] },
        lineStyle: { curveness: 0.1 },
        emphasis: { focus: 'adjacency', scale: true },
      }],
    }
    chartInstance.current.setOption(option, true)
    chartInstance.current.resize()
    // Second resize after layout settles, handles flex/abs timing edge cases
    setTimeout(() => chartInstance.current?.resize(), 100)
    window.__chart = chartInstance.current  // for debugging
    const r = chartRef.current?.getBoundingClientRect()
    const canvases = chartRef.current?.querySelectorAll('canvas') ?? []
    console.log('[GraphView] container', r?.width, 'x', r?.height,
      '| nodes:', chartNodes.length,
      '| canvas count:', canvases.length,
      '| canvas[0] size:', canvases[0]?.width, 'x', canvases[0]?.height,
      '| sample node:', chartNodes[0])
  }

  const handleSearch = (q) => {
    setSearchQ(q)
    if (!chartInstance.current || !q) return
    chartInstance.current.dispatchAction({
      type: 'highlight',
      seriesIndex: 0,
      dataIndex: chartInstance.current.getOption().series[0].data
        .map((d, i) => d.name.includes(q) ? i : -1)
        .filter(i => i >= 0),
    })
  }

  const showEmptyHint = !graphLoading && nodeCount === 0
  const showIdleHint = !graphLoading && nodeCount === -1 && !selectedTextbookId && mode !== 'merged'

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', gap: 8, padding: '8px 0', alignItems: 'center', flexShrink: 0 }}>
        <input
          value={searchQ}
          onChange={e => handleSearch(e.target.value)}
          placeholder="搜索知识点..."
          style={{
            flex: 1, background: '#1e293b', border: '1px solid #334155',
            borderRadius: 6, padding: '6px 12px', color: '#e2e8f0', fontSize: 13,
          }}
        />
      </div>

      {/* Stats bar */}
      {stats && (
        <div style={{ display: 'flex', gap: 16, padding: '6px 0', fontSize: 12, color: '#94a3b8', flexShrink: 0 }}>
          <span>原始 {stats.original_nodes} 节点</span>
          <span>→ 整合后 {stats.compressed_nodes} 节点</span>
          <span style={{ color: stats.compression_ratio <= 0.3 ? '#22c55e' : '#f59e0b' }}>
            压缩比 {(stats.compression_ratio * 100).toFixed(1)}%
          </span>
        </div>
      )}

      {/* Graph area */}
      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        <div ref={chartRef} style={{ position: 'absolute', inset: 0 }} />

        {/* Loading overlay */}
        {graphLoading && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: '#0f111788', zIndex: 20,
          }}>
            <div style={{ color: '#6366f1', fontSize: 14 }}>加载知识图谱中...</div>
          </div>
        )}

        {/* Empty state */}
        {showEmptyHint && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', zIndex: 10,
          }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>📭</div>
            <div style={{ color: '#64748b', fontSize: 13, textAlign: 'center' }}>
              该教材暂无知识图谱<br/>
              <span style={{ fontSize: 11, color: '#334155' }}>
                知识抽取可能正在运行中，或请检查后端日志
              </span>
            </div>
          </div>
        )}

        {/* Idle hint */}
        {showIdleHint && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', zIndex: 10,
          }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>📚</div>
            <div style={{ color: '#334155', fontSize: 13, textAlign: 'center' }}>
              从左侧点击一本教材查看知识图谱<br/>
              或切换到「整合视图」
            </div>
          </div>
        )}

        {/* Node detail panel */}
        {selected && (
          <div style={{
            position: 'absolute', top: 12, left: 12,
            background: '#1e293bee', border: '1px solid #334155',
            borderRadius: 10, padding: 16, maxWidth: 300, backdropFilter: 'blur(8px)',
            zIndex: 10,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <span style={{ fontWeight: 700, fontSize: 15 }}>{selected.name}</span>
              <button onClick={() => setSelected(null)} style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer' }}>✕</button>
            </div>
            <div style={{ fontSize: 11, color: '#6366f1', marginTop: 4 }}>{selected.category}</div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 8, lineHeight: 1.6 }}>{selected.definition}</div>
            <div style={{ marginTop: 10, fontSize: 11, color: '#64748b' }}>
              <div>📚 {selected.textbook_name}</div>
              <div>📖 {selected.chapter} · 第{selected.page}页</div>
              {selected.frequency > 1 && <div>🔁 出现频次: {selected.frequency}</div>}
            </div>
          </div>
        )}
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 12, padding: '6px 0', fontSize: 11, color: '#64748b', flexShrink: 0 }}>
        {Object.entries(RELATION_COLORS).map(([k, c]) => (
          <span key={k} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 16, height: 2, background: c, display: 'inline-block' }} />
            {k}
          </span>
        ))}
      </div>
    </div>
  )
}
