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

const VIEWS = [
  { key: 'force', label: '力导向' },
  { key: 'tree',  label: '树状图' },
  { key: 'sankey', label: '桑基图' },
  { key: 'heatmap', label: '矩阵热力图' },
]

export default function GraphView({ selectedTextbookId, mode }) {
  const chartRef = useRef()
  const chartInstance = useRef()
  const dataRef = useRef({ nodes: [], edges: [] })
  const [selected, setSelected] = useState(null)
  const [stats, setStats] = useState(null)
  const [searchQ, setSearchQ] = useState('')
  const [graphLoading, setGraphLoading] = useState(false)
  const [nodeCount, setNodeCount] = useState(-1)
  const [view, setView] = useState('force')

  useEffect(() => {
    if (!chartRef.current) return
    chartInstance.current = echarts.init(chartRef.current)
    chartInstance.current.on('click', params => {
      if (params.dataType === 'node' && params.data?.definition) setSelected(params.data)
    })
    const ro = new ResizeObserver(() => chartInstance.current?.resize())
    ro.observe(chartRef.current)
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

  // Re-render whenever view switches (data unchanged).
  useEffect(() => {
    if (dataRef.current.nodes.length) renderCurrent()
  }, [view])

  const loadSingle = async (tid) => {
    setGraphLoading(true)
    setSelected(null)
    setStats(null)
    try {
      const { data } = await getTextbookGraph(tid)
      dataRef.current = { nodes: data.nodes, edges: data.edges }
      renderCurrent()
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
      dataRef.current = { nodes: data.nodes, edges: data.edges }
      renderCurrent()
      setStats(data.stats)
      setNodeCount(data.nodes.length)
    } catch (e) {
      console.error('loadMerged failed:', e)
      setNodeCount(0)
    } finally {
      setGraphLoading(false)
    }
  }

  const renderCurrent = () => {
    if (!chartInstance.current) {
      requestAnimationFrame(renderCurrent)
      return
    }
    const { nodes, edges } = dataRef.current
    if (!nodes.length) return
    const builder = { force: buildForce, tree: buildTree, sankey: buildSankey, heatmap: buildHeatmap }[view]
    const option = builder(nodes, edges)
    chartInstance.current.setOption(option, true)
    chartInstance.current.resize()
    setTimeout(() => chartInstance.current?.resize(), 100)
  }

  const handleSearch = (q) => {
    setSearchQ(q)
    if (!chartInstance.current || !q || (view !== 'force' && view !== 'tree')) return
    const opt = chartInstance.current.getOption()
    const data = opt.series?.[0]?.data
    if (!Array.isArray(data)) return
    const indices = []
    data.forEach((d, i) => {
      const name = d?.name || ''
      if (name.includes(q)) indices.push(i)
    })
    if (indices.length) {
      chartInstance.current.dispatchAction({ type: 'highlight', seriesIndex: 0, dataIndex: indices })
    }
  }

  const showEmptyHint = !graphLoading && nodeCount === 0
  const showIdleHint = !graphLoading && nodeCount === -1 && !selectedTextbookId && mode !== 'merged'

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* View switcher + search */}
      <div style={{ display: 'flex', gap: 8, padding: '8px 0', alignItems: 'center', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {VIEWS.map(v => (
            <button key={v.key} onClick={() => setView(v.key)} style={{
              background: view === v.key ? '#4f46e5' : '#1e293b',
              border: '1px solid #334155', borderRadius: 6,
              color: view === v.key ? '#fff' : '#94a3b8',
              padding: '5px 12px', fontSize: 12, cursor: 'pointer', fontWeight: view === v.key ? 600 : 400,
            }}>{v.label}</button>
          ))}
        </div>
        <input
          value={searchQ}
          onChange={e => handleSearch(e.target.value)}
          placeholder={view === 'force' || view === 'tree' ? '搜索知识点...' : '当前视图不支持搜索'}
          disabled={view !== 'force' && view !== 'tree'}
          style={{
            flex: 1, background: '#1e293b', border: '1px solid #334155',
            borderRadius: 6, padding: '6px 12px', color: '#e2e8f0', fontSize: 13,
            opacity: (view === 'force' || view === 'tree') ? 1 : 0.5,
          }}
        />
      </div>

      {stats && (
        <div style={{ display: 'flex', gap: 16, padding: '6px 0', fontSize: 12, color: '#94a3b8', flexShrink: 0 }}>
          <span>原始 {stats.original_nodes} 节点</span>
          <span>→ 整合后 {stats.compressed_nodes} 节点</span>
          <span style={{ color: stats.compression_ratio <= 0.3 ? '#22c55e' : '#f59e0b' }}>
            压缩比 {(stats.compression_ratio * 100).toFixed(1)}%
          </span>
        </div>
      )}

      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        <div ref={chartRef} style={{ position: 'absolute', inset: 0 }} />

        {graphLoading && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: '#0f111788', zIndex: 20,
          }}>
            <div style={{ color: '#6366f1', fontSize: 14 }}>加载知识图谱中...</div>
          </div>
        )}

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

      {(view === 'force' || view === 'tree') && (
        <div style={{ display: 'flex', gap: 12, padding: '6px 0', fontSize: 11, color: '#64748b', flexShrink: 0 }}>
          {Object.entries(RELATION_COLORS).map(([k, c]) => (
            <span key={k} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 16, height: 2, background: c, display: 'inline-block' }} />
              {k}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// ============ View Builders ============

function colorOf(textbookId, tbIds) {
  const i = tbIds.indexOf(textbookId)
  return TEXTBOOK_COLORS[(i < 0 ? 0 : i) % TEXTBOOK_COLORS.length]
}

function buildForce(nodes, edges) {
  const tbIds = [...new Set(nodes.map(n => n.textbook_id))]
  const maxFreq = Math.max(...nodes.map(n => n.frequency || 1), 1)
  return {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item',
      formatter: p => p.dataType === 'node'
        ? `<b>${p.data.name}</b><br/>${p.data.chapter || ''}<br/>出现频次: ${p.data.frequency || 1}`
        : p.data.relation_type || '',
    },
    series: [{
      type: 'graph',
      layout: 'force',
      roam: true,
      draggable: true,
      force: { repulsion: 200, gravity: 0.05, edgeLength: [80, 200] },
      lineStyle: { curveness: 0.1 },
      emphasis: { focus: 'adjacency', scale: true },
      data: nodes.map(n => ({
        id: n.id,
        name: n.name,
        value: n.frequency || 1,
        symbolSize: 12 + ((n.frequency || 1) / maxFreq) * 30,
        itemStyle: { color: colorOf(n.textbook_id, tbIds) },
        label: { show: true, fontSize: 10, color: '#e2e8f0' },
        definition: n.definition, category: n.category,
        chapter: n.chapter, page: n.page,
        textbook_name: n.textbook_name, frequency: n.frequency,
      })),
      edges: edges.map(e => ({
        source: e.source, target: e.target,
        lineStyle: { color: RELATION_COLORS[e.relation_type] || '#475569', width: 1.5, opacity: 0.7 },
        relation_type: e.relation_type,
      })),
    }],
  }
}

function buildTree(nodes, edges) {
  // 教材 → 章节 → 知识点  三层树
  const tbIds = [...new Set(nodes.map(n => n.textbook_id))]
  const byTb = {}
  for (const n of nodes) {
    const tb = n.textbook_name || n.textbook_id || '未知教材'
    const ch = n.chapter || '未分类'
    byTb[tb] ??= {}
    byTb[tb][ch] ??= []
    byTb[tb][ch].push(n)
  }
  const root = {
    name: '知识图谱',
    children: Object.entries(byTb).map(([tb, chapters]) => ({
      name: tb,
      itemStyle: { color: colorOf(Object.values(chapters)[0]?.[0]?.textbook_id, tbIds) },
      collapsed: false,
      children: Object.entries(chapters).map(([ch, ns]) => ({
        name: ch,
        collapsed: true,
        children: ns.map(n => ({
          name: n.name,
          value: n.frequency || 1,
          definition: n.definition, category: n.category,
          chapter: n.chapter, page: n.page,
          textbook_name: n.textbook_name, frequency: n.frequency,
        })),
      })),
    })),
  }
  return {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item',
      formatter: p => p.data?.definition
        ? `<b>${p.data.name}</b><br/>${p.data.category || ''}<br/>${p.data.chapter || ''} · 第${p.data.page || '-'}页`
        : p.data?.name || '',
    },
    series: [{
      type: 'tree',
      data: [root],
      top: '2%', left: '12%', bottom: '2%', right: '20%',
      symbolSize: 8,
      orient: 'LR',
      initialTreeDepth: 2,
      roam: true,
      label: {
        position: 'left', verticalAlign: 'middle', align: 'right',
        color: '#e2e8f0', fontSize: 11,
      },
      leaves: { label: { position: 'right', align: 'left', color: '#94a3b8' } },
      emphasis: { focus: 'descendant' },
      expandAndCollapse: true,
      animationDuration: 400,
      lineStyle: { color: '#334155', curveness: 0.5 },
    }],
  }
}

function buildSankey(nodes) {
  // 教材 → 类别 流向；value = 节点数
  const flow = {}  // {tb -> {cat -> count}}
  for (const n of nodes) {
    const tb = n.textbook_name || n.textbook_id || '未知教材'
    const cat = n.category || '未分类'
    flow[tb] ??= {}
    flow[tb][cat] = (flow[tb][cat] || 0) + 1
  }
  const tbSet = Object.keys(flow)
  const catSet = [...new Set(nodes.map(n => n.category || '未分类'))]
  const tbIds = [...new Set(nodes.map(n => n.textbook_id))]
  // 为教材节点找一个 textbook_id 用于配色
  const tbToId = {}
  for (const n of nodes) { tbToId[n.textbook_name] = n.textbook_id }

  const data = [
    ...tbSet.map(tb => ({ name: tb, itemStyle: { color: colorOf(tbToId[tb], tbIds) } })),
    ...catSet.map(c => ({ name: c, itemStyle: { color: '#64748b' } })),
  ]
  const links = []
  for (const [tb, cats] of Object.entries(flow)) {
    for (const [c, v] of Object.entries(cats)) {
      links.push({ source: tb, target: c, value: v })
    }
  }
  return {
    backgroundColor: 'transparent',
    tooltip: { trigger: 'item', triggerOn: 'mousemove' },
    series: [{
      type: 'sankey',
      data, links,
      emphasis: { focus: 'adjacency' },
      lineStyle: { color: 'gradient', curveness: 0.5, opacity: 0.5 },
      label: { color: '#e2e8f0', fontSize: 11 },
      nodeAlign: 'left',
      left: '4%', right: '12%', top: '4%', bottom: '4%',
    }],
  }
}

function buildHeatmap(nodes) {
  const textbooks = [...new Set(nodes.map(n => n.textbook_name || n.textbook_id || '未知'))]
  const categories = [...new Set(nodes.map(n => n.category || '未分类'))]
  const counts = {}  // "x,y" -> count
  for (const n of nodes) {
    const x = textbooks.indexOf(n.textbook_name || n.textbook_id || '未知')
    const y = categories.indexOf(n.category || '未分类')
    const k = `${x},${y}`
    counts[k] = (counts[k] || 0) + 1
  }
  const data = []
  let maxV = 0
  for (let x = 0; x < textbooks.length; x++) {
    for (let y = 0; y < categories.length; y++) {
      const v = counts[`${x},${y}`] || 0
      data.push([x, y, v])
      if (v > maxV) maxV = v
    }
  }
  return {
    backgroundColor: 'transparent',
    tooltip: {
      position: 'top',
      formatter: p => `${textbooks[p.data[0]]} · ${categories[p.data[1]]}<br/><b>${p.data[2]}</b> 个知识点`,
    },
    grid: { left: '20%', right: '8%', top: '6%', bottom: '24%' },
    xAxis: {
      type: 'category', data: textbooks, splitArea: { show: true },
      axisLabel: { color: '#94a3b8', rotate: 30, fontSize: 11 },
      axisLine: { lineStyle: { color: '#334155' } },
    },
    yAxis: {
      type: 'category', data: categories, splitArea: { show: true },
      axisLabel: { color: '#94a3b8', fontSize: 11 },
      axisLine: { lineStyle: { color: '#334155' } },
    },
    visualMap: {
      min: 0, max: Math.max(1, maxV),
      calculable: true, orient: 'horizontal',
      left: 'center', bottom: '4%',
      textStyle: { color: '#94a3b8' },
      inRange: { color: ['#0f1117', '#1e293b', '#4f46e5', '#22d3ee', '#facc15'] },
    },
    series: [{
      type: 'heatmap',
      data,
      label: { show: true, color: '#e2e8f0', fontSize: 11 },
      emphasis: { itemStyle: { shadowBlur: 10, shadowColor: '#6366f1' } },
    }],
  }
}
