// API de mutation générique (phase 1) — PATCH/DELETE /api/records/:table/:id
//
// Pilotée par db/recordRegistry.js : seules les tables explicitement enregistrées
// (CRUD simples, sans side-effect métier) sont accessibles. Toute table absente
// du registre renvoie 404 — les routes à logique métier restent intactes.
//
// Ce qui est préservé "par construction" :
//   - change_log : les triggers AFTER UPDATE/DELETE (db/changeLog.js) inscrivent
//     la mutation quel que soit le chemin SQL, donc le cache client se resynchronise
//     via /bootstrap/delta sans code supplémentaire ici.
//   - realtime : on émet via emitEntity(spec.entity, ...) avec le même nom d'entité
//     que la route dédiée, pour ne casser aucun abonné WebSocket existant.
//   - invalidation cache front : gérée côté client/src/lib/api.js.

import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { patchRow, deleteRow } from '../utils/crudRouter.js'
import { getRecordSpec, listRecordTables } from '../db/recordRegistry.js'

const router = Router()
router.use(requireAuth)

// Mapping table SQL → entity_type (activity_log) pour l'historique par
// enregistrement. Les clés sont hardcodées (sûres pour l'interpolation SQL) ;
// toute table absente renvoie 404. Les valeurs doivent matcher l'`entity` émis
// par emitEntity/emitOrder/emitCompany (cf. services/realtimeEmitters.js),
// sinon activity_log ne sera pas joint correctement.
const HISTORY_ENTITY_MAP = {
  companies: 'company',
  contacts: 'contact',
  orders: 'order',
  products: 'product',
  projects: 'project',
  factures: 'facture',
  tickets: 'ticket',
  tasks: 'task',
  shipments: 'shipment',
  employees: 'employee',
  purchases: 'purchase',
  achats_fournisseurs: 'achat_fournisseur',
  timesheets: 'timesheet',
  paies: 'paie',
  vacations: 'vacation',
  adresses: 'adresse',
  interactions: 'interaction',
  activity_codes: 'activity_code',
}

// GET /api/records/:table/:id/history — timeline « qui a fait quoi, quand » pour
// un enregistrement, calqué sur les endpoints /history de serials & sale-receipts
// mais générique. Deux sources fusionnées :
//   1. activity_log — persistant + attribué (acteur humain). Source primaire.
//   2. change_log — toutes mutations (48h), pour capter les syncs externes
//      (Airtable, Stripe, Gmail…) qui n'ont pas d'acteur humain. Dédupliqué
//      contre activity_log (±3 s) pour ne pas doubler les éditions humaines.
// Plus un événement « created » synthétisé depuis created_at si absent des logs.
router.get('/:table/:id/history', (req, res) => {
  const table = req.params.table
  const entity = HISTORY_ENTITY_MAP[table]
  if (!entity) {
    return res.status(404).json({ error: `Historique non disponible pour la table : ${table}` })
  }
  const id = req.params.id

  // 1. Événements attribués, persistants.
  const acts = db.prepare(`
    SELECT a.id, a.action, a.detail, a.created_at, a.user_id, u.name AS user_name
    FROM activity_log a
    LEFT JOIN users u ON u.id = a.user_id
    WHERE a.entity_type = ? AND a.entity_id = ?
  `).all(entity, id)

  const events = acts.map(a => ({
    id: `act-${a.id}`,
    action: a.action,
    detail: a.detail,
    created_at: a.created_at,
    user_id: a.user_id,
    user_name: a.user_name,
    source: 'user',
  }))

  // 2. Mutations brutes orphelines (= sans acteur humain à ±3 s) → syncs/système.
  const WINDOW_MS = 3000
  const actTimes = acts.map(a => Date.parse(a.created_at)).filter(n => !Number.isNaN(n))
  const muts = db.prepare(`
    SELECT id, change_type, changed_at
    FROM change_log
    WHERE table_name = ? AND record_id = ?
  `).all(table, id)
  for (const m of muts) {
    const t = Date.parse(m.changed_at)
    if (actTimes.some(at => Math.abs(at - t) <= WINDOW_MS)) continue
    events.push({
      id: `chl-${m.id}`,
      action: m.change_type === 'delete' ? 'deleted' : 'updated',
      detail: null,
      created_at: m.changed_at,
      user_id: null,
      user_name: null,
      source: 'system',
    })
  }

  // 3. Synthèse de l'événement de création depuis created_at (les records issus
  //    d'une sync ou antérieurs à la journalisation n'ont aucun log de création).
  if (!events.some(e => e.action === 'created')) {
    try {
      // table provient d'une clé hardcodée de HISTORY_ENTITY_MAP → safe à interpoler.
      const rec = db.prepare(`SELECT created_at FROM ${table} WHERE id = ?`).get(id)
      if (rec?.created_at) {
        events.push({
          id: 'synthetic-created',
          action: 'created',
          detail: null,
          created_at: rec.created_at,
          user_id: null,
          user_name: null,
          source: 'system',
        })
      }
    } catch { /* table sans colonne created_at — pas de synthèse */ }
  }

  // Plus récent d'abord (tri lexicographique = chrono car ISO UTC avec Z).
  events.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
  res.json({ data: events })
})

// Récupère le spec ou répond 404. Les noms table/colonnes proviennent du registre
// (constantes hardcodées) — aucune valeur utilisateur n'entre dans le SQL.
// Seules les tables sans auth spécifique (listRecordTables) passent par ici :
// la porte générique n'a que requireAuth.
function resolveSpec(req, res) {
  const spec = listRecordTables().includes(req.params.table) ? getRecordSpec(req.params.table) : null
  if (!spec) {
    res.status(404).json({ error: `Table inconnue ou non gérée par l'API générique : ${req.params.table}` })
    return null
  }
  return spec
}

router.patch('/:table/:id', (req, res) => {
  const spec = resolveSpec(req, res)
  if (!spec) return
  const r = patchRow(spec, req.params.id, req.body, req)
  res.status(r.status).json(r.json)
})

router.delete('/:table/:id', (req, res) => {
  const spec = resolveSpec(req, res)
  if (!spec) return
  const r = deleteRow(spec, req.params.id, req)
  res.status(r.status).json(r.json)
})

export default router
