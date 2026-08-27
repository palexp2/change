// Écritures de fin de mois : provisions (crédit d'impôt R&D, subvention
// salariale) + heures R&D du mois. L'écriture FPA reste servie par
// /api/prepaid/fpa/month/:month — la page de fin de mois consomme les deux.
import { Router } from 'express'
import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import {
  monthEndState, listProvisions, getProvision, updateProvision,
  updateProvisionMonth, provisionSeries, publishProvisionMonth, rdHours,
  correctProvisionMonth,
} from '../services/monthEnd.js'
import { importRdHours, timesheetFileName } from '../services/rdTimesheetImport.js'
import { monthEndChecks } from '../services/monthEndChecks.js'
import { monthEndAutomationConfig } from '../services/monthEndAutomation.js'
import { buildFpaMonth } from '../services/prepaid.js'
import {
  listReceipts, addReceipt, updateReceipt, deleteReceipt,
  subsidyReconciliation, regularizeSubsidy, detectBankReceipts,
} from '../services/wageSubsidyReceipts.js'
import {
  piecesMonthState, recomputePiecesMonth, updatePiecesMonth,
  generatePiecesSheet, piecesSlackPreview, sendPiecesSlack,
} from '../services/piecesDisbursements.js'

const router = Router()
router.use(requireAuth)

const isMonth = v => /^\d{4}-\d{2}$/.test(String(v || ''))

// État complet d'un mois : provisions + heures + écriture FPA du même mois.
router.get('/month/:month', (req, res) => {
  if (!isMonth(req.params.month)) return res.status(400).json({ error: 'month invalide (YYYY-MM)' })
  try {
    const state = monthEndState(req.params.month)
    res.json({ ...state, fpa: buildFpaMonth(req.params.month), timesheet_file: timesheetFileName(req.params.month) })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// Checklist de préparation : connexions, fraîcheur de la feuille de temps,
// paies du mois, comptes QB. Route séparée de /month/:month — la recherche
// Drive est lente, la page affiche les provisions sans l'attendre.
router.get('/month/:month/checks', async (req, res) => {
  if (!isMonth(req.params.month)) return res.status(400).json({ error: 'month invalide (YYYY-MM)' })
  try {
    const { googleAccountEmail } = monthEndAutomationConfig()
    res.json(await monthEndChecks(req.params.month, { googleAccountEmail }))
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

router.get('/provisions', (req, res) => {
  res.json(listProvisions({ includeInactive: true }))
})

// Historique d'une provision jusqu'au mois demandé (cumulatifs inclus).
router.get('/provisions/:id/series/:month', (req, res) => {
  if (!isMonth(req.params.month)) return res.status(400).json({ error: 'month invalide (YYYY-MM)' })
  const provision = getProvision(req.params.id)
  if (!provision) return res.status(404).json({ error: 'Provision introuvable' })
  res.json({ provision, series: provisionSeries(provision, req.params.month) })
})

router.put('/provisions/:id', (req, res) => {
  try {
    res.json(updateProvision(req.params.id, req.body || {}))
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// Intrants du mois (PARI) et override de montant — autosave côté client.
router.put('/provisions/:id/months/:month', (req, res) => {
  if (!isMonth(req.params.month)) return res.status(400).json({ error: 'month invalide (YYYY-MM)' })
  try {
    res.json(updateProvisionMonth(req.params.id, req.params.month, req.body || {}))
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// Comptabilisation dans QuickBooks — action transactionnelle approuvée par
// l'utilisateur (bouton), jamais automatique.
router.post('/provisions/:id/months/:month/publish', async (req, res) => {
  if (!isMonth(req.params.month)) return res.status(400).json({ error: 'month invalide (YYYY-MM)' })
  try {
    res.json(await publishProvisionMonth(req.params.id, req.params.month, { userId: req.user.id }))
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// Corrige une écriture DÉJÀ comptabilisée pour suivre le calcul actuel (ex. les
// heures R&D ont été réimportées après la publication). Sparse update dans QB,
// jamais automatique.
router.post('/provisions/:id/months/:month/correct', async (req, res) => {
  if (!isMonth(req.params.month)) return res.status(400).json({ error: 'month invalide (YYYY-MM)' })
  try {
    res.json(await correctProvisionMonth(req.params.id, req.params.month, { userId: req.user.id }))
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// ── Rapprochement encaissement de la subvention salariale ──────────────────

router.get('/provisions/:id/receipts', (req, res) => {
  if (!getProvision(req.params.id)) return res.status(404).json({ error: 'Provision introuvable' })
  res.json({
    receipts: listReceipts(req.params.id),
    reconciliation: subsidyReconciliation(req.params.id),
  })
})

// Relance la détection immédiatement (sans attendre le prochain import
// bancaire) — utile juste après avoir configuré ou changé le libellé à
// rechercher (config.bank_match_label).
router.post('/provisions/:id/receipts/scan-bank', (req, res) => {
  if (!getProvision(req.params.id)) return res.status(404).json({ error: 'Provision introuvable' })
  try {
    res.json({ found: detectBankReceipts(req.params.id) })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

router.post('/provisions/:id/receipts', (req, res) => {
  try {
    res.status(201).json(addReceipt(req.params.id, req.body || {}, req.user.id))
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

router.put('/receipts/:id', (req, res) => {
  try {
    res.json(updateReceipt(req.params.id, req.body || {}))
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

router.delete('/receipts/:id', (req, res) => {
  deleteReceipt(req.params.id)
  res.json({ ok: true })
})

// Écriture qui vide l'écart entre provisionné et réellement reçu — jamais
// automatique, bouton dédié sur la carte de la provision.
router.post('/provisions/:id/regularize', async (req, res) => {
  try {
    res.json(await regularizeSubsidy(req.params.id, { userId: req.user.id }))
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// ── Heures R&D ──────────────────────────────────────────────────────────────

router.get('/hours/:month', (req, res) => {
  if (!isMonth(req.params.month)) return res.status(400).json({ error: 'month invalide (YYYY-MM)' })
  res.json(rdHours(req.params.month))
})

// L'import manuel suit la même config que le cron du 1er (compte Google qui a
// accès au dossier, liste des sous-traitants) — page Automations pour l'éditer.
router.post('/hours/:month/import', async (req, res) => {
  if (!isMonth(req.params.month)) return res.status(400).json({ error: 'month invalide (YYYY-MM)' })
  try {
    res.json(await importRdHours(req.params.month, monthEndAutomationConfig()))
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

router.post('/hours', (req, res) => {
  const { month, employee_name, hours, contractor } = req.body || {}
  if (!isMonth(month)) return res.status(400).json({ error: 'month invalide (YYYY-MM)' })
  if (!String(employee_name || '').trim()) return res.status(400).json({ error: 'employee_name requis' })
  const h = Number(hours)
  if (!Number.isFinite(h) || h < 0) return res.status(400).json({ error: 'hours invalide' })
  const exists = db.prepare(`
    SELECT 1 FROM rd_month_hours WHERE month = ? AND employee_name = ? AND deleted_at IS NULL
  `).get(month, employee_name.trim())
  if (exists) return res.status(400).json({ error: 'Cette personne a déjà une ligne pour ce mois' })
  const id = randomUUID()
  db.prepare(`
    INSERT INTO rd_month_hours (id, month, employee_name, hours, contractor, source)
    VALUES (?,?,?,?,?,'manuel')
  `).run(id, month, employee_name.trim(), h, contractor ? 1 : 0)
  res.json(db.prepare('SELECT * FROM rd_month_hours WHERE id = ?').get(id))
})

// Une correction à la main verrouille la ligne : l'import mensuel ne l'écrase
// plus (il la signale comme conservée).
router.put('/hours/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM rd_month_hours WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Ligne introuvable' })
  const patch = req.body || {}
  const fields = []
  const values = []
  if (patch.hours !== undefined) {
    const h = Number(patch.hours)
    if (!Number.isFinite(h) || h < 0) return res.status(400).json({ error: 'hours invalide' })
    fields.push('hours = ?'); values.push(h)
    fields.push("source = 'manuel'")
  }
  if (patch.contractor !== undefined) { fields.push('contractor = ?'); values.push(patch.contractor ? 1 : 0) }
  if (patch.notes !== undefined) { fields.push('notes = ?'); values.push(patch.notes || null) }
  if (!fields.length) return res.json(row)
  fields.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
  db.prepare(`UPDATE rd_month_hours SET ${fields.join(', ')} WHERE id = ?`).run(...values, req.params.id)
  res.json(db.prepare('SELECT * FROM rd_month_hours WHERE id = ?').get(req.params.id))
})

router.delete('/hours/:id', (req, res) => {
  db.prepare(`UPDATE rd_month_hours SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
    .run(req.params.id)
  res.json({ ok: true })
})

// ── Déboursés de pièces ─────────────────────────────────────────────────────

// État servi tel qu'enregistré : la page s'affiche sans attendre QuickBooks.
// Le recalcul est une action explicite (interroge le GL + chaque facture).
router.get('/pieces/:month', (req, res) => {
  if (!isMonth(req.params.month)) return res.status(400).json({ error: 'month invalide (YYYY-MM)' })
  try {
    res.json(piecesMonthState(req.params.month))
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

router.post('/pieces/:month/compute', async (req, res) => {
  if (!isMonth(req.params.month)) return res.status(400).json({ error: 'month invalide (YYYY-MM)' })
  try {
    res.json(await recomputePiecesMonth(req.params.month))
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// Corrections manuelles des deux montants « à payer » — autosave côté client.
router.put('/pieces/:month', (req, res) => {
  if (!isMonth(req.params.month)) return res.status(400).json({ error: 'month invalide (YYYY-MM)' })
  try {
    res.json(updatePiecesMonth(req.params.month, req.body || {}))
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

router.post('/pieces/:month/sheet', async (req, res) => {
  if (!isMonth(req.params.month)) return res.status(400).json({ error: 'month invalide (YYYY-MM)' })
  try {
    res.json(await generatePiecesSheet(req.params.month))
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

router.get('/pieces/:month/slack', (req, res) => {
  if (!isMonth(req.params.month)) return res.status(400).json({ error: 'month invalide (YYYY-MM)' })
  try {
    res.json(piecesSlackPreview(req.params.month))
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// Envoi du message — action sortante approuvée par l'utilisateur (bouton),
// jamais déclenchée par le cron du 7.
router.post('/pieces/:month/slack', async (req, res) => {
  if (!isMonth(req.params.month)) return res.status(400).json({ error: 'month invalide (YYYY-MM)' })
  try {
    res.json(await sendPiecesSlack(req.params.month, { userId: req.user.id }))
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

export default router
