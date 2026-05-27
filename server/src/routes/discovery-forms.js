// Formulaire de découverte technique — entité standalone.
//
// Pattern :
//   - L'agent crée un form via POST (depuis la page admin OU via le raccourci
//     de la page Qualification Call).
//   - Le form a un public_token court (base32 Crockford 10 chars) qui permet au
//     client (et à l'agent) de l'ouvrir via /erp/d/:token, sans auth.
//   - Le contenu (réponses, autosave, soumission) est géré par les routes
//     customer-post-payment.js /by-token/:token/* — le client et l'agent
//     remplissent via la même surface.
//
// La table sous-jacente reste customer_onboarding_responses : c'est le même
// concept, juste accédé via une autre porte d'entrée que le flow Stripe Checkout.

import { Router } from 'express'
import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { generateShortToken } from '../utils/shortToken.js'

const router = Router()
router.use(requireAuth)

function publicUrlForToken(token) {
  const baseUrl = (process.env.APP_URL || 'https://customer.orisha.io').replace(/\/$/, '')
  return `${baseUrl}/erp/d/${token}`
}

// Shape sortie pour les vues admin (liste + détail).
function shapeForm(row) {
  if (!row) return null
  const greenhouses = row.greenhouses_json ? JSON.parse(row.greenhouses_json) : []
  return {
    id: row.id,
    company_id: row.company_id,
    company_name: row.company_name || null,
    qualification_call_id: row.qualification_call_id,
    stripe_subscription_id: row.stripe_subscription_id,
    stripe_session_id: row.stripe_session_id,
    pending_invoice_id: row.pending_invoice_id,
    public_token: row.public_token,
    public_url: row.public_token ? publicUrlForToken(row.public_token) : null,
    status: row.status,
    permission_level: row.permission_level,
    num_greenhouses: row.num_greenhouses,
    greenhouses,
    chief_grower_count: greenhouses.filter(g => g.permission_level === 'chief_grower').length,
    helper_count: greenhouses.filter(g => g.permission_level === 'helper').length,
    is_new_site: row.is_new_site,
    submitted_at: row.submitted_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

// POST /api/discovery-forms — créer un formulaire.
// Body :
//   - company_id (requis)
//   - helper_count (int, défaut 0) — nombre de cartes serre niveau helper
//   - chief_count  (int, défaut 0) — nombre de cartes serre niveau chief_grower
//   - greenhouses (array, optionnel) — alternative explicite : [{ permission_level }, …]
//   - qualification_call_id (optionnel) — métadonnée si créé depuis le guide d'appel
//   - stripe_subscription_id (optionnel)
router.post('/', (req, res) => {
  const {
    company_id,
    helper_count = 0,
    chief_count = 0,
    greenhouses: greenhousesIn,
    qualification_call_id = null,
    stripe_subscription_id = null,
  } = req.body || {}

  if (!company_id || typeof company_id !== 'string') {
    return res.status(400).json({ error: 'company_id requis' })
  }
  const company = db.prepare('SELECT id FROM companies WHERE id=?').get(company_id)
  if (!company) return res.status(404).json({ error: 'Entreprise introuvable' })

  let greenhouses
  if (Array.isArray(greenhousesIn)) {
    greenhouses = greenhousesIn
      .map(g => {
        const p = g?.permission_level
        if (p !== 'helper' && p !== 'chief_grower') return null
        return { permission_level: p }
      })
      .filter(Boolean)
  } else {
    const h = Math.max(0, parseInt(helper_count) || 0)
    const c = Math.max(0, parseInt(chief_count) || 0)
    greenhouses = [
      ...Array(c).fill(null).map(() => ({ permission_level: 'chief_grower' })),
      ...Array(h).fill(null).map(() => ({ permission_level: 'helper' })),
    ]
  }
  if (greenhouses.length === 0) {
    return res.status(400).json({ error: 'Au moins une serre (helper ou chief) est requise' })
  }

  const topPermission = greenhouses.some(g => g.permission_level === 'chief_grower')
    ? 'chief_grower' : 'helper'
  const id = randomUUID()
  const publicToken = generateShortToken()
  db.prepare(`
    INSERT INTO customer_onboarding_responses
      (id, qualification_call_id, stripe_subscription_id, company_id,
       permission_level, num_greenhouses, greenhouses_json, public_token, status)
    VALUES (?,?,?,?,?,?,?,?, 'in_progress')
  `).run(
    id,
    qualification_call_id || null,
    stripe_subscription_id || null,
    company_id,
    topPermission,
    greenhouses.length,
    JSON.stringify(greenhouses),
    publicToken,
  )
  const row = db.prepare(`
    SELECT r.*, c.name AS company_name
      FROM customer_onboarding_responses r
      LEFT JOIN companies c ON c.id = r.company_id
     WHERE r.id=?
  `).get(id)
  res.status(201).json(shapeForm(row))
})

// GET /api/discovery-forms — liste, avec filtres optionnels.
// Query :
//   - company_id : ne renvoie que les forms liés à cette entreprise
//   - status : 'in_progress' | 'submitted'
//   - qualification_call_id
//   - limit : max rows (défaut 200, 'all' pour pas de limite)
router.get('/', (req, res) => {
  const { company_id, status, qualification_call_id, limit } = req.query || {}
  const where = []
  const params = []
  if (company_id) { where.push('r.company_id=?'); params.push(company_id) }
  if (status) { where.push('r.status=?'); params.push(status) }
  if (qualification_call_id) { where.push('r.qualification_call_id=?'); params.push(qualification_call_id) }

  let limitSql = ''
  if (limit !== 'all') {
    const n = Math.min(500, Math.max(1, parseInt(limit) || 200))
    limitSql = `LIMIT ${n}`
  }
  const sql = `
    SELECT r.*, c.name AS company_name
      FROM customer_onboarding_responses r
      LEFT JOIN companies c ON c.id = r.company_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY r.created_at DESC
     ${limitSql}
  `
  const rows = db.prepare(sql).all(...params)
  res.json({ rows: rows.map(shapeForm), total: rows.length })
})

// GET /api/discovery-forms/:id — détail (admin).
router.get('/:id', (req, res) => {
  const row = db.prepare(`
    SELECT r.*, c.name AS company_name
      FROM customer_onboarding_responses r
      LEFT JOIN companies c ON c.id = r.company_id
     WHERE r.id=?
  `).get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Formulaire introuvable' })
  res.json(shapeForm(row))
})

// DELETE /api/discovery-forms/:id — supprimer (cleanup, formulaire envoyé par erreur, etc.).
router.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT id FROM customer_onboarding_responses WHERE id=?').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Formulaire introuvable' })
  db.prepare('DELETE FROM customer_onboarding_responses WHERE id=?').run(req.params.id)
  res.json({ ok: true })
})

export default router
