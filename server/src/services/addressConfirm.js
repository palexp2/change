// Confirmation d'une adresse auprès d'une API de vérification d'adresses.
//
// À la différence du vérificateur `addressCheck.js` — 100 % hors-ligne, qui ne
// juge que la FORME (champ manquant, code postal mal formé, province
// incohérente) — ce module demande à Google (Places legacy : findplacefromtext
// puis details) si l'adresse EXISTE vraiment, et sous quelle écriture.
//
// Ne concerne que les adresses où une erreur coûte un camion : « Livraison » et
// « Ferme » (configurable, automation `sys_address_confirm`). Une adresse de
// facturation n'est pas confirmée.
//
// Le verdict est persisté sur la ligne (`confirm_status`, `confirm_formatted`,
// `confirm_suggestion`, `confirm_signature`, `confirmed_at`) et poussé en
// realtime : la fiche adresse et la modale affichent la proposition de Google
// avec un bouton « Utiliser ».
//
// Statuts :
//   confirmed   — Google renvoie la même adresse (aux abréviations près)
//   corrected   — Google renvoie une adresse différente → suggestion à appliquer
//   not_found   — Google ne connaît pas cette adresse
//   incomplete  — pas assez de champs pour interroger (rue + ville minimum)
//   unavailable — clé absente ou API en erreur (jamais bloquant)

import db from '../db/database.js'
import { findPlace, placeDetails } from './geocode.js'
// Le pays s'écrit « CA », « Canada », « canada »… selon la porte d'entrée
// (fiche ERP, formulaire client). Même référentiel que le vérificateur de
// forme, sinon « Canada » face au « CA » de Google passerait pour une erreur.
import { normalizeCountry } from './addressCheck.js'
import { emitEntity } from './realtimeEmitters.js'
import { isSystemAutomationActive, logSystemRun } from './systemAutomations.js'

export const ADDRESS_CONFIRM_AUTOMATION_ID = 'sys_address_confirm'

export const ADDRESS_CONFIRM_DEFAULT_CONFIG = {
  // Types d'adresse confirmés auprès de l'API (les autres sont ignorés).
  types: 'Livraison,Ferme',
}

const norm = v => String(v ?? '').trim()

function fold(v) {
  return norm(v).toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '')
}

const COUNTRY_NAMES = { CA: 'Canada', US: 'USA' }

// Abréviations de voirie : « boul. » et « boulevard » désignent la même rue,
// Google normalise dans un sens, les humains dans l'autre.
const STREET_ALIASES = {
  boul: 'boulevard', bl: 'boulevard', blvd: 'boulevard', bd: 'boulevard',
  av: 'avenue', ave: 'avenue',
  ch: 'chemin', chem: 'chemin',
  rte: 'route', rt: 'route',
  st: 'saint', ste: 'sainte', 'st-': 'saint',
  mtee: 'montee',
  rg: 'rang',
  no: '', num: '',
}

// Mots qui ne discriminent rien dans un nom de rue.
const STREET_STOPWORDS = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'l', 'd', 'the'])

function streetTokens(value) {
  return fold(value)
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map(t => (t in STREET_ALIASES ? STREET_ALIASES[t] : t))
    .filter(t => t && !STREET_STOPWORDS.has(t))
}

const civicNumber = value => (fold(value).match(/\d+/) || [null])[0]

const compactPostal = v => norm(v).toUpperCase().replace(/[\s-]+/g, '')

/**
 * Deux libellés de rue désignent-ils la même voie ? Comparaison tolérante : le
 * numéro civique doit coïncider, et les mots retenus par Google doivent tous se
 * retrouver dans la saisie (qui peut porter en plus un « app. 4 », un « Suite
 * 200 » que Google ne rend pas).
 */
export function sameStreet(stored, suggested) {
  const sug = streetTokens(suggested)
  if (!sug.length) return true // Google n'a pas rendu de rue : rien à opposer.
  const mine = streetTokens(stored)
  if (!mine.length) return false

  const a = civicNumber(stored)
  const b = civicNumber(suggested)
  if (a && b && a !== b) return false

  const mineSet = new Set(mine)
  return sug.every(t => mineSet.has(t))
}

/** Texte envoyé à Google. Vide si l'adresse n'a pas de quoi être situées. */
export function buildQuery(addr) {
  const line1 = norm(addr?.line1)
  const city = norm(addr?.city)
  if (!line1 || !city) return ''
  const country = norm(addr?.country).toUpperCase()
  return [line1, city, norm(addr?.province), norm(addr?.postal_code), COUNTRY_NAMES[country] || norm(addr?.country)]
    .filter(Boolean).join(', ')
}

/** Empreinte de l'adresse : une confirmation ne se rejoue que si elle change. */
export function addressSignature(addr) {
  return ['line1', 'city', 'province', 'postal_code', 'country', 'address_type']
    .map(k => fold(addr?.[k])).join('|')
}

// ── Configuration ────────────────────────────────────────────────────────────

export function getAddressConfirmConfig() {
  const row = db.prepare('SELECT action_config FROM automations WHERE id = ?').get(ADDRESS_CONFIRM_AUTOMATION_ID)
  let cfg = {}
  try { cfg = JSON.parse(row?.action_config || '{}') } catch { /* config illisible = valeurs par défaut */ }
  const raw = norm(cfg.types) || ADDRESS_CONFIRM_DEFAULT_CONFIG.types
  return { types: new Set(raw.split(/\s*,\s*/).filter(Boolean).map(fold)) }
}

/** Ce type d'adresse doit-il être confirmé auprès de l'API ? */
export function needsConfirmation(addressType, cfg = getAddressConfirmConfig()) {
  return cfg.types.has(fold(addressType))
}

// ── Confirmation ─────────────────────────────────────────────────────────────

/**
 * Interroge l'API et compare à la saisie. Ne persiste rien — utilisé tel quel
 * par le formulaire de création (l'adresse n'existe pas encore en base).
 *
 * @returns {Promise<{status,formatted,suggestion,diff,message}>}
 */
export async function confirmAddressInput(addr) {
  const query = buildQuery(addr)
  if (!query) {
    return { status: 'incomplete', formatted: '', suggestion: null, diff: [], message: 'Rue et ville requises pour confirmer' }
  }
  let place = null
  try {
    place = await findPlace(query)
  } catch (e) {
    return { status: 'unavailable', formatted: '', suggestion: null, diff: [], message: e.message }
  }
  if (!place) {
    return { status: 'not_found', formatted: '', suggestion: null, diff: [], message: 'Adresse introuvable' }
  }

  let details = null
  try {
    details = place.place_id ? await placeDetails(place.place_id) : null
  } catch {
    // Le candidat existe, seul le détail structuré manque : on garde le
    // formaté, sans suggestion applicable champ par champ.
    details = null
  }

  const formatted = details?.formatted_address || place.formatted_address || ''
  const c = details?.components
  if (!c) {
    return { status: 'confirmed', formatted, suggestion: null, diff: [], message: '' }
  }

  const sameCountry = !c.country
    || normalizeCountry(c.country) === (normalizeCountry(addr?.country) || norm(addr?.country).toUpperCase())

  const suggestion = {
    line1: c.line1 || norm(addr?.line1),
    city: c.city || norm(addr?.city),
    province: c.province || norm(addr?.province),
    postal_code: c.postal_code || norm(addr?.postal_code),
    // Pays équivalent : on garde l'écriture de la saisie (« Canada » ne
    // devient pas « CA » au passage).
    country: sameCountry ? norm(addr?.country) || c.country : c.country,
  }

  const diff = []
  if (!sameStreet(addr?.line1, c.line1)) diff.push('line1')
  if (c.city && fold(c.city) !== fold(addr?.city)) diff.push('city')
  if (c.province && c.province.toUpperCase() !== norm(addr?.province).toUpperCase()) diff.push('province')
  if (c.postal_code && compactPostal(c.postal_code) !== compactPostal(addr?.postal_code)) diff.push('postal_code')
  if (!sameCountry) diff.push('country')

  // Places répond toujours quelque chose : « 99999 rue Qwertyuiop,
  // Saint-Zzz » ramène une rue de Montréal. Quand la rue ET la ville
  // divergent, ce n'est pas une correction de la saisie, c'est un autre
  // endroit — on le dit introuvable plutôt que d'offrir un « Utiliser » qui
  // expédierait le colis ailleurs.
  const elsewhere = diff.includes('line1') && diff.includes('city')
  if (elsewhere) {
    return { status: 'not_found', formatted, suggestion: null, diff, message: 'Adresse introuvable' }
  }

  return {
    status: diff.length ? 'corrected' : 'confirmed',
    formatted,
    suggestion: diff.length ? suggestion : null,
    diff,
    message: '',
  }
}

function persistConfirmation(row, verdict) {
  const signature = addressSignature(row)
  const suggestion = verdict.suggestion ? JSON.stringify({ ...verdict.suggestion, diff: verdict.diff }) : null
  db.prepare(`
    UPDATE adresses
       SET confirm_status = ?, confirm_formatted = ?, confirm_suggestion = ?,
           confirm_signature = ?, confirmed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ?
  `).run(verdict.status, verdict.formatted || null, suggestion, signature, row.id)

  const fresh = db.prepare(
    'SELECT confirm_status, confirm_formatted, confirm_suggestion, confirmed_at FROM adresses WHERE id = ?'
  ).get(row.id)
  emitEntity('adresse', 'updated', row.id, { id: row.id, company_id: row.company_id, contact_id: row.contact_id, ...fresh })
  return fresh
}

/**
 * Confirme UNE adresse de la base et persiste le verdict.
 * Ne lève jamais : une confirmation impossible ne doit pas casser l'écriture
 * qui l'a déclenchée.
 *
 * @param {string} addressId
 * @param {{force?:boolean, log?:boolean}} opts `force` ignore l'empreinte.
 * @returns {Promise<verdict|null>} null = adresse absente, type non concerné ou déjà confirmée.
 */
export async function confirmAddressRecord(addressId, { force = false, log = true } = {}) {
  try {
    const row = db.prepare('SELECT * FROM adresses WHERE id = ?').get(addressId)
    if (!row) return null
    if (!force && !needsConfirmation(row.address_type)) return null
    // Même texte qu'à la dernière confirmation : inutile de repayer l'appel.
    if (!force && row.confirm_signature && row.confirm_signature === addressSignature(row)) return null

    const started = Date.now()
    const verdict = await confirmAddressInput(row)
    persistConfirmation(row, verdict)
    if (log && verdict.status !== 'confirmed') {
      logSystemRun(ADDRESS_CONFIRM_AUTOMATION_ID, {
        status: verdict.status === 'unavailable' ? 'error' : 'success',
        result: {
          summary: `${row.address_type || 'adresse'} — ${verdict.status}${verdict.formatted ? ` · ${verdict.formatted}` : ''}`,
          address_id: row.id,
          query: buildQuery(row),
          verdict,
        },
        error: verdict.status === 'unavailable' ? verdict.message : null,
        duration_ms: Date.now() - started,
      })
    }
    return verdict
  } catch (e) {
    console.error('⚠️  confirmAddressRecord:', e.message)
    return null
  }
}

// ── File d'attente ───────────────────────────────────────────────────────────
//
// Les écritures d'adresses arrivent en rafale (sync Airtable, autosave champ
// par champ). On sérialise les appels Google et on espace les requêtes : le
// serveur est mono-thread, une rafale d'appels sortants pénaliserait toutes les
// pages. L'empreinte (`confirm_signature`) fait le reste du travail : une
// adresse dont le texte n'a pas bougé ne repart pas chez Google.

const GAP_MS = 400
const pending = new Set()
let draining = false

async function drain() {
  if (draining) return
  draining = true
  try {
    while (pending.size) {
      const id = pending.values().next().value
      pending.delete(id)
      await confirmAddressRecord(id)
      if (pending.size) await new Promise(r => setTimeout(r, GAP_MS))
    }
  } finally {
    draining = false
  }
}

/**
 * Programme la confirmation d'une adresse (création ou modification), sans
 * bloquer l'appelant. Silencieux si l'automation est en pause ou si le type
 * d'adresse n'est pas concerné.
 */
export function scheduleAddressConfirm(addressId) {
  if (!addressId) return
  try {
    if (!isSystemAutomationActive(ADDRESS_CONFIRM_AUTOMATION_ID)) return
    const row = db.prepare(`
      SELECT id, company_id, contact_id, address_type, confirm_status, confirm_signature,
             line1, city, province, postal_code, country
        FROM adresses WHERE id = ?
    `).get(addressId)
    if (!row) return
    if (!needsConfirmation(row.address_type)) {
      // L'adresse a quitté les types confirmés (passée en facturation) : son
      // ancien verdict ne veut plus rien dire, on l'efface plutôt que de
      // laisser « confirmée » sur une adresse qu'on ne confirme plus.
      if (row.confirm_status) {
        db.prepare(`
          UPDATE adresses SET confirm_status = NULL, confirm_formatted = NULL,
                 confirm_suggestion = NULL, confirm_signature = NULL, confirmed_at = NULL
           WHERE id = ?
        `).run(addressId)
        emitEntity('adresse', 'updated', addressId, {
          id: addressId, company_id: row.company_id, contact_id: row.contact_id,
          confirm_status: null, confirm_formatted: null, confirm_suggestion: null, confirmed_at: null,
        })
      }
      return
    }
    if (row.confirm_signature && row.confirm_signature === addressSignature(row)) return
    pending.add(addressId)
    setTimeout(drain, 0)
  } catch (e) {
    console.error('⚠️  scheduleAddressConfirm:', e.message)
  }
}

/** Attend la file — tests uniquement. */
export async function _drainAddressConfirmQueue() { await drain() }

// ── Passe manuelle (bouton « Exécuter » de l'automation) ─────────────────────

/**
 * Confirme toutes les adresses concernées dont le texte a changé depuis leur
 * dernière confirmation. `dryRun` liste sans appeler l'API.
 */
export async function runAddressConfirmSweep({ dryRun = false, limit = 200 } = {}) {
  const cfg = getAddressConfirmConfig()
  const rows = db.prepare(`
    SELECT a.*, co.name AS company_name
    FROM adresses a LEFT JOIN companies co ON co.id = a.company_id
    ORDER BY a.updated_at DESC
  `).all()

  const todo = rows.filter(r => needsConfirmation(r.address_type, cfg)
    && (!r.confirm_signature || r.confirm_signature !== addressSignature(r)))

  if (dryRun) {
    return {
      summary: `${todo.length} adresse(s) à confirmer sur ${rows.length}`,
      addresses: todo.slice(0, 50).map(r => ({ id: r.id, company_name: r.company_name, query: buildQuery(r) })),
    }
  }

  const counts = { confirmed: 0, corrected: 0, not_found: 0, incomplete: 0, unavailable: 0 }
  for (const row of todo.slice(0, limit)) {
    const verdict = await confirmAddressRecord(row.id, { log: false })
    if (verdict && counts[verdict.status] !== undefined) counts[verdict.status]++
    await new Promise(r => setTimeout(r, GAP_MS))
  }
  return {
    summary: `${counts.confirmed} confirmée(s) · ${counts.corrected} à corriger · ${counts.not_found} introuvable(s)`
      + (counts.unavailable ? ` · ${counts.unavailable} indisponible(s)` : '')
      + (todo.length > limit ? ` · ${todo.length - limit} restante(s)` : ''),
    counts,
  }
}

export default {
  confirmAddressInput, confirmAddressRecord, scheduleAddressConfirm, needsConfirmation, runAddressConfirmSweep,
}
