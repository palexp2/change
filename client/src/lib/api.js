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
    updateItem: (orderId, itemId, data) => patch(`/orders/${orderId}/items/${itemId}`, data),
    duplicateItem: (orderId, itemId) => post(`/orders/${orderId}/items/${itemId}/duplicate`, {}),
    reorderItems: (orderId, order) => patch(`/orders/${orderId}/items/reorder`, order),
    deleteItem: (orderId, itemId) => del(`/orders/${orderId}/items/${itemId}`),
    scan: (orderId, value, mode = 'add') => post(`/orders/${orderId}/scan`, { value, mode }),
    delete: (id) => del(`/orders/${id}`),
    generateBonLivraison: (id) => post(`/orders/${id}/bon-livraison`, {}),
  },

  // Tasks
  tasks: {
    list: (params = {}) => get('/tasks?' + new URLSearchParams(params)),
    get: (id) => get(`/tasks/${id}`),
    create: (data) => post('/tasks', data),
    update: (id, data) => put(`/tasks/${id}`, data),
    updateStatus: (id, status) => patch(`/tasks/${id}/status`, { status }),
    delete: (id) => del(`/tasks/${id}`),
  },

  // Tickets
  tickets: {
    meta: () => get('/tickets/meta'),
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
    trash: () => get('/admin/trash'),
    restoreTrash: (table, id) => post(`/admin/trash/${table}/${id}/restore`, {}),
    purgeTrash: () => del('/admin/trash'),
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
    importQB: () => post('/connectors/sync/qb-import'),
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

  // Stripe
  stripe: {
    info: () => get('/connectors/stripe'),
    saveKey: (secret_key) => put('/connectors/stripe', { secret_key }),
    deleteKey: () => del('/connectors/stripe'),
    sync: () => post('/connectors/sync/stripe'),
  },

  // Novoxpress shipping labels
  novoxpress: {
    status: () => get('/novoxpress/status'),
    saveConfig: (data) => put('/novoxpress/config', data),
    deleteConfig: () => del('/novoxpress/config'),
    getRates: (shipmentId, data) => post(`/novoxpress/rates/${shipmentId}`, data),
    createLabel: (shipmentId, data) => post(`/novoxpress/label/${shipmentId}`, data),
    schedulePickup: (shipmentId, data) => post(`/novoxpress/pickup/${shipmentId}`, data),
    cancelPickup: (shipmentId) => del(`/novoxpress/pickup/${shipmentId}`),
  },

  // QuickBooks
  quickbooks: {
    accounts: () => get('/connectors/quickbooks/accounts'),
    vendors: () => get('/connectors/quickbooks/vendors'),
    syncDepenses: () => post('/connectors/sync/qb-depenses'),
    syncFactures: () => post('/connectors/sync/qb-factures'),
  },

  // Airtable
  airtable: {
    bases: () => get('/connectors/airtable/bases'),
    tables: (baseId) => get(`/connectors/airtable/bases/${baseId}/tables`),
    fieldDefs: (erpTable) => get(`/connectors/airtable/field-defs/${erpTable}`),
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
    reorderPills: (table, order, all_view_sort_order) => patch(`/views/${table}/pills/reorder`, { order, all_view_sort_order }),
    saveColumnWidths: (table, column_widths) => patch(`/views/${table}/column-widths`, { column_widths }),
    getDetailLayout: (entityType) => get(`/views/detail/${entityType}`),
    saveDetailLayout: (entityType, field_order) => put(`/views/detail/${entityType}`, { field_order }),
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
    list: (params = {}) => get('/projets/soumissions?' + new URLSearchParams(params)),
    get: (id) => get(`/projets/soumissions/${id}`),
  },

  // Adresses
  adresses: {
    list: (params = {}) => get('/projets/adresses?' + new URLSearchParams(params)),
    get: (id) => get(`/projets/adresses/${id}`),
    create: (data) => post('/projets/adresses', data),
    update: (id, data) => put(`/projets/adresses/${id}`, data),
    delete: (id) => del(`/projets/adresses/${id}`),
  },

  // BOM
  bom: {
    list: (params = {}) => get('/projets/bom?' + new URLSearchParams(params)),
    get: (id) => get(`/projets/bom/${id}`),
  },

  // Serial state changes
  serialChanges: {
    list: (params = {}) => get('/projets/serial-changes?' + new URLSearchParams(params)),
  },

  // Assemblages
  assemblages: {
    list: (params = {}) => get('/projets/assemblages?' + new URLSearchParams(params)),
    get: (id) => get(`/projets/assemblages/${id}`),
  },

  // Factures
  factures: {
    list: (params = {}) => get('/projets/factures?' + new URLSearchParams(params)),
    get: (id) => get(`/projets/factures/${id}`),
    update: (id, data) => patch(`/projets/factures/${id}`, data),
  },

  // Retours
  retours: {
    list: (params = {}) => get('/projets/retours?' + new URLSearchParams(params)),
    get: (id) => get(`/projets/retours/${id}`),
  },

  // Abonnements
  abonnements: {
    list: (params = {}) => get('/projets/abonnements?' + new URLSearchParams(params)),
    get: (id) => get(`/projets/abonnements/${id}`),
    stripeDetails: (id) => get(`/projets/abonnements/${id}/stripe-details`),
    patch: (id, body) => patch(`/projets/abonnements/${id}`, body),
  },

  // Catalog products
  catalog: {
    list: () => get('/catalog'),
    create: (data) => post('/catalog', data),
    update: (id, data) => put(`/catalog/${id}`, data),
    delete: (id) => del(`/catalog/${id}`),
  },

  employees: {
    list: (params = {}) => get('/employees?' + new URLSearchParams(params)),
    get: (id) => get(`/employees/${id}`),
    create: (data) => post('/employees', data),
    update: (id, data) => patch(`/employees/${id}`, data),
    delete: (id) => del(`/employees/${id}`),
  },

  // Returns (RMA)
  returns: {
    listByCompany: (companyId) => get(`/companies/${companyId}/returns`),
  },

  // Shipments (Envois)
  shipments: {
    list: (params = {}) => get('/shipments?' + new URLSearchParams(params)),
    get: (id) => get(`/shipments/${id}`),
    create: (data) => post('/shipments', data),
    update: (id, data) => patch(`/shipments/${id}`, data),
    delete: (id) => del(`/shipments/${id}`),
    weeklyStats: () => get('/shipments/stats/weekly'),
    sendTracking: (id, to) => post(`/shipments/${id}/send-tracking`, { to }),
    generateBonLivraison: (id) => post(`/shipments/${id}/bon-livraison`, {}),
  },

  // Dépenses
  depenses: {
    list: (params = {}) => get('/depenses?' + new URLSearchParams(params)),
    get: (id) => get(`/depenses/${id}`),
    create: (data) => post('/depenses', data),
    update: (id, data) => put(`/depenses/${id}`, data),
    updateStatus: (id, status) => patch(`/depenses/${id}/status`, { status }),
    delete: (id) => del(`/depenses/${id}`),
  },

  // Factures fournisseurs
  facturesFournisseurs: {
    list: (params = {}) => get('/factures-fournisseurs?' + new URLSearchParams(params)),
    get: (id) => get(`/factures-fournisseurs/${id}`),
    create: (data) => post('/factures-fournisseurs', data),
    update: (id, data) => put(`/factures-fournisseurs/${id}`, data),
    updateStatus: (id, status) => patch(`/factures-fournisseurs/${id}/status`, { status }),
    delete: (id) => del(`/factures-fournisseurs/${id}`),
  },

  // Global search
  search: {
    query: (q) => get(`/search?q=${encodeURIComponent(q)}`),
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
    listTasks:    ()         => get('/agent/tasks'),
    createTask:   (data)     => post('/agent/tasks', data),
    updateTask:   (id, data) => patch(`/agent/tasks/${id}`, data),
    deleteTask:   (id)       => del(`/agent/tasks/${id}`),
    status:       ()         => get('/agent/status'),
    getMemory:    ()         => get('/agent/memory'),
    saveMemory:   (content)  => put('/agent/memory', { content }),
  },

  // Sale receipts (OCR/AI extraction)
  saleReceipts: {
    list: (params = {}) => get('/sale-receipts?' + new URLSearchParams(params)),
    get: (id) => get(`/sale-receipts/${id}`),
    delete: (id) => del(`/sale-receipts/${id}`),
    pushToQb: (id, params) => post(`/sale-receipts/${id}/push-to-qb`, params),
    upload: (formData) => {
      const token = getToken()
      return fetch('/erp/api/sale-receipts/upload', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      }).then(async r => {
        const d = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
        return d
      })
    },
  },

  syncLog: {
    list: (params = {}) => get('/connectors/sync-log?' + new URLSearchParams(params)),
  },

  stripeQueue: {
    list: (params = {}) => get('/stripe-queue?' + new URLSearchParams(params)),
    get: (id) => get(`/stripe-queue/${id}`),
    update: (id, data) => patch(`/stripe-queue/${id}`, data),
    approve: (id, data = {}) => post(`/stripe-queue/${id}/approve`, data),
    reject: (id) => post(`/stripe-queue/${id}/reject`),
    reset: (id) => post(`/stripe-queue/${id}/reset`),
    taxMappings: () => get('/stripe-queue/tax-mappings/list'),
    saveTaxMapping: (data) => post('/stripe-queue/tax-mappings', data),
    deleteTaxMapping: (id) => del(`/stripe-queue/tax-mappings/${id}`),
    uniqueTaxRates: () => get('/stripe-queue/tax-rates/unique'),
    batchEnrich: () => post('/stripe-queue/batch-enrich'),
    batchStatus: () => get('/stripe-queue/batch-enrich/status'),
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
