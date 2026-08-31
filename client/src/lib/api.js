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

// Toute mutation (JSON ou multipart) doit purger le cache de la ressource
// touchée, sinon un GET immédiat après coup sert la réponse d'avant (TTL 30 s)
// — c'est ce qui empêchait un document fraîchement téléversé d'apparaître dans
// la liste rechargée juste après l'upload.
function invalidateForPath(path) {
  // Pour PATCH /admin/<resource>/... ou POST /admin/<resource>/..., on
  // invalide aussi la ressource sous-jacente (et pas seulement /admin), sinon
  // les GET /<resource>/... suivants servent le cache obsolète.
  const segments = path.split('?')[0].split('/').filter(Boolean)
  const resource = segments[0]
  if (!resource) return
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

// Une connexion HTTP gardée ouverte peut être fermée par le serveur à l'instant
// précis où le navigateur la réutilise : fetch() rejette alors avec un TypeError
// (ECONNRESET) sans que la requête ait été traitée. Un clic sur un bouton d'action
// se perdait donc « une fois sur deux » sans que rien ne soit fait côté serveur.
// Une seule reprise immédiate suffit — la connexion morte est écartée du pool.
// Réservé aux méthodes IDEMPOTENTES : rejouer un POST créerait un doublon.
const IDEMPOTENT = new Set(['GET', 'PUT', 'PATCH', 'DELETE'])
const isNetworkError = err => err instanceof TypeError && err?.name !== 'AbortError'

function withNetworkRetry(method, path, body) {
  return rawRequest(method, path, body).catch(err => {
    if (!isNetworkError(err)) throw err
    return rawRequest(method, path, body)
  })
}

// GETs consult the prefetch cache (populated by nav hover). Mutations
// invalidate the resource-path prefix so subsequent GETs see fresh data.
function request(method, path, body, { retryOnNetworkError = false } = {}) {
  if (method === 'GET') {
    const hit = cacheGet(path)
    if (hit) return hit
    const promise = withNetworkRetry('GET', path)
    cacheSet(path, promise)
    return promise
  }
  invalidateForPath(path)
  const retry = retryOnNetworkError || IDEMPOTENT.has(method)
  return retry ? withNetworkRetry(method, path, body) : rawRequest(method, path, body)
}

// Upload multipart : `fetch` direct (pas de Content-Type JSON, le navigateur
// pose le boundary) mais MÊME invalidation de cache qu'une mutation normale.
// `path` est relatif à BASE, comme pour request().
async function uploadRequest(path, formData, method = 'POST') {
  invalidateForPath(path)
  const token = getToken()
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: formData,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

const get = (path) => request('GET', path)
// Variante annulable — bypasse le cache (un fetch annulé ne doit pas y rester piégé).
const getAbortable = (path, signal) => rawRequest('GET', path, undefined, signal)
// GET sans cache — pour les endpoints de statut pollés (sync/batch en cours) :
// le cache prefetch (TTL 30 s) rendrait le poll aveugle aux transitions.
const getFresh = (path) => rawRequest('GET', path)
const post = (path, body) => request('POST', path, body)
// POST dont rejouer l'appel est sans conséquence (l'effet est le même la 2e fois) :
// éligible à la reprise sur coupure réseau, comme les méthodes idempotentes.
const postIdempotent = (path, body) => request('POST', path, body, { retryOnNetworkError: true })
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
    // Options du champ « Mots clés » : valeurs distinctes déjà utilisées, les
    // plus fréquentes en tête.
    keywords: () => get('/tickets/keywords'),
    get: (id, signal) => signal ? getAbortable(`/tickets/${id}`, signal) : get(`/tickets/${id}`),
    create: (data) => post('/tickets', data),
    update: (id, data) => put(`/tickets/${id}`, data),
    updateStatus: (id, status) => patch(`/tickets/${id}/status`, { status }),
    delete: (id) => del(`/tickets/${id}`),
    // Sondage de satisfaction par SMS. `phone` (optionnel) envoie à un numéro
    // ponctuel sans modifier la fiche du contact.
    survey: (id) => get(`/tickets/${id}/survey`),
    sendSurvey: (id, phone = null) => post(`/tickets/${id}/survey`, phone ? { phone } : {}),
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
    bankAccountsHistory: (params = {}) => get('/dashboard/bank-accounts/history?' + new URLSearchParams(params)),
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
  // Personnalisation des champs NATIFS (ceux définis dans tableDefs.js).
  // Depuis l'unification, ils vivent dans custom_fields (kind='native') et non
  // plus dans une table à part : même stockage, même route que les champs perso.
  fieldOverrides: {
    list: (table) => get(`/custom-fields/${encodeURIComponent(table)}/native`),
    save: (table, fieldId, data) => put(`/custom-fields/${encodeURIComponent(table)}/native/${encodeURIComponent(fieldId)}`, data),
    reset: (table, fieldId) => del(`/custom-fields/${encodeURIComponent(table)}/native/${encodeURIComponent(fieldId)}`),
    // Plus de saveOrder : le réordonnancement des champs a été retiré de la page
    // de configuration. Le `sort_order` déjà enregistré reste lu (applyFieldOrder).
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
    createContactSegment: (name, emails, createMissing = false) => post('/hubspot/contact-segment', { name, emails, createMissing }),
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

  // UPS — étiquettes de retour (client → atelier Orisha), tarifs et suivi.
  ups: {
    status: () => get('/ups/status'),
    saveConfig: (data) => put('/ups/config', data),
    deleteConfig: () => del('/ups/config'),
    test: () => post('/ups/test'),
    createReturnLabel: (returnId, data) => post(`/ups/returns/${returnId}/return-label`, data),
    sendReturnLabel: (returnId, to) => post(`/ups/returns/${returnId}/return-label/send`, { to }),
    shipmentRates: (shipmentId, data) => post(`/ups/shipments/${shipmentId}/rates`, data),
    trackShipment: (shipmentId) => post(`/ups/shipments/${shipmentId}/track`),
  },

  // Purolator — étiquettes sortantes (ERP → Purolator uniquement), tarifs et suivi.
  purolator: {
    status: () => get('/purolator/status'),
    saveConfig: (data) => put('/purolator/config', data),
    deleteConfig: () => del('/purolator/config'),
    shipmentRates: (shipmentId, data) => post(`/purolator/shipments/${shipmentId}/rates`, data),
    createLabel: (shipmentId, data) => post(`/purolator/shipments/${shipmentId}/label`, data),
    trackShipment: (shipmentId) => post(`/purolator/shipments/${shipmentId}/track`),
  },

  // DigiKey — commandes + factures rapatriées par l'API (sens unique DigiKey → ERP)
  digikey: {
    status: () => get('/digikey/status'),
    saveConfig: (data) => put('/digikey/config', data),
    deleteConfig: () => del('/digikey/config'),
    orders: (limit = 50) => get(`/digikey/orders?limit=${limit}`),
    sync: () => post('/connectors/sync/digikey'),
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
    // Modules à mapping « cœur » + table ERP alimentée (onglets Airtable de la
    // modale de configuration des champs).
    coreMapModules: () => get('/connectors/airtable/core-map-modules'),
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
    // Une seule route de création côté serveur, discriminée par `kind` — ces
    // helpers restent nommés pour la lisibilité des appelants.
    createFormula: (erpTable, data) => post(`/custom-fields/${erpTable}`, { ...data, kind: 'formula' }),
    previewFormula: (erpTable, data) => post(`/custom-fields/${erpTable}/formula/preview`, data),
    createLookup: (erpTable, data) => post(`/custom-fields/${erpTable}`, { ...data, kind: 'lookup' }),
    createRollup: (erpTable, data) => post(`/custom-fields/${erpTable}`, { ...data, kind: 'rollup' }),
    // Les champs auto-remplis n'ont pas de kind « auto » en base : le kind EST le
    // type (created_time, last_modified_by…).
    createAuto: (erpTable, { auto_type, ...data }) => post(`/custom-fields/${erpTable}`, { ...data, kind: auto_type }),
    createButton: (erpTable, data) => post(`/custom-fields/${erpTable}`, { ...data, kind: 'button' }),
    createLink: (erpTable, data) => post(`/custom-fields/${erpTable}`, { ...data, kind: 'link' }),
    runButton: (fieldId, recordId) => post(`/custom-fields/button/${fieldId}/run`, { record_id: recordId }),
    update: (id, data) => put(`/custom-fields/${id}`, data),
    delete: (id) => del(`/custom-fields/${id}`),
    dependents: (id) => get(`/custom-fields/${id}/dependents`),
    lookupMeta: (erpTable) => get(`/custom-fields/_meta/${erpTable}`),
    // Adopte une colonne physique déjà existante (mapping Airtable, ou
    // orpheline) plutôt que d'en créer une nouvelle — pas d'ALTER TABLE.
    adopt: (erpTable, data) => post(`/custom-fields/${erpTable}/adopt`, data),
    // Duplique un champ (structure + valeurs par défaut). La copie n'hérite
    // jamais du lien vers une source externe — voir la route serveur.
    duplicate: (erpTable, data) => post(`/custom-fields/${erpTable}/duplicate`, data),
    // Masquage GLOBAL d'un champ natif — l'équivalent d'une suppression pour un
    // champ dont la colonne SQL ne peut pas disparaître. Réversible.
    setNativeHidden: (erpTable, fieldId, hidden) =>
      patch(`/custom-fields/${encodeURIComponent(erpTable)}/native/${encodeURIComponent(fieldId)}/hidden`, { hidden }),
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
    stateChanges: (params = {}) => get('/serials/state-changes?' + new URLSearchParams(params)),
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
    // Vérificateur d'adresses postales : état courant / relance d'une passe.
    check: () => get('/projets/adresses/check'),
    runCheck: () => post('/projets/adresses/check', {}),
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
    reconciliationAudit: () => get('/projets/factures/reconciliation-audit'),
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
    context: (id, addressId) => get(`/retours/${id}/return-context${addressId ? `?address_id=${addressId}` : ''}`),
    getRates: (id, data) => post(`/retours/${id}/return-rates`, data),
    createLabel: (id, data) => post(`/retours/${id}/return-label`, data),
    retryLabelPdf: (id) => post(`/retours/${id}/return-label/retry-pdf`),
    diagnostic: (id, data) => post(`/retours/${id}/diagnostic`, data),
    generateMemo: (id) => post(`/retours/${id}/memo`),
    sendInstructions: (id, to) => post(`/retours/${id}/send-instructions`, { to }),
    bulkFromSerials: (data) => post('/retours/bulk-from-serials', data),
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
    salaryExpenseDeductions: (id) => get(`/paies/${id}/salary-expense/deductions`),
    salaryExpenseDeductionsRefresh: (id) => post(`/paies/${id}/salary-expense/deductions/refresh`, {}),
    salaryExpenseUpdate: (id, data = {}) => post(`/paies/${id}/salary-expense/update`, data),
    salaryExpensePreview: (id, data = {}) => post(`/paies/${id}/salary-expense/preview`, data),
    salaryExpensePush: (id, data = {}) => post(`/paies/${id}/salary-expense/push`, data),
    agaRepartitionPreview: (amount, txn_date = null) => post('/paies/aga-repartition/preview', { amount, txn_date }),
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
    config: () => get('/treasury/config'),
    updateConfig: (data) => put('/treasury/config', data),
    balances: () => get('/treasury/balances'),
    noteBalance: (balance) => post('/treasury/balance', { balance }),
    // Passé réel : mouvements du relevé bancaire BNC CAD, jour par jour
    // (même forme que projection.days — alimente la remontée dans le passé).
    actuals: (params = {}) => get('/treasury/actuals?' + new URLSearchParams(params)),
    // Historique : ce que la projection annonçait, jour par jour (snapshots).
    history: (days = 60) => get(`/treasury/history?days=${days}`),
    historyDay: (date) => get(`/treasury/history/${date}`),
    // Mouvement en retard confirmé déjà sorti du compte (cesse d'être projeté).
    markCleared: (data) => post('/treasury/cleared', data),
    unmarkCleared: (key) => del(`/treasury/cleared/${encodeURIComponent(key)}`),
    // Paiements et virements émis (remplace l'onglet Pmt_Suivi du CTB - Suivi) :
    // `cleared` = passé à la banque (le vert du fichier). Tant qu'un paiement
    // n'est pas passé, il pèse sur la projection.
    payments: {
      list: (params = {}) => get('/treasury/payments?' + new URLSearchParams(params)),
      // Mémoire par fournisseur : dernier commentaire / moyen / compte utilisés.
      vendorHints: () => get('/treasury/payments/vendor-hints'),
      // Modèles dérivés de l'historique : « refaire le même paiement » d'un clic.
      templates: () => get('/treasury/payments/templates'),
      openBills: () => get('/treasury/payments/open-bills'),
      create: (data) => post('/treasury/payments', data),
      update: (id, data) => put(`/treasury/payments/${id}`, data),
      setCleared: (id, cleared) => post(`/treasury/payments/${id}/cleared`, { cleared }),
      delete: (id) => del(`/treasury/payments/${id}`),
      autoClear: (account = null) => post('/treasury/payments/auto-clear', { account }),
      importSheet: (since) => post('/treasury/payments/import-sheet', { since }),
      // Sync automatique de l'onglet Pmt_Suivi (toutes les 30 min) : active ?
      // dernier passage ? — affiché à côté du bouton de sync manuelle.
      sheetStatus: () => get('/treasury/payments/sheet-status'),
      // Détection du « passé à la banque » dans le grand livre QuickBooks :
      // les appariements sûrs sont cochés, les autres reviennent à confirmer.
      qbClear: ({ dryRun = false } = {}) => post('/treasury/payments/qb-clear', { dry_run: dryRun }),
      qbClearStatus: () => get('/treasury/payments/qb-clear/status'),
      qbClearApply: ({ paymentIds = [], achatIds = [] }) =>
        post('/treasury/payments/qb-clear/apply', { payment_ids: paymentIds, achat_ids: achatIds }),
    },
    // Cédule hebdomadaire de paiements fournisseurs : ce qu'on paie cette
    // semaine, confronté au solde BNC et au solde projeté de la carte.
    // Cocher (`pay`) crée le paiement émis du jour lié à la facture ; décocher
    // le supprime tant qu'il n'est pas passé à la banque.
    schedule: {
      get: (params = {}) => get('/treasury/payment-schedule?' + new URLSearchParams(params)),
      pay: (achatId, data = {}) => post(`/treasury/payment-schedule/${achatId}/pay`, data),
      unpay: (achatId) => del(`/treasury/payment-schedule/${achatId}/pay`),
      defer: (achatId, data = {}) => put(`/treasury/payment-schedule/${achatId}/defer`, data),
      resume: (achatId) => del(`/treasury/payment-schedule/${achatId}/defer`),
      // La remarque ambre d'une ligne appartient au profil du fournisseur :
      // l'éditer ici écrit dans ce profil (donc partout où il est affiché).
      setParticularites: (achatId, particularites) =>
        put(`/treasury/payment-schedule/${achatId}/particularites`, { particularites }),
    },
    // Cartes de crédit à payer (Visa CAD / USD) : le solde n'arrive par aucun
    // canal automatique, montant et date se saisissent à la main.
    cardDues: {
      update: (id, data) => put(`/treasury/card-dues/${id}`, data),
      pay: (id, data) => post(`/treasury/card-dues/${id}/pay`, data),
      unpay: (id) => del(`/treasury/card-dues/${id}/pay`),
      dismiss: (id) => post(`/treasury/card-dues/${id}/dismiss`, {}),
      restore: (id) => del(`/treasury/card-dues/${id}/dismiss`),
    },
    // Plafond des cartes : question inverse de `cardDues` (« a-t-elle encore de
    // la place ? »). Solde QuickBooks + achats du relevé pas encore
    // comptabilisés, confrontés au plafond cible et au prélèvement du mois.
    cardCeilings: {
      list: ({ refresh = false } = {}) => get(`/treasury/card-ceilings${refresh ? '?refresh=1' : ''}`),
      create: (data) => post('/treasury/card-ceilings', data),
      update: (id, data) => patch(`/treasury/card-ceilings/${id}`, data),
      delete: (id) => del(`/treasury/card-ceilings/${id}`),
    },
    recurring: {
      list: () => get('/treasury/recurring'),
      create: (data) => post('/treasury/recurring', data),
      update: (id, data) => put(`/treasury/recurring/${id}`, data),
      delete: (id) => del(`/treasury/recurring/${id}`),
    },
    // Sync du Google Sheet « Maintien du solde disponible BNC » (le fichier
    // fait foi) : état de la dernière sync + déclenchement manuel.
    soldeSheet: {
      status: () => get('/treasury/solde-sheet/status'),
      sync: (dryRun = false) => post('/treasury/solde-sheet/sync', { dry_run: dryRun }),
      // Sync à l'ouverture de la page si le fichier n'a pas été lu depuis
      // `maxAgeMinutes` — l'utilisateur n'a plus à cliquer « Synchroniser ».
      syncIfStale: (maxAgeMinutes = 20) =>
        post('/treasury/solde-sheet/sync-if-stale', { max_age_minutes: maxAgeMinutes }),
    },
    // Ce que le relevé BNC apprend à la projection : montants et jours réels des
    // récurrentes, récurrentes introuvables au relevé, prélèvements périodiques
    // pas encore modélisés (propositions).
    learning: {
      get: (months) => get('/treasury/learning' + (months ? `?months=${months}` : '')),
      adopt: (suggestion) => post('/treasury/learning/adopt', suggestion),
    },
  },

  // Rapprochement bancaire (remplace TRX_Orisha.xlsx)
  bank: {
    accounts: () => get('/bank/accounts'),
    createAccount: (data) => post('/bank/accounts', data),
    updateAccount: (id, data) => patch(`/bank/accounts/${id}`, data),
    deleteAccount: (id) => del(`/bank/accounts/${id}`),
    transactions: (accountId) => get(`/bank/accounts/${accountId}/transactions`),
    import: (accountId, data) => post(`/bank/accounts/${accountId}/import`, data),
    imports: (accountId) => get(`/bank/accounts/${accountId}/imports`),
    automatch: (accountId) => post(`/bank/accounts/${accountId}/automatch`, {}),
    summary: (accountId) => get(`/bank/accounts/${accountId}/summary`),
    qbCompare: (accountId, params = {}) => {
      const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString()
      return get(`/bank/accounts/${accountId}/qb-compare${qs ? `?${qs}` : ''}`)
    },
    reconcileAuto: (accountId) => post(`/bank/accounts/${accountId}/reconcile-auto`, {}),
    qbAccounts: () => get('/bank/qb-accounts'),
    qbLink: (accountId) => post(`/bank/accounts/${accountId}/qb-link`, {}),
    suggestions: (txnId) => get(`/bank/transactions/${txnId}/suggestions`),
    match: (txnId, data) => post(`/bank/transactions/${txnId}/match`, data),
    reconcile: (ids, unreconcile = false) => post('/bank/transactions/reconcile', { ids, unreconcile }),
    updateTransaction: (id, data) => patch(`/bank/transactions/${id}`, data),
    deleteTransaction: (id) => del(`/bank/transactions/${id}`),
    trxSheetStatus: () => get('/bank/trx-sheet/status'),
    trxSheetSync: (dryRun = false) => post('/bank/trx-sheet/sync', { dryRun }),
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

  // Écritures de fin de mois : provisions mensuelles (crédit d'impôt R&D,
  // subvention salariale) et heures R&D importées des feuilles de temps.
  monthEnd: {
    month: (month) => get(`/month-end/month/${month}`),
    checks: (month) => get(`/month-end/month/${month}/checks`),
    provisions: () => get('/month-end/provisions'),
    series: (id, month) => get(`/month-end/provisions/${id}/series/${month}`),
    updateProvision: (id, data) => put(`/month-end/provisions/${id}`, data),
    updateMonth: (id, month, data) => put(`/month-end/provisions/${id}/months/${month}`, data),
    publish: (id, month) => post(`/month-end/provisions/${id}/months/${month}/publish`, {}),
    correct: (id, month) => post(`/month-end/provisions/${id}/months/${month}/correct`, {}),
    receipts: (id) => get(`/month-end/provisions/${id}/receipts`),
    addReceipt: (id, data) => post(`/month-end/provisions/${id}/receipts`, data),
    updateReceipt: (id, data) => put(`/month-end/receipts/${id}`, data),
    deleteReceipt: (id) => del(`/month-end/receipts/${id}`),
    regularizeSubsidy: (id) => post(`/month-end/provisions/${id}/regularize`, {}),
    scanBankReceipts: (id) => post(`/month-end/provisions/${id}/receipts/scan-bank`, {}),
    hours: (month) => get(`/month-end/hours/${month}`),
    importHours: (month) => post(`/month-end/hours/${month}/import`, {}),
    addHours: (data) => post('/month-end/hours', data),
    updateHours: (id, data) => put(`/month-end/hours/${id}`, data),
    deleteHours: (id) => del(`/month-end/hours/${id}`),
    // Déboursés de pièces : calcul depuis QuickBooks, fichier Drive, message Slack
    pieces: (month) => get(`/month-end/pieces/${month}`),
    piecesCompute: (month) => post(`/month-end/pieces/${month}/compute`, {}),
    piecesUpdate: (month, data) => put(`/month-end/pieces/${month}`, data),
    piecesSheet: (month) => post(`/month-end/pieces/${month}/sheet`, {}),
    piecesSlackPreview: (month) => get(`/month-end/pieces/${month}/slack`),
    piecesSlackSend: (month) => post(`/month-end/pieces/${month}/slack`, {}),
  },

  // Dettes à long terme : cédules de remboursement + comptabilisation QB
  marketingBudget: {
    expenses: (status = 'all') => get(`/marketing-budget/expenses?status=${status}`),
    decide: (id, status) => patch(`/marketing-budget/expenses/${id}`, { status }),
    never: (id, opts) => post(`/marketing-budget/expenses/${id}/never`, opts || {}),
    rules: () => get('/marketing-budget/rules'),
    createRule: (data) => post('/marketing-budget/rules', data),
    deleteRule: (id) => del(`/marketing-budget/rules/${id}`),
    sync: () => post('/marketing-budget/sync', {}),
    slackPreview: () => get('/marketing-budget/slack/preview'),
    slackSend: () => post('/marketing-budget/slack/send', {}),
    summary: (fy) => get(`/marketing-budget/summary?fy=${fy}`),
    setBudget: (data) => put('/marketing-budget/budget', data),
  },
  instagram: {
    weeks: (params = {}) => get('/instagram/weeks?' + new URLSearchParams(params)),
    update: (id, data) => patch(`/instagram/prospects/${id}`, data),
    remove: (id) => del(`/instagram/prospects/${id}`),
    scrape: (days) => post('/instagram/scrape', days ? { days } : {}),
    session: () => get('/instagram/session'),
    setSession: (data) => put('/instagram/session', data),
  },
  ltDebts: {
    list: () => get('/lt-debts'),
    create: (data) => post('/lt-debts', data),
    update: (id, data) => put(`/lt-debts/${id}`, data),
    delete: (id) => del(`/lt-debts/${id}`),
    payments: (id) => get(`/lt-debts/${id}/payments`),
    addPayment: (id, data) => post(`/lt-debts/${id}/payments`, data),
    importPayments: (id, rows, replace) => post(`/lt-debts/${id}/payments/import`, { rows, replace: replace === true }),
    generatePayments: (id, params) => post(`/lt-debts/${id}/payments/generate`, params),
    qbBalance: (id) => get(`/lt-debts/${id}/qb-balance`),
    // Les transactions QB liées aux versements publiés existent-elles encore ?
    qbCheck: (id) => get(`/lt-debts/${id}/qb-check`),
    updatePayment: (id, data) => put(`/lt-debts/payments/${id}`, data),
    deletePayment: (id) => del(`/lt-debts/payments/${id}`),
    markBooked: (id) => post(`/lt-debts/payments/${id}/mark-booked`, {}),
    unmarkBooked: (id) => post(`/lt-debts/payments/${id}/unmark-booked`, {}),
    publishPayment: (id) => post(`/lt-debts/payments/${id}/publish`, {}),
    unpublishPayment: (id, opts) => post(`/lt-debts/payments/${id}/unpublish`, opts || {}),
  },

  // Inventaire Drive — recensement décisionnel des documents de la comptabilité
  // encore tenus dans Google Drive (métadonnées seulement, aucun import).
  driveInventory: {
    list: () => get('/drive-inventory'),
    // Le recensement tourne en arrière-plan (plusieurs minutes) : `scan` rend la
    // main tout de suite, `status` suit la progression.
    scan: (accountEmail) => post('/drive-inventory/scan', accountEmail ? { account_email: accountEmail } : {}),
    status: () => get('/drive-inventory/status'),
    create: (data) => post('/drive-inventory/items', data),
    update: (id, data) => patch(`/drive-inventory/items/${id}`, data),
    updateTab: (id, data) => patch(`/drive-inventory/tabs/${id}`, data),
    remove: (id) => del(`/drive-inventory/items/${id}`),
  },

  // Import MAPAQ — exploitations agricoles en serre. `preview` ne fait que lire
  // et classer ; `createProspects` est le seul appel qui écrit, après cochage.
  mapaq: {
    preview: (opts) => post('/mapaq/preview', opts || {}),
    createProspects: (entries) => post('/mapaq/prospects', { entries }),
  },

  // Registre des entreprises du Québec — miroir local, en LECTURE SEULE côté
  // registre. Les seuls appels qui écrivent touchent l'ERP : `link` (le NEQ
  // porté par la fiche entreprise) et `createProspects`.
  // `getFresh` partout en lecture : la correspondance et la liste de prospects
  // changent dès qu'on lie un NEQ ou qu'on crée une entreprise, et le cache
  // prefetch (TTL 30 s) rendait l'écran aveugle à sa propre action.
  req: {
    status: () => getFresh('/req/status'),
    search: (q, limit) => getFresh(`/req/search?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ''}`),
    entreprise: (neq) => get(`/req/entreprises/${encodeURIComponent(neq)}`),
    match: (companyId) => getFresh(`/req/match/${companyId}`),
    link: (companyId, neq) => put(`/req/link/${companyId}`, { neq }),
    prospects: (params = {}) => {
      const qs = new URLSearchParams(
        Object.entries(params).filter(([, v]) => v !== '' && v != null),
      ).toString()
      return getFresh(`/req/prospects${qs ? `?${qs}` : ''}`)
    },
    createProspects: (neqs) => post('/req/prospects', { neqs }),
    import: (opts) => post('/req/import', opts || {}),
    removeEntreprise: (neq) => del(`/req/entreprises/${encodeURIComponent(neq)}`),
  },

  // Douanes — relevé CARM (GCRA) de l'ASFC + appariement aux reçus
  carm: {
    list: () => get('/carm/transactions'),
    import: (payload) => post('/carm/import', typeof payload === 'string' ? { text: payload } : payload),
    importPreview: (payload) => post('/carm/import/preview', typeof payload === 'string' ? { text: payload } : payload),
    // Comptabilisation : l'aperçu n'écrit rien, `post` pousse dans QuickBooks.
    postingsPreview: () => get('/carm/postings/preview'),
    postPostings: (groupIds) => post('/carm/postings/post', groupIds ? { group_ids: groupIds } : {}),
    skip: (id, reason) => post(`/carm/transactions/${id}/skip`, { reason }),
    unskip: (id) => post(`/carm/transactions/${id}/unskip`, {}),
    saveConfig: (patch) => put('/carm/config', patch),
    update: (id, data) => patch(`/carm/transactions/${id}`, data),
    delete: (id) => del(`/carm/transactions/${id}`),
    link: (id, saleReceiptId) => post(`/carm/transactions/${id}/link`, { sale_receipt_id: saleReceiptId }),
    unlink: (id) => post(`/carm/transactions/${id}/unlink`, {}),
  },

  // Abonnements fournisseurs (registre des charges récurrentes attendues)
  vendorSubscriptions: {
    list: (params = {}) => get('/vendor-subscriptions?' + new URLSearchParams(params)),
    get: (id) => get(`/vendor-subscriptions/${id}`),
    create: (data) => post('/vendor-subscriptions', data),
    update: (id, data) => put(`/vendor-subscriptions/${id}`, data),
    delete: (id) => del(`/vendor-subscriptions/${id}`),
    missingReceipts: () => get('/vendor-subscriptions/missing-receipts'),
    // Confirme qu'un nom de fournisseur QuickBooks désigne bien ce fournisseur :
    // enregistré comme alias, il sera reconnu par les analyses suivantes.
    // Poser deux fois le même alias ne fait rien de plus → rejouable sans risque.
    linkVendor: (id, vendor) => postIdempotent(`/vendor-subscriptions/${id}/link-vendor`, { vendor }),
  },

  // Profils fournisseurs — défauts comptables par fournisseur (vendor QB par devise,
  // comptes, statut fiscal, code de taxe, termes de paiement), appris à chaque push QB.
  // Collecte de factures sur les portails fournisseurs (Amazon, Wix) — pour les
  // fournisseurs qui n'envoient rien par courriel et n'ont pas d'API.
  scrapers: {
    list: () => get('/scrapers'),
    runs: (accountId) => get(`/scrapers/runs${accountId ? `?account_id=${accountId}` : ''}`),
    documents: () => get('/scrapers/documents'),
    needs: () => get('/scrapers/needs'),
    needForTransaction: (txnId) => get(`/scrapers/needs/transaction/${txnId}`),
    collectForTransaction: (txnId) => post(`/scrapers/needs/transaction/${txnId}/collect`, {}),
    create: (data) => post('/scrapers/accounts', data),
    update: (id, data) => patch(`/scrapers/accounts/${id}`, data),
    remove: (id) => del(`/scrapers/accounts/${id}`),
    run: (id) => post(`/scrapers/accounts/${id}/run`, {}),
    runAll: () => post('/scrapers/run-all', {}),
    otp: (id, code) => post(`/scrapers/accounts/${id}/otp`, { code }),
    forgetSession: (id) => post(`/scrapers/accounts/${id}/forget-session`, {}),
    importSession: (id, payload) => post(`/scrapers/accounts/${id}/session`, { payload }),
    artifactUrl: (runId, name) =>
      `/erp/api/scrapers/runs/${runId}/artifacts/${name}?token=${encodeURIComponent(localStorage.getItem('erp_token') || '')}`,
  },

  vendorProfiles: {
    list: () => get('/vendor-profiles'),
    create: (data) => post('/vendor-profiles', data),
    update: (id, data) => patch(`/vendor-profiles/${id}`, data),
    delete: (id) => del(`/vendor-profiles/${id}`),
    seed: () => post('/vendor-profiles/seed', {}),
    duplicates: () => get('/vendor-profiles/duplicates'),
    merge: (targetId, sourceIds) => post(`/vendor-profiles/${targetId}/merge`, { sourceIds }),
    // « Pas un doublon » persistant : le groupe (ids) n'est plus re-proposé tant que
    // sa composition ne change pas. undismiss = ré-activer la détection (id du dismissal).
    dismissDuplicates: (ids) => post('/vendor-profiles/duplicates/dismiss', { ids }),
    undismissDuplicates: (dismissalId) => del(`/vendor-profiles/duplicates/dismissals/${dismissalId}`),
  },

  // Pièces jointes polymorphes — attachables à n'importe quelle entité
  // (entityType ∈ companies|contacts|orders|tickets|projects|products|…).
  attachments: {
    list: (entityType, entityId) => get(`/attachments/${entityType}/${entityId}`),
    upload: (entityType, entityId, files) => {
      const fd = new FormData()
      for (const f of files) fd.append('file', f)
      return uploadRequest(`/attachments/${entityType}/${entityId}`, fd)
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

  // Travaux : file de prompts, suggestions de l'agent, carnet d'idées, travaux
  // récurrents.
  // Les listes sont pollées via getFresh (pas de cache) : la file change en
  // arrière-plan à chaque fin d'exécution, un cache de 30 s la ferait mentir.
  travaux: {
    // `space` sépare les deux files : 'finance' (Espace finance) / 'agent' (section Agent).
    listPrompts:   (params = {}) => getFresh('/travaux/prompts' + (Object.keys(params).length ? '?' + new URLSearchParams(params) : '')),
    createPrompt:  (data)      => post('/travaux/prompts', data),
    updatePrompt:  (id, data)  => patch(`/travaux/prompts/${id}`, data),
    deletePrompt:  (id)        => del(`/travaux/prompts/${id}`),
    reorderPrompts:(ids)       => post('/travaux/prompts/reorder', { ids }),
    promptFirst:   (id)        => post(`/travaux/prompts/${id}/first`, {}),
    advanceQueue:  ()          => post('/travaux/prompts/advance', {}),
    // Pause de la file : rien de nouveau ne démarre, l'exécution en cours va au bout.
    getQueuePause: ()          => getFresh('/travaux/queue/pause'),
    setQueuePaused:(paused, reason) => post('/travaux/queue/pause', { paused, reason }),
    listMessages:  (id)        => getFresh(`/travaux/prompts/${id}/messages`),
    // placement : 'front' (défaut) = la tâche repart tout de suite ; 'back' = elle
    // retourne en fin de file et repartira quand son tour reviendra.
    replyToPrompt: (id, text, placement)  => post(`/travaux/prompts/${id}/reply`, { text, ...(placement ? { placement } : {}) }),
    // Steering : message livré à Claude PENDANT l'exécution, sans l'interrompre.
    steerPrompt:   (id, text)  => post(`/travaux/prompts/${id}/message`, { text }),

    listSuggestions:  (params = {}) => getFresh('/travaux/suggestions?' + new URLSearchParams(params)),
    acceptSuggestion: (id, prompt, space, priority) => post(`/travaux/suggestions/${id}/accept`, {
      ...(prompt ? { prompt } : {}), ...(space ? { space } : {}), ...(priority ? { priority: true } : {}),
    }),
    dismissSuggestion:(id, reason)  => post(`/travaux/suggestions/${id}/dismiss`, { reason }),
    deleteSuggestion: (id)          => del(`/travaux/suggestions/${id}`),
    // Sans `kind`, le serveur passe les deux moteurs (chantiers + intégrations).
    generateSuggestions: (kind)     => post('/travaux/suggestions/generate', kind ? { kind } : {}),
    // Discussion d'une suggestion (chantier ou intégration) : échange en lecture
    // seule à côté de la carte — rien ne part en exécution par ce chemin.
    listSuggestionMessages: (id)       => getFresh(`/travaux/suggestions/${id}/messages`),
    askSuggestion:          (id, text) => post(`/travaux/suggestions/${id}/messages`, { text }),

    // Carnet d'idées : rien ne s'exécute d'ici ; `promoteIdea` dépose un item de
    // file « de côté », à lancer à la main.
    listIdeas:    ()         => getFresh('/travaux/ideas'),
    createIdea:   (data)     => post('/travaux/ideas', data),
    updateIdea:   (id, data) => patch(`/travaux/ideas/${id}`, data),
    deleteIdea:   (id)       => del(`/travaux/ideas/${id}`),
    reorderIdeas: (ids)      => post('/travaux/ideas/reorder', { ids }),
    promoteIdea:  (id, space) => post(`/travaux/ideas/${id}/promote`, space ? { space } : {}),

    listRecurring:   (params = {}) => getFresh('/travaux/recurring?' + new URLSearchParams(params)),
    createRecurring: (data)        => post('/travaux/recurring', data),
    updateRecurring: (id, data)    => patch(`/travaux/recurring/${id}`, data),
    deleteRecurring: (id)          => del(`/travaux/recurring/${id}`),
    setCompletion:   (id, data)    => post(`/travaux/recurring/${id}/completion`, data),
    listCompletions: (id)          => getFresh(`/travaux/recurring/${id}/completions`),
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

  // Taux de change Banque du Canada (référence du calculateur de conversion)
  fx: {
    rate: (date, pair = 'USDCAD') => get('/fx/rate?' + new URLSearchParams({ date, pair })),
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
    // Achats LIA rapprochables : suggestion par ligne + candidats du même fournisseur.
    liaMatches: (id) => get(`/sale-receipts/${id}/lia-matches`),
    pushToQb: (id, params) => post(`/sale-receipts/${id}/push-to-qb`, params),
    // Relevé mensuel d'un fournisseur prépayé : joint le document aux transactions
    // QB du mois couvert (aucune comptabilisation).
    attachToMonthQb: (id, month) => post(`/sale-receipts/${id}/attach-to-month-qb`, { month }),
    reExtract: (id) => post(`/sale-receipts/${id}/re-extract`),
    upload: (formData) => uploadRequest('/sale-receipts/upload', formData),
  },

  // Anomalies transactionnelles (doublons, montants hors norme, devise incohérente)
  // Journal des nouveautés — état de la garde « toute modif est documentée »
  changelog: {
    status: () => get('/changelog/status'),
  },

  anomalies: {
    list: (params = {}) => get('/anomalies?' + new URLSearchParams(params)),
    dismiss: (id, reason) => post(`/anomalies/${id}/dismiss`, { reason }),
    reopen: (id) => post(`/anomalies/${id}/reopen`),
    scan: () => post('/anomalies/scan', {}),
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
    upload: (formData) => uploadRequest('/public-files/upload', formData),
    // Remplace le contenu d'un fichier en conservant son lien public (token).
    replace: (id, formData) => uploadRequest(`/public-files/${id}/replace`, formData),
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

  // Météo au site (GeoMet ECCC / National Weather Service) — lecture seule.
  weather: {
    get: (companyId, at, signal) => {
      const qs = new URLSearchParams({ companyId })
      if (at) qs.set('at', at)
      return getAbortable(`/weather?${qs}`, signal)
    },
  },

  stripeInvoiceItems: {
    list: (params = {}) => get('/stripe-invoice-items?' + new URLSearchParams(params)),
    get: (id) => get(`/stripe-invoice-items/${id}`),
    update: (id, data) => patch(`/stripe-invoice-items/${id}`, data),
  },

}

export default api
