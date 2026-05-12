import React, { useCallback, useEffect, useRef, useState } from 'react'
import { deleteTextbook, listTextbooks, uploadTextbook } from '../api'

const STATUS_COLOR = {
  done: '#22c55e',
  extracting: '#f59e0b',
  parsing: '#3b82f6',
  queued: '#6b7280',
  error: '#ef4444',
}

export default function TextbookPanel({ onGraphSelect, onRefreshNeeded }) {
  const [textbooks, setTextbooks] = useState([])
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(false)
  const inputRef = useRef()
  const pollRef = useRef()

  const refresh = useCallback(async () => {
    const { data } = await listTextbooks()
    setTextbooks(data)
  }, [])

  useEffect(() => {
    refresh()
    pollRef.current = setInterval(refresh, 3000)
    return () => clearInterval(pollRef.current)
  }, [refresh])

  const handleFiles = async (files) => {
    setUploading(true)
    for (const file of files) {
      try {
        await uploadTextbook(file)
      } catch (e) {
        alert(`上传失败: ${file.name}`)
      }
    }
    setUploading(false)
    refresh()
  }

  const onDrop = (e) => {
    e.preventDefault()
    setDragging(false)
    handleFiles([...e.dataTransfer.files])
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 12 }}>
      <div style={{ fontWeight: 700, fontSize: 15, color: '#94a3b8', letterSpacing: 1 }}>
        教材管理
      </div>

      {/* 上传区域 */}
      <div
        onClick={() => inputRef.current.click()}
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        style={{
          border: `2px dashed ${dragging ? '#6366f1' : '#334155'}`,
          borderRadius: 10,
          padding: '20px 12px',
          textAlign: 'center',
          cursor: 'pointer',
          background: dragging ? '#1e1b4b22' : '#1e293b',
          transition: 'all 0.2s',
          color: '#64748b',
          fontSize: 13,
        }}
      >
        {uploading ? '上传中...' : '点击或拖拽上传教材\nPDF / MD / TXT'}
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".pdf,.md,.txt,.markdown,.docx"
          style={{ display: 'none' }}
          onChange={e => handleFiles([...e.target.files])}
        />
      </div>

      {/* 教材列表 */}
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {textbooks.map(tb => (
          <div
            key={tb.textbook_id}
            style={{
              background: '#1e293b',
              borderRadius: 8,
              padding: '10px 12px',
              cursor: tb.status === 'done' ? 'pointer' : 'default',
              border: '1px solid #334155',
            }}
            onClick={() => tb.status === 'done' && onGraphSelect(tb.textbook_id)}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
              <span style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {tb.title || tb.filename || tb.textbook_id}
              </span>
              <button
                onClick={e => { e.stopPropagation(); deleteTextbook(tb.textbook_id).then(refresh) }}
                style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 14 }}
              >✕</button>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 4, alignItems: 'center' }}>
              <span style={{
                width: 8, height: 8, borderRadius: '50%',
                background: STATUS_COLOR[tb.status] || '#6b7280',
                display: 'inline-block',
                flexShrink: 0,
              }} />
              <span style={{ fontSize: 11, color: '#64748b' }}>{tb.status}</span>
              {tb.total_chars && (
                <span style={{ fontSize: 11, color: '#64748b', marginLeft: 'auto' }}>
                  {(tb.total_chars / 10000).toFixed(1)}万字
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
