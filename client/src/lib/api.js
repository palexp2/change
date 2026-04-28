import { cacheGet, cacheSet, invalidate } from './prefetch.js'
import { invalidateStale } from './swr.js'

const BASE = '/erp/api'

function getToken() {
  return localStorage.getItem('erp_token')
}

function rawRequest(method, path, body) {
  const token = getToken()
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`

  return fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).then(async (res) => {
    if (res.status === 401) {
      localStorage.removeItem('erp_token')
      window.location.href = '/erp/login'
      return
    }
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    return data
  })
}

// GETs consult the prefetch cache (populated by nav hover). Mutations
// invalidate the resource-path prefix so subsequent GETs see fresh data.
function request(method, path, body) {
  if (method === 'GET') {
    const hit = cacheGet(path)
    if (hit) return hit
    const promise = rawRequest('GET', path)
    cacheSet(path, promise)
    return promise
  }
  const resource = path.split('?')[0].split('/').filter(Boolean)[0]
  if (resource) {
    invalidate('/' + resource)
    invalidateStale(resource)
  }
  return rawRequest(method, path, body)
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
    lookup: () => get('/companies/lookup'),
    get: (id) => get(`/companies/${id}`),
    create: (data) => post('/companies', data),
    update: (id, data) => put(`/companies/${id}`, data),
    delete: (id) => del(`/companies/${id}`),
  },

  // Contacts
  contacts: {
    list: (params = {}) => get('/contacts?' + new URLSearchParams(params)),
    lookup: () => get('/contacts/lookup'),
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
    poPrefill: (id) => get(`/products/${id}/purchase-order/prefill`),
    poSendEmail: (id, data) => post(`/products/${id}/purchase-order/send-email`, data),
    poPdfBlob: async (id, po) => {
      const token = localStorage.getItem('erp_token')
      const headers = { 'Content-Type': 'application/json' }
      if (token) headers['Authorization'] = `Bearer ${token}`
      const res = await fetch(`${BASE}/products/${id}/purchase-order/pdf`, {
        method: 'POST', headers, body: JSON.stringify(po),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`)
      return await res.blob()
    },
  },

  // Orders
  orders: {
    list: (params = {}) => get('/orders?' + new URLSearchParams(params)),
    lookup: () => get('/orders/lookup'),
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
    keywords: {
      list: () => get('/tasks/keywords/list'),
      create: (data) => post('/tasks/keywords', data),
      delete: (id) => del(`/tasks/keywords/${id}`),
    },
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
    get: (id) => get(`/interactions/${id}`),
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
    gmailAccounts: () => get('/connectors/gmail/accounts'),
    postmarkInfo: () => get('/connectors/postmark'),
    postmarkSetDefault: (default_from) => put('/connectors/postmark/default', { default_from }),
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

  // HubSpot
  hubspot: {
    info: () => get('/connectors/hubspot'),
    saveToken: (access_token) => put('/connectors/hubspot', { access_token }),
    deleteToken: () => del('/connectors/hubspot'),
    sync: (full = false) => post('/connectors/sync/hubspot', { full }),
    setMapping: (user_id, hubspot_owner_id) => put('/connectors/hubspot/mapping', { user_id, hubspot_owner_id }),
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
    accounts: (params = {}) => get('/connectors/quickbooks/accounts?' + new URLSearchParams(params)),
    vendors: () => get('/connectors/quickbooks/vendors'),
    taxCodes: () => get('/connectors/quickbooks/tax-codes'),
    syncAchats: () => post('/connectors/sync/qb-achats'),
  },

  // Airtable
  airtable: {
    bases: () => get('/connectors/airtable/bases'),
    tables: (baseId) => get(`/connectors/airtable/bases/${baseId}/tables`),
    fieldDefs: (erpTable) => get(`/connectors/airtable/field-defs/${erpTable}`),
    erpTableColumns: (erpTable) => get(`/connectors/erp-table-columns/${erpTable}`),
    frozenColumns: (erpTable) => get(`/connectors/frozen-columns/${erpTable}`),
    setFrozenColumn: (erpTable, column_name, frozen) => put(`/connectors/frozen-columns/${erpTable}`, { column_name, frozen }),
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
    setBulkDeleteEnabled: (table, enabled) => patch(`/views/${table}/bulk-delete-enabled`, { enabled }),
    getDetailLayout: (entityType) => get(`/views/detail/${entityType}`),
    saveDetailLayout: (entityType, field_order) => put(`/views/detail/${entityType}`, { field_order }),
  },

  // Purchases
  purchases: {
    list: (params = {}) => get('/purchases?' + new URLSearchParams(params)),
    get: (id) => get(`/purchases/${id}`),
    update: (id, data) => patch(`/purchases/${id}`, data),
    delete: (id) => del(`/purchases/${id}`),
  },

  // Serials
  serials: {
    list: (params = {}) => get('/serials?' + new URLSearchParams(params)),
    get: (id) => get(`/serials/${id}`),
    history: (id) => get(`/serials/${id}/history`),
    accounting: {
      transitions: (params = {}) => get('/serials/accounting/transitions?' + new URLSearchParams(params)),
      missingValuations: (params = {}) => get('/serials/accounting/missing-valuations?' + new URLSearchParams(params)),
      listRules: () => get('/serials/accounting/rules'),
      createRule: (data) => post('/serials/accounting/rules', data),
      updateRule: (id, data) => put(`/serials/accounting/rules/${id}`, data),
      deleteRule: (id) => del(`/serials/accounting/rules/${id}`),
    },
  },

  // Soumissions
  soumissions: {
    list: (params = {}) => get('/projets/soumissions?' + new URLSearchParams(params)),
    get: (id) => get(`/projets/soumissions/${id}`),
  },

  // Adresses
  adresses: {
    list: (params = {}) => get('/projets/adresses?' + new URLSearchParams(params)),
    lookup: () => get('/projets/adresses/lookup'),
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

  // Undo (restore soft-deleted records)
  undo: {
    restore: (table, id) => post(`/undo/${table}/${id}`, {}),
  },

  // Factures
  factures: {
    list: (params = {}) => get('/projets/factures?' + new URLSearchParams(params)),
    get: (id) => get(`/projets/factures/${id}`),
    update: (id, data) => patch(`/projets/factures/${id}`, data),
    recognizeRevenue: (id) => post(`/projets/factures/${id}/recognize-revenue`, {}),
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
    syncConfig: () => get('/employees/sync-config'),
    saveSyncConfig: (data) => put('/connectors/airtable/module-config/employees', data),
    sync: () => post('/connectors/sync/employees'),
  },

  vacations: {
    list: (params = {}) => get('/vacations?' + new URLSearchParams(params)),
    create: (data) => post('/vacations', data),
    update: (id, data) => patch(`/vacations/${id}`, data),
    delete: (id) => del(`/vacations/${id}`),
  },

  timesheets: {
    list: (params = {}) => get('/timesheets?' + new URLSearchParams(params)),
    getDay: (params = {}) => get('/timesheets/day?' + new URLSearchParams(params)),
    createDay: (data) => post('/timesheets/day', data),
    updateDay: (id, data) => patch(`/timesheets/day/${id}`, data),
    deleteDay: (id) => del(`/timesheets/day/${id}`),
    addEntry: (dayId, data) => post(`/timesheets/day/${dayId}/entries`, data),
    updateEntry: (id, data) => patch(`/timesheets/entries/${id}`, data),
    deleteEntry: (id) => del(`/timesheets/entries/${id}`),
    getPreferences: () => get('/timesheets/preferences'),
    updatePreferences: (data) => patch('/timesheets/preferences', data),
  },

  activityCodes: {
    list: (params = {}) => get('/activity-codes?' + new URLSearchParams(params)),
    get: (id) => get(`/activity-codes/${id}`),
    create: (data) => post('/activity-codes', data),
    update: (id, data) => patch(`/activity-codes/${id}`, data),
    delete: (id) => del(`/activity-codes/${id}`),
  },

  paies: {
    list: (params = {}) => get('/paies?' + new URLSearchParams(params)),
    get: (id) => get(`/paies/${id}`),
    create: (data) => post('/paies', data),
    update: (id, data) => patch(`/paies/${id}`, data),
    delete: (id) => del(`/paies/${id}`),
    items: (params = {}) => get('/paies/items/list?' + new URLSearchParams(params)),
    syncConfig: () => get('/paies/sync-config'),
    saveSyncConfig: (data) => put('/connectors/airtable/module-config/paies', data),
    sync: () => post('/connectors/sync/paies'),
    syncItems: () => post('/connectors/sync/paie_items'),
    importTimesheets: (id) => post(`/paies/${id}/import-timesheets`, {}),
  },

  hourBank: {
    list: () => get('/hour-bank'),
    forEmployee: (employeeId) => get(`/hour-bank/${employeeId}`),
    create: (data) => post('/hour-bank', data),
    updateEntry: (id, data) => patch(`/hour-bank/entry/${id}`, data),
    deleteEntry: (id) => del(`/hour-bank/entry/${id}`),
  },

  // Stock movements (mouvements d'inventaire)
  stockMovements: {
    list: (params = {}) => get('/stock-movements?' + new URLSearchParams(params)),
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

  // Achats fournisseurs (dépenses + factures)
  achatsFournisseurs: {
    list: (params = {}) => get('/achats-fournisseurs?' + new URLSearchParams(params)),
    get: (id) => get(`/achats-fournisseurs/${id}`),
    create: (data) => post('/achats-fournisseurs', data),
    update: (id, data) => put(`/achats-fournisseurs/${id}`, data),
    updateStatus: (id, status) => patch(`/achats-fournisseurs/${id}/status`, { status }),
    delete: (id) => del(`/achats-fournisseurs/${id}`),
    attachments: {
      list: (id) => get(`/achats-fournisseurs/${id}/attachments`),
      fetchFromQB: (id) => post(`/achats-fournisseurs/${id}/fetch-qb-attachments`, {}),
      download: async (id, attId) => {
        const token = getToken()
        const res = await fetch(`${BASE}/achats-fournisseurs/${id}/attachments/${attId}/download`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const cd = res.headers.get('content-disposition') || ''
        const m = cd.match(/filename="?([^";]+)"?/i)
        const filename = m ? m[1] : 'piece-jointe'
        const blob = await res.blob()
        return { blob, filename }
      },
      delete: (id, attId) => del(`/achats-fournisseurs/${id}/attachments/${attId}`),
    },
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
    run: (id, body = {}) => post(`/automations/${id}/run`, body),
    testEmail: (id, body) => post(`/automations/${id}/test-email`, body),
    emailPreview: (id, language) => get(`/automations/${id}/email-preview${language ? `?language=${encodeURIComponent(language)}` : ''}`),
    fires: (id, limit = 100) => get(`/automations/${id}/fires?limit=${limit}`),
    resetFires: (id) => post(`/automations/${id}/reset-fires`, {}),
    test: (id) => post(`/automations/${id}/test`, {}),
    fieldRuleTables: () => get('/automations/field-rule/tables'),
    ruleFieldDefs: (erpTable) => get(`/automations/field-defs?erp_table=${encodeURIComponent(erpTable)}`),
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

  // QuickBooks journal entries (proxy — no local copy)
  journalEntries: {
    list: (params = {}) => get('/journal-entries?' + new URLSearchParams(params)),
    get: (id) => get(`/journal-entries/${id}`),
    create: (data) => post('/journal-entries', data),
    pendingOperations: (params = {}) => get('/journal-entries/pending-operations?' + new URLSearchParams(params)),
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

  stripePayouts: {
    list: (params = {}) => get('/stripe-payouts?' + new URLSearchParams(params)),
    get: (stripeId) => get(`/stripe-payouts/${stripeId}`),
    sync: (fullHistory = false) => post('/stripe-payouts/sync', { fullHistory }),
    syncTransactions: (stripeId) => post(`/stripe-payouts/${stripeId}/sync-transactions`),
    previewDeposit: (stripeId) => get(`/stripe-payouts/${stripeId}/preview-deposit`),
    pushDeposit: (stripeId) => post(`/stripe-payouts/${stripeId}/push-deposit`, { confirm: true }),
    unlinkDeposit: (stripeId, { force = false } = {}) => post(`/stripe-payouts/${stripeId}/unlink-deposit`, { force }),
  },

  stripeQueue: {
    taxMappings: () => get('/stripe-queue/tax-mappings/list'),
    saveTaxMapping: (data) => post('/stripe-queue/tax-mappings', data),
    deleteTaxMapping: (id) => del(`/stripe-queue/tax-mappings/${id}`),
    batchEnrich: () => post('/stripe-queue/batch-enrich'),
    batchStatus: () => get('/stripe-queue/batch-enrich/status'),
  },

  stripeInvoices: {
    create: (data) => post('/stripe-invoices', data),
    send: (stripeInvoiceId) => post(`/stripe-invoices/${stripeInvoiceId}/send`),
    convertibleSoumissions: (companyId) => get(`/stripe-invoices/companies/${companyId}/convertible-soumissions`),
    soumissionItems: (id) => get(`/stripe-invoices/soumissions/${id}/items`),
    shippingProvince: (companyId) => get(`/stripe-invoices/companies/${companyId}/shipping-province`),
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
