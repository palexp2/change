// Lecture de l'API Venn : comptes (avec soldes) et transactions d'un compte
// sur une plage de dates. LECTURE SEULE — ce module n'expose aucune écriture
// vers Venn, et il n'en apparaîtra pas : la décision (même politique que Plaid)
// est que l'ERP ne peut pas déplacer d'argent.
//
// Deux précautions structurent ce fichier :
//
//  1. ON NE CONNAÎT PAS PAR CŒUR LA FORME DES RÉPONSES. La clé d'API arrive
//     après le branchement, et le portail Venn n'était pas consultable au
//     moment d'écrire. Les normaliseurs ci-dessous acceptent donc les formes
//     courantes (`data` / `items` / `accounts` / tableau nu ; `availableBalance`
//     ou `balances.available` ; `postedAt` ou `date`…) et restent PURS, donc
//     testables sans réseau. Si Venn nomme les choses autrement, c'est ici — et
//     nulle part ailleurs — qu'on corrige.
//  2. UNE PANNE NE DOIT JAMAIS PASSER POUR UN RÉSULTAT VIDE (leçon Instagram,
//     services/sessionHealth.js) : 401, 429 et toute réponse non-JSON lèvent
//     avec un message lisible, et l'état de la connexion est écrit en base
//     après chaque appel pour que la page Connecteurs le montre.
import { apiBase, authHeaders, getConfig, isVennConfigured, DEFAULTS } from '../connectors/venn.js'
import { recordSessionStatus } from './sessionHealth.js'

const TIMEOUT_MS = 30_000
// Garde-fou de pagination : une API qui renvoie toujours le même curseur ne
// doit pas faire tourner le serveur indéfiniment.
const MAX_PAGES = 50

// ── Normalisation des réponses ───────────────────────────────────────────────

/** Première valeur non vide parmi les chemins donnés (« a.b.c »). */
function pick(obj, paths) {
  for (const p of paths) {
    let v = obj
    for (const part of p.split('.')) v = v?.[part]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return null
}

/** Le tableau de résultats, quel que soit le nom que l'API lui donne. */
export function extractList(payload) {
  if (Array.isArray(payload)) return payload
  for (const k of ['data', 'items', 'results', 'accounts', 'transactions', 'records']) {
    const v = payload?.[k]
    if (Array.isArray(v)) return v
  }
  // { data: { items: [...] } }
  for (const k of ['data', 'result']) {
    const inner = payload?.[k]
    if (inner && typeof inner === 'object') {
      const nested = extractList(inner)
      if (nested.length || Array.isArray(inner?.items)) return nested
    }
  }
  return []
}

/** Curseur de page suivante, ou null quand on est au bout. */
export function nextCursorOf(payload) {
  const c = pick(payload || {}, [
    'nextCursor', 'next_cursor', 'cursor', 'nextPageToken', 'next_page_token',
    'paging.nextCursor', 'paging.next_cursor', 'pagination.nextCursor',
    'pagination.next_cursor', 'meta.nextCursor', 'meta.next_cursor',
  ])
  return c ? String(c) : null
}

const toNumber = (v) => {
  if (v === null || v === undefined || v === '') return null
  // Montants en cents : certaines API bancaires ne renvoient que des entiers.
  const n = typeof v === 'object' ? Number(pick(v, ['amount', 'value'])) : Number(v)
  return Number.isFinite(n) ? n : null
}

/** Un compte Venn, ramené au vocabulaire de l'ERP. */
export function normalizeAccount(raw) {
  const id = pick(raw, ['id', 'accountId', 'account_id', 'uuid', 'reference'])
  if (!id) return null
  return {
    venn_account_id: String(id),
    name: String(pick(raw, ['name', 'nickname', 'label', 'displayName', 'accountName', 'description']) || id),
    currency: String(pick(raw, ['currency', 'currencyCode', 'currency_code', 'balance.currency']) || '').toUpperCase() || null,
    balance_available: toNumber(pick(raw, [
      'availableBalance', 'available_balance', 'balances.available', 'balance.available', 'available',
    ])),
    balance_current: toNumber(pick(raw, [
      'currentBalance', 'current_balance', 'balances.current', 'balance.current', 'ledgerBalance',
      'ledger_balance', 'current', 'balance',
    ])),
  }
}

// Sens du mouvement. L'ERP suit la convention du relevé bancaire : un dépôt est
// POSITIF, un retrait NÉGATIF (voir bank_transactions). Venn peut l'exprimer
// par un champ de direction ou par le signe du montant — on accepte les deux,
// la direction déclarée faisant foi quand elle existe.
const DEBIT_RE = /^(debit|dr|outgoing|outbound|withdrawal|payment|send|sent|out)$/i
const CREDIT_RE = /^(credit|cr|incoming|inbound|deposit|receive|received|in)$/i

export function signedAmount(raw) {
  const amount = toNumber(pick(raw, ['amount', 'value', 'amountCents', 'amount_cents', 'transactionAmount.amount']))
  if (amount === null) return null
  const dir = String(pick(raw, ['direction', 'type', 'side', 'flow', 'creditDebitIndicator', 'credit_debit_indicator']) || '')
  const abs = Math.abs(amount)
  if (DEBIT_RE.test(dir)) return -abs
  if (CREDIT_RE.test(dir)) return abs
  return amount
}

// Encore en attente côté banque : son montant peut bouger avant de se poser.
// Les effets de bord (appariement aux factures) l'ignorent, exactement comme
// pour Plaid.
const PENDING_RE = /^(pending|authorized|processing|in_progress|hold)$/i

export function normalizeTransaction(raw) {
  const id = pick(raw, ['id', 'transactionId', 'transaction_id', 'uuid', 'reference'])
  const amount = signedAmount(raw)
  const date = String(pick(raw, [
    'postedAt', 'posted_at', 'postedDate', 'date', 'transactionDate', 'transaction_date',
    'bookingDate', 'createdAt', 'created_at', 'valueDate',
  ]) || '').slice(0, 10)
  if (!id || amount === null || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const status = String(pick(raw, ['status', 'state']) || '')
  // Libellé : `details` d'abord côté UI (COALESCE(details, description)) — on y
  // met le libellé BRUT du relevé, celui que l'humain reconnaît, et le
  // commerçant normalisé dans `description` quand il diffère.
  const rawLabel = pick(raw, ['description', 'narrative', 'memo', 'details', 'statementDescription', 'reference'])
  const merchant = pick(raw, ['merchantName', 'merchant_name', 'merchant.name', 'counterpartyName', 'counterparty.name', 'payee'])
  const description = merchant && rawLabel && merchant !== rawLabel ? String(merchant) : String(merchant || rawLabel || '')
  const details = merchant && rawLabel && merchant !== rawLabel ? String(rawLabel) : null
  return {
    venn_transaction_id: String(id),
    txn_date: date,
    amount: Math.round(amount * 100) / 100,
    description: description || null,
    details,
    // La devise est conservée TELLE QUELLE : aucune conversion à l'import
    // (décision explicite — la conversion USD→CAD reste trimestrielle et
    // humaine).
    currency: String(pick(raw, ['currency', 'currencyCode', 'currency_code']) || '').toUpperCase() || null,
    pending: PENDING_RE.test(status) || pick(raw, ['pending']) === true,
    bank_category: pick(raw, ['category', 'categoryName', 'category.name']) ? String(pick(raw, ['category', 'categoryName', 'category.name'])) : null,
    txn_type: pick(raw, ['type', 'transactionType', 'transaction_type']) ? String(pick(raw, ['type', 'transactionType', 'transaction_type'])) : null,
  }
}

// ── Appel HTTP ───────────────────────────────────────────────────────────────

/** Message parlant pour les pannes qu'on sait nommer (401, 403, 429). */
export function vennErrorMessage(status, bodyText = '') {
  const extract = String(bodyText || '').slice(0, 300).trim()
  if (status === 401) return 'Venn refuse la clé d’API (401) — la clé est absente, expirée ou révoquée : la recoller dans Connecteurs → Venn.'
  if (status === 403) return `Venn refuse l’accès (403) — la clé n’a pas la permission de lire ce compte.${extract ? ` ${extract}` : ''}`
  if (status === 429) return 'Venn limite les appels (429) — trop de lectures d’affilée, la synchronisation reprendra au prochain passage.'
  if (status === 404) return `Venn ne connaît pas cette adresse (404) — vérifier les chemins d’API dans Connecteurs → Venn.${extract ? ` ${extract}` : ''}`
  return `Venn a répondu ${status}${extract ? ` : ${extract}` : ''}`
}

function statusFor(httpStatus) {
  return httpStatus === 401 || httpStatus === 403 ? 'expired' : 'error'
}

/**
 * Un appel GET à l'API Venn. Lève avec un message lisible ; écrit l'état de la
 * connexion au passage (`connector_sessions`), pour que « la clé est morte » se
 * voie sur la page Connecteurs plutôt que de se déguiser en liste vide.
 */
async function vennGet(path, query = {}) {
  if (!isVennConfigured()) {
    const msg = 'Venn n’est pas configuré — coller la clé d’API dans Connecteurs → Venn.'
    recordSessionStatus('venn', { status: 'error', detail: msg })
    throw new Error(msg)
  }
  const cfg = getConfig()
  const url = new URL(apiBase(cfg) + path)
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
  }
  let res, body
  try {
    res = await fetch(url, { headers: authHeaders(cfg), signal: AbortSignal.timeout(TIMEOUT_MS) })
    body = await res.text()
  } catch (e) {
    // Panne réseau : la clé n'est pas en cause, on ne renvoie personne la
    // recoller pour rien.
    const msg = `Venn injoignable : ${e.message}`
    recordSessionStatus('venn', { status: 'error', detail: msg })
    throw new Error(msg)
  }
  if (!res.ok) {
    const msg = vennErrorMessage(res.status, body)
    recordSessionStatus('venn', { status: statusFor(res.status), detail: msg })
    const err = new Error(msg)
    err.status = res.status
    throw err
  }
  let json
  try { json = JSON.parse(body) } catch {
    const msg = `Venn a répondu autre chose que du JSON (${res.status}) — vérifier l’adresse de l’API.`
    recordSessionStatus('venn', { status: 'error', detail: msg })
    throw new Error(msg)
  }
  return json
}

/** Identité d'un élément, pour reconnaître une page déjà vue. */
function rowKey(row) {
  const id = pick(row || {}, ['id', 'transactionId', 'transaction_id', 'accountId', 'account_id', 'uuid', 'reference'])
  return id ? String(id) : JSON.stringify(row)
}

/**
 * Toutes les pages d'une ressource — curseur ou décalage, selon ce que Venn
 * donne.
 *
 * GARDE-FOU : on s'arrête dès qu'une page n'apporte aucun élément nouveau. Une
 * API qui ignore le paramètre de décalage qu'on lui envoie renverrait sinon
 * éternellement sa première page — 50 appels pour rien, et un 429 au bout.
 */
async function vennGetAll(path, query = {}) {
  const cfg = getConfig()
  const limit = Number(cfg.page_size || DEFAULTS.page_size) || 100
  const rows = []
  const seen = new Set()
  let cursor = null
  let offset = 0
  for (let page = 0; page < MAX_PAGES; page++) {
    const payload = await vennGet(path, { ...query, limit, ...(cursor ? { cursor } : offset ? { offset } : {}) })
    const batch = extractList(payload)
    let fresh = 0
    for (const row of batch) {
      const k = rowKey(row)
      if (seen.has(k)) continue
      seen.add(k)
      rows.push(row)
      fresh++
    }
    if (!fresh) break
    cursor = nextCursorOf(payload)
    if (cursor) continue
    // Pas de curseur : on avance par décalage tant que la page est pleine.
    if (batch.length < limit) break
    offset += batch.length
  }
  return rows
}

// ── API publique du module ───────────────────────────────────────────────────

/** Les comptes Venn, avec leurs soldes disponible et courant. */
export async function listVennAccounts() {
  const cfg = getConfig()
  const raw = await vennGetAll(cfg.accounts_path || DEFAULTS.accounts_path)
  const accounts = raw.map(normalizeAccount).filter(Boolean)
  recordSessionStatus('venn', {
    status: 'ok',
    detail: accounts.length
      ? `${accounts.length} compte(s) : ${accounts.map(a => `${a.name}${a.currency ? ` (${a.currency})` : ''}`).join(', ')}`
      : 'clé valide, mais aucun compte renvoyé',
  })
  return accounts
}

/**
 * Les transactions d'UN compte Venn entre deux dates (AAAA-MM-JJ, incluses).
 * Les noms des paramètres de date sont envoyés sous leurs deux graphies
 * courantes : une API qui n'en connaît qu'une ignore l'autre.
 */
export async function listVennTransactions(vennAccountId, { from, to } = {}) {
  const cfg = getConfig()
  const path = String(cfg.transactions_path || DEFAULTS.transactions_path)
    .replace('{accountId}', encodeURIComponent(vennAccountId))
  const query = { accountId: vennAccountId }
  if (from) { query.from = from; query.startDate = from }
  if (to) { query.to = to; query.endDate = to }
  const raw = await vennGetAll(path, query)
  return raw.map(normalizeTransaction).filter(Boolean)
}

/** « Tester la connexion » : liste les comptes et leurs soldes. Rien d'autre. */
export async function testVennConnection() {
  const accounts = await listVennAccounts()
  return { ok: true, accounts }
}

/**
 * Sonde de santé (services/sessionHealth.js) : un appel qui exige la clé.
 * Ne lève jamais — elle rend l'état écrit en base.
 */
export async function probeVenn() {
  try {
    const accounts = await listVennAccounts()
    return recordSessionStatus('venn', { status: 'ok', detail: `${accounts.length} compte(s) lisible(s)` })
  } catch (e) {
    return recordSessionStatus('venn', {
      // « expired » est réservé à la clé refusée : c'est le seul cas où
      // l'action à faire est d'en recoller une.
      status: e.status === 401 || e.status === 403 ? 'expired' : 'error',
      detail: e.message,
    })
  }
}
