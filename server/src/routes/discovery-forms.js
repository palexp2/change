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
import { newRecordId } from '../utils/recordId.js'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { generateShortToken } from '../utils/shortToken.js'
import { APP_URL } from '../config/appUrl.js'
import { parseLimit } from '../utils/pagination.js'
import { normalizeDiscoveryOptions, discoveryOptionsFromRow } from '../services/discoveryFormOptions.js'
import { calculateDiscoveryEquipment } from '../services/discoveryEquipment.js'

const router = Router()
router.use(requireAuth)

function publicUrlForToken(token) {
  const baseUrl = APP_URL
  return `${baseUrl}/erp/d/${token}`
}

// Shape sortie pour les vues admin (liste + détail).
// Inclut les réponses du client (adresses, réseau, cartes serre, extras) : la
// fiche côté ERP est une lecture du formulaire tel que rempli.
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
    within_central_controller_range: row.within_central_controller_range == null ? null : !!row.within_central_controller_range,
    farm_address: row.farm_address_json ? JSON.parse(row.farm_address_json) : null,
    shipping_same_as_farm: row.shipping_same_as_farm == null ? null : !!row.shipping_same_as_farm,
    shipping_address: row.shipping_address_json ? JSON.parse(row.shipping_address_json) : null,
    network_access: row.network_access,
    wifi_ssid: row.wifi_ssid,
    wifi_password: row.wifi_password,
    extras: row.extras_json ? JSON.parse(row.extras_json) : [],
    custom_answers: row.custom_answers_json ? JSON.parse(row.custom_answers_json) : {},
    form_options: discoveryOptionsFromRow(row),
    verification: row.verification_json ? JSON.parse(row.verification_json) : {},
    generated_order_id: row.generated_order_id || null,
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
    form_options,
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
    return res.status(400).json({ error: 'Au moins une serre (helper ou chef de culture) est requise' })
  }

  const topPermission = greenhouses.some(g => g.permission_level === 'chief_grower')
    ? 'chief_grower' : 'helper'
  const id = newRecordId()
  const publicToken = generateShortToken()
  db.prepare(`
    INSERT INTO customer_onboarding_responses
      (id, qualification_call_id, stripe_subscription_id, company_id,
       permission_level, num_greenhouses, greenhouses_json, public_token, form_options_json, status)
    VALUES (?,?,?,?,?,?,?,?,?, 'in_progress')
  `).run(
    id,
    qualification_call_id || null,
    stripe_subscription_id || null,
    company_id,
    topPermission,
    greenhouses.length,
    JSON.stringify(greenhouses),
    publicToken,
    JSON.stringify(normalizeDiscoveryOptions(form_options)),
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
    const n = parseLimit(limit, { def: 200, max: 500 })
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

function schemaRules() {
  let rules = {}
  try {
    const row = db.prepare("SELECT schema_json FROM discovery_form_schema WHERE id='default'").get()
    rules = row?.schema_json ? (JSON.parse(row.schema_json).equipment || {}) : {}
  } catch { /* valeurs par défaut */ }
  // Réutiliser le produit exact du catalogue, sauf association explicite dans l'éditeur.
  const configured = rules.products?.central_controller
  const product = configured && db.prepare('SELECT id FROM products WHERE id=? AND active=1').get(configured)
  if (!product) {
    const candidates = configured ? [] : db.prepare("SELECT id FROM products WHERE active=1 AND (role='central_controller' OR name_fr='Contrôleur central')").all()
    rules.products = { ...rules.products, central_controller: candidates.length === 1 ? candidates[0].id : null }
  }
  return rules
}

// Aperçu interne : il est volontairement disponible même si la checklist n'est
// pas terminée. Le vérificateur garde l'autorité de créer quand il est prêt.
router.get('/:id/equipment-preview', (req, res) => {
  const row = db.prepare('SELECT * FROM customer_onboarding_responses WHERE id=?').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Formulaire introuvable' })
  const response = shapeForm(row)
  res.json(calculateDiscoveryEquipment(response, schemaRules()))
})

router.patch('/:id/verification', (req, res) => {
  const row = db.prepare('SELECT id, verification_json FROM customer_onboarding_responses WHERE id=?').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Formulaire introuvable' })
  const next = req.body?.verification && typeof req.body.verification === 'object' ? req.body.verification : {}
  db.prepare("UPDATE customer_onboarding_responses SET verification_json=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
    .run(JSON.stringify(next), row.id)
  res.json({ ok: true, verification: next })
})

router.post('/:id/create-order', (req, res) => {
  const row = db.prepare('SELECT * FROM customer_onboarding_responses WHERE id=?').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Formulaire introuvable' })
  if (row.generated_order_id) return res.status(409).json({ error: 'Une commande a déjà été créée pour ce formulaire', order_id: row.generated_order_id })
  const calc = calculateDiscoveryEquipment(shapeForm(row), schemaRules())
  if (!calc.calculationComplete) return res.status(422).json({ error: `Dimensionnement incomplet : ${calc.warnings.map(w => w.message).join(' ')}`, warnings: calc.warnings })
  const orderId = newRecordId()
  const orderNumber = (db.prepare('SELECT MAX(order_number) AS m FROM orders').get()?.m || 0) + 1
  db.transaction(() => {
    // La commande doit exister avant de poser la clé étrangère. La liaison
    // conditionnelle reste dans la même transaction : un doublon annule tout.
    db.prepare("INSERT INTO orders (id, order_number, company_id, status, notes, date_commande) VALUES (?,?,?,'Commande vide',?,date('now'))")
      .run(orderId, orderNumber, row.company_id || null, [`System Builder #${row.id}`, ...calc.orderNotes].join('\n'))
    const claim = db.prepare("UPDATE customer_onboarding_responses SET generated_order_id=? WHERE id=? AND generated_order_id IS NULL").run(orderId, row.id)
    if (claim.changes !== 1) throw new Error('Une commande a déjà été créée pour ce formulaire')
    for (const item of calc.orderItems) {
      const product = db.prepare('SELECT unit_cost FROM products WHERE id=?').get(item.product_id)
      db.prepare("INSERT INTO order_items (id, order_id, product_id, qty, unit_cost, item_type, notes) VALUES (?,?,?,?,?,'Non facturable',?)")
        .run(newRecordId(), orderId, item.product_id, item.qty, product?.unit_cost || 0, `${item.greenhouse ? `Serre #${item.greenhouse}` : 'Site'}${item.note ? ` · ${item.note}` : ''}`)
    }
  })()
  res.status(201).json({ id: orderId, order_number: orderNumber, unconfigured: calc.unconfigured })
})

// DELETE /api/discovery-forms/:id — supprimer (cleanup, formulaire envoyé par erreur, etc.).
router.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT id FROM customer_onboarding_responses WHERE id=?').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Formulaire introuvable' })
  db.prepare('DELETE FROM customer_onboarding_responses WHERE id=?').run(req.params.id)
  res.json({ ok: true })
})

export default router
