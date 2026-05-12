import axios from 'axios'

const BASE = '/api'

export const uploadTextbook = (file, onProgress) => {
  const form = new FormData()
  form.append('file', file)
  return axios.post(`${BASE}/textbooks/upload`, form, {
    onUploadProgress: e => onProgress?.(Math.round(e.loaded / e.total * 100)),
  })
}

export const listTextbooks = () => axios.get(`${BASE}/textbooks/`)
export const getTextbookStatus = id => axios.get(`${BASE}/textbooks/${id}/status`)
export const getTextbookGraph = id => axios.get(`${BASE}/textbooks/${id}/graph`)
export const deleteTextbook = id => axios.delete(`${BASE}/textbooks/${id}`)

export const startAlign = () => axios.post(`${BASE}/graph/align/start`)
export const getAlignStatus = () => axios.get(`${BASE}/graph/align/status`)
export const getMergedGraph = () => axios.get(`${BASE}/graph/merged`)
export const getDecisions = () => axios.get(`${BASE}/graph/decisions`)
export const getStats = () => axios.get(`${BASE}/graph/stats`)
export const overrideDecision = (id, body) => axios.patch(`${BASE}/graph/decisions/${id}`, body)
export const manualMerge = (sourceId, targetId) =>
  axios.post(`${BASE}/graph/manual-merge`, { source_id: sourceId, target_id: targetId })
export const manualRemove = nodeId =>
  axios.post(`${BASE}/graph/manual-remove`, { node_id: nodeId })
export const undoLast = () => axios.post(`${BASE}/graph/undo`)
export const undoHistory = () => axios.get(`${BASE}/graph/undo-history`)

export const ragQuery = (question, textbookIds) =>
  axios.post(`${BASE}/rag/query`, { question, textbook_ids: textbookIds })
export const ragStatus = () => axios.get(`${BASE}/rag/status`)

export const chat = (message, sessionId = 'default') =>
  axios.post(`${BASE}/chat/`, { message, session_id: sessionId })
export const getChatHistory = sessionId => axios.get(`${BASE}/chat/history/${sessionId}`)

export const getTokenStats = () => axios.get(`${BASE}/stats/`)
export const resetTokenStats = () => axios.post(`${BASE}/stats/reset`)
