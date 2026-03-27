const BASE = '/erp/api'

function getToken() {
  return localStorage.getItem('erp_token')
}

async function request(method, path, body) {
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
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`)
  }
  return data
}

const get = (path) => request('GET', path)
const post = (path, body) => request('POST', path, body)
const put = (path, body) => request('PUT', path, body)
const patch = (path, body) => request('PATCH', path, body)
const del = (path) => request('DELETE', path)

export const api = {
  // Auth
  auth: {
    login: (email, password) => post('/auth/login', { email, password }),
    setup: (data) => post('/auth/setup', data),
    me: () => get('/auth/me'),
    users: () => get('/auth/users'),
    changePassword: (current_password, new_password) => post('/auth/change-password', { current_password, new_password }),
  },

  // Companies
  companies: {
    list: (params = {}) => get('/companies?' + new URLSearchParams(params)),
    get: (id) => get(`/companies/${id}`),
    create: (data) => post('/companies', data),
    update: (id, data) => put(`/companies/${id}`, data),
    delete: (id) => del(`/companies/${id}`),
  },

  // Contacts
  contacts: {
    list: (params = {}) => get('/contacts?' + new URLSearchParams(params)),
    get: (id) => get(`/contacts/${id}`),
    create: (data) => post('/contacts', data),
    update: (id, data) => put(`/contacts/${id}`, data),
    delete: (id) => del(`/contacts/${id}`),
  },

  // Projects
  projects: {
    list: (params = {}) => get('/projects?' + new URLSearchParams(params)),
    get: (id) => get(`/projects/${id}`),
    create: (data) => post('/projects', data),
    update: (id, data) => put(`/projects/${id}`, data),
    updateStatus: (id, status, refusal_reason) => patch(`/projects/${id}/status`, { status, refusal_reason }),
    delete: (id) => del(`/projects/${id}`),
  },

  // Products
  products: {
    list: (params = {}) => get('/products?' + new URLSearchParams(params)),
    get: (id) => get(`/products/${id}`),
    create: (data) => post('/products', data),
    update: (id, data) => put(`/products/${id}`, data),
    adjustStock: (id, data) => post(`/products/${id}/stock`, data),
    delete: (id) => del(`/products/${id}`),
  },

  // Orders
  orders: {
    list: (params = {}) => get('/orders?' + new URLSearchParams(params)),
    get: (id) => get(`/orders/${id}`),
    create: (data) => post('/orders', data),
    update: (id, data) => put(`/orders/${id}`, data),
    updateStatus: (id, status) => patch(`/orders/${id}/status`, { status }),
    addShipment: (id, data) => post(`/orders/${id}/shipments`, data),
    addItem: (id, data) => post(`/orders/${id}/items`, data),
    deleteItem: (orderId, itemId) => del(`/orders/${orderId}/items/${itemId}`),
    delete: (id) => del(`/orders/${id}`),
  },

  // Tickets
  tickets: {
    list: (params = {}) => get('/tickets?' + new URLSearchParams(params)),
    get: (id) => get(`/tickets/${id}`),
    create: (data) => post('/tickets', data),
    update: (id, data) => put(`/tickets/${id}`, data),
    updateStatus: (id, status) => patch(`/tickets/${id}/status`, { status }),
    delete: (id) => del(`/tickets/${id}`),
  },

  // Dashboard
  dashboard: {
    get: () => get('/dashboard'),
  },

  // Admin
  admin: {
    listUsers: () => get('/admin/users'),
    createUser: (data) => post('/admin/users', data),
    updateUser: (id, data) => put(`/admin/users/${id}`, data),
    resetPassword: (id, new_password) => post(`/admin/users/${id}/reset-password`, { password: new_password }),
    deleteUser: (id) => del(`/admin/users/${id}`),
    health: () => get('/admin/health'),
    migrateLegacy: () => post('/admin/migrate-legacy', {}),
  },

  // Field Definitions
  fieldDefs: {
    list: (entity_type) => get(`/admin/field-defs${entity_type ? '?entity_type=' + entity_type : ''}`),
    create: (data) => post('/admin/field-defs', data),
    update: (id, data) => patch(`/admin/field-defs/${id}`, data),
    delete: (id) => del(`/admin/field-defs/${id}`),
  },

  // Interactions
  interactions: {
    list: (params = {}) => get('/interactions?' + new URLSearchParams(params)),
    create: (data) => post('/interactions', data),
    emailBody: (id) => get(`/interactions/${id}/email-body`),
    delete: (id) => del(`/interactions/${id}`),
  },

  // Calls
  calls: {
    transcript: (id) => get(`/calls/${id}/transcript`),
    retranscribe: (id) => post(`/calls/${id}/retranscribe`),
    rematch: () => post('/calls/rematch'),
  },

  // Connectors
  connectors: {
    list: () => get('/connectors'),
    disconnect: (id) => del(`/connectors/accounts/${id}`),
    saveConfig: (connector, data) => put(`/connectors/config/${connector}`, data),
    syncGmail: () => post('/connectors/sync/gmail'),
    syncDrive: () => post('/connectors/sync/drive'),
    fixFtpTimestamps: () => post('/connectors/fix-ftp-timestamps'),
    deduplicateFtpCalls: () => post('/connectors/deduplicate-ftp-calls'),
    syncStatus: () => get('/connectors/sync/status'),
    ftpInfo: () => get('/connectors/ftp'),
    ftpAddPhone: (data) => post('/connectors/ftp/phones', data),
    ftpDeletePhone: (ftpUser) => del(`/connectors/ftp/phones/${ftpUser}`),
    ftpUpdatePassword: (ftpUser, ftpPass) => put(`/connectors/ftp/phones/${ftpUser}`, { ftpPass }),
    whisperInfo: () => get('/connectors/whisper'),
    whisperSaveKey: (api_key) => put('/connectors/whisper', { api_key }),
    whisperRetry: () => post('/connectors/whisper/retry'),
    whisperDriveStatus: () => get('/connectors/whisper/drive-status'),
    whisperDownloadDrive: () => post('/connectors/whisper/download-drive'),
    whisperDownloadProgress: () => get('/connectors/whisper/download-drive/status'),
  },

  // Airtable
  airtable: {
    bases: () => get('/connectors/airtable/bases'),
    tables: (baseId) => get(`/connectors/airtable/bases/${baseId}/tables`),
    saveConfig: (type, data) => put(`/connectors/airtable/${type}-config`, data),
    saveModuleConfig: (module, data) => put(`/connectors/airtable/module-config/${module}`, data),
    sync: (module) => post(`/connectors/sync/${module}`),
    syncAll: () => post('/connectors/sync/airtable-all'),
  },

  // Views (config + pills)
  views: {
    get: (table) => get(`/views/${table}`),
    updateConfig: (table, data) => put(`/views/${table}`, data),
    createPill: (table, data) => post(`/views/${table}/pills`, data),
    updatePill: (table, id, data) => put(`/views/${table}/pills/${id}`, data),
    deletePill: (table, id) => del(`/views/${table}/pills/${id}`),
    reorderPills: (table, order) => patch(`/views/${table}/pills/reorder`, order),
  },

  // Purchases
  purchases: {
    list: (params = {}) => get('/purchases?' + new URLSearchParams(params)),
    get: (id) => get(`/purchases/${id}`),
  },

  // Serials
  serials: {
    list: (params = {}) => get('/serials?' + new URLSearchParams(params)),
    get: (id) => get(`/serials/${id}`),
  },

  // Soumissions
  soumissions: {
    list: (params = {}) => get('/inventaire/soumissions?' + new URLSearchParams(params)),
    get: (id) => get(`/inventaire/soumissions/${id}`),
  },

  // Adresses
  adresses: {
    list: (params = {}) => get('/inventaire/adresses?' + new URLSearchParams(params)),
    get: (id) => get(`/inventaire/adresses/${id}`),
  },

  // BOM
  bom: {
    list: (params = {}) => get('/inventaire/bom?' + new URLSearchParams(params)),
    get: (id) => get(`/inventaire/bom/${id}`),
  },

  // Serial state changes
  serialChanges: {
    list: (params = {}) => get('/inventaire/serial-changes?' + new URLSearchParams(params)),
  },

  // Assemblages
  assemblages: {
    list: (params = {}) => get('/inventaire/assemblages?' + new URLSearchParams(params)),
    get: (id) => get(`/inventaire/assemblages/${id}`),
  },

  // Factures
  factures: {
    list: (params = {}) => get('/inventaire/factures?' + new URLSearchParams(params)),
    get: (id) => get(`/inventaire/factures/${id}`),
  },

  // Retours
  retours: {
    list: (params = {}) => get('/inventaire/retours?' + new URLSearchParams(params)),
    get: (id) => get(`/inventaire/retours/${id}`),
  },

  // Abonnements
  abonnements: {
    list: (params = {}) => get('/inventaire/abonnements?' + new URLSearchParams(params)),
    get: (id) => get(`/inventaire/abonnements/${id}`),
  },

  // Catalog products
  catalog: {
    list: () => get('/catalog'),
    create: (data) => post('/catalog', data),
    update: (id, data) => put(`/catalog/${id}`, data),
    delete: (id) => del(`/catalog/${id}`),
  },

  // Shipments (Envois)
  shipments: {
    list: (params = {}) => get('/shipments?' + new URLSearchParams(params)),
    get: (id) => get(`/shipments/${id}`),
    create: (data) => post('/shipments', data),
    update: (id, data) => patch(`/shipments/${id}`, data),
    delete: (id) => del(`/shipments/${id}`),
  },

  // Global search
  search: {
    query: (q) => get(`/search?q=${encodeURIComponent(q)}`),
  },

  // Notifications
  notifications: {
    list: (params = {}) => get('/notifications?' + new URLSearchParams(params)),
    markRead: (id) => patch(`/notifications/${id}/read`),
    markAllRead: () => post('/notifications/read-all'),
  },

  // Webhooks
  webhooks: {
    list: () => get('/webhooks'),
    create: (data) => post('/webhooks', data),
    update: (id, data) => patch(`/webhooks/${id}`, data),
    delete: (id) => del(`/webhooks/${id}`),
  },

  // Automations
  automations: {
    list: () => get('/automations'),
    get: (id) => get(`/automations/${id}`),
    create: (data) => post('/automations', data),
    update: (id, data) => patch(`/automations/${id}`, data),
    delete: (id) => del(`/automations/${id}`),
    logs: (id) => get(`/automations/${id}/logs`),
    run: (id) => post(`/automations/${id}/run`),
  },

  interfaces: {
    list: () => get('/interfaces'),
    get: (id) => get(`/interfaces/${id}`),
    create: (data) => post('/interfaces', data),
    update: (id, data) => patch(`/interfaces/${id}`, data),
    delete: (id) => del(`/interfaces/${id}`),
    restore: (id) => post(`/interfaces/${id}/restore`),
    pages: (id) => get(`/interfaces/${id}/pages`),
    createPage: (id, data) => post(`/interfaces/${id}/pages`, data),
    reorderPages: (id, data) => patch(`/interfaces/${id}/pages/reorder`, data),
    updatePage: (pageId, data) => patch(`/interfaces/pages/${pageId}`, data),
    deletePage: (pageId) => del(`/interfaces/pages/${pageId}`),
    blocks: (pageId) => get(`/interfaces/pages/${pageId}/blocks`),
    createBlock: (pageId, data) => post(`/interfaces/pages/${pageId}/blocks`, data),
    updateBlock: (blockId, data) => patch(`/interfaces/blocks/${blockId}`, data),
    deleteBlock: (blockId) => del(`/interfaces/blocks/${blockId}`),
    saveLayout: (pageId, layout) => patch(`/interfaces/pages/${pageId}/blocks/layout`, layout),
    blockData: (blockId, filterValues) => get(`/interfaces/blocks/${blockId}/data${filterValues && Object.keys(filterValues).length ? '?filter_values=' + encodeURIComponent(JSON.stringify(filterValues)) : ''}`),
  },

  // Documents (soumissions créées localement)
  documents: {
    soumissions: {
      list: (params = {}) => get('/documents/soumissions?' + new URLSearchParams(params)),
      get: (id) => get(`/documents/soumissions/${id}`),
      create: (data) => post('/documents/soumissions', data),
      update: (id, data) => put(`/documents/soumissions/${id}`, data),
      delete: (id) => del(`/documents/soumissions/${id}`),
      duplicate: (id) => post(`/documents/soumissions/${id}/duplicate`),
      pdfUrl: (id) => `${BASE}/documents/soumissions/${id}/pdf`,
    },
  },

  agent: {
    listTasks:  ()         => get('/agent/tasks'),
    createTask: (data)     => post('/agent/tasks', data),
    updateTask: (id, data) => patch(`/agent/tasks/${id}`, data),
    deleteTask: (id)       => del(`/agent/tasks/${id}`),
  },
}

export function uploadRecording(formData) {
  const token = localStorage.getItem('erp_token')
  return fetch('/erp/api/calls/upload', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: formData,
  }).then(async r => {
    const d = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
    return d
  })
}

export default api
