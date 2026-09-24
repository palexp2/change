import { Router } from 'express'
import db from '../db/database.js'
import { newRecordId } from '../utils/recordId.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { listCards, getCardByLast4 } from '../services/paymentCards.js'

const router = Router()
router.use(requireAuth)

// Registre des cartes : 4 derniers chiffres → compte QuickBooks qui paie.
// Carte de l'entreprise → son compte de carte ; carte personnelle d'un employé
// → le compte « <Nom> (rembourser à) ».
router.get('/', (req, res) => {
  res.json({ data: listCards({ includeInactive: true }) })
})

const FIELDS = ['holder', 'card_type', 'last4', 'ownership', 'qb_account_id', 'qb_account_name', 'currency', 'active', 'notes']

function clean(body) {
  const out = {}
  for (const f of FIELDS) {
    if (!(f in body)) continue
    let v = body[f]
    if (f === 'last4') v = String(v ?? '').replace(/\D/g, '').slice(-4)
    else if (f === 'active') v = v ? 1 : 0
    else if (f === 'ownership') v = v === 'company' ? 'company' : 'personal'
    else v = v === '' ? null : v
    out[f] = v
  }
  return out
}

router.post('/', requireAdmin, (req, res) => {
  const data = clean(req.body || {})
  if (!data.holder) return res.status(400).json({ error: 'Nom du porteur requis' })
  if (!data.last4 || data.last4.length !== 4) return res.status(400).json({ error: '4 derniers chiffres requis' })
  if (getCardByLast4(data.last4)) return res.status(400).json({ error: `La carte ••${data.last4} existe déjà` })
  const id = newRecordId()
  const cols = ['id', ...Object.keys(data)]
  db.prepare(`INSERT INTO payment_cards (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(id, ...Object.values(data))
  res.json(db.prepare('SELECT * FROM payment_cards WHERE id=?').get(id))
})

router.patch('/:id', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT * FROM payment_cards WHERE id=? AND deleted_at IS NULL').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Carte introuvable' })
  const data = clean(req.body || {})
  if ('last4' in data) {
    if (data.last4.length !== 4) return res.status(400).json({ error: '4 derniers chiffres requis' })
    const other = getCardByLast4(data.last4)
    if (other && other.id !== row.id) return res.status(400).json({ error: `La carte ••${data.last4} existe déjà` })
  }
  const keys = Object.keys(data)
  if (keys.length) {
    db.prepare(`UPDATE payment_cards SET ${keys.map(k => `${k}=?`).join(',')},
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(...Object.values(data), row.id)
  }
  res.json(db.prepare('SELECT * FROM payment_cards WHERE id=?').get(row.id))
})

router.delete('/:id', requireAdmin, (req, res) => {
  db.prepare(`UPDATE payment_cards SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(req.params.id)
  res.json({ ok: true })
})

export default router
