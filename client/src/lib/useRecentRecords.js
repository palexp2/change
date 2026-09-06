// Fil « Récemment consultés » — mémorise les derniers enregistrements (fiches
// *Detail) ouverts par l'utilisateur pour offrir un retour rapide depuis la
// palette GlobalSearch (requête vide).
//
// Conception :
//   - Le tracker (useTrackRecentVisit, branché une fois dans App.jsx) observe le
//     pathname courant. Quand il matche une route de fiche détail connue, il
//     enregistre la visite (type + table + id + url).
//   - Le libellé n'est PAS figé à la visite : il est résolu *live* depuis le
//     dataStore au moment de l'affichage (resolveRecent), de sorte qu'un record
//     renommé apparaît à jour. Un libellé de secours est tout de même capturé à
//     la visite au cas où la table ne serait plus hydratée.
//   - Persisté dans localStorage, synchronisé entre onglets via l'event storage.

import { useSyncExternalStore, useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { getRecord } from './dataStore.js'

const STORAGE_KEY = 'erp:recentRecords'
const MAX = 10

// ── Table de routage : pathname → { type, table, id } ───────────────────────
// `type` pilote l'icône/le libellé de catégorie côté UI (voir GlobalSearch).
// `table` est la table du dataStore où résoudre le libellé live.
// Seules les fiches détail dont la table est cachée (CACHED_TABLES) sont
// suivies — c'est ce qui permet la résolution live du nom.
const ROUTES = [
  { re: /^\/companies\/([^/]+)$/,     type: 'company',     table: 'companies' },
  { re: /^\/contacts\/([^/]+)$/,      type: 'contact',     table: 'contacts' },
  { re: /^\/products\/([^/]+)$/,      type: 'product',     table: 'products' },
  { re: /^\/projects\/([^/]+)$/,      type: 'project',     table: 'projects' },
  { re: /^\/orders\/([^/]+)$/,        type: 'order',       table: 'orders' },
  { re: /^\/factures\/([^/]+)$/,      type: 'facture',     table: 'factures' },
  { re: /^\/tickets\/([^/]+)$/,       type: 'ticket',      table: 'tickets' },
  { re: /^\/serials\/([^/]+)$/,       type: 'serial',      table: 'serial_numbers' },
  { re: /^\/purchases\/([^/]+)$/,     type: 'purchase',    table: 'purchases' },
  { re: /^\/retours\/([^/]+)$/,       type: 'return',      table: 'returns' },
  { re: /^\/envois\/([^/]+)$/,        type: 'shipment',    table: 'shipments' },
  { re: /^\/sale-receipts\/([^/]+)$/, type: 'sale_receipt', table: 'sale_receipts' },
  { re: /^\/employees\/([^/]+)$/,     type: 'employee',    table: 'employees' },
]

function matchRoute(pathname) {
  for (const r of ROUTES) {
    const m = r.re.exec(pathname)
    if (m) return { ...r, id: m[1], url: pathname }
  }
  return null
}

// Premier champ non vide parmi une liste de candidats.
function firstOf(record, fields) {
  for (const f of fields) {
    const v = record?.[f]
    if (v != null && String(v).trim() !== '') return String(v).trim()
  }
  return ''
}

// Libellé principal d'un record selon sa table.
export function labelFor(table, record) {
  if (!record) return ''
  switch (table) {
    case 'contacts':
    case 'employees':
      return `${record.first_name || ''} ${record.last_name || ''}`.trim()
    case 'orders':
      return record.order_number ? `#${record.order_number}` : firstOf(record, ['autonumber'])
    case 'factures':
      return record.document_number ? `${record.document_number}` : firstOf(record, ['invoice_id'])
    case 'returns':
      return record.n_de_retour ? `#${record.n_de_retour}` : firstOf(record, ['autonumber'])
    case 'shipments':
      // Le « # d'envoi » (ENV-1687) nomme l'envoi partout dans l'app ; le no de
      // suivi n'est qu'un repli pour un envoi pas encore numéroté.
      // `autonumber` / `shipping_id_novoxpress` : colonnes Airtable droppées
      // (script drop-envois-airtable-only-cols).
      return firstOf(record, ['d_envoi', 'tracking_number'])
    case 'products':
      return firstOf(record, ['name_fr', 'name_en', 'sku'])
    case 'serial_numbers':
      return firstOf(record, ['serial'])
    case 'tickets':
      return firstOf(record, ['title'])
    case 'purchases':
      return firstOf(record, ['nom_de_la_piece', 'reference', 'numero_de_commande'])
    case 'sale_receipts':
      return firstOf(record, ['receipt_number', 'company', 'original_name'])
    default:
      return firstOf(record, ['name', 'title', 'label'])
  }
}

// Sous-libellé contextuel (entreprise liée, etc.).
function subFor(table, record) {
  if (!record) return ''
  if (table === 'contacts') {
    const co = record.company_id ? getRecord('companies', record.company_id) : null
    return co?.name || record.email || ''
  }
  if (table === 'orders' || table === 'returns' || table === 'factures' || table === 'tickets') {
    const co = record.company_id ? getRecord('companies', record.company_id) : null
    return co?.name || ''
  }
  if (table === 'products' || table === 'serial_numbers') return firstOf(record, ['sku'])
  if (table === 'purchases') return firstOf(record, ['supplier', 'fournisseur'])
  if (table === 'sale_receipts') return firstOf(record, ['company'])
  return ''
}

// ── Store mémoire + persistance localStorage ────────────────────────────────
function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

let items = load()
const listeners = new Set()

function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items)) } catch { /* quota / mode privé */ }
}

function emit() {
  for (const fn of listeners) { try { fn() } catch { /* noop */ } }
}

export function recordVisit({ type, table, id, url, label }) {
  if (!url || !id) return
  // Dédoublonnage par url : la visite la plus récente remonte en tête.
  const entry = { type, table, id, url, label: label || '', ts: Date.now() }
  items = [entry, ...items.filter(it => it.url !== url)].slice(0, MAX)
  persist()
  emit()
}

export function clearRecentRecords() {
  items = []
  persist()
  emit()
}

// Synchronisation inter-onglets : un autre onglet a modifié la liste.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) { items = load(); emit() }
  })
}

// Hook de lecture brute (liste persistée, libellés de secours).
function useRawRecent() {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb) },
    () => items,
    () => items,
  )
}

// Hook d'affichage : résout le libellé/sous-libellé live depuis le dataStore,
// avec repli sur le libellé capturé à la visite. Les records dont la table n'est
// plus résolvable conservent leur libellé de secours.
export function useRecentRecords() {
  const raw = useRawRecent()
  return raw.map((it) => {
    const record = getRecord(it.table, it.id)
    const label = (record && labelFor(it.table, record)) || it.label || `#${it.id}`
    const sub = record ? subFor(it.table, record) : ''
    return { ...it, label, sub }
  })
}

// Tracker — à monter une seule fois (App.jsx). Enregistre une visite quand le
// pathname matche une fiche détail connue.
export function useTrackRecentVisit() {
  const { pathname } = useLocation()
  useEffect(() => {
    const m = matchRoute(pathname)
    if (!m) return
    const record = getRecord(m.table, m.id)
    recordVisit({
      type: m.type,
      table: m.table,
      id: m.id,
      url: m.url,
      label: record ? labelFor(m.table, record) : '',
    })
  }, [pathname])
}
