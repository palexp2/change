import { Router } from 'express'
import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { buildPartialUpdate } from '../utils/partialUpdate.js'
import { qbEntityUrl } from '../connectors/quickbooks.js'
import { requireAuth } from '../middleware/auth.js'
import {
  computeProjection, computeActuals, checkTreasuryAlert, variableOccurrence,
  checkBalanceVariance, reconcileBalanceEntry,
  getTreasuryConfig, TREASURY_DEFAULT_CONFIG, TREASURY_AUTOMATION_ID,
} from '../services/treasury.js'

import {
  listPayments, getPayment, createPayment, setCleared, autoClearFromBank,
  validatePayment, PAYMENT_FIELDS, PAYMENT_METHODS,
  vendorPaymentHints, learnPaymentNote, paymentTemplates, openBills,
  enrichInvoiceDatesFromQb,
} from '../services/treasuryPayments.js'

import {
  buildSchedule, payBill, unpayBill, deferBill, resumeBill, setVendorParticularites,
} from '../services/paymentSchedule.js'

import {
  updateCardDue, payCardDue, unpayCardDue, dismissCardDue,
} from '../services/cardDues.js'

import {
  buildCardCeilings, createCard, updateCard, deleteCard, clearQbCardCache,
} from '../services/cardCeiling.js'

const router = Router()
router.use(requireAuth)

// ── Cédule hebdomadaire de paiements fournisseurs ────────────────────────────
// « Qu'est-ce qu'on paie cette semaine, et est-ce que le compte suit ? » Les
// factures ouvertes non couvertes (paiement émis, sortie récurrente) triées par
// échéance et regroupées par fournisseur, avec le total de la semaine confronté
// au solde disponible BNC et le solde projeté de la carte de crédit.

router.get('/payment-schedule', (req, res) => {
  res.json(buildSchedule({ from: req.query.from || null }))
})

// Cocher = « je le paie » : crée le paiement émis du jour, lié à la facture.
router.post('/payment-schedule/:achatId/pay', (req, res) => {
  const result = payBill(req.params.achatId, req.body || {}, req.user.id)
  if (result.error) return res.status(result.status || 400).json({ error: result.error })
  res.status(result.created ? 201 : 200).json(result.payment)
})

// Décocher : supprime le paiement tant qu'il n'est pas passé à la banque.
router.delete('/payment-schedule/:achatId/pay', (req, res) => {
  const result = unpayBill(req.params.achatId)
  if (result.error) return res.status(result.status || 400).json({ error: result.error })
  res.json(result)
})

// Report explicite (raison obligatoire côté UI, autosave au blur).
router.put('/payment-schedule/:achatId/defer', (req, res) => {
  const until = req.body?.defer_until
  if (until && !/^\d{4}-\d{2}-\d{2}$/.test(String(until))) {
    return res.status(400).json({ error: 'defer_until au format YYYY-MM-DD' })
  }
  const exists = db.prepare("SELECT id FROM achats_fournisseurs WHERE id=? AND type='bill'").get(req.params.achatId)
  if (!exists) return res.status(404).json({ error: 'Facture introuvable' })
  res.json(deferBill(req.params.achatId, { reason: req.body?.reason, defer_until: until || null }, req.user.id))
})

router.delete('/payment-schedule/:achatId/defer', (req, res) => {
  res.json(resumeBill(req.params.achatId))
})

// Corriger la remarque ambre d'une ligne : elle appartient au PROFIL du
// fournisseur, c'est donc lui qui est modifié (une remarque fausse est fausse
// partout). Autosave au blur côté UI.
router.put('/payment-schedule/:achatId/particularites', (req, res) => {
  const value = req.body?.particularites
  if (value != null && typeof value !== 'string') {
    return res.status(400).json({ error: 'particularites: texte attendu' })
  }
  if (value && value.length > 4000) {
    return res.status(400).json({ error: 'particularites: 4000 caractères maximum' })
  }
  const result = setVendorParticularites(req.params.achatId, value ?? null)
  if (result.error) return res.status(result.status || 400).json({ error: result.error })
  res.json(result)
})

// ── Paiements et virements émis (remplace l'onglet Pmt_Suivi) ─────────────────
// Un paiement existe dès qu'il est émis ; `cleared_at` dit s'il est passé à la
// ── Cartes de crédit à payer ─────────────────────────────────────────────────
// Le solde d'une Visa n'arrive par aucun canal automatique : il se saisit à la
// main, d'où ces routes d'édition. « J'ai payé » crée le paiement émis
// exactement comme pour une facture — la ligne quitte la cédule et passe dans
// « À passer à la banque ».

router.put('/card-dues/:id', (req, res) => {
  const out = updateCardDue(req.params.id, req.body || {})
  if (out.error) return res.status(out.status || 400).json({ error: out.error })
  res.json(out.due)
})

router.post('/card-dues/:id/pay', (req, res) => {
  const out = payCardDue(req.params.id, req.body || {}, req.user?.id || null)
  if (out.error) return res.status(out.status || 400).json({ error: out.error })
  // Solde à zéro : rien n'est émis, le mois est simplement classé.
  if (out.nothingToPay) return res.json({ nothing_to_pay: true, due: out.due })
  res.status(out.created ? 201 : 200).json(out.payment)
})

router.delete('/card-dues/:id/pay', (req, res) => {
  const out = unpayCardDue(req.params.id)
  if (out.error) return res.status(out.status || 400).json({ error: out.error })
  res.json(out)
})

router.post('/card-dues/:id/dismiss', (req, res) => {
  const out = dismissCardDue(req.params.id, true)
  if (out.error) return res.status(out.status || 404).json({ error: out.error })
  res.json(out.due)
})

router.delete('/card-dues/:id/dismiss', (req, res) => {
  const out = dismissCardDue(req.params.id, false)
  if (out.error) return res.status(out.status || 404).json({ error: out.error })
  res.json(out.due)
})

// ── Plafond des cartes de crédit ─────────────────────────────────────────────
// Question complémentaire de celle du dessus (« as-tu payé la carte ? ») : « la
// carte a-t-elle encore de la place ? ». Solde QuickBooks + achats du relevé pas
// encore comptabilisés, confrontés au plafond cible et au prélèvement du mois.

router.get('/card-ceilings', async (req, res) => {
  try {
    res.json(await buildCardCeilings({ refresh: !!req.query.refresh }))
  } catch (e) {
    res.status(502).json({ error: e.message || 'Lecture des soldes impossible' })
  }
})

router.post('/card-ceilings', (req, res) => {
  const out = createCard(req.body || {})
  if (out.error) return res.status(out.status || 400).json({ error: out.error })
  res.status(201).json(out.card)
})

// Autosave : un champ à la fois, PATCH.
router.patch('/card-ceilings/:id', (req, res) => {
  const out = updateCard(req.params.id, req.body || {})
  if (out.error) return res.status(out.status || 400).json({ error: out.error })
  // Le compte QB a pu changer : le cache de solde porterait sinon l'ancien.
  clearQbCardCache()
  res.json(out.card)
})

router.delete('/card-ceilings/:id', (req, res) => {
  const out = deleteCard(req.params.id)
  if (out.error) return res.status(out.status || 404).json({ error: out.error })
  res.json(out)
})

// banque. Tant qu'il ne l'est pas, il pèse sur la projection.

router.get('/payments', async (req, res) => {
  const status = ['pending', 'cleared', 'all'].includes(req.query.status) ? req.query.status : 'all'
  const rows = listPayments({ status, from: req.query.from, to: req.query.to, limit: req.query.limit })
  // Date de la facture manquante, sans lien vers un achat ERP, mais avec un n°
  // de facture : on va la chercher chez QuickBooks (Bill/Purchase par
  // DocNumber). Best-effort — un échec (offline, pas trouvée) ne bloque jamais
  // l'affichage, la ligne réessaiera au prochain chargement.
  await enrichInvoiceDatesFromQb(rows).catch(() => {})
  // Deux liens QuickBooks, deux natures :
  //   - `qb_url` : l'écriture qui a prouvé le passage à la banque ;
  //   - `bill_qb_url` : la facture fournisseur réglée par ce paiement — c'est
  //     elle qu'on ouvre en cliquant son n° (même geste que dans la cédule).
  res.json(rows.map(p => ({
    ...p,
    qb_url: p.qb_txn_id && p.qb_txn_type ? qbEntityUrl(p.qb_txn_type, p.qb_txn_id) : null,
    bill_qb_url: p.achat_qb_id ? qbEntityUrl('bill', p.achat_qb_id) : null,
  })))
})

// Mémoire « comment on paie ce fournisseur » : dernier commentaire, moyen et
// compte utilisés par fournisseur. Sert à re-proposer le commentaire dès que le
// nom est saisi dans le formulaire de nouveau paiement.
router.get('/payments/vendor-hints', (req, res) => {
  res.json(vendorPaymentHints())
})

// « Repartir d'un paiement déjà fait » : les combinaisons bénéficiaire + moyen +
// comptes déjà utilisées, les plus récentes d'abord. L'historique sert de
// catalogue de modèles — aucune table à entretenir.
router.get('/payments/templates', (req, res) => {
  res.json(paymentTemplates({ limit: req.query.limit }))
})

// Factures fournisseurs encore à payer : on en choisit une dans /paiements-emis
// et le formulaire se pré-remplit (fournisseur, montant, n° de facture) avec le
// lien achat_id — la facture sort alors de la liste et de la projection en double.
router.get('/payments/open-bills', (req, res) => {
  res.json(openBills({ limit: req.query.limit }))
})

router.post('/payments', (req, res) => {
  const error = validatePayment(req.body)
  if (error) return res.status(400).json({ error })
  const created = createPayment({ ...req.body, source: 'manual' }, req.user.id)
  // Le commentaire saisi devient la note de paiement du profil fournisseur.
  learnPaymentNote(created.label, created.notes)
  res.status(201).json(created)
})

router.put('/payments/:id', (req, res) => {
  const existing = getPayment(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  const error = validatePayment(req.body, { partial: true })
  if (error) return res.status(400).json({ error })
  const { setClause, values, error: buildError } = buildPartialUpdate(req.body, {
    allowed: PAYMENT_FIELDS,
    nonNullable: new Set(['payment_date', 'amount']),
  })
  if (buildError) return res.status(400).json({ error: buildError })
  if (setClause) {
    db.prepare(`UPDATE treasury_payments SET ${setClause}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(...values, req.params.id)
  }
  const updated = getPayment(req.params.id)
  if ('notes' in req.body) learnPaymentNote(updated.label, updated.notes)
  res.json(updated)
})

// Coche / décoche « passé à la banque » — le vert du fichier Pmt_Suivi.
router.post('/payments/:id/cleared', (req, res) => {
  const existing = getPayment(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  const cleared = !(req.body.cleared === false || req.body.cleared === 0)
  res.json(setCleared(req.params.id, cleared))
})

router.delete('/payments/:id', (req, res) => {
  const existing = getPayment(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  db.prepare(`UPDATE treasury_payments SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`)
    .run(req.params.id)
  res.json({ ok: true })
})

// Appariement au relevé bancaire importé → coche les paiements retrouvés.
router.post('/payments/auto-clear', (req, res) => {
  res.json(autoClearFromBank({ accountName: req.body.account || null }))
})

// ── « Passé à la banque » détecté dans QuickBooks ────────────────────────────
// Le grand livre QB marque chaque écriture compensée (« C ») ou rapprochée
// (« R ») : c'est la preuve que l'argent est sorti du compte. Les appariements
// sûrs sont cochés, les autres sont retournés pour confirmation.

router.get('/payments/qb-clear/status', async (req, res) => {
  const { qbClearStatus } = await import('../services/treasuryQbClear.js')
  res.json(qbClearStatus())
})

// dry_run=1 → simulation (aucune écriture).
router.post('/payments/qb-clear', async (req, res) => {
  try {
    const { syncQbClear } = await import('../services/treasuryQbClear.js')
    const dryRun = req.body?.dry_run === true || req.body?.dry_run === '1' || req.query.dry_run === '1'
    res.json(await syncQbClear({ trigger: 'manual', apply: !dryRun, userId: req.user.id }))
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

// Confirmation manuelle d'une sélection : { payment_ids: [], achat_ids: [] }.
// La détection est refaite côté serveur — on ne coche jamais sur la seule foi
// d'un id envoyé par le client.
router.post('/payments/qb-clear/apply', async (req, res) => {
  const paymentIds = Array.isArray(req.body?.payment_ids) ? req.body.payment_ids.map(String) : []
  const achatIds = Array.isArray(req.body?.achat_ids) ? req.body.achat_ids.map(String) : []
  if (!paymentIds.length && !achatIds.length) {
    return res.status(400).json({ error: 'payment_ids ou achat_ids requis' })
  }
  try {
    const { applyQbCleared } = await import('../services/treasuryQbClear.js')
    res.json(await applyQbCleared({ paymentIds, achatIds, userId: req.user.id }))
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

// Reprise de l'historique depuis l'onglet Pmt_Suivi (vert = passé à la banque).
router.post('/payments/import-sheet', async (req, res) => {
  try {
    const { importPmtSuivi } = await import('../services/pmtSuiviImport.js')
    const since = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.since || '')) ? req.body.since : null
    const result = await importPmtSuivi({ since, googleAccountEmail: req.body.google_account_email || null, userId: req.user.id })
    autoClearFromBank({ accountName: 'BNC CAD' })
    res.json(result)
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

// État de la sync automatique de l'onglet Pmt_Suivi (toutes les 30 min) :
// active ? dernier passage ? — affiché à côté du bouton « Synchroniser la feuille ».
router.get('/payments/sheet-status', async (req, res) => {
  const { pmtSuiviStatus } = await import('../services/pmtSuiviImport.js')
  res.json(pmtSuiviStatus())
})

router.get('/payment-methods', (req, res) => res.json(PAYMENT_METHODS))

// ── Sync du fichier « Maintien du solde disponible BNC » (Google Sheet) ──────
// Le fichier fait foi : la sync importe le solde réel, ajoute les paiements
// planifiés inconnus de l'ERP et aligne les récurrentes. ?dry_run=1 (ou body
// { dry_run: true }) liste les différences sans rien écrire.

router.get('/solde-sheet/status', async (req, res) => {
  const { soldeSheetStatus } = await import('../services/treasurySoldeSheet.js')
  res.json(soldeSheetStatus())
})

router.post('/solde-sheet/sync', async (req, res) => {
  try {
    const { syncSoldeSheet, soldeSheetStatus } = await import('../services/treasurySoldeSheet.js')
    // Automation désactivée le 2026-08-29 (Charles : le fichier créait des
    // paiements en double avec Pmt_Suivi/la cédule) — le bouton manuel ne doit
    // pas rester une porte de derrière qui relance la sync quand même.
    if (!soldeSheetStatus().active) {
      return res.status(409).json({ error: 'Synchronisation désactivée — voir la page Automations pour la réactiver' })
    }
    const dryRun = req.body?.dry_run === true || req.body?.dry_run === '1' || req.query.dry_run === '1'
    const result = await syncSoldeSheet({ trigger: 'manual', apply: !dryRun, userId: req.user.id })
    res.json(result)
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

// Sync du fichier seulement s'il n'a pas tourné depuis `max_age_minutes`
// (défaut 20). Appelée à l'ouverture de la page : la donnée du fichier est à
// jour sans que personne n'ait à cliquer « Synchroniser ».
router.post('/solde-sheet/sync-if-stale', async (req, res) => {
  try {
    const { syncSoldeSheet, minutesSinceLastSoldeSheetRun, soldeSheetStatus } =
      await import('../services/treasurySoldeSheet.js')
    const maxAge = Math.min(1440, Math.max(1, Number(req.body?.max_age_minutes ?? req.query.max_age_minutes) || 20))
    const status = soldeSheetStatus()
    if (!status.active) return res.json({ skipped: true, reason: 'automation désactivée', status })
    const since = minutesSinceLastSoldeSheetRun()
    if (since != null && since < maxAge) {
      return res.json({ skipped: true, reason: `synchronisé il y a ${Math.round(since)} min`, status })
    }
    const result = await syncSoldeSheet({ trigger: 'page', apply: true, userId: req.user.id })
    res.json({ skipped: false, ...result })
  } catch (e) {
    // Un fichier inaccessible ne doit pas casser l'ouverture de la page : la
    // dernière sync réussie reste affichée avec sa date.
    res.status(200).json({ skipped: true, error: e.message })
  }
})

// ── Apprentissage sur le relevé bancaire ─────────────────────────────────────
// Ce que le compte BNC apprend à la projection : montants et jours réels des
// sorties récurrentes, récurrentes jamais retrouvées au relevé, et prélèvements
// périodiques que l'ERP ne connaît pas encore (propositions).
router.get('/learning', async (req, res) => {
  const { learningReport } = await import('../services/treasuryLearning.js')
  const months = Number(req.query.months) || undefined
  res.json(learningReport({ months }))
})

// Adopter une proposition = créer la sortie récurrente correspondante. Action
// explicite : la détection ne modifie jamais la projection d'elle-même.
router.post('/learning/adopt', async (req, res) => {
  const { adoptSuggestion } = await import('../services/treasuryLearning.js')
  const result = adoptSuggestion(req.body || {}, req.user.id)
  if (result?.error) return res.status(400).json({ error: result.error })
  res.status(201).json(result)
})

// Projection jour par jour du solde BNC CAD.
// ?scenario=certain|realistic|pessimistic (défaut certain — rentrées sûres
// uniquement ; realistic/pessimistic ajoutent les rentrées estimées AR/MRR à
// titre indicatif).
router.get('/projection', (req, res) => {
  const scenario = ['realistic', 'pessimistic'].includes(req.query.scenario) ? req.query.scenario : 'certain'
  res.json(computeProjection({ days: req.query.days, scenario }))
})

// Passé réel : entrées et sorties réellement passées au compte BNC CAD, jour
// par jour, dans la même forme que `days` de la projection. Permet à la liste et
// au calendrier de la page Trésorerie de remonter dans le passé sans changer de
// composant. ?from=YYYY-MM-DD&to=YYYY-MM-DD (défaut : 30 derniers jours).
router.get('/actuals', (req, res) => {
  const iso = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null)
  const today = new Date().toISOString().slice(0, 10)
  const to = iso(req.query.to) || today
  const defFrom = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10)
  const from = iso(req.query.from) || defFrom
  if (from > to) return res.status(400).json({ error: 'from doit précéder to' })
  res.json(computeActuals({ from, to }))
})

// ── Config de projection (sources activées, seuils) ──────────────────────────
// Persistée dans action_config de l'automation sys_treasury_alert, comme le
// reste de la config trésorerie (éditable aussi depuis la page automation).

router.get('/config', (req, res) => {
  res.json(getTreasuryConfig())
})

router.put('/config', (req, res) => {
  const allowed = Object.keys(TREASURY_DEFAULT_CONFIG)
  const updates = {}
  for (const k of allowed) {
    if (!(k in req.body)) continue
    const v = req.body[k]
    if (typeof v === 'boolean') updates[k] = v ? '1' : '0'
    else if (v == null || String(v).trim() === '') updates[k] = ''
    else updates[k] = String(v).trim()
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Aucun champ de config reconnu' })
  const row = db.prepare('SELECT action_config FROM automations WHERE id=?').get(TREASURY_AUTOMATION_ID)
  if (!row) return res.status(404).json({ error: 'Automation sys_treasury_alert introuvable' })
  let cfg = {}
  try { cfg = JSON.parse(row.action_config || '{}') } catch {}
  Object.assign(cfg, updates)
  db.prepare('UPDATE automations SET action_config=? WHERE id=?')
    .run(JSON.stringify(cfg), TREASURY_AUTOMATION_ID)
  res.json(getTreasuryConfig())
})

// ── Solde disponible réel (saisie rapide) ────────────────────────────────────

router.get('/balances', (req, res) => {
  const rows = db.prepare(`
    SELECT b.*, u.name AS created_by_name FROM treasury_balances b
    LEFT JOIN users u ON u.id = b.created_by
    ORDER BY b.noted_at DESC LIMIT 20
  `).all()
  res.json(rows)
})

router.post('/balance', (req, res) => {
  const n = Number(req.body.balance)
  if (!Number.isFinite(n)) return res.status(400).json({ error: 'balance doit être un nombre' })
  const id = randomUUID()
  db.prepare('INSERT INTO treasury_balances (id, balance, created_by) VALUES (?,?,?)')
    .run(id, Math.round(n * 100) / 100, req.user.id)
  // Réconciliation synchrone (écrit predicted_balance / variance sur la saisie)
  // pour que la réponse porte déjà l'écart, puis notification + alerte en
  // arrière-plan. L'ordre compte : la réconciliation compare à la DERNIÈRE photo
  // de la projection, et checkTreasuryAlert en prend une nouvelle.
  reconcileBalanceEntry(id)
  const created = db.prepare('SELECT * FROM treasury_balances WHERE id=?').get(id)
  checkBalanceVariance(id)
    .then(() => checkTreasuryAlert({ trigger: 'saisie solde' }))
    .catch(() => {})
  res.status(201).json(created)
})

// ── Historique : ce que la projection annonçait, jour par jour ────────────────
// Chaque exécution (cron quotidien + saisie de solde) laisse une photo. Sans
// elle, une journée passée était irrécupérable — la projection repart toujours
// d'aujourd'hui. C'est cet historique qui permet le post-mortem d'un écart.

router.get('/history', (req, res) => {
  const limit = Math.min(180, Math.max(1, Number(req.query.days) || 60))
  const since = new Date(Date.now() - limit * 24 * 3600 * 1000).toISOString().slice(0, 10)
  // Une ligne par jour : la photo la plus récente de la journée. Les jours
  // antérieurs à la mise en place des photos (3 août 2026) n'en ont pas — ils
  // restent listés avec ce qu'on sait d'eux (solde saisi, journal), pour que le
  // passé reste consultable même sans projection reconstituable.
  const snaps = db.prepare(`
    SELECT s.id, s.snapshot_date, s.created_at, s.trigger, s.start_balance, s.balance_noted_at,
           s.threshold, s.min_balance, s.min_date, s.action_days, s.action_min_balance, s.action_min_date,
           s.first_negative_date, s.first_negative_balance, s.suggested_transfer
    FROM treasury_snapshots s
    WHERE s.scenario = 'certain' AND s.snapshot_date >= ? AND s.created_at = (
      SELECT MAX(x.created_at) FROM treasury_snapshots x
      WHERE x.snapshot_date = s.snapshot_date AND x.scenario = 'certain'
    )
  `).all(since)
  // Solde réel saisi ce jour-là (le dernier de la journée) + écart mesuré.
  const entries = db.prepare(`
    SELECT id, substr(noted_at, 1, 10) AS day, balance, noted_at, predicted_balance, variance, variance_note
    FROM treasury_balances WHERE substr(noted_at, 1, 10) >= ? ORDER BY noted_at DESC
  `).all(since)
  const runs = db.prepare(`
    SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n,
           SUM(CASE WHEN result LIKE 'ALERTE%' THEN 1 ELSE 0 END) AS alerts
    FROM automation_logs WHERE automation_id = ? AND substr(created_at, 1, 10) >= ?
    GROUP BY day
  `).all(TREASURY_AUTOMATION_ID, since)

  const byDay = new Map()
  const day = d => {
    if (!byDay.has(d)) byDay.set(d, { snapshot_date: d, entry: null, runs: 0, alerts: 0 })
    return byDay.get(d)
  }
  for (const s of snaps) Object.assign(day(s.snapshot_date), s)
  for (const e of entries) { const d = day(e.day); if (!d.entry) d.entry = e }
  for (const r of runs) Object.assign(day(r.day), { runs: r.n, alerts: r.alerts })
  res.json([...byDay.values()].sort((a, b) => b.snapshot_date.localeCompare(a.snapshot_date)))
})

// Photo complète d'un jour : la série quotidienne telle qu'elle était annoncée,
// plus les saisies de solde et les exécutions de l'automation de ce jour-là.
// Un jour sans photo répond quand même (snapshot absent) : les saisies et le
// journal de l'automation restent consultables.
router.get('/history/:date', (req, res) => {
  const date = String(req.params.date).slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date au format YYYY-MM-DD' })
  const snap = db.prepare(`
    SELECT * FROM treasury_snapshots WHERE snapshot_date = ? AND scenario = 'certain'
    ORDER BY created_at DESC LIMIT 1
  `).get(date) || null
  let days = []
  try { days = JSON.parse(snap?.days || '[]') } catch {}
  const balances = db.prepare(`
    SELECT b.*, u.name AS created_by_name FROM treasury_balances b
    LEFT JOIN users u ON u.id = b.created_by
    WHERE substr(b.noted_at, 1, 10) = ? ORDER BY b.noted_at
  `).all(date)
  const runs = db.prepare(`
    SELECT created_at, status, result, error FROM automation_logs
    WHERE automation_id = ? AND substr(created_at, 1, 10) = ? ORDER BY created_at
  `).all(TREASURY_AUTOMATION_ID, date)
  // Toutes les photos du jour : une aggravation intra-journée est visible ici.
  const revisions = db.prepare(`
    SELECT id, created_at, trigger, start_balance, action_min_balance, action_min_date, first_negative_date
    FROM treasury_snapshots WHERE snapshot_date = ? AND scenario = 'certain' ORDER BY created_at
  `).all(date)
  // Ce qui est VRAIMENT passé au compte ce jour-là (relevé bancaire importé) :
  // c'est la réalité, la photo de projection n'en est que l'annonce.
  const actual = computeActuals({ from: date, to: date })
  res.json({
    ...(snap || { snapshot_date: date }), days, balances, runs, revisions,
    actual_day: actual.days[0] || null,
    actual_coverage_to: actual.coverage_to,
  })
})

// ── Mouvements en retard confirmés sortis du compte ──────────────────────────
// Un mouvement daté entre la saisie du solde et aujourd'hui reste projeté par
// prudence. Si l'utilisateur sait qu'il a déjà passé (donc déjà reflété dans le
// solde saisi), il le confirme ici et le mouvement cesse d'être compté.

router.post('/cleared', (req, res) => {
  const key = String(req.body.event_key || '').trim()
  if (!key) return res.status(400).json({ error: 'event_key requis' })
  db.prepare(`
    INSERT INTO treasury_cleared_events (event_key, label, amount, event_date, cleared_by)
    VALUES (?,?,?,?,?)
    ON CONFLICT(event_key) DO UPDATE SET
      cleared_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), cleared_by = excluded.cleared_by
  `).run(key, req.body.label || null, req.body.amount == null ? null : Number(req.body.amount),
    req.body.event_date || null, req.user.id)
  res.status(201).json({ ok: true })
})

router.delete('/cleared/:key', (req, res) => {
  db.prepare('DELETE FROM treasury_cleared_events WHERE event_key = ?').run(req.params.key)
  res.json({ ok: true })
})

// Suppression d'une saisie de solde (correction d'une erreur de frappe, cleanup E2E).
router.delete('/balance/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM treasury_balances WHERE id=?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  db.prepare('DELETE FROM treasury_balances WHERE id=?').run(req.params.id)
  res.json({ ok: true })
})

// ── Sorties récurrentes ──────────────────────────────────────────────────────

const RECURRING_FIELDS = ['label', 'amount', 'frequency', 'day_of_month', 'anchor_date', 'active', 'notes', 'variable_amount', 'vendor_match', 'starts_on', 'ends_on']

function validateRecurring(body, { partial = false } = {}) {
  if (!partial && (!body.label || !String(body.label).trim())) return 'label requis'
  if ('frequency' in body && body.frequency != null &&
      !['weekly', 'biweekly', 'monthly', 'quarterly'].includes(body.frequency)) {
    return 'frequency invalide (weekly, biweekly, monthly, quarterly)'
  }
  if ('amount' in body && body.amount !== null && body.amount !== '' && body.amount !== undefined) {
    const n = Number(body.amount)
    if (!Number.isFinite(n) || n < 0) return 'amount doit être un nombre positif'
  }
  if ('day_of_month' in body && body.day_of_month != null && body.day_of_month !== '') {
    const n = Number(body.day_of_month)
    if (!Number.isInteger(n) || n < 1 || n > 31) return 'day_of_month doit être entre 1 et 31'
  }
  if ('anchor_date' in body && body.anchor_date && !/^\d{4}-\d{2}-\d{2}$/.test(body.anchor_date)) {
    return 'anchor_date au format YYYY-MM-DD'
  }
  if ('variable_amount' in body && body.variable_amount != null && ![0, 1, true, false].includes(body.variable_amount)) {
    return 'variable_amount doit être 0 ou 1'
  }
  for (const k of ['starts_on', 'ends_on']) {
    if (k in body && body[k] && !/^\d{4}-\d{2}-\d{2}$/.test(body[k])) return `${k} au format YYYY-MM-DD`
  }
  if (body.starts_on && body.ends_on && body.starts_on > body.ends_on) {
    return 'starts_on doit précéder ends_on'
  }
  return null
}

// Annote une récurrente à montant variable : date d'application du montant
// saisi (`amount_applies_to`) et péremption (`amount_stale` — occurrence passée,
// montant à ressaisir). Fenêtre de recherche : 1 an après aujourd'hui.
function annotateRecurring(r) {
  if (!r.variable_amount || !(Number(r.amount) > 0)) return r
  const today = new Date()
  const todayIso = today.toISOString().slice(0, 10)
  const end = new Date(today); end.setFullYear(end.getFullYear() + 1)
  const applies = variableOccurrence(r, todayIso, end.toISOString().slice(0, 10))
  return { ...r, amount_applies_to: applies, amount_stale: applies ? 0 : 1 }
}

router.get('/recurring', (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM recurring_outflows WHERE deleted_at IS NULL ORDER BY active DESC, label COLLATE NOCASE'
  ).all()
  res.json(rows.map(annotateRecurring))
})

router.post('/recurring', (req, res) => {
  const error = validateRecurring(req.body)
  if (error) return res.status(400).json({ error })
  const b = req.body
  const id = randomUUID()
  const amount = b.amount === '' || b.amount == null ? null : Number(b.amount)
  db.prepare(`
    INSERT INTO recurring_outflows (id, label, amount, frequency, day_of_month, anchor_date, active, notes, variable_amount, vendor_match, starts_on, ends_on, amount_entered_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?, CASE WHEN ? IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now') END)
  `).run(
    id, String(b.label).trim(),
    amount,
    b.frequency || 'monthly',
    b.day_of_month === '' || b.day_of_month == null ? null : Number(b.day_of_month),
    b.anchor_date || null,
    b.active === 0 || b.active === false ? 0 : 1,
    b.notes || null,
    b.variable_amount === 1 || b.variable_amount === true ? 1 : 0,
    b.vendor_match || null,
    b.starts_on || null,
    b.ends_on || null,
    amount
  )
  res.status(201).json(annotateRecurring(db.prepare('SELECT * FROM recurring_outflows WHERE id=?').get(id)))
})

router.put('/recurring/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM recurring_outflows WHERE id=? AND deleted_at IS NULL').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  const error = validateRecurring(req.body, { partial: true })
  if (error) return res.status(400).json({ error })
  const { setClause, values, error: buildError } = buildPartialUpdate(req.body, {
    allowed: RECURRING_FIELDS,
    nonNullable: new Set(['label', 'frequency']),
  })
  if (buildError) return res.status(400).json({ error: buildError })
  if (setClause) {
    db.prepare(`UPDATE recurring_outflows SET ${setClause}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(...values, req.params.id)
  }
  // Chaque (re)saisie du montant est horodatée : pour les montants variables,
  // elle détermine l'unique occurrence à laquelle le montant s'applique.
  if ('amount' in req.body) {
    db.prepare(`
      UPDATE recurring_outflows
      SET amount_entered_at = CASE WHEN amount IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now') END
      WHERE id = ?
    `).run(req.params.id)
  }
  res.json(annotateRecurring(db.prepare('SELECT * FROM recurring_outflows WHERE id=?').get(req.params.id)))
})

router.delete('/recurring/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM recurring_outflows WHERE id=? AND deleted_at IS NULL').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  db.prepare(`UPDATE recurring_outflows SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`)
    .run(req.params.id)
  res.json({ ok: true })
})

export default router
