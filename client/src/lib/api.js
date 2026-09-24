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
  // Créer / modifier / supprimer un champ change aussi les colonnes ERP servies
  // par le mapping Airtable (/connectors/.../mapping-data). Sans cette purge, la
  // cellule « Champ Airtable » d'un champ fraîchement créé restait vide jusqu'à
  // expiration du cache (TTL 30 s) ou rechargement de la page — impossible de le
  // mapper tout de suite.
  if (resource === 'custom-fields') invalidate('/connectors')
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

// Téléchargement binaire (PDF, images…) avec le token porté en header —
// à utiliser au lieu d'un fetch brut + localStorage.getItem('erp_token').
// (Pour un <iframe src> ou window.open, le header est impossible : ces
// cas-là passent par `?token=` en query param, accepté par le middleware.)
export async function apiBlob(path) {
  const token = getToken()
  const res = await fetch(`${BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    const err = new Error(data.error || `HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  return res.blob()
}

// Idem, mais rend aussi le nom de fichier annoncé par le serveur
// (Content-Disposition) : utile quand le nom ne se déduit pas de l'URL
// (pièces jointes de courriel, dont l'URL ne porte qu'un id).
export async function apiBlobNamed(path) {
  const token = getToken()
  const res = await fetch(`${BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || `HTTP ${res.status}`)
  }
  const cd = res.headers.get('content-disposition') || ''
  const m = cd.match(/filename="?([^";]+)"?/i)
  return { blob: await res.blob(), filename: m ? m[1] : 'piece-jointe' }
}

export const api = {
  // Jauges IA de la barre de gauche (tous les utilisateurs) : caches serveur seulement.
  aiUsage: () => getFresh('/ai-usage'),
  // Auth
  auth: {
    login: (email, password) => post('/auth/login', { email, password }),
    setup: (data) => post('/auth/setup', data),
    me: () => getFresh('/auth/me'),
    users: () => get('/auth/users'),
    changePassword: (current_password, new_password) => post('/auth/change-password', { current_password, new_password }),
    forgotPassword: (email) => post('/auth/forgot-password', { email }),
    checkReset: (token) => post('/auth/reset-password/check', { token }),
    resetPassword: (token, password) => post('/auth/reset-password', { token, password }),
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
    tickets: (id) => get(`/companies/${id}/tickets`),
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
    emailAttachments: (id) => get(`/contacts/${id}/email-attachments`),
    downloadEmailAttachment: (id, attId) => apiBlobNamed(`/contacts/${id}/email-attachments/${attId}/download`),
  },

  // Projects
  projects: {
    list: (params = {}) => get('/projects?' + new URLSearchParams(params)),
    get: (id) => get(`/projects/${id}`),
    create: (data) => post('/projects', data),
    update: (id, data) => put(`/projects/${id}`, data),
    updateStatus: (id, status) => patch(`/projects/${id}/status`, { status }),
    delete: (id) => del(`/projects/${id}`),
    vendeurOptions: () => get('/projects/vendeur-options'),
    commissions: (id) => get(`/projects/${id}/commissions`),
    commissionBeneficiaries: () => get('/projects/commission-beneficiaries'),
    addCommission: (id, data) => post(`/projects/${id}/commissions`, data),
  },

  // Products
  products: {
    list: (params = {}) => get('/products?' + new URLSearchParams(params)),
    get: (id) => get(`/products/${id}`),
    create: (data) => post('/products', data),
    update: (id, data) => put(`/products/${id}`, data),
    adjustStock: (id, data) => post(`/products/${id}/stock`, data),
    // Achats (PO Airtable) qui citent cette pièce — tableau « Achats » de la fiche.
    purchases: (id) => get(`/products/${id}/purchases`),
    purchasePrefill: (id) => get(`/products/${id}/purchases/prefill`),
    createPurchase: (id, data) => post(`/products/${id}/purchases`, data),
    syncPurchase: (id, purchaseId) => post(`/products/${id}/purchases/${purchaseId}/sync`, {}),
    delete: (id) => del(`/products/${id}`),
    // Ce qui empêche la suppression (BOM, envois, achats liés) — sert à griser
    // le bouton avant même de tenter le DELETE (qui répond 409).
    // getFresh : le verdict change dès qu'un BOM/envoi/achat bouge ailleurs,
    // le cache 30 s du prefetch le rendrait faux.
    deleteCheck: (id) => getFresh(`/products/${id}/delete-check`),
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
    // Image de la fiche : jusqu'ici elle ne pouvait venir que du miroir Airtable.
    uploadImage: (id, file) => {
      const fd = new FormData()
      fd.append('file', file)
      return uploadRequest(`/products/${id}/image`, fd)
    },
    deleteImage: (id) => del(`/products/${id}/image`),
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
    unpickItem: (orderId, itemId, data) => post(`/orders/${orderId}/items/${itemId}/unpick`, data),
    duplicateItem: (orderId, itemId) => post(`/orders/${orderId}/items/${itemId}/duplicate`, {}),
    reorderItems: (orderId, order) => patch(`/orders/${orderId}/items/reorder`, order),
    deleteItem: (orderId, itemId) => del(`/orders/${orderId}/items/${itemId}`),
    scan: (orderId, value, mode = 'add', confirm = false) => post(`/orders/${orderId}/scan`, { value, mode, confirm }),
    // Recalcule et re-gèle le coût des lignes déjà envoyées (Pièces + valeur de
    // fabrication de chaque numéro de série).
    recomputeShippedCosts: (id) => post(`/orders/${id}/recompute-shipped-costs`, {}),
    delete: (id) => del(`/orders/${id}`),
    generateBonLivraison: (id) => post(`/orders/${id}/bon-livraison`, {}),
    // lang : 'fr' | 'en' pour forcer la langue des documents ; sans valeur, le
    // serveur prend celle du contact de l'adresse de livraison.
    generateInstallationDocsBlob: async (id, lang) => {
      const token = localStorage.getItem('erp_token')
      const headers = { 'Content-Type': 'application/json' }
      if (token) headers['Authorization'] = `Bearer ${token}`
      const res = await fetch(`${BASE}/orders/${id}/generate-installation-docs`, {
        method: 'POST', headers, body: JSON.stringify(lang ? { lang } : {}),
      })
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
        lang: res.headers.get('X-Docs-Lang') || null,
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
    list: (params = {}) => get('/tickets?' + new URLSearchParams(params)),
    ids: () => get('/tickets/ids'),
    // Options du champ « Mots clés » : valeurs distinctes déjà utilisées, les
    // plus fréquentes en tête.
    keywords: () => get('/tickets/keywords'),
    get: (id, signal) => signal ? getAbortable(`/tickets/${id}`, signal) : get(`/tickets/${id}`),
    create: (data) => post('/tickets', data),
    update: (id, data) => put(`/tickets/${id}`, data),
    delete: (id) => del(`/tickets/${id}`),
    // Sondage de satisfaction par SMS. Numéro et langue se saisissent à l'envoi
    // (un billet ne porte plus de contact) ; un renvoi peut les omettre.
    survey: (id) => get(`/tickets/${id}/survey`),
    sendSurvey: (id, { phone = null, language = null } = {}) =>
      post(`/tickets/${id}/survey`, { ...(phone ? { phone } : {}), ...(language ? { language } : {}) }),
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
    revenueByMonth: (params = {}) => get('/dashboard/revenue-by-month?' + new URLSearchParams(params)),
    incomeStatement: (params = {}) => get('/dashboard/income-statement?' + new URLSearchParams(params)),
    productivity: (params = {}) => get('/dashboard/productivity?' + new URLSearchParams(params)),
    deferredRevenue: () => get('/dashboard/deferred-revenue'),
    agingReceivables: () => get('/dashboard/aging-receivables'),
  },

  // Admin
  admin: {
    employeeOptions: () => get('/admin/employee-options'),
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

  // Configuration des formulaires d'ajout de record (mode édition du formulaire).
  formConfigs: {
    get: (table) => get(`/form-configs/${encodeURIComponent(table)}`),
    save: (table, fields) => put(`/form-configs/${encodeURIComponent(table)}`, { fields }),
    // Catalogue des champs du registre proposables en plus de ceux déclarés par
    // la page (cf. server/src/services/formFieldCatalog.js).
    availableFields: (table) => get(`/form-configs/${encodeURIComponent(table)}/fields`),
  },

  // Interactions
  interactions: {
    list: (params = {}, signal) => signal
      ? getAbortable('/interactions?' + new URLSearchParams(params), signal)
      : get('/interactions?' + new URLSearchParams(params)),
    get: (id) => get(`/interactions/${id}`),
    create: (data) => post('/interactions', data),
    emailBody: (id) => get(`/interactions/${id}/email-body`),
    attachments: (id) => get(`/interactions/${id}/attachments`),
    downloadAttachment: (id, attId) => apiBlobNamed(`/interactions/${id}/attachments/${attId}/download`),
    pin: (id, pinned) => patch(`/interactions/${id}/pin`, { pinned }),
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
    sessionHealth: () => getFresh('/connectors/session-health'),
    manychat: () => getFresh('/connectors/manychat'),
    saveManychat: (data) => put('/connectors/manychat', data),
    importManychatSession: (payload) => post('/connectors/manychat/session', { payload }),
    checkSession: (connector) => post('/connectors/session-health/check', { connector }),
    disconnect: (id) => del(`/connectors/accounts/${id}`),
    saveConfig: (connector, data) => put(`/connectors/config/${connector}`, data),
    syncGmail: () => post('/connectors/sync/gmail'),
    gmailAccounts: () => get('/connectors/gmail/accounts'),
    gmailMyMailbox: () => getFresh('/connectors/google/my-mailbox'),
    gmailDisconnectMine: () => del('/connectors/google/my-mailbox'),
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

  // Plaid — connexion bancaire directe (rapprochement en temps quasi réel)
  plaid: {
    status: () => get('/plaid/status'),
    linkToken: () => post('/plaid/link-token'),
    exchange: (public_token) => post('/plaid/exchange', { public_token }),
    linkAccount: (bankAccountId, plaid_account_id, plaid_item_id) =>
      post(`/plaid/accounts/${bankAccountId}/link`, { plaid_account_id, plaid_item_id }),
    sync: (itemId) => post(`/plaid/sync/${itemId}`),
    // État par compte : fraîcheur, comptes mappés mais vides, santé vue de
    // chez Plaid (la banque répond-elle encore ?).
    syncStatus: () => get('/plaid/sync-status'),
    // Relit tout l'historique disponible (compte mappé après coup).
    resetCursor: (itemId) => post(`/plaid/items/${itemId}/reset-cursor`, {}),
    // Demande à la banque d'être interrogée tout de suite.
    refresh: (itemId) => post(`/plaid/items/${itemId}/refresh`, {}),
    removeItem: (itemId) => del(`/plaid/items/${itemId}`),
  },

  // Venn — deuxième banque (CAD + USD), en LECTURE SEULE : comptes, soldes et
  // transactions. Aucun paiement n'est jamais émis d'ici.
  venn: {
    status: () => get('/venn/status'),
    saveConfig: (data) => put('/venn/config', data),
    deleteConfig: () => del('/venn/config'),
    test: () => post('/venn/test'),
    accounts: () => get('/venn/accounts'),
    linkAccount: (bankAccountId, venn_account_id) =>
      post(`/venn/accounts/${bankAccountId}/link`, { venn_account_id }),
    sync: (body = {}) => post('/venn/sync', body),
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
    returnRates: (returnId, data) => post(`/ups/returns/${returnId}/rates`, data),
    createReturnLabel: (returnId, data) => post(`/ups/returns/${returnId}/return-label`, data),
    sendReturnLabel: (returnId, to) => post(`/ups/returns/${returnId}/return-label/send`, { to }),
    shipmentRates: (shipmentId, data) => post(`/ups/shipments/${shipmentId}/rates`, data),
    trackShipment: (shipmentId) => post(`/ups/shipments/${shipmentId}/track`),
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
    // Table lue en direct dans Airtable (hors miroir) : son mapping fixé en code,
    // affiché en lecture seule sur /champs. `null` si la table n'en est pas une.
    directSource: (table) => get(`/connectors/airtable/direct-source/${table}`),
    // Purge le cache serveur des métadonnées Airtable (60 s) : « Rafraîchir » au
    // bas des sélecteurs de champ, pour voir un champ tout juste créé côté
    // Airtable. À enchaîner avec un rechargement des données du picker.
    refreshSchema: (module) => post('/connectors/airtable/schema-refresh', { module: module || null }),
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
    // Relit les choix de la Sélection Airtable qui alimente la colonne et
    // complète la liste du champ (ajout seulement). Sert à l'ouverture de la
    // modale de champ : une option ajoutée dans Airtable n'entrait dans la
    // liste qu'au prochain sync complet.
    airtableChoices: (erpTable, column) =>
      post(`/custom-fields/${encodeURIComponent(erpTable)}/choices/${encodeURIComponent(column)}/from-airtable`, {}),
    lookupMeta: (erpTable) => get(`/custom-fields/_meta/${erpTable}`),
    // Adopte une colonne physique déjà existante (mapping Airtable, ou
    // orpheline) plutôt que d'en créer une nouvelle — pas d'ALTER TABLE.
    adopt: (erpTable, data) => post(`/custom-fields/${erpTable}/adopt`, data),
    // Duplique un champ (structure + valeurs par défaut). La copie n'hérite
    // jamais du lien vers une source externe — voir la route serveur.
    duplicate: (erpTable, data) => post(`/custom-fields/${erpTable}/duplicate`, data),
    // Suppression d'un champ natif : la ligne part à la corbeille et le champ
    // disparaît de partout (le drapeau garde son nom historique `hidden`, c'est
    // ainsi que le serveur republie les champs supprimés). `label` sert de
    // libellé dans la corbeille — le serveur ignore tableDefs.js.
    setNativeHidden: (erpTable, fieldId, hidden, label) =>
      patch(`/custom-fields/${encodeURIComponent(erpTable)}/native/${encodeURIComponent(fieldId)}/hidden`, { hidden, label }),
    // Champ de type « Attachement » : les fichiers s'écrivent par leur route
    // dédiée, qui met la cellule à jour elle-même et renvoie la nouvelle liste.
    files: {
      list: (fieldId, recordId) => get(`/custom-field-files/${fieldId}/${recordId}`),
      upload: (fieldId, recordId, fileList) => {
        const fd = new FormData()
        for (const f of fileList) fd.append('file', f)
        return uploadRequest(`/custom-field-files/${fieldId}/${recordId}`, fd)
      },
      remove: (fieldId, recordId, fileId) =>
        del(`/custom-field-files/${fieldId}/${recordId}/${encodeURIComponent(fileId)}`),
    },
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
    // « Autoriser la suppression de la fiche » (mode de personnalisation) :
    // true/false, ou null pour revenir au comportement d'origine de la fiche.
    setDetailDeleteAllowed: (entityType, allow_delete) => put(`/views/detail/${entityType}`, { allow_delete }),
  },

  // Purchases
  purchases: {
    list: (params = {}) => get('/purchases?' + new URLSearchParams(params)),
    get: (id) => get(`/purchases/${id}`),
    create: (data) => post('/purchases', data),
    update: (id, data) => patch(`/purchases/${id}`, data),
    delete: (id) => del(`/purchases/${id}`),
    liaLinks: (params) => get('/purchases/lia-links?' + new URLSearchParams(params)),
  },

  // Serials
  serials: {
    list: (params = {}) => get('/serials?' + new URLSearchParams(params)),
    get: (id) => get(`/serials/${id}`),
    // N'accepte que `product_id` côté serveur (lier / délier le produit).
    update: (id, data) => patch(`/serials/${id}`, data),
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
    // Revérifie une seule adresse et renvoie la ligne à jour.
    recheck: (id) => post(`/projets/adresses/${id}/check`, {}),
    // Confirmation auprès de l'API d'adresses (livraison / ferme).
    // `confirmInput` porte une adresse SAISIE, avant enregistrement.
    confirmInput: (data) => post('/projets/adresses/confirm', data),
    reconfirm: (id) => post(`/projets/adresses/${id}/confirm`, {}),
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
    create: (data) => post('/projets/assemblages', data),
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
    pdfBlob: (id) => apiBlob(`/projets/factures/${id}/pdf`),
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
    updateDepositLink: (id, data) => patch(`/payments/${id}/deposit-link`, data),
    qbLinkSuggestions: (id) => get(`/payments/${id}/qb-link-suggestions`),
    qbCreditAccount: (id) => get(`/payments/${id}/qb-credit-account`),
    delete: (id) => del(`/payments/${id}`),
  },

  // Retours
  retours: {
    list: (params = {}) => get('/projets/retours?' + new URLSearchParams(params)),
    get: (id) => get(`/projets/retours/${id}`),
    // Édition d'un retour / d'un de ses articles : seuls les champs réglés en
    // « Bidirectionnel » (ou sans import Airtable) sont acceptés — les autres
    // reviennent en 400, leur valeur serait écrasée au prochain sync.
    update: (id, data) => patch(`/projets/retours/${id}`, data),
    updateItem: (itemId, data) => patch(`/projets/retours/items/${itemId}`, data),
    // Réception au pistolet : le code scanné pose la date et le réceptionniste
    // sur l'article, et rend la phrase à afficher (étagère d'analyse ou de
    // reconditionnement).
    receiveScan: (id, data) => post(`/retours/${id}/receive-scan`, data),
    context: (id, addressId) => get(`/retours/${id}/return-context${addressId ? `?address_id=${addressId}` : ''}`),
    getRates: (id, data) => post(`/retours/${id}/return-rates`, data),
    createLabel: (id, data) => post(`/retours/${id}/return-label`, data),
    retryLabelPdf: (id) => post(`/retours/${id}/return-label/retry-pdf`),
    diagnostic: (id, data) => post(`/retours/${id}/diagnostic`, data),
    generateMemo: (id) => post(`/retours/${id}/memo`),
    instructionsEmail: (id) => get(`/retours/${id}/instructions-email`),
    sendInstructions: (id, data) => post(`/retours/${id}/send-instructions`, data),
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
    delete: (id, { force } = {}) => del(`/employees/${id}${force ? '?force=1' : ''}`),
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

  // Journal des problèmes d'opérations (/problemes-operations).
  opsIssues: {
    list: (params = {}) => get('/ops-issues?' + new URLSearchParams(params)),
    get: (id) => get(`/ops-issues/${id}`),
    create: (data) => post('/ops-issues', data),
    update: (id, data) => patch(`/ops-issues/${id}`, data),
    delete: (id) => del(`/ops-issues/${id}`),
  },

  discoveryForms: {
    list: (params = {}) => get('/discovery-forms?' + new URLSearchParams(params)),
    get: (id) => get(`/discovery-forms/${id}`),
    create: (data) => post('/discovery-forms', data),
    delete: (id) => del(`/discovery-forms/${id}`),
    equipmentPreview: (id) => get(`/discovery-forms/${id}/equipment-preview`),
    saveAddresses: (id, data) => patch(`/discovery-forms/${id}/addresses`, data),
    saveOptions: (id, form_options) => patch(`/discovery-forms/${id}/options`, { form_options }),
    saveVerification: (id, verification) => patch(`/discovery-forms/${id}/verification`, { verification }),
    createOrder: (id) => post(`/discovery-forms/${id}/create-order`, {}),
    // Accès public au formulaire via short token (sans auth) — utilisé par la page client.
    getByToken: (token) => fetch(`/erp/api/customer/post-payment/by-token/${encodeURIComponent(token)}`).then(r => r.json()),
    saveByToken: (token, body) => fetch(`/erp/api/customer/post-payment/by-token/${encodeURIComponent(token)}/save`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then(r => r.json()),
    submitByToken: (token) => fetch(`/erp/api/customer/post-payment/by-token/${encodeURIComponent(token)}/submit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
    }).then(r => r.json()),
  },

  // Calque de surcharges du formulaire de découverte (éditeur System builder).
  discoveryFormSchema: {
    uploadImage: (file) => {
      const data = new FormData()
      data.append('file', file)
      return uploadRequest('/discovery-form-schema/images', data)
    },
    get: () => get('/discovery-form-schema'),
    save: (schema) => put('/discovery-form-schema', { schema }),
    reset: () => del('/discovery-form-schema'),
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
    getPreferences: (params = {}) => get('/timesheets/preferences?' + new URLSearchParams(params)),
    updatePreferences: (data) => patch('/timesheets/preferences', data),
    // Mode semaine : un seul total par semaine (clé = lundi ISO, déduit de `date`)
    getWeek: (params = {}) => get('/timesheets/week?' + new URLSearchParams(params)),
    listWeeks: (params = {}) => get('/timesheets/weeks?' + new URLSearchParams(params)),
    saveWeek: (data) => put('/timesheets/week', data),
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
    // Le débit de la paie au relevé bancaire (montant et date à proposer).
    salaryExpenseBankDebit: (id) => get(`/paies/${id}/salary-expense/bank-debit`),
    agaRepartitionPreview: (amount, txn_date = null) => post('/paies/aga-repartition/preview', { amount, txn_date }),
    agaRepartitionPush: (amount, txn_date = null, bank_txn_id = null) => post('/paies/aga-repartition/push', { amount, txn_date, bank_txn_id }),
    agaBankDebit: () => get('/paies/aga-repartition/bank-debit'),
    saveSyncConfig: (data) => put('/connectors/airtable/module-config/paies', data),
    sync: () => post('/connectors/sync/paies'),
    syncItems: () => post('/connectors/sync/paie_items'),
    importTimesheets: (id) => post(`/paies/${id}/import-timesheets`, {}),
  },

  // Stock movements (mouvements d'inventaire)
  stockMovements: {
    list: (params = {}) => get('/stock-movements?' + new URLSearchParams(params)),
  },

  // Achats de fournitures (miroir Airtable « Fournitures » + « Achats fournitures »)
  fournitures: {
    list: () => get('/fournitures'),
    createAchat: (data) => post('/fournitures/achats', data),
    updateAchat: (id, data) => patch(`/fournitures/achats/${id}`, data),
    get: (id) => get(`/fournitures/${id}`),
    create: (data) => post('/fournitures', data),
    update: (id, data) => patch(`/fournitures/${id}`, data),
    delete: (id) => del(`/fournitures/${id}`),
    sync: () => post('/fournitures/sync', {}),
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
    trackingEmailPreview: (id) => get(`/shipments/${id}/tracking-email`),
    sendTracking: (id, data) => post(`/shipments/${id}/send-tracking`, data),
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
    // Lecture immédiate du solde à la banque (la sync Plaid le fait déjà aux
    // 30 min ; ce bouton évite d'attendre le prochain passage).
    refreshBalanceFromBank: () => post('/treasury/balance/refresh-from-bank', {}),
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
      // Renvoie l'écriture de paiement dans QuickBooks quand l'envoi
      // automatique a échoué ou avait été écarté.
      qbPush: (id) => post(`/treasury/payments/${id}/qb-push`, {}),
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
    // Dépôt de relevés : des fichiers entrent, un aperçu en sort, et rien
    // n'est écrit avant le commit.
    statements: {
      upload: (formData) => uploadRequest('/bank/statements/upload', formData),
      list: () => getFresh('/bank/statements'),
      // getFresh : l'aperçu est interrogé en boucle pendant la lecture.
      get: (id) => getFresh(`/bank/statements/${id}`),
      setAccount: (id, accountId) => patch(`/bank/statements/${id}`, { account_id: accountId }),
      reanalyze: (id) => post(`/bank/statements/${id}/reanalyze`, {}),
      // Le fichier déposé est une facture, pas un relevé : il part à
      // l'extraction de données.
      toReceipt: (id) => post(`/bank/statements/${id}/to-receipt`, {}),
      commit: (id, rows = null) => post(`/bank/statements/${id}/commit`, rows ? { rows } : {}),
      remove: (id) => del(`/bank/statements/${id}`),
    },
    automatch: (accountId) => post(`/bank/accounts/${accountId}/automatch`, {}),
    summary: (accountId) => get(`/bank/accounts/${accountId}/summary`),
    qbCompare: (accountId, params = {}) => {
      const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString()
      return get(`/bank/accounts/${accountId}/qb-compare${qs ? `?${qs}` : ''}`)
    },
    // « Mettre à jour » : le seul bouton d'action de /rapprochement — apparier
    // aux documents, vérifier dans QuickBooks, recalculer l'écart.
    updateAll: (accountId) => post(`/bank/accounts/${accountId}/update-all`, {}),
    qbAudit: (accountId, sinceDays = null) => post(`/bank/accounts/${accountId}/qb-audit`, { sinceDays }),
    qbAccounts: () => get('/bank/qb-accounts'),
    suggestions: (txnId) => get(`/bank/transactions/${txnId}/suggestions`),
    // Vue QuickBooks : le geste qu'attend chaque ligne du compte (virement,
    // appariement, publication), en un seul appel.
    nextActions: (accountId) => getFresh(`/bank/accounts/${accountId}/next-actions`),
    match: (txnId, data) => post(`/bank/transactions/${txnId}/match`, data),
    publishMatched: (txnId) => post(`/bank/transactions/${txnId}/publish-matched`, {}),
    // « X » : envoyer la ligne à la relecture de Michel (recopié au classeur).
    setReview: (txnId, on) => post(`/bank/transactions/${txnId}/review`, { on }),
    // Encaissement client : chercher soi-même la facture quand la détection
    // n'a pas tranché.
    invoiceSearch: (txnId, q) => get(`/bank/transactions/${txnId}/invoice-search?q=${encodeURIComponent(q)}`),
    receiptSearch: (txnId, q) => get(`/bank/transactions/${txnId}/receipt-search?q=${encodeURIComponent(q)}`),
    // « Ajouter » : comptabiliser une ligne qui n'aura jamais de facture.
    addDefaults: (txnId) => get(`/bank/transactions/${txnId}/add-defaults`),
    taxCodeRate: (taxCodeId) => get(`/bank/tax-code-rate/${taxCodeId}`),
    addExpense: (txnId, data) => post(`/bank/transactions/${txnId}/add-expense`, data),
    // « Transfert » : les deux moitiés d'un mouvement interne.
    transferCandidates: (txnId) => get(`/bank/transactions/${txnId}/transfer-candidates`),
    transfer: (txnId, data) => post(`/bank/transactions/${txnId}/transfer`, data),
    unlinkTransfer: (txnId) => del(`/bank/transactions/${txnId}/transfer`),
    reconcile: (ids, unreconcile = false) => post('/bank/transactions/reconcile', { ids, unreconcile }),
    // L'écriture QuickBooks de la ligne, mise en forme comme QuickBooks
    // l'affiche — pour confirmer l'appariement sans ouvrir QBO.
    qbEntry: (txnId) => getFresh(`/bank/transactions/${txnId}/qb-entry`),
    clearQbLink: (txnId) => del(`/bank/transactions/${txnId}/qb-link`),
    // Ce qu'il y a à comptabiliser pour cette ligne et qui le porte : document
    // apparié, versement de dette, paie, paiement émis. Le panneau latéral s'en
    // sert pour ouvrir la bonne surface sur place, sans changer d'écran.
    dossier: (txnId) => getFresh(`/bank/transactions/${txnId}/dossier`),
    // « Ce libellé, c'est ce fournisseur » : apprend un motif de relevé sur la
    // fiche du fournisseur, depuis la ligne bancaire.
    learnVendorPattern: (txnId, data) => post(`/bank/transactions/${txnId}/vendor-pattern`, data),
    // Propositions : ce que les moteurs ont trouvé et qui attend un clic.
    txnProposals: (txnId) => getFresh(`/bank/transactions/${txnId}/proposals`),
    acceptProposal: (id) => post(`/bank/proposals/${id}/accept`, {}),
    refuseProposal: (id, note) => post(`/bank/proposals/${id}/refuse`, note ? { note } : {}),
    acceptProposals: (ids) => post('/bank/proposals/accept', { ids }),
    // Toutes les propositions d'un coup, pour l'écran dédié.
    proposals: (params = {}) => getFresh('/bank/proposals?' + new URLSearchParams(params)),
    proposalsSummary: () => getFresh('/bank/proposals/summary'),
    // Règles bancaires : des conditions qui préparent l'écriture. Elles ne
    // publient jamais — c'est toujours un clic humain qui écrit.
    rules: {
      list: () => getFresh('/bank/rules'),
      suggestions: () => getFresh('/bank/rules/suggestions'),
      preview: (rule) => post('/bank/rules/preview', rule),
      draftFromTxn: (txnId) => get(`/bank/rules/draft-from-txn/${txnId}`),
      create: (rule) => post('/bank/rules', rule),
      update: (id, data) => patch(`/bank/rules/${id}`, data),
      remove: (id) => del(`/bank/rules/${id}`),
      verify: (id) => getFresh(`/bank/rules/${id}/verify`),
      relax: (id) => post(`/bank/rules/${id}/relax`, {}),
      repair: () => post('/bank/rules/repair', {}),
      // L'atelier : les habitudes que le relevé raconte.
      habits: () => getFresh('/bank/rules/habits'),
      // Le ménage : doublons, illisibles, sans trace, débordantes.
      housekeeping: () => getFresh('/bank/rules/housekeeping'),
      archive: (ids) => post('/bank/rules/archive', { ids }),
      restore: (ids) => post('/bank/rules/restore', { ids }),
      // Au fil de l'eau : ce libellé mérite-t-il une règle ?
      opportunity: (txnId) => get(`/bank/rules/opportunity/${txnId}`),
      // L'API QuickBooks ne donne pas les règles : on lit le fichier exporté.
      previewQbFile: (file) => {
        const fd = new FormData()
        fd.append('file', file)
        return uploadRequest('/bank/rules/import-qb/preview', fd)
      },
      importQb: (rules) => post('/bank/rules/import-qb/commit', { rules }),
    },
    updateTransaction: (id, data) => patch(`/bank/transactions/${id}`, data),
    deleteTransaction: (id) => del(`/bank/transactions/${id}`),
    // Doublons hérités de TRX_Orisha sur un compte branché à Plaid.
    mergePlaidDuplicates: (accountId, dryRun = true) =>
      post(`/bank/accounts/${accountId}/merge-plaid-duplicates`, { dry_run: dryRun }),
    // Le classeur Google ne se lit plus, il s'écrit : Boreal a le dernier mot.
    mirrorStatus: () => getFresh('/bank/trx-sheet/mirror'),
    mirrorSync: () => post('/bank/trx-sheet/mirror', {}),
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

  // Revenus perçus d'avance : l'état du compte 23900 (dépôts de commandes), et
  // l'écriture qui solde un dossier — préparée ici, envoyée sur clic.
  deferredRevenue: {
    state: (end) => get(`/deferred-revenue/state${end ? `?end=${end}` : ''}`),
    correction: (key) => get(`/deferred-revenue/correction/${encodeURIComponent(key)}`),
    publishCorrection: (data) => post('/deferred-revenue/correction', data),
  },

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
    conversations: () => getFresh('/instagram/conversations'),
    conversationMessages: (userId, refresh = false) => getFresh(`/instagram/conversations/${userId}/messages${refresh ? '?refresh=1' : ''}`),
    sendMessage: (userId, text) => post(`/instagram/conversations/${userId}/send`, { text }),
    setSession: (data) => put('/instagram/session', data),
    workbench: (all = false) => getFresh(`/instagram/workbench${all ? '?all=1' : ''}`),
    drafts: () => getFresh('/instagram/drafts'),
    setSegment: (prospectId, segment) => post(`/instagram/prospects/${prospectId}/segment`, { segment }),
    sortSegments: () => post('/instagram/segments/run', {}),
    writeDraft: (prospectId, data = {}) => post('/instagram/drafts/write', { prospect_id: prospectId, ...data }),
    writeAllDrafts: () => post('/instagram/drafts/write-all', {}),
    sendDraftsNow: () => post('/instagram/drafts/send-now', {}),
    holdDrafts: () => post('/instagram/drafts/hold-all', {}),
    updateDraft: (id, data) => patch(`/instagram/drafts/${id}`, data),
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

  // Carte des clients — points situés + complétion des coordonnées manquantes.
  clientMap: {
    points: () => getFresh('/client-map/points'),
    geocode: (limit) => post('/client-map/geocode', { limit }),
    refreshLeads: () => post('/client-map/leads/refresh'),
    greenhouses: (lat, lng) => get(`/client-map/greenhouses?lat=${lat}&lng=${lng}`),
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
    health: () => get('/scrapers/health'),
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
    // Pont de session : le module de navigateur appelle ces routes lui-même, l'ERP
    // n'a besoin que de savoir où en est chaque portail.
    bridgeTargets: () => get('/scrapers/session-bridge/targets'),
    // Lien direct : le dépôt n'existe que sur le serveur, le module s'y télécharge.
    bridgeModuleUrl: () =>
      `/erp/api/scrapers/session-bridge/module?token=${encodeURIComponent(localStorage.getItem('erp_token') || '')}`,
    artifactUrl: (runId, name) =>
      `/erp/api/scrapers/runs/${runId}/artifacts/${name}?token=${encodeURIComponent(localStorage.getItem('erp_token') || '')}`,
  },

  // Cartes de paiement connues : 4 derniers chiffres → compte QuickBooks payeur.
  paymentCards: {
    list: () => get('/payment-cards'),
    create: (data) => post('/payment-cards', data),
    update: (id, data) => patch(`/payment-cards/${id}`, data),
    delete: (id) => del(`/payment-cards/${id}`),
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

  // Résolution d'identifiants d'enregistrement (id ERP ou record ID Airtable)
  // en libellé + URL de fiche — cf. server/src/services/recordLinks.js. Sans
  // cache prefetch : chaque lot de clés est unique, et useRecordLinks.js tient
  // déjà son propre cache mémoire.
  recordLinks: {
    // `byLabel` : les clés qui ne sont pas des identifiants sont aussi cherchées
    // comme libellés dans la table cible (colonnes qui portent un nom, pas un id).
    resolve: (keys, table, byLabel = false) => getFresh(
      `/record-links?keys=${encodeURIComponent(keys.join(','))}${table ? `&table=${encodeURIComponent(table)}` : ''}`
      + (byLabel ? '&by_label=1' : '')
    ),
    // Tables proposables comme cible d'un champ affiché « Lien vers … ».
    tables: () => getFresh('/record-links/tables'),
    // Candidats à une association (éditeur de lien d'une cellule de DataTable).
    // `filter` : filtre du champ lien — seul ce sous-ensemble est proposé
    // (cf. server/src/services/linkFilter.js).
    search: (table, q, limit, filter = null) => getFresh(
      `/record-links/search?table=${encodeURIComponent(table)}`
      + `${q ? `&q=${encodeURIComponent(q)}` : ''}${limit ? `&limit=${limit}` : ''}`
      + (filter?.length ? `&filter=${encodeURIComponent(JSON.stringify(filter))}` : '')
    ),
    // Colonnes de la table cible sur lesquelles ce filtre peut porter.
    columns: (table) => getFresh(`/record-links/columns?table=${encodeURIComponent(table)}`),
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
    runtimeStatus: () => get('/automations/runtime/status'),
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
      pdfBlob: (id) => apiBlob(`/documents/soumissions/${id}/pdf`),
    },
  },

  agent: {
    listTasks:    ()         => get('/agent/tasks'),
    // Statut du runner : pollé toutes les 5 s — getFresh, le cache prefetch
    // (TTL 30 s) rendrait le poll aveugle aux transitions.
    runnerStatus: ()         => getFresh('/agent/runner/status'),
    // Journal d'exécution d'une tâche en cours : lu à la demande, jamais caché.
    streamLog:    (id)       => getFresh(`/agent/tasks/${id}/stream-log`),
    // Quotas Claude : pollés toutes les 30 s avec leur propre cache (voir
    // ClaudeUsage.jsx) — le cache prefetch (TTL 30 s) doublerait le délai de
    // rafraîchissement en resservant la réponse précédente.
    getUsage:     ()         => getFresh('/agent/usage'),
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
    spellfix:      (text)      => post('/travaux/spellfix', { text }),
    updatePrompt:  (id, data)  => patch(`/travaux/prompts/${id}`, data),
    deletePrompt:  (id)        => del(`/travaux/prompts/${id}`),
    reorderPrompts:(ids)       => post('/travaux/prompts/reorder', { ids }),
    promptFirst:   (id)        => post(`/travaux/prompts/${id}/first`, {}),
    // Arrêt d'une exécution EN COURS : tue le process, la carte passe à 'blocked'
    // (agent_status 'stopped') dès que le poll serveur détecte la mort du process.
    stopPrompt:    (id)        => post(`/travaux/prompts/${id}/stop`, {}),
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

    getReviewSettings: () => getFresh('/travaux/review-settings'),
    updateReviewSettings: (patch) => put('/travaux/review-settings', patch),
    listSuggestions:  (params = {}) => getFresh('/travaux/suggestions?' + new URLSearchParams(params)),
    acceptSuggestion: (id, prompt, space, priority) => post(`/travaux/suggestions/${id}/accept`, {
      ...(prompt ? { prompt } : {}), ...(space ? { space } : {}), ...(priority ? { priority: true } : {}),
    }),
    dismissSuggestion:(id, reason)  => post(`/travaux/suggestions/${id}/dismiss`, { reason }),
    deleteSuggestion: (id)          => del(`/travaux/suggestions/${id}`),
    // Sans `kind`, le serveur passe les deux moteurs (chantiers + intégrations).
    generateSuggestions: (kind, source = null) => post('/travaux/suggestions/generate', { ...(kind ? { kind } : {}), ...(source ? { source } : {}) }),
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
    fileBlob: (id) => apiBlob(`/sale-receipts/${id}/file`),
    // URL de service d'une page du document, pour un <a href> ou un <img src> :
    // le token passe en query param (une balise ne porte pas d'en-tête
    // Authorization — cf. requireAuth). page 0 = page 1.
    fileUrl: (id, page = 0) =>
      `/erp/api/sale-receipts/${id}/file?page=${page}&token=${encodeURIComponent(localStorage.getItem('erp_token') || '')}`,
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
    // Vérifie qu'un montant est bien celui imprimé sur le document (relecture du PDF).
    amountCheck: (id, amount) => get(`/sale-receipts/${id}/amount-check?` + new URLSearchParams({ amount })),
    invoiceSummary: id => get(`/sale-receipts/${id}/invoice-summary`),
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

  // Contrôles comptables — les constatations du passage de vérification.
  audit: {
    findings: (params = {}) => get('/audit/findings?' + new URLSearchParams(params)),
    run: (body = {}) => post('/audit/run', body),
    dismiss: (id, reason) => post(`/audit/findings/${id}/dismiss`, { reason }),
    reopen: (id) => post(`/audit/findings/${id}/reopen`),
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

  // Création manuelle d'un abonnement Stripe depuis la fiche entreprise.
  stripeSubscriptions: {
    billingContext: (companyId) => get(`/stripe-subscriptions/companies/${companyId}/billing-context`),
    create: (data) => post('/stripe-subscriptions', data),
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
