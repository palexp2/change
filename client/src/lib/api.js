import { cacheGet, cacheSet, invalidate } from './prefetch.js'
import { invalidateStale } from './swr.js'
import { markOffline, markOnline, noteBootId } from './serverStatus.js'
import { onFetchStart, onFetchEnd } from './pageLoadTracker.js'

const BASE = '/erp/api'

function getToken() {
  return localStorage.getItem('erp_token')
}

function rawRequest(method, path, body, signal) {
  const token = getToken()
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`

  onFetchStart()
  return fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  }).then(async (res) => {
    // 502/503/504 peuvent venir de nginx (erp-server down, timeout upstream) →
    // serveur offline, ou de notre propre app (ex. route Novoxpress qui mappe
    // une erreur Novoxpress upstream en 502) → réponse JSON applicative. On
    // distingue les deux via le Content-Type : nginx renvoie du HTML, l'app du
    // JSON. Sans ça, une erreur Novoxpress affichait "Connexion perdue" alors
    // que le serveur ERP répondait normalement.
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      const ct = res.headers.get('content-type') || ''
      if (!ct.includes('application/json')) {
        markOffline(`gateway-${res.status}`)
        const err = new Error(`HTTP ${res.status}`)
        err.status = res.status
        throw err
      }
      // JSON applicatif → fallthrough vers le traitement d'erreur normal.
    }
    // Any other response (even 4xx) means the server is up.
    const bootId = res.headers.get('X-Boot-Id')
    if (bootId) noteBootId(bootId)
    markOnline()
    if (res.status === 401) {
      localStorage.removeItem('erp_token')
      window.location.href = '/erp/login'
      return
    }
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`)
      err.details = data
      err.status = res.status
      throw err
    }
    return data
  }, (err) => {
    // fetch() rejects with TypeError for network errors (server unreachable,
    // DNS failure, CORS issues). Treat as offline.
    // AbortError = annulation côté client (navigation rapide) → pas une panne réseau.
    if (err?.name === 'AbortError') throw err
    const reason = (typeof navigator !== 'undefined' && navigator.onLine === false) ? 'no-internet' : 'network'
    markOffline(reason)
    throw err
  }).finally(() => onFetchEnd())
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
  // Pour PATCH /admin/<resource>/... ou POST /admin/<resource>/..., on
  // invalide aussi la ressource sous-jacente (et pas seulement /admin), sinon
  // les GET /<resource>/... suivants servent le cache obsolète.
  const segments = path.split('?')[0].split('/').filter(Boolean)
  const resource = segments[0]
  if (resource) {
    invalidate('/' + resource)
    invalidateStale(resource)
    if (resource === 'admin' && segments[1]) {
      invalidate('/' + segments[1])
      invalidateStale(segments[1])
    }
    // API générique /records/<table>/... : invalider la ressource sous-jacente
    // (sinon les GET /<resource> servent le cache obsolète). Le nom de table SQL
    // utilise des underscores (activity_codes) alors que la route REST utilise
    // des tirets (activity-codes) — on invalide les deux variantes par sécurité.
    if (resource === 'records' && segments[1]) {
      const table = segments[1]
      for (const variant of new Set([table, table.replace(/_/g, '-')])) {
        invalidate('/' + variant)
        invalidateStale(variant)
      }
    }
  }
  return rawRequest(method, path, body)
}

const get = (path) => request('GET', path)
// Variante annulable — bypasse le cache (un fetch annulé ne doit pas y rester piégé).
const getAbortable = (path, signal) => rawRequest('GET', path, undefined, signal)
// GET sans cache — pour les endpoints de statut pollés (sync/batch en cours) :
// le cache prefetch (TTL 30 s) rendrait le poll aveugle aux transitions.
const getFresh = (path) => rawRequest('GET', path)
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
    getPreferences: () => get('/auth/preferences'),
    updatePreferences: (data) => patch('/auth/preferences', data),
  },

  // Companies
  companies: {
    list: (params = {}) => get('/companies?' + new URLSearchParams(params)),
    lookup: () => get('/companies/lookup'),
    duplicates: (params = {}) => get('/companies/duplicates?' + new URLSearchParams(params)),
    get: (id) => get(`/companies/${id}`),
    create: (data) => post('/companies', data),
    update: (id, data) => put(`/companies/${id}`, data),
    delete: (id) => del(`/companies/${id}`),
    onboardingResponses: (id) => get(`/companies/${id}/onboarding-responses`),
  },

  // Contacts
  contacts: {
    list: (params = {}) => get('/contacts?' + new URLSearchParams(params)),
    lookup: () => get('/contacts/lookup'),
    duplicates: (params = {}) => get('/contacts/duplicates?' + new URLSearchParams(params)),
    get: (id) => get(`/contacts/${id}`),
    create: (data) => post('/contacts', data),
    update: (id, data) => put(`/contacts/${id}`, data),
    delete: (id) => del(`/contacts/${id}`),
    listCompanies: (id) => get(`/contacts/${id}/companies`),
    addCompany: (id, data) => post(`/contacts/${id}/companies`, data),
    updateCompany: (id, linkId, data) => patch(`/contacts/${id}/companies/${linkId}`, data),
    removeCompany: (id, linkId) => del(`/contacts/${id}/companies/${linkId}`),
  },

  // Projects
  projects: {
    list: (params = {}) => get('/projects?' + new URLSearchParams(params)),
    get: (id) => get(`/projects/${id}`),
    create: (data) => post('/projects', data),
    update: (id, data) => put(`/projects/${id}`, data),
    updateStatus: (id, status, refusal_reason) => patch(`/projects/${id}/status`, { status, refusal_reason }),
    delete: (id) => del(`/projects/${id}`),
    vendeurOptions: () => get('/projects/vendeur-options'),
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
    refreshInstallationDocs: (id) => post(`/products/${id}/refresh-installation-docs`, {}),
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
    generateInstallationDocsBlob: async (id) => {
      const token = localStorage.getItem('erp_token')
      const headers = {}
      if (token) headers['Authorization'] = `Bearer ${token}`
      const res = await fetch(`${BASE}/orders/${id}/generate-installation-docs`, { method: 'POST', headers })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        const e = new Error(err.error || `HTTP ${res.status}`)
        e.payload = err
        throw e
      }
      return {
        blob: await res.blob(),
        included: parseInt(res.headers.get('X-Docs-Included') || '0', 10),
        skipped: parseInt(res.headers.get('X-Docs-Skipped') || '0', 10),
      }
    },
  },

  // Tasks
  tasks: {
    list: (params = {}, signal) => signal
      ? getAbortable('/tasks?' + new URLSearchParams(params), signal)
      : get('/tasks?' + new URLSearchParams(params)),
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
    ids: () => get('/tickets/ids'),
    get: (id, signal) => signal ? getAbortable(`/tickets/${id}`, signal) : get(`/tickets/${id}`),
    create: (data) => post('/tickets', data),
    update: (id, data) => put(`/tickets/${id}`, data),
    updateStatus: (id, status) => patch(`/tickets/${id}/status`, { status }),
    delete: (id) => del(`/tickets/${id}`),
  },

  // Dashboard
  dashboard: {
    get: () => get('/dashboard'),
    getGoal: () => get('/dashboard/goal'),
    updateGoal: (data) => put('/dashboard/goal', data),
    subscriptionEvents: (params = {}) => get('/dashboard/subscription-events?' + new URLSearchParams(params)),
    topProducts: (params = {}) => get('/dashboard/top-products?' + new URLSearchParams(params)),
    balanceSheet: (params = {}) => get('/dashboard/balance-sheet?' + new URLSearchParams(params)),
    bankAccounts: (params = {}) => get('/dashboard/bank-accounts?' + new URLSearchParams(params)),
    deferredRevenue: () => get('/dashboard/deferred-revenue'),
    agingReceivables: () => get('/dashboard/aging-receivables'),
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
    clearFactureDeferredRevenue: (id) => post(`/admin/factures/${id}/clear-deferred-revenue`, {}),
    clearFactureRevenueRecognition: (id) => post(`/admin/factures/${id}/clear-revenue-recognition`, {}),
    linkFactureRevenueRecognition: (id, je_id) => post(`/admin/factures/${id}/link-revenue-recognition`, { je_id }),
    linkFactureDeferredRevenue: (id, qb_ref) => post(`/admin/factures/${id}/link-deferred-revenue`, { qb_ref }),
    clearFacturePaidStatus: (id) => post(`/admin/factures/${id}/clear-paid-status`, {}),
    factureReconciliationAudit: () => get('/admin/facture-reconciliation-audit'),
    factureRawSchema: (id) => get(`/admin/factures/${id}/raw-schema`),
    factureRawUpdate: (id, data) => patch(`/admin/factures/${id}/raw`, data),
    paymentRawSchema: (id) => get(`/admin/payments/${id}/raw-schema`),
    paymentRawUpdate: (id, data) => patch(`/admin/payments/${id}/raw`, data),
  },

  telemetry: {
    pageLoad: (url, load_ms) => post('/telemetry/page-load', { url, load_ms }),
  },

  // Field visibility rules — règles conditionnelles de masquage des champs
  // dans les pages détail. Configurées globalement (admin), évaluées côté
  // client via <FieldGuard> à partir du record courant.
  fieldVisibilityRules: {
    list: (context) => get('/field-visibility-rules' + (context ? `?context=${encodeURIComponent(context)}` : '')),
    create: (data) => post('/field-visibility-rules', data),
    update: (id, data) => put(`/field-visibility-rules/${id}`, data),
    delete: (id) => del(`/field-visibility-rules/${id}`),
  },

  // Overrides de champs natifs (renommage / type d'affichage) par table —
  // menu contextuel « Modifier le champ » des colonnes non-custom de DataTable.
  fieldOverrides: {
    list: (table) => get(`/field-overrides/${encodeURIComponent(table)}`),
    save: (table, fieldId, data) => put(`/field-overrides/${encodeURIComponent(table)}/${encodeURIComponent(fieldId)}`, data),
    reset: (table, fieldId) => del(`/field-overrides/${encodeURIComponent(table)}/${encodeURIComponent(fieldId)}`),
  },

  // Interactions
  interactions: {
    list: (params = {}, signal) => signal
      ? getAbortable('/interactions?' + new URLSearchParams(params), signal)
      : get('/interactions?' + new URLSearchParams(params)),
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
    syncStatus: () => getFresh('/connectors/sync/status'),
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
    qbMyConnection: () => get('/connectors/quickbooks/my-connection'),
    qbDisconnectMine: () => del('/connectors/quickbooks/my-connection'),
    qbConnections: () => get('/connectors/quickbooks/connections'),
    qbDisconnectUser: (accountKey) => del(`/connectors/quickbooks/connections/${accountKey}`),
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
    createContactSegment: (name, emails) => post('/hubspot/contact-segment', { name, emails }),
  },

  // Novoxpress shipping labels
  novoxpress: {
    status: () => get('/novoxpress/status'),
    saveConfig: (data) => put('/novoxpress/config', data),
    deleteConfig: () => del('/novoxpress/config'),
    getRates: (shipmentId, data) => post(`/novoxpress/rates/${shipmentId}`, data),
    createLabel: (shipmentId, data) => post(`/novoxpress/label/${shipmentId}`, data),
    retryLabelPdf: (shipmentId) => post(`/novoxpress/label/${shipmentId}/retry-pdf`),
    diagnostic: (shipmentId, data) => post(`/novoxpress/diagnostic/${shipmentId}`, data),
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
    projetsAirtableFields: () => get('/connectors/airtable/projets/airtable-fields'),
    setProjetsFieldDisabled: (airtable_field_name, disabled) =>
      post('/connectors/airtable/projets/airtable-field-disabled', { airtable_field_name, disabled }),
    disabledColumns: (erpTable) => get(`/connectors/airtable/disabled-columns/${erpTable}`),
    // Mapping Airtable → ERP par champ (modale projets)
    projetsMappingData: () => get('/connectors/airtable/projets/mapping-data'),
    setProjetsFieldMapping: (data) =>
      post('/connectors/airtable/projets/airtable-field-mapping', data),
    // Contrôle des champs Airtable généralisé par module (cf. AIRTABLE_FIELD_MODULES
    // côté serveur). La page ModuleFields utilise ces routes pour tous les modules.
    fieldModules: () => get('/connectors/airtable/field-modules'),
    moduleMappingData: (module) => get(`/connectors/airtable/module-fields/${module}/mapping-data`),
    moduleAirtableFields: (module) => get(`/connectors/airtable/module-fields/${module}/airtable-fields`),
    setModuleFieldMapping: (module, data) =>
      post(`/connectors/airtable/module-fields/${module}/airtable-field-mapping`, data),
    setModuleFieldDisabled: (module, airtable_field_name, disabled) =>
      post(`/connectors/airtable/module-fields/${module}/airtable-field-disabled`, { airtable_field_name, disabled }),
    // Mapping des champs « cœur » (field_map de airtable_module_config) —
    // modale AirtableCoreMapModal (/comptabilite/regles-serials).
    moduleCoreMap: (module) => get(`/connectors/airtable/module-fields/${module}/core-map`),
    saveModuleCoreMap: (module, field_map) => put(`/connectors/airtable/module-fields/${module}/core-map`, { field_map }),
    // Choix du sens de synchronisation d'un champ (pull / push / both).
    setModuleFieldDirection: (module, field_key, direction) =>
      put(`/connectors/airtable/module-fields/${module}/field-direction`, { field_key, direction }),
  },

  // Custom fields (utilisateur peut ajouter / supprimer ses propres champs sur certaines tables)
  customFields: {
    list: (erpTable) => get(`/custom-fields/${erpTable}`),
    create: (erpTable, data) => post(`/custom-fields/${erpTable}`, data),
    createFormula: (erpTable, data) => post(`/custom-fields/${erpTable}/formula`, data),
    previewFormula: (erpTable, data) => post(`/custom-fields/${erpTable}/formula/preview`, data),
    createLookup: (erpTable, data) => post(`/custom-fields/${erpTable}/lookup`, data),
    createRollup: (erpTable, data) => post(`/custom-fields/${erpTable}/rollup`, data),
    createAuto: (erpTable, data) => post(`/custom-fields/${erpTable}/auto`, data),
    createButton: (erpTable, data) => post(`/custom-fields/${erpTable}/button`, data),
    runButton: (fieldId, recordId) => post(`/custom-fields/button/${fieldId}/run`, { record_id: recordId }),
    update: (id, data) => put(`/custom-fields/${id}`, data),
    delete: (id) => del(`/custom-fields/${id}`),
    dependents: (id) => get(`/custom-fields/${id}/dependents`),
    lookupMeta: (erpTable) => get(`/custom-fields/_meta/${erpTable}`),
    // Adopte une colonne physique déjà existante (mapping Airtable, ou
    // orpheline) plutôt que d'en créer une nouvelle — pas d'ALTER TABLE.
    adopt: (erpTable, data) => post(`/custom-fields/${erpTable}/adopt`, data),
  },

  // Views (config + pills)
  views: {
    get: (table) => get(`/views/${table}`),
    updateConfig: (table, data) => put(`/views/${table}`, data),
    createPill: (table, data) => post(`/views/${table}/pills`, data),
    updatePill: (table, id, data) => put(`/views/${table}/pills/${id}`, data),
    deletePill: (table, id) => del(`/views/${table}/pills/${id}`),
    reorderPills: (table, order) => patch(`/views/${table}/pills/reorder`, { order }),
    setPillLocked: (table, id, locked) => patch(`/views/${table}/pills/${id}/locked`, { locked }),
    saveColumnWidths: (table, column_widths) => patch(`/views/${table}/column-widths`, { column_widths }),
    savePillColumnWidths: (table, id, column_widths) => patch(`/views/${table}/pills/${id}/column-widths`, { column_widths }),
    saveFooterAggregations: (table, footer_aggregations) => patch(`/views/${table}/footer-aggregations`, { footer_aggregations }),
    setBulkDeleteEnabled: (table, enabled) => patch(`/views/${table}/bulk-delete-enabled`, { enabled }),
    getDetailLayout: (entityType) => get(`/views/detail/${entityType}`),
    saveDetailLayout: (entityType, field_order) => put(`/views/detail/${entityType}`, { field_order }),
  },

  // Purchases
  purchases: {
    list: (params = {}) => get('/purchases?' + new URLSearchParams(params)),
    get: (id) => get(`/purchases/${id}`),
    create: (data) => post('/purchases', data),
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
    delete: (id) => del(`/projets/factures/${id}`),
    recognizeRevenue: (id, opts = {}) => post(`/projets/factures/${id}/recognize-revenue`, opts),
    qbState: (id) => get(`/projets/factures/${id}/qb-state`),
    discounts: (id) => get(`/projets/factures/${id}/discounts`),
    neighbors: (id) => get(`/projets/factures/${id}/neighbors`),
    retryPdf: (id) => post(`/projets/factures/${id}/retry-pdf`, {}),
  },

  // Paiements / remboursements (Stripe et hors-Stripe) attachés aux factures
  payments: {
    list: (params = {}) => get('/payments?' + new URLSearchParams(params)),
    listForFacture: (factureId) => get(`/payments/facture/${factureId}`),
    directDeposits: () => get('/payments/direct-deposits'),
    directDeposit: (id) => get(`/payments/direct-deposits/${id}`),
    previewDeposit: (data) => post('/payments/preview-deposit', data),
    create: (data) => post('/payments', data),
    update: (id, data) => patch(`/payments/${id}`, data),
    retryQb: (id) => post(`/payments/${id}/retry-qb`, {}),
    qbLinkSuggestions: (id) => get(`/payments/${id}/qb-link-suggestions`),
    qbCreditAccount: (id) => get(`/payments/${id}/qb-credit-account`),
    delete: (id) => del(`/payments/${id}`),
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
    eventCreate: (id, body) => post(`/projets/abonnements/${id}/events`, body),
    eventPatch: (id, eventId, body) => patch(`/projets/abonnements/${id}/events/${eventId}`, body),
    eventDelete: (id, eventId) => del(`/projets/abonnements/${id}/events/${eventId}`),
    events: (params = {}) => get('/projets/abonnement-events?' + new URLSearchParams(params)),
    eventRachatPatch: (eventId, body) => patch(`/projets/abonnement-events/${eventId}/rachat`, body),
    eventRachatCandidates: (eventId) => get(`/projets/abonnement-events/${eventId}/rachat-candidates`),
    eventDetectRachat: (eventId) => post(`/projets/abonnement-events/${eventId}/detect-rachat`),
    backfillRachat: () => post('/projets/abonnement-events/backfill-rachat'),
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
    balance: (params = {}) => get('/vacations/balance?' + new URLSearchParams(params)),
    create: (data) => post('/vacations', data),
    update: (id, data) => patch(`/vacations/${id}`, data),
    delete: (id) => del(`/vacations/${id}`),
  },

  discoveryForms: {
    list: (params = {}) => get('/discovery-forms?' + new URLSearchParams(params)),
    get: (id) => get(`/discovery-forms/${id}`),
    create: (data) => post('/discovery-forms', data),
    delete: (id) => del(`/discovery-forms/${id}`),
    // Accès public au formulaire via short token (sans auth) — utilisé par la page client.
    getByToken: (token) => fetch(`/erp/api/customer/post-payment/by-token/${encodeURIComponent(token)}`).then(r => r.json()),
    saveByToken: (token, body) => fetch(`/erp/api/customer/post-payment/by-token/${encodeURIComponent(token)}/save`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then(r => r.json()),
    submitByToken: (token) => fetch(`/erp/api/customer/post-payment/by-token/${encodeURIComponent(token)}/submit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
    }).then(r => r.json()),
  },

  qualificationCalls: {
    list: () => get('/qualification-calls'),
    byCompany: (companyId) => get(`/qualification-calls/by-company/${companyId}`),
    get: (id) => get(`/qualification-calls/${id}`),
    create: (data) => post('/qualification-calls', data),
    update: (id, data) => patch(`/qualification-calls/${id}`, data),
    subscribeCard: (id, body) => post(`/qualification-calls/${id}/subscribe-card`, body),
    saveFarmAddress: (id, body) => post(`/qualification-calls/${id}/farm-address`, body),
    sendSystemBuilderEmail: (id, body) => post(`/qualification-calls/${id}/send-system-builder-email`, body),
    delete: (id) => del(`/qualification-calls/${id}`),
  },

  emailRelance: {
    qualificationCalls: () => get('/email-relance/qualification-calls'),
    settings: () => get('/email-relance/settings'),
    saveGlobal: (instructions) => put('/email-relance/settings/global', { instructions }),
    saveQc: (qcId, instructions) => put(`/email-relance/settings/qc/${qcId}`, { instructions }),
    regenerate: (qualification_call_id, temperature, general_rules, specific_instructions) =>
      post('/email-relance/regenerate', {
        qualification_call_id, temperature, general_rules, specific_instructions,
      }),
    saveDraft: (qcId, subject, body) => put(`/email-relance/draft/${qcId}`, { subject, body }),
    gmailAccount: () => get('/email-relance/gmail-account'),
    send: (qcId, to) => post(`/email-relance/send/${qcId}`, to ? { to } : {}),
  },

  timesheets: {
    list: (params = {}) => get('/timesheets?' + new URLSearchParams(params)),
    getDay: (params = {}) => get('/timesheets/day?' + new URLSearchParams(params)),
    createDay: (data) => post('/timesheets/day', data),
    updateDay: (id, data) => patch(`/timesheets/day/${id}`, data),
    setDayStatus: (id, data) => patch(`/timesheets/day/${id}/status`, data),
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
    getUsers: (id) => get(`/activity-codes/${id}/users`),
    setUsers: (id, user_ids) => put(`/activity-codes/${id}/users`, { user_ids }),
  },

  paies: {
    list: (params = {}) => get('/paies?' + new URLSearchParams(params)),
    get: (id) => get(`/paies/${id}`),
    create: (data) => post('/paies', data),
    update: (id, data) => patch(`/paies/${id}`, data),
    delete: (id) => del(`/paies/${id}`),
    items: (params = {}) => get('/paies/items/list?' + new URLSearchParams(params)),
    repartitionPreview: (id, params = {}) => get(`/paies/${id}/repartition-preview?` + new URLSearchParams(params)),
    repartitionPush: (id, data = {}) => post(`/paies/${id}/repartition-push`, data),
    salaryExpenseReconcile: () => post('/paies/salary-expense/reconcile', {}),
    salaryExpenseEstimate: (id) => get(`/paies/${id}/salary-expense/estimate`),
    salaryExpensePreview: (id, data = {}) => post(`/paies/${id}/salary-expense/preview`, data),
    salaryExpensePush: (id, data = {}) => post(`/paies/${id}/salary-expense/push`, data),
    agaRepartitionPreview: (amount) => post('/paies/aga-repartition/preview', { amount }),
    agaRepartitionPush: (amount, txn_date = null) => post('/paies/aga-repartition/push', { amount, txn_date }),
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

  // Feed des opérations (journal d'activité applicatif — qui / quoi / quand)
  activity: {
    list: (params = {}) => get('/activity?' + new URLSearchParams(params)),
  },

  // Journal des side effects — timeline unifiée (sync_log + automation_logs + activity_log).
  sideEffects: {
    list: (params = {}) => get('/side-effects?' + new URLSearchParams(params)),
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
    vendorHistory: (id) => get(`/achats-fournisseurs/${id}/vendor-history`),
    pushToQb: (id) => post(`/achats-fournisseurs/${id}/push-to-qb`, {}),
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

  // Trésorerie BNC (projection + saisie du solde réel + sorties récurrentes)
  treasury: {
    projection: (params = {}) => get('/treasury/projection?' + new URLSearchParams(params)),
    balances: () => get('/treasury/balances'),
    noteBalance: (balance) => post('/treasury/balance', { balance }),
    recurring: {
      list: () => get('/treasury/recurring'),
      create: (data) => post('/treasury/recurring', data),
      update: (id, data) => put(`/treasury/recurring/${id}`, data),
      delete: (id) => del(`/treasury/recurring/${id}`),
    },
  },

  // Comptes prépayés : ledger fournisseurs prépayés + cédule FPA #13000
  prepaid: {
    accounts: {
      list: () => get('/prepaid/accounts'),
      create: (data) => post('/prepaid/accounts', data),
      update: (id, data) => put(`/prepaid/accounts/${id}`, data),
      delete: (id) => del(`/prepaid/accounts/${id}`),
      entries: (id) => get(`/prepaid/accounts/${id}/entries`),
      addEntry: (id, data) => post(`/prepaid/accounts/${id}/entries`, data),
      syncQb: (id) => post(`/prepaid/accounts/${id}/sync-qb`, {}),
      auditQb: (id, apply) => post(`/prepaid/accounts/${id}/audit-qb`, { apply: apply === true }),
      providerBalance: (id) => get(`/prepaid/accounts/${id}/provider-balance`),
    },
    entries: {
      update: (id, data) => put(`/prepaid/entries/${id}`, data),
      delete: (id) => del(`/prepaid/entries/${id}`),
    },
    expenses: {
      list: (fy) => get('/prepaid/expenses' + (fy ? `?fy=${fy}` : '')),
      create: (data) => post('/prepaid/expenses', data),
      update: (id, data) => put(`/prepaid/expenses/${id}`, data),
      delete: (id) => del(`/prepaid/expenses/${id}`),
      addAmortization: (id, data) => post(`/prepaid/expenses/${id}/amortizations`, data),
    },
    amortizations: {
      update: (id, data) => put(`/prepaid/amortizations/${id}`, data),
      delete: (id) => del(`/prepaid/amortizations/${id}`),
    },
    fpaMonth: (month) => get(`/prepaid/fpa/month/${month}`),
    fpaPublish: (month) => post(`/prepaid/fpa/month/${month}/publish`, {}),
  },

  // Dettes à long terme : cédules de remboursement + comptabilisation QB
  ltDebts: {
    list: () => get('/lt-debts'),
    create: (data) => post('/lt-debts', data),
    update: (id, data) => put(`/lt-debts/${id}`, data),
    delete: (id) => del(`/lt-debts/${id}`),
    payments: (id) => get(`/lt-debts/${id}/payments`),
    addPayment: (id, data) => post(`/lt-debts/${id}/payments`, data),
    importPayments: (id, rows, replace) => post(`/lt-debts/${id}/payments/import`, { rows, replace: replace === true }),
    updatePayment: (id, data) => put(`/lt-debts/payments/${id}`, data),
    deletePayment: (id) => del(`/lt-debts/payments/${id}`),
    markBooked: (id) => post(`/lt-debts/payments/${id}/mark-booked`, {}),
    unmarkBooked: (id) => post(`/lt-debts/payments/${id}/unmark-booked`, {}),
    publishPayment: (id) => post(`/lt-debts/payments/${id}/publish`, {}),
  },

  // Abonnements fournisseurs (registre des charges récurrentes attendues)
  vendorSubscriptions: {
    list: (params = {}) => get('/vendor-subscriptions?' + new URLSearchParams(params)),
    get: (id) => get(`/vendor-subscriptions/${id}`),
    create: (data) => post('/vendor-subscriptions', data),
    update: (id, data) => put(`/vendor-subscriptions/${id}`, data),
    delete: (id) => del(`/vendor-subscriptions/${id}`),
    missingReceipts: () => get('/vendor-subscriptions/missing-receipts'),
  },

  // Profils fournisseurs — défauts comptables par fournisseur (vendor QB par devise,
  // comptes, statut fiscal, code de taxe, termes de paiement), appris à chaque push QB.
  vendorProfiles: {
    list: () => get('/vendor-profiles'),
    create: (data) => post('/vendor-profiles', data),
    update: (id, data) => patch(`/vendor-profiles/${id}`, data),
    delete: (id) => del(`/vendor-profiles/${id}`),
    seed: () => post('/vendor-profiles/seed', {}),
    duplicates: () => get('/vendor-profiles/duplicates'),
    merge: (targetId, sourceIds) => post(`/vendor-profiles/${targetId}/merge`, { sourceIds }),
  },

  // Pièces jointes polymorphes — attachables à n'importe quelle entité
  // (entityType ∈ companies|contacts|orders|tickets|projects|products|…).
  attachments: {
    list: (entityType, entityId) => get(`/attachments/${entityType}/${entityId}`),
    upload: async (entityType, entityId, files) => {
      const token = getToken()
      const fd = new FormData()
      for (const f of files) fd.append('file', f)
      const res = await fetch(`${BASE}/attachments/${entityType}/${entityId}`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      return data
    },
    download: async (entityType, entityId, attId) => {
      const token = getToken()
      const res = await fetch(`${BASE}/attachments/${entityType}/${entityId}/${attId}/download`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const cd = res.headers.get('content-disposition') || ''
      const m = cd.match(/filename="?([^";]+)"?/i)
      const filename = m ? decodeURIComponent(m[1]) : 'piece-jointe'
      const blob = await res.blob()
      return { blob, filename }
    },
    delete: (entityType, entityId, attId) => del(`/attachments/${entityType}/${entityId}/${attId}`),
  },

  // Global search
  search: {
    query: (q) => get(`/search?q=${encodeURIComponent(q)}`),
  },

  // API de mutation générique (phase 1) — pilotée par un registre de schémas
  // côté serveur (server/src/db/recordRegistry.js). `table` est le nom SQL réel
  // (ex. 'activity_codes', 'vacations'). Couvre uniquement les tables CRUD
  // simples ; les ressources à logique métier gardent leurs méthodes dédiées.
  records: {
    update: (table, id, data) => patch(`/records/${table}/${id}`, data),
    delete: (table, id) => del(`/records/${table}/${id}`),
    history: (table, id) => get(`/records/${table}/${id}/history`),
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
    emailPreview: (id, language, recordId) => {
      const qs = new URLSearchParams()
      if (language) qs.set('language', language)
      if (recordId) qs.set('record_id', recordId)
      const q = qs.toString()
      return get(`/automations/${id}/email-preview${q ? `?${q}` : ''}`)
    },
    fires: (id, limit = 100) => get(`/automations/${id}/fires?limit=${limit}`),
    resetFires: (id) => post(`/automations/${id}/reset-fires`, {}),
    test: (id, body = {}) => post(`/automations/${id}/test`, body),
    runDateRule: (id) => post(`/automations/${id}/run-date-rule`, {}),
    rotateToken: (id) => post(`/automations/${id}/rotate-token`, {}),
    fieldRuleTables: () => get('/automations/field-rule/tables'),
    ruleFieldDefs: (erpTable, { includeCustom = false } = {}) =>
      get(`/automations/field-defs?erp_table=${encodeURIComponent(erpTable)}${includeCustom ? '&include_custom=1' : ''}`),
    retryQueue: (id) => get(`/automations/${id}/retry-queue`),
    retryNow: (id, retryId) => post(`/automations/${id}/retry-queue/${retryId}/retry`, {}),
    deferredQueue: (id) => get(`/automations/${id}/deferred-queue`),
    drainDeferred: (id) => post(`/automations/${id}/drain-deferred`, {}),
    versions: (id) => get(`/automations/${id}/versions`),
    restoreVersion: (id, versionId) => post(`/automations/${id}/versions/${versionId}/restore`, {}),
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
      convertToOrder: (id) => post(`/documents/soumissions/${id}/convert-to-order`, {}),
      pdfUrl: (id) => `${BASE}/documents/soumissions/${id}/pdf`,
    },
  },

  agent: {
    listTasks:    ()         => get('/agent/tasks'),
    getUsage:     ()         => get('/agent/usage'),
    createTask:   (data)     => post('/agent/tasks', data),
    updateTask:   (id, data) => patch(`/agent/tasks/${id}`, data),
    deleteTask:   (id)       => del(`/agent/tasks/${id}`),
    sendMessage:  (id, text) => post(`/agent/tasks/${id}/message`, { text }),
    getSettings:  ()         => get('/agent/settings'),
    saveSettings: (data)     => put('/agent/settings', data),
    readClaudeMd: ()         => get('/agent/claude-md'),
    saveClaudeMd: (content)  => put('/agent/claude-md', { content }),
    listBacklog:  ()         => get('/agent/backlog'),
    addBacklog:   (text, opts = {}) => post('/agent/backlog', { text, ...opts }),
    retryBacklog: (id)       => post(`/agent/backlog/${id}/retry`, {}),
    approveBacklog:(id, comment) => post(`/agent/backlog/${id}/approve`, { comment }),
    deleteBacklog:(id)       => del(`/agent/backlog/${id}`),
  },

  // QuickBooks journal entries (proxy — no local copy)
  journalEntries: {
    list: (params = {}) => get('/journal-entries?' + new URLSearchParams(params)),
    get: (id) => get(`/journal-entries/${id}`),
    create: (data) => post('/journal-entries', data),
    pendingOperations: (params = {}) => get('/journal-entries/pending-operations?' + new URLSearchParams(params)),
    getDefaults: () => get('/journal-entries/defaults'),
    saveDefaults: (defaults) => put('/journal-entries/defaults', { defaults }),
  },

  // Sale receipts (OCR/AI extraction)
  saleReceipts: {
    list: (params = {}) => get('/sale-receipts?' + new URLSearchParams(params)),
    transactionTypes: () => get('/sale-receipts/transaction-types'),
    get: (id) => get(`/sale-receipts/${id}`),
    update: (id, body) => patch(`/sale-receipts/${id}`, body),
    delete: (id) => del(`/sale-receipts/${id}`),
    archive: (id) => post(`/sale-receipts/${id}/archive`),
    unarchive: (id) => post(`/sale-receipts/${id}/unarchive`),
    markRead: (id) => post(`/sale-receipts/${id}/read`),
    markUnread: (id) => post(`/sale-receipts/${id}/unread`),
    history: (id) => get(`/sale-receipts/${id}/history`),
    vendorHistory: (id) => get(`/sale-receipts/${id}/vendor-history`),
    pushToQb: (id, params) => post(`/sale-receipts/${id}/push-to-qb`, params),
    reExtract: (id) => post(`/sale-receipts/${id}/re-extract`),
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

  // Fichiers publics — upload, list, edit, delete par n'importe quel user
  // authentifié. L'accès au fichier lui-même est public via /erp/p/<token>/<name>.
  publicFiles: {
    list: (params = {}) => get('/public-files?' + new URLSearchParams(params)),
    folders: () => get('/public-files/folders'),
    update: (id, data) => patch(`/public-files/${id}`, data),
    delete: (id) => del(`/public-files/${id}`),
    upload: (formData) => {
      const token = getToken()
      return fetch('/erp/api/public-files/upload', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      }).then(async r => {
        const d = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
        return d
      })
    },
    // Remplace le contenu d'un fichier en conservant son lien public (token).
    replace: (id, formData) => {
      const token = getToken()
      return fetch(`/erp/api/public-files/${id}/replace`, {
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
    batchStatus: () => getFresh('/stripe-queue/batch-enrich/status'),
    // Mapping configurable Stripe → factures (modale « Mapping Stripe » sur /factures)
    factureFieldMap: () => get('/stripe-queue/facture-field-map'),
    saveFactureFieldMap: (field_map) => put('/stripe-queue/facture-field-map', { field_map }),
    // Mapping configurable Stripe → subscriptions (modale « Sync Stripe » sur /abonnements)
    subscriptionFieldMap: () => get('/stripe-queue/subscription-field-map'),
    saveSubscriptionFieldMap: (field_map) => put('/stripe-queue/subscription-field-map', { field_map }),
  },

  stripeInvoices: {
    create: (data) => post('/stripe-invoices', data),
    send: (pendingId, body) => post(`/stripe-invoices/${pendingId}/send`, body || {}),
    emailDefaults: (pendingId) => get(`/stripe-invoices/${pendingId}/email-defaults`),
    convertibleSoumissions: (companyId) => get(`/stripe-invoices/companies/${companyId}/convertible-soumissions`),
    soumissionItems: (id) => get(`/stripe-invoices/soumissions/${id}/items`),
    shippingProvince: (companyId) => get(`/stripe-invoices/companies/${companyId}/shipping-province`),
  },

  stripeInvoiceItems: {
    list: (params = {}) => get('/stripe-invoice-items?' + new URLSearchParams(params)),
    get: (id) => get(`/stripe-invoice-items/${id}`),
    update: (id, data) => patch(`/stripe-invoice-items/${id}`, data),
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
