import db from '../db/database.js'
import { newRecordId } from '../utils/recordId.js'
import { generateShortToken } from '../utils/shortToken.js'
import { normalizeDiscoveryOptions } from './discoveryFormOptions.js'
import { isSystemAutomationActive, logSystemRun } from './systemAutomations.js'
import { projectIdFromStripeMetadata } from './stripeProjectLink.js'

// Soumission payée sur Stripe → System builder (customer_onboarding_responses)
// prérempli : une carte par serre (Chef de culture / Assistant), extras de
// chaque serre, extras du site. Demande de Pierre-Alexandre Papillon
// (2026-09-30). Un seul formulaire par session Checkout (stripe_session_id
// UNIQUE) : le webhook et le retour de Stripe peuvent tous deux l'appeler.

export const AUTOMATION_ID = 'sys_soumission_system_builder'

const BASE_ROLES = new Set(['chief_grower', 'helper'])
// Produit de la soumission (SKU) → réglage du System builder.
const GREENHOUSE_COUNTS = { 'SVC-011': 'furnaces', 'SVC-008': 'valves', 'SVC-007': 'rollups', 'SVC-010': 'roofs', 'SVC-013': 'screens' }
const GREENHOUSE_FLAGS = { 'SVC-009': 'ventilation', 'SVC-006': 'humidity_valve', 'SVC-012': 'advanced_temperature_sensor' }
const SITE_SENSORS = { 'SVC-014': 'rain_sensor', 'SVC-015': 'wind_sensor', 'SVC-016': 'solar_sensor', 'SVC-019': 'outdoor_temperature_sensor' }
const CENTRAL_SKUS = new Set(['SVC-018', '1479'])
// Le capteur de sol du catalogue n'a pas de SKU.
const isSoilSensor = it => !it.sku && /^capteur de sol$/i.test(String(it.name_fr || '').trim())
// Inclus d'office dans un Chef de culture : rien à reporter.
const INCLUDED_SKUS = new Set(['SVC-005'])

const qtyOf = it => Math.max(1, Math.round(Number(it.qty) || 1))

/**
 * Lignes de soumission (avec sku, role, name_fr du produit) → réglages du
 * System builder. Pur : aucune écriture.
 * @returns {{ greenhouses: object[], form_options: object, notes: string[] }}
 */
export function systemFromSoumissionItems(items, { lang = 'fr' } = {}) {
  const greenhouses = []
  const extras = []
  const firstCardOfGroup = new Map()
  // Cartes de serre, dans l'ordre de la soumission.
  for (const it of items) {
    if (!BASE_ROLES.has(it.role)) continue
    const group = it.group_name || ''
    if (!firstCardOfGroup.has(group)) firstCardOfGroup.set(group, greenhouses.length)
    for (let k = 0; k < qtyOf(it); k++) {
      greenhouses.push({ permission_level: it.role })
      extras.push({})
    }
  }
  const site = { mobile_controllers: 0, extra_central_controllers: 0, sensors: {} }
  const notes = []
  for (const it of items) {
    if (BASE_ROLES.has(it.role) || INCLUDED_SKUS.has(it.sku)) continue
    const qty = qtyOf(it)
    // Ligne sans serre (ancienne soumission) : première serre.
    const idx = firstCardOfGroup.get(it.group_name || '') ?? (greenhouses.length ? 0 : null)
    const e = idx == null ? null : extras[idx]
    if (e && GREENHOUSE_COUNTS[it.sku]) e[GREENHOUSE_COUNTS[it.sku]] = (e[GREENHOUSE_COUNTS[it.sku]] || 0) + qty
    else if (e && GREENHOUSE_FLAGS[it.sku]) e[GREENHOUSE_FLAGS[it.sku]] = true
    else if (SITE_SENSORS[it.sku]) site.sensors[SITE_SENSORS[it.sku]] = (site.sensors[SITE_SENSORS[it.sku]] || 0) + qty
    else if (isSoilSensor(it)) site.sensors.soil_temperature_sensor = (site.sensors.soil_temperature_sensor || 0) + qty
    else if (CENTRAL_SKUS.has(it.sku)) site.extra_central_controllers += qty
    else if (it.role === 'mobile_controller') site.mobile_controllers += qty
    else {
      // Sur mesure ou produit sans équivalent : laissé en note pour Orisha.
      const label = it.description_fr || it.name_fr || it.description_en || it.sku || 'Article'
      notes.push(`${label} × ${qty}${it.group_name ? ` (${it.group_name})` : ''}`)
    }
  }
  return {
    greenhouses,
    form_options: normalizeDiscoveryOptions({ lang, ...site, additional_equipment: extras }),
    notes,
  }
}

const ITEMS_QUERY = `
  SELECT di.*, p.sku, p.role, p.name_fr
  FROM document_items di
  LEFT JOIN products p ON di.catalog_product_id = p.id
  WHERE di.document_id = ? AND di.document_type = 'soumission'
  ORDER BY di.sort_order
`

const idOf = v => (typeof v === 'string' ? v : v?.id || null)

/**
 * Crée (une fois) le System builder de la session Checkout payée d'une
 * soumission. Synchrone : deux appels concurrents ne peuvent pas doubler.
 * @returns {object|null} la ligne customer_onboarding_responses (avec
 *   public_token), ou null (automation désactivée, soumission sans serre).
 */
export function ensureSoumissionSystemBuilder({ soumissionId, session, source }) {
  if (!soumissionId || !session?.id) return null
  const byId = id => db.prepare('SELECT * FROM customer_onboarding_responses WHERE id=?').get(id)
  const existing = db.prepare('SELECT * FROM customer_onboarding_responses WHERE stripe_session_id=?').get(session.id)
  if (existing?.public_token && existing.greenhouses_json) return existing
  if (!isSystemAutomationActive(AUTOMATION_ID)) return null

  const started = Date.now()
  const triggerData = { source, session_id: session.id, soumission_id: soumissionId }
  const s = db.prepare('SELECT * FROM soumissions WHERE id=?').get(soumissionId)
  if (!s) {
    logSystemRun(AUTOMATION_ID, { status: 'error', error: `Soumission ${soumissionId} introuvable`, duration_ms: Date.now() - started, triggerData })
    return null
  }
  const built = systemFromSoumissionItems(db.prepare(ITEMS_QUERY).all(s.id), { lang: s.language === 'English' ? 'en' : 'fr' })
  if (!built.greenhouses.length) {
    logSystemRun(AUTOMATION_ID, { status: 'skipped', result: `Soumission #${s.quote_number ?? s.id} sans serre : aucun System builder`, duration_ms: Date.now() - started, triggerData })
    return null
  }
  const companyId = s.company_id || session.metadata?.erp_company_id || null
  const topPermission = built.greenhouses.some(g => g.permission_level === 'chief_grower') ? 'chief_grower' : 'helper'
  const notes = built.notes.length ? `Soumission #${s.quote_number ?? ''} — à vérifier :\n${built.notes.join('\n')}` : null

  const id = db.transaction(() => {
    if (existing) {
      // Ligne ouverte par l'ancien parcours post-paiement : on la complète
      // sans écraser ce que le client aurait déjà rempli.
      db.prepare(`
        UPDATE customer_onboarding_responses SET
          public_token = COALESCE(public_token, ?), soumission_id = ?, company_id = COALESCE(company_id, ?),
          permission_level = COALESCE(permission_level, ?), num_greenhouses = COALESCE(num_greenhouses, ?),
          greenhouses_json = COALESCE(greenhouses_json, ?), form_options_json = COALESCE(form_options_json, ?),
          technical_notes = COALESCE(technical_notes, ?), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?
      `).run(generateShortToken(), s.id, companyId, topPermission, built.greenhouses.length,
        JSON.stringify(built.greenhouses), JSON.stringify(built.form_options), notes, existing.id)
      return existing.id
    }
    const newId = newRecordId()
    db.prepare(`
      INSERT INTO customer_onboarding_responses
        (id, stripe_session_id, stripe_invoice_id, stripe_subscription_id, company_id, soumission_id,
         permission_level, num_greenhouses, greenhouses_json, public_token, form_options_json, technical_notes, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'in_progress')
    `).run(newId, session.id, idOf(session.invoice), idOf(session.subscription), companyId, s.id,
      topPermission, built.greenhouses.length, JSON.stringify(built.greenhouses), generateShortToken(),
      JSON.stringify(built.form_options), notes)
    return newId
  })()
  // Projet de la soumission (ou celui posé sur la session Checkout).
  const projectId = projectIdFromStripeMetadata(session.metadata, { erp_soumission_id: s.id })
  if (projectId) {
    db.prepare("UPDATE customer_onboarding_responses SET project_id=? WHERE id=? AND (project_id IS NULL OR project_id='')").run(projectId, id)
  }

  const row = byId(id)
  logSystemRun(AUTOMATION_ID, {
    status: 'success',
    result: `SYS-${row.form_number ?? '?'} créé pour la soumission #${s.quote_number ?? s.id} (${built.greenhouses.length} serre${built.greenhouses.length > 1 ? 's' : ''})`,
    duration_ms: Date.now() - started,
    triggerData: { ...triggerData, form_id: id },
  })
  return row
}
