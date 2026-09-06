import { createContext, useContext, useSyncExternalStore } from 'react'
import { subscribe } from './realtime.js'
import { patchRecord, insertRecord, getRecord, isTableHydrated } from './dataStore.js'
import { getUser } from './auth.jsx'

// ── Ce qui vient de changer, et par qui ─────────────────────────────────────
//
// Deux besoins, une seule plomberie :
//
//  1. Une modification faite AILLEURS (dans Airtable, par un collègue, par une
//     automatisation) doit apparaître dans Boréal SANS rafraîchir la page. Les
//     pages branchées sur le cache global (`useTable`) ne se rafraîchissaient
//     qu'au delta poll (10 s) ; celles qui écoutent déjà leur canal le font
//     depuis toujours. Ici on s'abonne, une fois pour toute l'app, au canal
//     `<entité>:list` de chaque table, et on pousse la valeur dans le cache.
//
//  2. Le champ qui a bougé porte pendant quelques secondes une PASTILLE
//     discrète : les initiales de l'auteur si c'est quelqu'un, une icône de
//     prise sinon (« c'est une API qui tient ce champ à jour »). D'où cette
//     mémoire courte : `recordId + champ → qui/quoi/quand`, lue par
//     <FieldPulse> dans les fiches et par le DataTable dans ses cellules.
//
// Le serveur dit quelles colonnes ont changé (`msg.fields`, renseigné par le
// moteur de miroir Airtable qui le sait de son UPDATE différentiel). Quand il
// ne le dit pas — édition humaine passée par une route —, on le déduit du
// cache : la valeur qu'on y a encore EST l'ancienne.

// Durée de vie d'une pastille. Les trois animations CSS qui la rendent
// (`fieldPulse`, `dtCellFlash`, `dtEditorBadge` dans index.css) durent
// exactement autant : une pastille encore « vivante » mais déjà effacée à
// l'écran ne servirait qu'à retarder la suivante.
const PULSE_MS = 4000

// Champs méta qui changent à chaque écriture sans intérêt pour l'utilisateur.
const IGNORED_FIELDS = new Set([
  'updated_at', 'created_at', 'synced_at', 'last_synced_at', 'airtable_id',
])

// Origine d'une écriture externe → nom affiché dans l'infobulle.
const SOURCE_LABELS = {
  airtable: 'Airtable',
  quickbooks: 'QuickBooks',
  stripe: 'Stripe',
  gmail: 'Gmail',
}

// Nom d'entité (préfixe des canaux temps réel) → table du cache global.
// Doit rester aligné avec ENTITY_BY_TABLE (server/src/services/realtimeEmitters.js) :
// un nom qui diverge = un canal auquel personne n'est abonné, donc une
// modification Airtable invisible jusqu'au prochain delta.
export const ENTITY_TABLES = {
  order: 'orders',
  order_item: 'order_items',
  company: 'companies',
  contact: 'contacts',
  product: 'products',
  project: 'projects',
  facture: 'factures',
  ticket: 'tickets',
  task: 'tasks',
  shipment: 'shipments',
  employee: 'employees',
  vacation: 'vacations',
  paie: 'paies',
  paie_item: 'paie_items',
  timesheet: 'timesheets',
  hour_bank_entry: 'hour_bank',
  serial_number: 'serial_numbers',
  serial_state_change: 'serial_state_changes',
  purchase: 'purchases',
  achat_fournisseur: 'achats_fournisseurs',
  sale_receipt: 'sale_receipts',
  journal_entry: 'journal_entries',
  interaction: 'interactions',
  adresse: 'adresses',
  soumission: 'soumissions',
  return: 'returns',
  return_item: 'return_items',
  stock_movement: 'stock_movements',
  assemblage: 'assemblages',
  bom_item: 'bom_items',
  instagram_prospect: 'instagram_prospects',
  subscription: 'subscriptions',
  activity_code: 'activity_codes',
}

// ── Mémoire courte des pastilles ────────────────────────────────────────────
// byRecord : Map<recordId, Map<champ, pulse>> — la forme imbriquée sert les
// deux lectures : « ce champ vient-il de changer ? » (fiche) et « cette ligne
// vient-elle de changer ? » (badge de ligne du DataTable).
const byRecord = new Map()
const timers = new Map()
const listeners = new Set()
// Compteur de version : ce que lit `usePulseTick`. useSyncExternalStore compare
// les instantanés avec Object.is — rendre la Map elle-même ne re-rendrait
// jamais rien, son identité ne changeant pas.
let version = 0

// Les pastilles arrivent une par une (un message WebSocket par écriture) mais
// se regardent en bloc : on regroupe les notifications sur 50 ms pour qu'un
// sync qui touche trente records ne provoque pas trente rendus du tableau.
// Invisible à l'oeil — la pastille vit 6 s.
let notifyTimer = null
function notify() {
  version++
  if (notifyTimer) return
  notifyTimer = setTimeout(() => {
    notifyTimer = null
    for (const fn of listeners) {
      try { fn() } catch (e) { console.error('[recordLive] listener error', e) }
    }
  }, 50)
}

function subscribePulses(cb) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function dropPulse(recordId, field) {
  const fields = byRecord.get(recordId)
  if (!fields) return
  fields.delete(field)
  if (fields.size === 0) byRecord.delete(recordId)
}

/** Note qu'un champ vient d'être mis à jour ailleurs. `meta` : voir buildMeta. */
export function notePulse(recordId, field, meta) {
  if (!recordId || !field) return
  let fields = byRecord.get(recordId)
  if (!fields) { fields = new Map(); byRecord.set(recordId, fields) }
  fields.set(field, { ...meta, field, ts: Date.now() })

  const key = `${recordId}|${field}`
  const prev = timers.get(key)
  if (prev) clearTimeout(prev)
  timers.set(key, setTimeout(() => {
    timers.delete(key)
    dropPulse(recordId, field)
    notify()
  }, PULSE_MS))
  notify()
}

/** Le champ vient-il d'être mis à jour ailleurs ? (lecture hors rendu React) */
export function getPulse(recordId, field) {
  if (!recordId || !field) return null
  return byRecord.get(recordId)?.get(field) || null
}

/** La pastille la plus récente de ce record, tous champs confondus. */
export function getRecordPulse(recordId) {
  const fields = recordId ? byRecord.get(recordId) : null
  if (!fields || fields.size === 0) return null
  let best = null
  for (const p of fields.values()) if (!best || p.ts > best.ts) best = p
  return best
}

/** Les champs de ce record qui viennent de changer (Set, jamais null). */
export function getRecordPulseFields(recordId) {
  const fields = recordId ? byRecord.get(recordId) : null
  return fields ? new Set(fields.keys()) : EMPTY_SET
}
const EMPTY_SET = new Set()

/**
 * Abonnement au registre des pastilles pour un composant qui les lit en lot
 * (le DataTable, une pastille par cellule) : rend un numéro de version qui
 * change à chaque pose ou expiration, et les lectures se font ensuite avec
 * getRecordPulse / getRecordPulseFields.
 */
export function usePulseTick() {
  return useSyncExternalStore(subscribePulses, () => version, () => 0)
}

/** La pastille d'UN champ d'UN record — le cas de la fiche. */
export function usePulse(recordId, field) {
  return useSyncExternalStore(
    subscribePulses,
    () => getPulse(recordId, field),
    () => null,
  )
}

// ── Qui a fait la modification ──────────────────────────────────────────────

function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return null
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function buildMeta(msg) {
  const actorId = msg.actorUserId || null
  const actorName = actorId ? (getRecord('users', actorId)?.name || null) : null
  const sourceLabel = msg.source ? (SOURCE_LABELS[msg.source] || msg.source) : null
  return {
    source: msg.source || null,
    actorId,
    actorName,
    // Pas d'initiales ⇒ <FieldPulse> montre l'icône d'intégration : personne
    // n'est nommé, c'est donc une machine qui tient le champ.
    initials: actorName ? initialsOf(actorName) : null,
    title: actorName
      ? `Mis à jour par ${actorName}`
      : `Mis à jour par ${sourceLabel || 'une intégration'}`,
  }
}

// ── Le pont temps réel ──────────────────────────────────────────────────────

let started = false
let unsubscribes = []

function handle(table, msg, meId) {
  // `order:item:updated` comme `product:updated` : le verbe est le dernier
  // segment du type.
  const verb = String(msg.type || '').split(':').pop()
  const payload = msg.payload
  if (!payload || payload.id == null) return

  if (verb === 'created') {
    // Une ligne neuve n'a pas de champ « modifié » : rien à faire clignoter.
    // Elle rejoint le cache pour apparaître tout de suite dans les listes qui
    // le lisent (les autres reçoivent l'événement sur leur propre canal).
    insertRecord(table, payload)
    return
  }
  if (verb !== 'updated') return

  // La valeur encore en cache EST l'ancienne : on patche APRÈS avoir noté le
  // diff, mais `patchRecord` fait les deux d'un coup et rend les colonnes
  // réellement changées.
  const applied = patchRecord(table, payload.id, payload)

  // Ses propres modifications ne s'annoncent pas : on vient de les faire.
  if (msg.actorUserId && meId && String(msg.actorUserId) === String(meId)) return

  const changed = (msg.fields?.length ? msg.fields : applied) || []
  const shown = changed.filter(f => !IGNORED_FIELDS.has(f))
  if (!shown.length) return

  // Rien en cache et rien de dit par le serveur : on ne sait pas ce qui a
  // changé, donc on n'invente pas de pastille.
  const meta = buildMeta(msg)
  for (const f of shown) notePulse(payload.id, f, meta)
}

/**
 * Branche l'app sur les modifications venues d'ailleurs. Appelé une fois, au
 * montage du Layout (à côté de la connexion WebSocket).
 */
export function startRecordLive() {
  if (started) return
  started = true
  const meId = getUser()?.id ?? null
  for (const [entity, table] of Object.entries(ENTITY_TABLES)) {
    unsubscribes.push(subscribe(`${entity}:list`, (msg) => {
      try { handle(table, msg, meId) }
      catch (e) { console.error(`[recordLive] ${entity}:`, e) }
    }))
  }
}

export function stopRecordLive() {
  for (const off of unsubscribes) { try { off() } catch { /* déjà détaché */ } }
  unsubscribes = []
  started = false
  for (const t of timers.values()) clearTimeout(t)
  timers.clear()
  if (notifyTimer) { clearTimeout(notifyTimer); notifyTimer = null }
  byRecord.clear()
  notify()
}

// ── Quel record est affiché ici ? ───────────────────────────────────────────
//
// Une pastille de champ a besoin de l'id du record affiché. Les fiches ne le
// passent PAS champ par champ (108 <Field> dans l'app) : le panneau qui monte
// la fiche l'annonce une fois, et tous les champs à l'intérieur le lisent.
// Posé par RecordRoutePanel (fiche atteinte par son URL) et par le side-peek
// du DataTable — c'est-à-dire partout où une fiche s'affiche (règle de design :
// une fiche ne s'affiche QUE dans un panneau latéral).
const RecordScopeContext = createContext(null)

export function RecordScope({ id, children }) {
  return <RecordScopeContext.Provider value={id || null}>{children}</RecordScopeContext.Provider>
}

export function useRecordScope() {
  return useContext(RecordScopeContext)
}

// Exposé pour les tests / la console.
export const __recordLive = { byRecord, isTableHydrated, PULSE_MS }
