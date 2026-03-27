import { useState, useCallback } from 'react'

const BASE = '/erp/api'

function getToken() {
  return localStorage.getItem('erp_token')
}

async function req(method, path, body) {
  const token = getToken()
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

  if (res.status === 401) {
    localStorage.removeItem('erp_token')
    window.location.href = '/erp/login'
    return
  }

  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

async function upload(path, formData) {
  const token = getToken()
  const headers = {}
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: formData })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

// Base API calls
export const baseAPI = {
  // Tables
  tables: () => req('GET', '/base/tables'),
  createTable: (data) => req('POST', '/base/tables', data),
  updateTable: (id, data) => req('PATCH', `/base/tables/${id}`, data),
  deleteTable: (id) => req('DELETE', `/base/tables/${id}`),
  restoreTable: (id) => req('POST', `/base/tables/${id}/restore`),

  // Fields
  fields: (tableId) => req('GET', `/base/tables/${tableId}/fields`),
  createField: (tableId, data) => req('POST', `/base/tables/${tableId}/fields`, data),
  updateField: (tableId, fieldId, data) => req('PATCH', `/base/fields/${fieldId}`, data),
  deleteField: (tableId, fieldId) => req('DELETE', `/base/fields/${fieldId}`),
  restoreField: (fieldId) => req('POST', `/base/fields/${fieldId}/restore`),
  reorderFields: (tableId, order) => req('PATCH', `/base/tables/${tableId}/fields/reorder`, order),

  // Records
  records: (tableId, params = {}) => req('GET', `/base/tables/${tableId}/records?` + new URLSearchParams(params)),
  getRecord: (recordId) => req('GET', `/base/records/${recordId}`),
  createRecord: (tableId, data) => req('POST', `/base/tables/${tableId}/records`, data),
  updateRecord: (tableId, recordId, data) => req('PATCH', `/base/records/${recordId}`, data),
  deleteRecord: (tableId, recordId) => req('DELETE', `/base/records/${recordId}`),
  duplicateRecord: (tableId, recordId) => req('POST', `/base/records/${recordId}/duplicate`),
  recordHistory: (tableId, recordId) => req('GET', `/base/records/${recordId}/history`),
  bulkCreate: (tableId, records) => req('POST', `/base/tables/${tableId}/records/bulk`, { records }),
  bulkUpdate: (tableId, recordIds, data) => req('PATCH', `/base/tables/${tableId}/records/bulk`, { record_ids: recordIds, data }),
  bulkDelete: (tableId, ids) => req('DELETE', `/base/tables/${tableId}/records/bulk`, { record_ids: ids }),

  // Views
  views: (tableId) => req('GET', `/base/tables/${tableId}/views`),
  createView: (tableId, data) => req('POST', `/base/tables/${tableId}/views`, data),
  updateView: (tableId, viewId, data) => req('PATCH', `/base/views/${viewId}`, data),
  deleteView: (tableId, viewId) => req('DELETE', `/base/views/${viewId}`),
  duplicateView: (tableId, viewId) => req('POST', `/base/views/${viewId}/duplicate`),
  restoreView: (viewId) => req('POST', `/base/views/${viewId}/restore`),

  // Import / Export
  importRecords: (tableId, formData) => upload(`/base/tables/${tableId}/import`, formData),
  exportUrl: (tableId, format, params = {}) => {
    const q = new URLSearchParams({ format, ...params })
    return `${BASE}/base/tables/${tableId}/export?${q}&token=${getToken()}`
  },

  // Trash
  trash: (params = {}) => req('GET', `/base/trash?` + new URLSearchParams(params)),
  purgeTrash: () => req('DELETE', '/base/trash'),

  // Search within base
  search: (q, tableId) => req('GET', `/base/search?q=${encodeURIComponent(q)}${tableId ? `&table_id=${tableId}` : ''}`),
}

// Hook for loading state wrapper
export function useBaseAPI() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const call = useCallback(async (fn) => {
    setLoading(true)
    setError(null)
    try {
      const result = await fn()
      return result
    } catch (e) {
      setError(e.message)
      throw e
    } finally {
      setLoading(false)
    }
  }, [])

  return { loading, error, call, clearError: () => setError(null) }
}
