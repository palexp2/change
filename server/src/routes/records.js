import { HR_TABLES, isHR } from '../services/dataAccess.js'
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
import { requireAuth } from '../middleware/auth.js'
import { patchRow, deleteRow } from '../utils/crudRouter.js'
import { getRecordSpec, listRecordTables } from '../db/recordRegistry.js'
import { REVISION_TABLES, listRevisions } from '../services/recordRevisions.js'

const router = Router()
router.use(requireAuth)
router.param('table', (req, res, next, table) => {
  if (HR_TABLES.has(table) && !isHR(req.user)) return res.status(403).json({ error: 'Accès RH requis' })
  next()
})

// GET /api/records/:table/:id/revisions — historique champ par champ (ancienne
// → nouvelle valeur, auteur) affiché au bas des fiches. Voir services/recordRevisions.js.
router.get('/:table/:id/revisions', (req, res) => {
  if (!Object.hasOwn(REVISION_TABLES, req.params.table)) return res.status(404).json({ error: 'Historique non disponible' })
  res.json(listRevisions(req.params.table, req.params.id))
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
