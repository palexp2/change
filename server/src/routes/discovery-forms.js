import { discoveryAddresses, airtableTwinAddress } from '../services/discoveryAddresses.js'
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
import { JWT_ROLES, isJwtProduct } from '../../../client/src/lib/discoveryEquipmentCatalog.js'
import { unknownAnswers } from '../../../client/src/lib/discoveryUnknownAnswers.js'
import { newRecordId } from '../utils/recordId.js'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { generateShortToken } from '../utils/shortToken.js'
import { APP_URL } from '../config/appUrl.js'
import { parseLimit } from '../utils/pagination.js'
import { normalizeDiscoveryOptions, discoveryOptionsFromRow } from '../services/discoveryFormOptions.js'
import { calculateDiscoveryEquipment } from '../services/discoveryEquipment.js'
import { queueDiscoveryOrderMirror } from '../services/discoveryOrderAirtable.js'
import { emitOrder } from '../services/realtimeEmitters.js'
import { buildPartialUpdate } from './customer-post-payment.js'
import { applyOrderItemDefaults } from '../services/orderItemDefaults.js'
import { localDay } from '../utils/datetime.js'

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
    form_number: row.form_number ?? null,
    company_id: row.company_id,
    company_name: row.company_name || null,
    project_id: row.project_id || null,
    project_name: row.project_name ?? (row.project_id ? db.prepare('SELECT name FROM projects WHERE id=?').get(row.project_id)?.name || null : null),
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
    central_controller_distance: row.central_controller_distance || null,
    farm_address: row.farm_address_json ? JSON.parse(row.farm_address_json) : null,
    shipping_same_as_farm: row.shipping_same_as_farm == null ? null : !!row.shipping_same_as_farm,
    shipping_address: row.shipping_address_json ? JSON.parse(row.shipping_address_json) : null,
    ...discoveryAddresses(row),
    network_access: row.network_access,
    wifi_ssid: row.wifi_ssid,
    wifi_password: row.wifi_password,
    extras: row.extras_json ? JSON.parse(row.extras_json) : [],
    custom_answers: row.custom_answers_json ? JSON.parse(row.custom_answers_json) : {},
    form_options: discoveryOptionsFromRow(row),
    verification: row.verification_json ? JSON.parse(row.verification_json) : {},
    technical_notes: row.technical_notes || '',
    generated_order_id: row.generated_order_id || null,
    generated_order_number: row.generated_order_number ?? null,
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
    SELECT r.*, c.name AS company_name, o.order_number AS generated_order_number
      FROM customer_onboarding_responses r
      LEFT JOIN companies c ON c.id = r.company_id
      LEFT JOIN orders o ON o.id = r.generated_order_id
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
    SELECT r.*, c.name AS company_name, o.order_number AS generated_order_number
      FROM customer_onboarding_responses r
      LEFT JOIN companies c ON c.id = r.company_id
      LEFT JOIN orders o ON o.id = r.generated_order_id
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
  // Une association devenue invalide doit apparaître parmi les produits
  // manquants dans l'aperçu, jamais devenir un article matériel de permission.
  for (const role of JWT_ROLES) {
    const id = rules.products?.[role]
    if (id && !isJwtProduct(db.prepare('SELECT type FROM products WHERE id=? AND deleted_at IS NULL AND active=1').get(id))) {
      rules.products = { ...rules.products, [role]: null }
    }
  }
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
  const result = calculateDiscoveryEquipment(response, schemaRules())
  // Vignette, type, nom et fiche par rôle : l'image à côté du nom, le type pour
  // regrouper, le nom du catalogue affiché, l'id pour ouvrir le produit.
  const product = db.prepare(`SELECT id, COALESCE(NULLIF(name_fr, ''), name_en) AS name, image_url, type FROM products WHERE id=?`)
  const productImages = {}
  const productTypes = {}
  const productIds = {}
  const productNames = {}
  for (const line of result.orderItems) {
    const p = product.get(line.product_id)
    for (const s of line.sources) {
      if (p?.image_url) productImages[s.role] = p.image_url
      if (p?.type) productTypes[s.role] = p.type
      if (p?.id) productIds[s.role] = p.id
      if (p?.name) productNames[s.role] = p.name
    }
  }
  res.json({ ...result, productImages, productTypes, productIds, productNames })
})

router.patch('/:id/verification', (req, res) => {
  const row = db.prepare('SELECT id, verification_json FROM customer_onboarding_responses WHERE id=?').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Formulaire introuvable' })
  const next = req.body?.verification && typeof req.body.verification === 'object' ? req.body.verification : {}
  db.prepare("UPDATE customer_onboarding_responses SET verification_json=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
    .run(JSON.stringify(next), row.id)
  res.json({ ok: true, verification: next })
})

// Notes internes : modifiables même après la création de la commande.
router.patch('/:id/notes', (req, res) => {
  const row = db.prepare('SELECT id FROM customer_onboarding_responses WHERE id=?').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Formulaire introuvable' })
  const notes = typeof req.body?.technical_notes === 'string' ? req.body.technical_notes : ''
  db.prepare("UPDATE customer_onboarding_responses SET technical_notes=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
    .run(notes, row.id)
  res.json({ ok: true, technical_notes: notes })
})

// Options achetées et extras par serre, modifiables par Orisha tant qu'aucune
// commande n'a été créée ; le client les voit à la prochaine ouverture du lien.
router.patch('/:id/options', (req, res) => {
  const row = db.prepare('SELECT id, generated_order_id FROM customer_onboarding_responses WHERE id=?').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Formulaire introuvable' })
  if (row.generated_order_id) return res.status(409).json({ error: 'Une commande a déjà été créée pour ce formulaire' })
  db.prepare("UPDATE customer_onboarding_responses SET form_options_json=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
    .run(JSON.stringify(normalizeDiscoveryOptions(req.body?.form_options)), row.id)
  const updated = db.prepare('SELECT r.*, c.name AS company_name FROM customer_onboarding_responses r LEFT JOIN companies c ON c.id = r.company_id WHERE r.id=?').get(row.id)
  res.json(shapeForm(updated))
})

// Réponses corrigées par Orisha depuis la fiche, tant qu'aucune commande n'existe.
// `answers` : champs racine (mêmes clés que l'autosave du formulaire public) ;
// `greenhouse` : { index, values } fusionné dans la carte (values.custom aussi) ;
// `custom_answers` : fusionné dans les réponses aux questions ajoutées.
const LOCKED_GREENHOUSE_KEYS = new Set(['permission_level'])
router.patch('/:id/answers', (req, res) => {
  const row = db.prepare('SELECT * FROM customer_onboarding_responses WHERE id=?').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Formulaire introuvable' })
  if (row.generated_order_id) return res.status(409).json({ error: 'Une commande a déjà été créée pour ce formulaire' })
  const body = req.body || {}
  const next = { ...(body.answers && typeof body.answers === 'object' ? body.answers : {}) }
  for (const key of ['greenhouses', 'num_greenhouses', 'custom_answers']) delete next[key]
  const gh = body.greenhouse
  if (gh && typeof gh === 'object') {
    const greenhouses = row.greenhouses_json ? JSON.parse(row.greenhouses_json) : []
    const index = Number(gh.index)
    if (!Number.isInteger(index) || !greenhouses[index]) return res.status(400).json({ error: 'Serre introuvable' })
    const values = Object.fromEntries(Object.entries(gh.values && typeof gh.values === 'object' ? gh.values : {}).filter(([key]) => !LOCKED_GREENHOUSE_KEYS.has(key)))
    const current = greenhouses[index]
    if (values.custom && typeof values.custom === 'object') values.custom = { ...(current.custom || {}), ...values.custom }
    greenhouses[index] = { ...current, ...values }
    next.greenhouses = greenhouses
  }
  if (body.custom_answers && typeof body.custom_answers === 'object' && !Array.isArray(body.custom_answers)) {
    next.custom_answers = { ...(row.custom_answers_json ? JSON.parse(row.custom_answers_json) : {}), ...body.custom_answers }
  }
  const { updates, values } = buildPartialUpdate(next)
  if (!updates.length) return res.status(400).json({ error: 'Aucune réponse à enregistrer' })
  db.prepare(`UPDATE customer_onboarding_responses SET ${updates.join(', ')}, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND generated_order_id IS NULL`)
    .run(...values, row.id)
  res.json(shapeForm(db.prepare(`
    SELECT r.*, c.name AS company_name, o.order_number AS generated_order_number
      FROM customer_onboarding_responses r
      LEFT JOIN companies c ON c.id = r.company_id
      LEFT JOIN orders o ON o.id = r.generated_order_id
     WHERE r.id=?
  `).get(row.id)))
})

router.patch('/:id/addresses', (req, res) => {
  const row = db.prepare('SELECT * FROM customer_onboarding_responses WHERE id=?').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Formulaire introuvable' })
  const changes = Object.entries(req.body || {}).filter(([key]) => ['farm_address_id', 'shipping_address_id'].includes(key))
  if (!changes.length) return res.status(400).json({ error: 'Adresse requise' })
  const selected = []
  for (const [key, id] of changes) {
    const address = typeof id === 'string' && db.prepare('SELECT * FROM adresses WHERE id=? AND company_id=?').get(id, row.company_id)
    if (!address) return res.status(400).json({ error: 'Choisissez une adresse de cette entreprise' })
    selected.push([key, address])
  }
  db.transaction(() => {
    for (const [key, address] of selected) {
      const jsonKey = key === 'farm_address_id' ? 'farm_address_json' : 'shipping_address_json'
      db.prepare(`UPDATE customer_onboarding_responses SET ${key}=?, ${jsonKey}=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
        .run(address.id, JSON.stringify(Object.fromEntries(['line1', 'city', 'province', 'postal_code', 'country'].map(field => [field, address[field]]))), row.id)
      if (key === 'shipping_address_id') db.prepare('UPDATE customer_onboarding_responses SET shipping_same_as_farm=0 WHERE id=?').run(row.id)
    }
    discoveryAddresses(db.prepare('SELECT * FROM customer_onboarding_responses WHERE id=?').get(row.id), { persist: true })
  })()
  res.json(shapeForm(db.prepare('SELECT * FROM customer_onboarding_responses WHERE id=?').get(row.id)))
})

router.patch('/:id/project', (req, res) => {
  const row = db.prepare('SELECT * FROM customer_onboarding_responses WHERE id=?').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Formulaire introuvable' })
  const id = req.body?.project_id || null
  if (id && !db.prepare('SELECT 1 FROM projects WHERE id=? AND company_id=?').get(id, row.company_id)) {
    return res.status(400).json({ error: 'Choisissez un projet de cette entreprise' })
  }
  db.prepare("UPDATE customer_onboarding_responses SET project_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(id, row.id)
  res.json(shapeForm(db.prepare('SELECT * FROM customer_onboarding_responses WHERE id=?').get(row.id)))
})

router.post('/:id/create-order', async (req, res) => {
  const row = db.prepare('SELECT * FROM customer_onboarding_responses WHERE id=?').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Formulaire introuvable' })
  if (row.generated_order_id) return res.status(409).json({ error: 'Une commande a déjà été créée pour ce formulaire', order_id: row.generated_order_id })
  const form = shapeForm(row)
  const unknown = unknownAnswers(form)
  if (unknown.length) return res.status(422).json({ error: `Réponses « Je ne sais pas » à corriger : ${unknown.map(u => (u.greenhouse ? `Serre #${u.greenhouse} · ${u.label}` : u.label)).join(', ')}`, unknown })
  const calc = calculateDiscoveryEquipment(form, schemaRules())
  if (!calc.calculationComplete) return res.status(422).json({ error: `Dimensionnement incomplet : ${calc.warnings.map(w => w.message).join(' ')}`, warnings: calc.warnings })
  const orderId = newRecordId()
  const orderNumber = (db.prepare('SELECT MAX(order_number) AS m FROM orders').get()?.m || 0) + 1
  db.transaction(() => {
    // La commande doit exister avant de poser la clé étrangère. La liaison
    // conditionnelle reste dans la même transaction : un doublon annule tout.
    const addresses = discoveryAddresses(row, { persist: true })
    // La livraison se lie à l'adresse connue d'Airtable quand elle existe déjà.
    const shipping = airtableTwinAddress(addresses.shipping_address)
    const farm = airtableTwinAddress(addresses.farm_address)
    addresses.shipping_address = shipping
    addresses.shipping_address_id = shipping?.id || null
    addresses.farm_address = farm
    addresses.farm_address_id = farm?.id || null
    db.prepare("INSERT INTO orders (id, order_number, company_id, project_id, farm_address_id, address_id, assigned_to, status, notes, date_commande) VALUES (?,?,?,?,?,?,?,'Commande vide',?,?)")
      .run(orderId, orderNumber, row.company_id || null, row.project_id || null, addresses.farm_address_id, addresses.shipping_address_id, req.user?.id || null, calc.orderNotes.join('\n'), localDay())
    // Colonnes miroir des liens Airtable « Adresse de livraison » et « Adresse
    // de la ferme (pour coordonnées géographiques) ».
    const orderCols = new Set(db.pragma('table_info(orders)').map(c => c.name))
    for (const [column, address] of [['adresse_de_livraison', addresses.shipping_address], ['adresse_de_la_ferme_pour_coordonnees_geographiques', addresses.farm_address]]) {
      if (orderCols.has(column)) db.prepare(`UPDATE orders SET ${column}=? WHERE id=?`).run(address?.id ? JSON.stringify([address.airtable_id || address.id]) : '', orderId)
    }
    // Réseau Wi-Fi du client → champs « Wi-Fi name » / « Wi-Fi password » de la commande.
    // « Non fourni » : Orisha a accepté de s'en passer, rien à reporter.
    const known = v => (v && !['Je ne sais pas', 'Non fourni'].includes(String(v).trim()) ? String(v).trim() : null)
    for (const [column, value] of [['wi_fi_name', known(row.wifi_ssid)], ['wi_fi_password', known(row.wifi_password)]]) {
      if (orderCols.has(column) && value) db.prepare(`UPDATE orders SET ${column}=? WHERE id=?`).run(value, orderId)
    }
    const claim = db.prepare("UPDATE customer_onboarding_responses SET generated_order_id=? WHERE id=? AND generated_order_id IS NULL").run(orderId, row.id)
    if (claim.changes !== 1) throw new Error('Une commande a déjà été créée pour ce formulaire')
    for (const item of calc.orderItems) {
      const itemId = newRecordId()
      db.prepare("INSERT INTO order_items (id, order_id, product_id, qty, item_type, notes) VALUES (?,?,?,?,'Facturable',?)")
        .run(itemId, orderId, item.product_id, item.qty, item.label)
      applyOrderItemDefaults(itemId)
    }
  })()
  emitOrder('created', orderId, req.user?.id)
  // Airtable suit en arrière-plan ; un échec est repris par la reprise périodique.
  queueDiscoveryOrderMirror(orderId)
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
