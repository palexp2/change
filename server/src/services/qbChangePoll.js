// « Qu'est-ce qui a changé dans QuickBooks depuis la dernière fois ? »
//
// Les avis instantanés d'Intuit (routes/quickbooks-webhook.js) restent la voie
// idéale, mais ils dépendent d'un réglage dans le portail développeur qui, chez
// nous, n'a jamais rien envoyé de réel (2026-09-19 : seule leur notification de
// test est arrivée). Ce passage donne le même résultat sans dépendre d'eux : UN
// appel toutes les 30 secondes qui demande la liste des écritures modifiées, et
// le même traitement que pour un avis reçu.
//
// Coût : un seul appel par passage, quel que soit le nombre de comptes — c'est
// l'interface « change data capture » de QuickBooks, déjà utilisée pour les
// factures fournisseurs (services/quickbooks.js:importFromQB). Un passage qui ne
// trouve rien ne coûte rien d'autre.
import db from '../db/database.js'
import { qbGet, getQbRealmIdSync } from '../connectors/quickbooks.js'
import { isSystemAutomationActive } from './systemAutomations.js'
import { logSync } from './syncLog.js'

export const POLL_AUTOMATION_ID = 'sys_qb_change_poll'
const CURSOR_KEY = 'change_poll_cursor'
// QuickBooks refuse une fenêtre de plus de 30 jours ; on s'arrête bien avant.
const MAX_LOOKBACK_MIN = 7 * 24 * 60
// Recouvrement volontaire : une écriture enregistrée pile pendant l'appel
// précédent serait sinon manquée. Les doublons sont sans effet (idempotence par
// empreinte dans qb_webhook_events).
const OVERLAP_MIN = 2

function readCursor() {
  const row = db.prepare(
    "SELECT value FROM connector_config WHERE connector='quickbooks' AND key=?"
  ).get(CURSOR_KEY)
  return row?.value || null
}

function writeCursor(iso) {
  db.prepare(`
    INSERT INTO connector_config (connector, key, value) VALUES ('quickbooks', ?, ?)
    ON CONFLICT(connector, key) DO UPDATE SET value=excluded.value
  `).run(CURSOR_KEY, iso)
}

// Format attendu par QuickBooks : ISO sans millisecondes.
function qbInstant(date) {
  return new Date(date).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function changedSinceFor(now = Date.now(), cursor = readCursor()) {
  const floor = now - MAX_LOOKBACK_MIN * 60_000
  const parsed = cursor ? Date.parse(cursor) : NaN
  const from = Number.isFinite(parsed) ? parsed - OVERLAP_MIN * 60_000 : now - 30 * 60_000
  return qbInstant(Math.max(from, floor))
}

// La réponse groupe les objets par entité ; un objet supprimé porte
// status:'Deleted' et n'a que son Id.
export function entitiesFromCdc(data, realmId) {
  const out = []
  for (const group of data?.CDCResponse?.[0]?.QueryResponse || []) {
    for (const [name, list] of Object.entries(group)) {
      if (!Array.isArray(list)) continue
      for (const o of list) {
        if (!o?.Id) continue
        const deleted = o.status === 'Deleted' || o.status === 'Voided'
        out.push({
          realmId,
          name,
          id: String(o.Id),
          operation: deleted ? 'Delete' : 'Update',
          lastUpdated: o.MetaData?.LastUpdatedTime || null,
        })
      }
    }
  }
  return out
}

let running = false

export async function pollQbChanges({ trigger = 'planifie' } = {}) {
  if (running) return { skipped: 'en cours' }
  if (!isSystemAutomationActive(POLL_AUTOMATION_ID)) return { skipped: 'inactive' }
  running = true
  const t0 = Date.now()
  try {
    const { SUBSCRIBED_ENTITIES, ingestEntities } = await import('../routes/quickbooks-webhook.js')
    const since = changedSinceFor(t0)
    const data = await qbGet(
      `/cdc?entities=${SUBSCRIBED_ENTITIES.join(',')}&changedSince=${encodeURIComponent(since)}`
    )
    const entities = entitiesFromCdc(data, String(getQbRealmIdSync() || ''))
    const handled = await ingestEntities(entities)
    // Le curseur n'avance qu'après un passage réussi : une panne réseau ne crée
    // pas de trou dans la surveillance.
    writeCursor(qbInstant(t0))
    if (handled) {
      console.log(`🔔 QuickBooks: ${handled} écriture(s) modifiée(s) reprise(s) (depuis ${since})`)
      logSync('qb_change_poll', trigger, { status: 'success', modified: handled, durationMs: Date.now() - t0 })
    }
    return { since, seen: entities.length, handled }
  } catch (e) {
    // Journalisé, mais sans faire de bruit à chaque passage : une erreur
    // passagère (jeton en cours de renouvellement) se répare toute seule.
    logSync('qb_change_poll', trigger, { status: 'error', error: e.message, durationMs: Date.now() - t0 })
    return { error: e.message }
  } finally {
    running = false
  }
}

export function changePollStatus() {
  const last = db.prepare(`
    SELECT status, records_modified, error_message, created_at FROM sync_log
    WHERE module='qb_change_poll' ORDER BY created_at DESC LIMIT 1
  `).get() || null
  return {
    active: isSystemAutomationActive(POLL_AUTOMATION_ID),
    cursor: readCursor(),
    last,
  }
}
