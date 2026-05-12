import React, { useEffect, useRef, useState } from 'react'
import * as echarts from 'echarts'
import {
  getMergedGraph, getTextbookGraph,
  manualMerge, manualRemove, undoLast, undoHistory,
} from '../api'

const TEXTBOOK_COLORS = ['#6366f1','#22d3ee','#f59e0b','#10b981','#f43f5e','#a78bfa','#fb923c']

const RELATION_COLORS = {
  prerequisite: '#ef4444',
  parallel: '#6366f1',
  contains: '#22c55e',
  applies_to: '#f59e0b',
}

const RELATION_LABELS = {
  prerequisite: '前置依赖',
  parallel: '并列关系',
  contains: '包含关系',
  applies_to: '应用关系',
}

const RELATION_TIPS = {
  prerequisite: '前置依赖：学习 B 之前必须先掌握 A。例：动作电位 ← 静息电位',
  parallel:     '并列关系：同一层级的平行概念。例：有丝分裂 ⇔ 减数分裂',
  contains:     '包含关系：上位概念包含下位概念。例：免疫系统 ⊃ T 细胞',
  applies_to:   '应用关系：知识点是另一个的应用场景。例：抗体 → 体液免疫',
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
  const dragRef = useRef({ src: null, startX: 0, startY: 0 })
  const modeRef = useRef(mode)
  const viewRef = useRef('force')
  const shiftRef = useRef(false)  // 全局追踪 Shift 键状态，不依赖 zrender 事件透传
  const [selected, setSelected] = useState(null)
  const [stats, setStats] = useState(null)
  const [searchQ, setSearchQ] = useState('')
  const [graphLoading, setGraphLoading] = useState(false)
  const [nodeCount, setNodeCount] = useState(-1)
  const [view, setView] = useState('force')
  const [confirmDlg, setConfirmDlg] = useState(null)  // {kind:'merge'|'remove', ...}
  const [showHelp, setShowHelp] = useState(false)
  const [undoCount, setUndoCount] = useState(0)
  const [toast, setToast] = useState(null)
  const [shiftHeld, setShiftHeld] = useState(false)  // UI 实时显示，方便用户确认监听器在工作
  const helpShownRef = useRef(false)  // 本会话首次进入 merged 时弹一次

  const showToast = (msg, kind = 'info') => {
    setToast({ msg, kind })
    setTimeout(() => setToast(null), 2400)
  }

  const refreshUndoCount = async () => {
    try {
      const { data } = await undoHistory()
      setUndoCount(data.available || 0)
    } catch { /* ignore */ }
  }

  useEffect(() => {
    if (!chartRef.current) return
    chartInstance.current = echarts.init(chartRef.current)

    // 点击节点 = 查看详情
    chartInstance.current.on('click', params => {
      if (params.dataType === 'node' && params.data?.definition) setSelected(params.data)
    })

    const editable = () => modeRef.current === 'merged' && viewRef.current === 'force'

    // Shift+拖拽合并。设计：
    //   1. 用 chart.on(mousedown) 拿源节点（ECharts 自己做坐标变换，不出错）
    //   2. 锁源节点 el.draggable=false → 力布局不被扰动 → 邻居不动
    //   3. 用 chart.on(mouseover/mouseout) 追踪目标，避开 roam/zoom 坐标系问题
    //   4. zr.on(mousemove) 只用来更新虚线终点（屏幕坐标足够）
    //   5. mouseup 时若 src+tgt 都有 → 弹合并对话框
    const chart = chartInstance.current
    const zr = chart.getZr()
    let dragLine = null

    const cleanup = () => {
      const { src, tgt } = dragRef.current
      if (dragLine) { zr.remove(dragLine); dragLine = null }
      if (src?.el) src.el.draggable = src.origDraggable !== false
      if (src?.dataIndex != null) chart.dispatchAction({ type: 'downplay', seriesIndex: 0, dataIndex: src.dataIndex })
      if (tgt?.dataIndex != null) chart.dispatchAction({ type: 'downplay', seriesIndex: 0, dataIndex: tgt.dataIndex })
      dragRef.current = { src: null, tgt: null, startX: 0, startY: 0 }
    }

    // ① 源节点 via chart.on(mousedown)
    chart.on('mousedown', params => {
      if (!editable()) return
      const shifted = shiftRef.current || params.event?.event?.shiftKey
      if (!shifted) return
      if (params.dataType !== 'node' || !params.data?.id) return

      const data = chart.getModel().getSeriesByIndex(0).getData()
      const el = data.getItemGraphicEl(params.dataIndex)
      const origDraggable = el ? el.draggable : true
      if (el) el.draggable = false  // 锁源 → 邻居不被挤开

      const layout = data.getItemLayout(params.dataIndex) || {}
      dragRef.current = {
        src: {
          id: params.data.id, name: params.data.name,
          dataIndex: params.dataIndex, el, origDraggable,
          x: layout.x ?? 0, y: layout.y ?? 0,
        },
        tgt: null, startX: 0, startY: 0,
      }
      chart.dispatchAction({ type: 'highlight', seriesIndex: 0, dataIndex: params.dataIndex })

      // 黄色虚线（屏幕坐标 = layout 坐标 / 因为 zrender Line 也在图表坐标系下）
      dragLine = new echarts.graphic.Line({
        shape: { x1: layout.x ?? 0, y1: layout.y ?? 0, x2: layout.x ?? 0, y2: layout.y ?? 0 },
        style: { stroke: '#fbbf24', lineWidth: 2, lineDash: [6, 4], opacity: 0.9 },
        silent: true, z: 10000,
      })
      zr.add(dragLine)

      params.event?.event?.preventDefault?.()
    })

    // ② 目标节点 via mouseover（ECharts 自己负责命中）
    chart.on('mouseover', params => {
      const { src, tgt } = dragRef.current
      if (!src) return
      if (params.dataType !== 'node' || !params.data?.id) return
      if (params.data.id === src.id) return  // 不可指向自己
      if (tgt && tgt.id !== params.data.id) {
        chart.dispatchAction({ type: 'downplay', seriesIndex: 0, dataIndex: tgt.dataIndex })
      }
      chart.dispatchAction({ type: 'highlight', seriesIndex: 0, dataIndex: params.dataIndex })
      dragRef.current.tgt = { id: params.data.id, name: params.data.name, dataIndex: params.dataIndex }
    })

    chart.on('mouseout', params => {
      const { src, tgt } = dragRef.current
      if (!src || !tgt) return
      if (params.dataType !== 'node') return
      if (params.data?.id !== tgt.id) return
      chart.dispatchAction({ type: 'downplay', seriesIndex: 0, dataIndex: tgt.dataIndex })
      dragRef.current.tgt = null
    })

    // ③ 虚线终点跟随光标
    zr.on('mousemove', e => {
      if (!dragRef.current.src || !dragLine) return
      dragLine.attr({ shape: {
        x1: dragRef.current.src.x, y1: dragRef.current.src.y,
        x2: e.offsetX, y2: e.offsetY,
      }})
    })

    // ④ 松手 → 弹对话框 + 清理
    zr.on('mouseup', () => {
      const { src, tgt } = dragRef.current
      cleanup()
      if (!src || !tgt) return
      setConfirmDlg({
        kind: 'merge',
        source: { id: src.id, name: src.name },
        target: { id: tgt.id, name: tgt.name },
      })
    })

    zr.on('mouseleave', cleanup)

    // 右键节点 = 删除确认
    chartInstance.current.on('contextmenu', params => {
      if (!editable()) return
      if (params.dataType === 'node' && params.data?.id) {
        params.event?.event?.preventDefault?.()
        setConfirmDlg({
          kind: 'remove',
          target: { id: params.data.id, name: params.data.name },
        })
      }
    })

    const ro = new ResizeObserver(() => chartInstance.current?.resize())
    ro.observe(chartRef.current)
    setTimeout(() => chartInstance.current?.resize(), 50)
    return () => {
      ro.disconnect()
      chartInstance.current?.dispose()
    }
  }, [])

  // Ctrl+Z 撤销 + 全局 Shift 状态追踪
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Shift') {
        shiftRef.current = true
        setShiftHeld(true)
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && mode === 'merged') {
        e.preventDefault()
        doUndo()
      }
    }
    const onKeyUp = (e) => {
      if (e.key === 'Shift') {
        shiftRef.current = false
        setShiftHeld(false)
      }
    }
    const onBlur = () => {
      shiftRef.current = false
      setShiftHeld(false)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [mode])

  // 进入整合视图首次 → 弹使用说明
  useEffect(() => {
    if (mode === 'merged' && !helpShownRef.current) {
      helpShownRef.current = true
      setShowHelp(true)
    }
  }, [mode])

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
    viewRef.current = view
    if (dataRef.current.nodes.length) renderCurrent()
  }, [view])

  useEffect(() => { modeRef.current = mode }, [mode])

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
      refreshUndoCount()
    } catch (e) {
      console.error('loadMerged failed:', e)
      setNodeCount(0)
    } finally {
      setGraphLoading(false)
    }
  }

  const doMerge = async () => {
    if (!confirmDlg || confirmDlg.kind !== 'merge') return
    const { source, target } = confirmDlg
    setConfirmDlg(null)
    try {
      await manualMerge(source.id, target.id)
      showToast(`已合并：${source.name} → ${target.name}`, 'success')
      await loadMerged()
      window.dispatchEvent(new CustomEvent('align-finished'))
    } catch (e) {
      showToast('合并失败：' + (e?.response?.data?.detail || e.message), 'error')
    }
  }

  const doRemove = async () => {
    if (!confirmDlg || confirmDlg.kind !== 'remove') return
    const { target } = confirmDlg
    setConfirmDlg(null)
    try {
      await manualRemove(target.id)
      showToast(`已删除：${target.name}`, 'success')
      await loadMerged()
      window.dispatchEvent(new CustomEvent('align-finished'))
    } catch (e) {
      showToast('删除失败：' + (e?.response?.data?.detail || e.message), 'error')
    }
  }

  const doUndo = async () => {
    try {
      const { data } = await undoLast()
      showToast(`已撤销：${data.undone}`, 'success')
      await loadMerged()
      window.dispatchEvent(new CustomEvent('align-finished'))
    } catch (e) {
      const msg = e?.response?.data?.detail || e.message
      if (msg.includes('没有可撤销')) showToast('没有可撤销的操作', 'info')
      else showToast('撤销失败：' + msg, 'error')
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
        {mode === 'merged' && (
          <>
            {view === 'force' && (
              <span title={shiftHeld ? 'Shift 已按下，可拖拽合并' : '按住 Shift 进入合并模式'} style={{
                fontSize: 11, padding: '4px 8px',
                background: shiftHeld ? '#fbbf24' : '#1e293b',
                color: shiftHeld ? '#0f1117' : '#475569',
                border: '1px solid ' + (shiftHeld ? '#fbbf24' : '#334155'),
                borderRadius: 6, fontWeight: shiftHeld ? 700 : 400,
                transition: 'all 0.1s',
              }}>⇧ {shiftHeld ? '已按下' : '未按'}</span>
            )}
            <button onClick={doUndo} disabled={undoCount === 0} title="Ctrl+Z" style={{
              background: undoCount > 0 ? '#1e293b' : '#0f1117',
              border: '1px solid #334155', borderRadius: 6,
              color: undoCount > 0 ? '#fbbf24' : '#475569',
              padding: '5px 10px', fontSize: 12,
              cursor: undoCount > 0 ? 'pointer' : 'not-allowed',
            }}>↶ 撤销 {undoCount > 0 ? `(${undoCount})` : ''}</button>
            <button onClick={() => setShowHelp(true)} title="拖拽合并使用说明" style={{
              background: '#1e293b', border: '1px solid #334155', borderRadius: 6,
              color: '#94a3b8', padding: '5px 10px', fontSize: 12, cursor: 'pointer',
            }}>?</button>
          </>
        )}
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
            <span key={k} title={RELATION_TIPS[k] || ''} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'help' }}>
              <span style={{ width: 16, height: 2, background: c, display: 'inline-block' }} />
              {RELATION_LABELS[k] || k}
            </span>
          ))}
          <span style={{ color: '#475569', fontSize: 10, marginLeft: 'auto' }}>悬停看说明</span>
        </div>
      )}

      {/* 操作引导 / 使用说明 */}
      {showHelp && (
        <div onClick={() => setShowHelp(false)} style={modalBackdrop}>
          <div onClick={e => e.stopPropagation()} style={modalBox}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <span style={{ fontSize: 16, fontWeight: 700, color: '#f1f5f9' }}>🎯 整合视图操作指南</span>
              <button onClick={() => setShowHelp(false)} style={closeBtn}>✕</button>
            </div>
            <div style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.85 }}>
              在「整合视图 + 力导向图」下，你可以手动调整知识图谱的合并决策：
              <table style={{ width: '100%', marginTop: 10, fontSize: 13, borderCollapse: 'collapse' }}>
                <tbody>
                  <tr><td style={helpCell}>🖱️ <b>左键点击节点</b></td><td style={helpCell}>查看该知识点的定义、章节、来源</td></tr>
                  <tr><td style={helpCell}>🖱️ <b>左键拖拽节点</b></td><td style={helpCell}>调整节点位置（动态布局，不触发合并）</td></tr>
                  <tr><td style={helpCell}>🖱️ <b>左键拖拽空白处</b></td><td style={helpCell}>平移整个画布；滚轮缩放</td></tr>
                  <tr><td style={helpCell}>⇧ <b>Shift+拖拽 A → B</b></td><td style={helpCell}>合并 A 到 B。按下时 A 高亮且保持原位（其他节点不会被挤开），鼠标拉出一条黄色虚线指向光标，划过 B 时 B 也高亮，松手 → 屏幕中央弹"🔀 合并知识点"确认窗口</td></tr>
                  <tr><td style={helpCell}>🖱️ <b>右键点击节点</b></td><td style={helpCell}>删除该知识点（从整合结果中移除）</td></tr>
                  <tr><td style={helpCell}>↶ <b>撤销 / Ctrl+Z</b></td><td style={helpCell}>回滚最近一次手动操作（最多 20 步）</td></tr>
                </tbody>
              </table>
              <div style={{ marginTop: 14, padding: 10, background: '#0f172a', borderRadius: 6, fontSize: 12, color: '#94a3b8', borderLeft: '3px solid #6366f1' }}>
                💡 每次合并/删除前会弹确认对话框，操作后会自动持久化（重启不丢失）。
                所有手动决策会出现在右侧「整合操作」面板的决策列表里。
              </div>

              <div style={{ marginTop: 14, fontSize: 13, color: '#cbd5e1' }}>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>📚 四种知识点关系</div>
                <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                  <tbody>
                    <tr><td style={{ ...helpCell, color: '#ef4444', whiteSpace: 'nowrap' }}>前置依赖</td><td style={helpCell}>学 B 前必须先掌握 A。例：动作电位 ← 静息电位</td></tr>
                    <tr><td style={{ ...helpCell, color: '#6366f1', whiteSpace: 'nowrap' }}>并列关系</td><td style={helpCell}>同一层级的平行概念。例：有丝分裂 ⇔ 减数分裂</td></tr>
                    <tr><td style={{ ...helpCell, color: '#22c55e', whiteSpace: 'nowrap' }}>包含关系</td><td style={helpCell}>上位概念包含下位概念。例：免疫系统 ⊃ T 细胞</td></tr>
                    <tr><td style={{ ...helpCell, color: '#f59e0b', whiteSpace: 'nowrap' }}>应用关系</td><td style={helpCell}>知识点是另一个的应用场景。例：抗体 → 体液免疫</td></tr>
                  </tbody>
                </table>
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
              <button onClick={() => setShowHelp(false)} style={primaryBtn}>知道了</button>
            </div>
          </div>
        </div>
      )}

      {/* 确认对话框：合并 / 删除 */}
      {confirmDlg && (
        <div onClick={() => setConfirmDlg(null)} style={modalBackdrop}>
          <div onClick={e => e.stopPropagation()} style={{ ...modalBox, maxWidth: 440 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#f1f5f9', marginBottom: 10 }}>
              {confirmDlg.kind === 'merge' ? '🔀 合并知识点' : '🗑️ 删除知识点'}
            </div>
            <div style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.7 }}>
              {confirmDlg.kind === 'merge' ? (
                <>
                  将把 <b style={{ color: '#fbbf24' }}>「{confirmDlg.source.name}」</b> 合并到
                  {' '}<b style={{ color: '#22d3ee' }}>「{confirmDlg.target.name}」</b>。
                  <div style={{ marginTop: 10, padding: 10, background: '#0f172a', borderRadius: 6, fontSize: 12, color: '#94a3b8' }}>
                    • 保留<b>定义较长</b>的版本作为代表<br/>
                    • 两个节点的相关边会自动重连到合并后的节点<br/>
                    • 频次（frequency）累加<br/>
                    • 该决策会附加到「整合操作」面板的决策列表
                  </div>
                </>
              ) : (
                <>
                  将从整合结果中删除 <b style={{ color: '#f43f5e' }}>「{confirmDlg.target.name}」</b>。
                  <div style={{ marginTop: 10, padding: 10, background: '#0f172a', borderRadius: 6, fontSize: 12, color: '#94a3b8' }}>
                    • 该节点及其所有相关边一并移除<br/>
                    • 不会从教材原文中删除，仅从整合后图谱中移除<br/>
                    • 该决策会附加到「整合操作」面板的决策列表
                  </div>
                </>
              )}
              <div style={{ marginTop: 8, fontSize: 11, color: '#64748b' }}>
                可以通过 ↶ 撤销 或 Ctrl+Z 回滚。
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button onClick={() => setConfirmDlg(null)} style={secondaryBtn}>取消</button>
              <button onClick={confirmDlg.kind === 'merge' ? doMerge : doRemove}
                style={confirmDlg.kind === 'merge' ? primaryBtn : dangerBtn}>
                {confirmDlg.kind === 'merge' ? '确认合并' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', top: 24, right: 24, zIndex: 200,
          background: toast.kind === 'error' ? '#7f1d1d' : toast.kind === 'success' ? '#065f46' : '#1e293b',
          color: '#fff', border: '1px solid ' + (toast.kind === 'error' ? '#ef4444' : toast.kind === 'success' ? '#10b981' : '#334155'),
          borderRadius: 8, padding: '10px 16px', fontSize: 13, boxShadow: '0 8px 24px #0008',
        }}>{toast.msg}</div>
      )}
    </div>
  )
}

// ============ Modal / button styles ============

const modalBackdrop = {
  position: 'fixed', inset: 0, background: '#0f1117cc', backdropFilter: 'blur(4px)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
}
const modalBox = {
  background: '#1e293b', border: '1px solid #334155', borderRadius: 12,
  padding: 20, maxWidth: 520, width: '90%', boxShadow: '0 12px 48px #000a',
}
const closeBtn = {
  background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 16,
}
const helpCell = { padding: '6px 8px', borderTop: '1px solid #334155', verticalAlign: 'top' }
const primaryBtn = {
  background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 6,
  padding: '7px 16px', fontSize: 13, cursor: 'pointer', fontWeight: 600,
}
const secondaryBtn = {
  background: '#1e293b', color: '#94a3b8', border: '1px solid #334155',
  borderRadius: 6, padding: '7px 16px', fontSize: 13, cursor: 'pointer',
}
const dangerBtn = {
  background: '#dc2626', color: '#fff', border: 'none', borderRadius: 6,
  padding: '7px 16px', fontSize: 13, cursor: 'pointer', fontWeight: 600,
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
        : (RELATION_LABELS[p.data.relation_type] || p.data.relation_type || ''),
    },
    series: [{
      type: 'graph',
      layout: 'force',
      roam: true,
      // 允许节点自由拖动调整布局。合并通过 Shift+拖拽触发（zr 命中测试，
      // 不依赖 ECharts 高层 mouseup，所以不被原生拖拽干扰）。
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
