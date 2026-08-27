import { Router } from 'express'
import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { buildPartialUpdate } from '../utils/partialUpdate.js'
import { requireAuth } from '../middleware/auth.js'
import { emitEntity } from '../services/realtimeEmitters.js'
import { findMissingReceipts, linkSubscriptionVendorAlias } from '../services/vendorSubscriptions.js'
import { lookupCancelUrl } from '../services/subscriptionCancelUrls.js'

const router = Router()
router.use(requireAuth)

const FIELDS = ['vendor', 'plan', 'currency', 'variable', 'amount', 'amount_label', 'taxes',
  'frequency', 'billing_day', 'billing_month', 'billing_label', 'period', 'payment_method',
  'active', 'comments', 'cancel_url']

function validate(body, { partial = false } = {}) {
  if (!partial && (!body.vendor || !String(body.vendor).trim())) return 'vendor requis'
  if ('vendor' in body && partial && !String(body.vendor || '').trim()) return 'vendor requis'
  if ('frequency' in body && body.frequency != null && !['Mensuel', 'Annuel'].includes(body.frequency)) {
    return "frequency doit être 'Mensuel' ou 'Annuel'"
  }
  if ('amount' in body && body.amount !== null && body.amount !== '' && body.amount !== undefined) {
    const n = Number(body.amount)
    if (!Number.isFinite(n) || n < 0) return 'amount doit être un nombre positif'
  }
  if ('cancel_url' in body && body.cancel_url) {
    if (!/^https?:\/\/\S+$/i.test(String(body.cancel_url).trim())) {
      return 'cancel_url doit être une URL http(s)'
    }
  }
  for (const [k, max, min] of [['billing_day', 31, 1], ['billing_month', 12, 1]]) {
    if (k in body && body[k] !== null && body[k] !== '' && body[k] !== undefined) {
      const n = Number(body[k])
      if (!Number.isInteger(n) || n < min || n > max) return `${k} doit être un entier entre ${min} et ${max}`
    }
  }
  return null
}

router.get('/', (req, res) => {
  let where = 'deleted_at IS NULL'
  const params = []
  if (req.query.active === '1') { where += ' AND active = 1' }
  const rows = db.prepare(
    `SELECT * FROM vendor_subscriptions WHERE ${where} ORDER BY active DESC, vendor COLLATE NOCASE`
  ).all(...params)
  res.json(rows)
})

// Charges attendues sans dépense comptabilisée : reçus à réclamer (`missing`),
// reçus/achats reçus mais pas encore poussés dans QB (`to_book`), et dépenses
// très probablement comptabilisées sous un autre nom / hors fenêtre
// (`likely_booked`, trouvées par le rapprochement approfondi).
router.get('/missing-receipts', (req, res) => {
  const missing = findMissingReceipts()
  res.json({
    generated_at: new Date().toISOString(),
    missing,
    counts: {
      missing: missing.filter(m => m.status === 'missing').length,
      to_book: missing.filter(m => m.status === 'to_book').length,
      likely_booked: missing.filter(m => m.status === 'likely_booked').length,
    },
  })
})

// Confirme qu'un nom de fournisseur QuickBooks désigne bien le fournisseur de cet
// abonnement : le nom est enregistré comme alias sur le profil fournisseur, ce qui
// rend le rapprochement STRICT (et donc silencieux) pour toutes les analyses
// futures. Body : { vendor: 'CircleCo Inc. USD' }.
router.post('/:id/link-vendor', (req, res) => {
  const sub = db.prepare('SELECT * FROM vendor_subscriptions WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!sub) return res.status(404).json({ error: 'Not found' })
  const vendor = String(req.body?.vendor || '').trim()
  if (!vendor) return res.status(400).json({ error: 'vendor requis' })
  try {
    res.json(linkSubscriptionVendorAlias(sub, vendor))
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM vendor_subscriptions WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(row)
})

router.post('/', (req, res) => {
  const error = validate(req.body)
  if (error) return res.status(400).json({ error })
  const id = randomUUID()
  const b = req.body
  db.prepare(`
    INSERT INTO vendor_subscriptions
      (id, vendor, plan, currency, variable, amount, amount_label, taxes, frequency,
       billing_day, billing_month, billing_label, period, payment_method, active, comments, created_by,
       cancel_url)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, String(b.vendor).trim(), b.plan || null, b.currency || 'CAD', b.variable ? 1 : 0,
    b.amount === '' || b.amount == null ? null : Number(b.amount), b.amount_label || null,
    b.taxes || null, b.frequency || 'Mensuel',
    b.billing_day === '' || b.billing_day == null ? null : Number(b.billing_day),
    b.billing_month === '' || b.billing_month == null ? null : Number(b.billing_month),
    b.billing_label || null, b.period || null, b.payment_method || null,
    b.active === 0 || b.active === false ? 0 : 1, b.comments || null, req.user.id,
    // Page d'annulation connue du répertoire : le bouton « Se désabonner »
    // ouvre la bonne page dès la création, sans saisie.
    (b.cancel_url || '').trim() || lookupCancelUrl(b.vendor) || null
  )
  const created = db.prepare('SELECT * FROM vendor_subscriptions WHERE id = ?').get(id)
  emitEntity('vendor_subscription', 'created', id, created, req.user?.id)
  res.status(201).json(created)
})

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT id, active, cancelled_at FROM vendor_subscriptions WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  const error = validate(req.body, { partial: true })
  if (error) return res.status(400).json({ error })
  const { setClause, values, error: buildError } = buildPartialUpdate(req.body, {
    allowed: FIELDS,
    nonNullable: new Set(['vendor', 'frequency']),
  })
  if (buildError) return res.status(400).json({ error: buildError })
  if (setClause) {
    db.prepare(`UPDATE vendor_subscriptions SET ${setClause}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(...values, req.params.id)
  }
  // Désabonnement / réactivation : horodate le moment où l'abonnement est
  // marqué annulé, efface la date à la réactivation. La date d'origine n'est
  // pas réécrite si `active` est resauvegardé à 0 alors qu'il l'était déjà.
  if ('active' in req.body) {
    const nowActive = !(req.body.active === 0 || req.body.active === false || req.body.active === '0')
    if (!nowActive && !existing.cancelled_at) {
      db.prepare(`UPDATE vendor_subscriptions SET cancelled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(req.params.id)
    } else if (nowActive && existing.cancelled_at) {
      db.prepare('UPDATE vendor_subscriptions SET cancelled_at = NULL WHERE id = ?').run(req.params.id)
    }
  }
  const updated = db.prepare('SELECT * FROM vendor_subscriptions WHERE id = ?').get(req.params.id)
  if (setClause) {
    emitEntity('vendor_subscription', 'updated', req.params.id, updated, req.user?.id)
  }
  res.json(updated)
})

router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT id, vendor FROM vendor_subscriptions WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  db.prepare(`UPDATE vendor_subscriptions SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
    .run(req.params.id)
  emitEntity('vendor_subscription', 'deleted', req.params.id, { id: req.params.id }, req.user?.id)
  res.json({ ok: true })
})

export default router
