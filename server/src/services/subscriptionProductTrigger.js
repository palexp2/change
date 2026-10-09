// Déclencheur « Quand un abonnement contient un produit » des automatisations
// en blocs (page Automatisations). Il remplace l'ancienne automatisation codée
// « Programme partenaire → HubSpot » (Charles, 2026-10-09 : déclencheur et
// actions modifiables dans l'interface).
//
// Une passe toutes les 30 s : pour chaque automatisation active de ce type,
// chaque couple abonnement × contact (le contact de l'abonnement et le
// signataire noté sur la ligne du produit) qui contient un des produits visés
// fait tourner les actions une fois. Le couple est noté dans
// automation_rule_fires (record_table « subscription_contacts »). Un échec est
// retenté au plus une fois par heure.

import db from '../db/database.js'
import { runSteps, stepsLog } from './ruleActions/steps.js'
import { logRuleRun } from './systemAutomations.js'
import { siblingStripeProducts } from './stripeCatalog.js'
import { APP_URL } from '../config/appUrl.js'

export const SUB_PRODUCT_TABLE = 'subscription_contacts'

function activeAutomations(id = null) {
  return db.prepare(`SELECT * FROM automations WHERE deleted_at IS NULL AND action_type = 'steps'
    AND trigger_type = 'subscription_product' ${id ? 'AND id = ?' : 'AND active = 1'}`).all(...(id ? [id] : []))
}

function productSet(tc) {
  const ids = (Array.isArray(tc.products) ? tc.products : []).filter(Boolean)
  return new Set(ids.flatMap(id => siblingStripeProducts(id)))
}

/** Champs offerts aux actions ({{email}}, {{maintenant_ms}}…). */
function rowFor(sub, ct, role, items) {
  const now = new Date()
  return {
    id: `${sub.id}:${ct.id}`, subscription_id: sub.id, stripe_id: sub.stripe_id, contact_id: ct.id,
    email: ct.email, first_name: ct.first_name, last_name: ct.last_name,
    contact_name: [ct.first_name, ct.last_name].filter(Boolean).join(' ').trim() || ct.email,
    hubspot_record_id: ct.hubspot_record_id ? String(ct.hubspot_record_id).replace(/\.0$/, '') : '',
    company_id: sub.company_id, role, produits: items.map(i => i.name).filter(Boolean).join(', '),
    maintenant: now.toISOString(), maintenant_ms: String(now.getTime()), app_url: APP_URL,
  }
}

/** Contacts d'un abonnement pour des lignes visées : le sien, puis les signataires. */
function contactsOf(s, hit, contact) {
  const out = []
  const seen = new Set()
  for (const [cid, role] of [[s.contact_id, 'contact'], ...hit.map(it => [it.metadata?.erp_contact_id, 'signataire'])]) {
    if (!cid || seen.has(cid)) continue
    seen.add(cid)
    const ct = contact.get(cid)
    if (ct) out.push([ct, role])
  }
  return out
}

const contactStmt = () => db.prepare('SELECT id, email, first_name, last_name, hubspot_record_id FROM contacts WHERE id = ? AND deleted_at IS NULL')

/** Couples abonnement × contact qui contiennent un produit visé. */
export function matchingPairs(tc) {
  const ids = productSet(tc)
  if (!ids.size) return []
  const subs = db.prepare(`SELECT s.id, s.stripe_id, s.contact_id, s.company_id, ci.items_json
    FROM subscriptions s JOIN subscription_current_items ci ON ci.subscription_id = s.id`).all()
  const contact = contactStmt()
  const out = []
  for (const s of subs) {
    let items = []
    try { items = JSON.parse(s.items_json) || [] } catch { /* illisible */ }
    const hit = items.filter(it => it?.stripe_product_id && ids.has(it.stripe_product_id))
    if (!hit.length) continue
    for (const [ct, role] of contactsOf(s, hit, contact)) out.push(rowFor(s, ct, role, hit))
  }
  return out
}

const firedStmt = () => db.prepare('SELECT 1 FROM automation_rule_fires WHERE automation_id = ? AND record_table = ? AND record_id = ?')

const markFiredOnce = (automationId, recordId) => db.prepare('INSERT OR IGNORE INTO automation_rule_fires (automation_id, record_table, record_id) VALUES (?, ?, ?)').run(automationId, SUB_PRODUCT_TABLE, recordId)

async function fire(a, row, trigger) {
  const rule = { id: a.id, name: a.name, trigger_config: JSON.parse(a.trigger_config || '{}'), action_config: JSON.parse(a.action_config || '{}') }
  // Mode « perd » : la mémoire des couples tenus fait office de garde-fou ;
  // le même départ peut se reproduire après un réabonnement.
  const lost = isLost(rule.trigger_config)
  const markFired = lost ? () => {} : markFiredOnce
  const started = Date.now()
  const label = `${row.contact_name} (abonnement ${row.stripe_id || row.subscription_id}${lost ? ` · ${row.produits} ${row.cause}` : ''})`
  try {
    const outputs = await runSteps({ rule, row })
    markFired(a.id, row.id)
    logRuleRun(a.id, { status: 'success', result: `${label}\n${stepsLog(outputs)}`, duration_ms: Date.now() - started, triggerData: { trigger, record_id: row.id } })
    return true
  } catch (e) {
    // Pas de nouvelle tentative (Charles, 2026-10-09) : l'échec compte comme
    // un tir ; « Tester » relance à la main.
    markFired(a.id, row.id)
    logRuleRun(a.id, { status: 'error', error: `${label}\n${e.message}`, duration_ms: Date.now() - started, triggerData: { trigger, record_id: row.id } })
    throw e
  }
}

// ── Mode « perd le produit » (trigger_config.event = 'lost') ─────────────────
// Pierre-Alexandre Papillon, 2026-10-09 : quand un abonnement qui contient un
// produit visé est annulé, ou que ce produit en est retiré, les actions
// tournent pour son contact et le signataire de la ligne.
//
// Mémoire : automation_rule_fires, record_table « subscription_contacts_held »
// = couples abonnement × contact × produit visé (« sub:contact:prod_… ») qui
// tenaient le produit à la passe précédente, abonnement non annulé. Un couple
// qui disparaît part en actions si l'abonnement est annulé ou n'a plus le
// produit ; autre cause (contact délié, produit ôté du déclencheur) : oublié
// sans rien faire. Tenue même désactivée : l'activer ne rattrape pas le passé.

export const HELD_TABLE = 'subscription_contacts_held'
const isLost = tc => tc?.event === 'lost'

/** Produit configuré pour chaque id Stripe (versions de langue incluses). */
function canonicalMap(tc) {
  const m = new Map()
  for (const p of (Array.isArray(tc.products) ? tc.products : []).filter(Boolean)) {
    for (const s of siblingStripeProducts(p)) if (!m.has(s)) m.set(s, p)
  }
  return m
}

const productName = (p, hit = []) => hit.find(it => it?.name)?.name
  || db.prepare('SELECT name FROM stripe_products WHERE id = ?').get(p)?.name || p

/** Couples abonnement (non annulé) × contact × produit visé, à cet instant. */
export function heldPairs(tc) {
  const canon = canonicalMap(tc)
  if (!canon.size) return []
  const subs = db.prepare(`SELECT s.id, s.stripe_id, s.contact_id, s.company_id, ci.items_json
    FROM subscriptions s JOIN subscription_current_items ci ON ci.subscription_id = s.id
    WHERE COALESCE(s.status, '') <> 'canceled'`).all()
  const contact = contactStmt()
  const out = []
  for (const s of subs) {
    let items = []
    try { items = JSON.parse(s.items_json) || [] } catch { /* illisible */ }
    const byProduct = new Map()
    for (const it of items) {
      const p = it?.stripe_product_id && canon.get(it.stripe_product_id)
      if (p) byProduct.set(p, [...(byProduct.get(p) || []), it])
    }
    for (const [p, hit] of byProduct) {
      for (const [ct, role] of contactsOf(s, hit, contact)) {
        out.push({ ...rowFor(s, ct, role, [{ name: productName(p, hit) }]), id: `${s.id}:${ct.id}:${p}`, product: p, cause: '' })
      }
    }
  }
  return out
}

/** Ligne d'actions pour un couple disparu, ou null s'il n'y a pas départ. */
function lostRow(recordId, tc) {
  const [subId, contactId, product] = recordId.split(':')
  if (!product || !(tc.products || []).includes(product)) return null
  const sub = db.prepare('SELECT id, stripe_id, contact_id, company_id, status FROM subscriptions WHERE id = ?').get(subId)
  const ct = sub && contactStmt().get(contactId)
  if (!ct) return null
  let items = []
  try { items = JSON.parse(db.prepare('SELECT items_json FROM subscription_current_items WHERE subscription_id = ?').get(sub.id)?.items_json) || [] } catch { /* illisible */ }
  const ids = new Set(siblingStripeProducts(product))
  const hit = items.filter(it => it?.stripe_product_id && ids.has(it.stripe_product_id))
  const cause = sub.status === 'canceled' ? 'annulé' : !hit.length ? 'retiré' : null
  if (!cause) return null
  const role = sub.contact_id === ct.id ? 'contact' : 'signataire'
  return { ...rowFor(sub, ct, role, [{ name: productName(product, hit) }]), id: recordId, product, cause }
}

/** Une passe pour une automatisation « perd » : mémoire à jour, départs tirés. */
async function lostPass(a) {
  const tc = JSON.parse(a.trigger_config || '{}')
  const now = new Set(heldPairs(tc).map(r => r.id))
  const held = db.prepare('SELECT record_id FROM automation_rule_fires WHERE automation_id = ? AND record_table = ?').pluck().all(a.id, HELD_TABLE)
  const was = new Set(held)
  const add = db.prepare('INSERT OR IGNORE INTO automation_rule_fires (automation_id, record_table, record_id) VALUES (?, ?, ?)')
  const drop = db.prepare('DELETE FROM automation_rule_fires WHERE automation_id = ? AND record_table = ? AND record_id = ?')
  const gone = held.filter(id => !now.has(id))
  db.transaction(() => {
    for (const id of now) if (!was.has(id)) add.run(a.id, HELD_TABLE, id)
    for (const id of gone) drop.run(a.id, HELD_TABLE, id)
  })()
  if (!a.active) return
  for (const id of gone) {
    const row = lostRow(id, tc)
    if (row) await fire(a, row, 'auto').catch(() => {})
  }
}

/** Couples correspondants, marqués déjà traités ou non (aperçu « Tester »). */
export function pairsFor(a) {
  const tc = JSON.parse(a.trigger_config || '{}')
  // Mode « perd » : les couples qui tiennent le produit — « Exécuter » lance
  // les actions comme s'ils venaient de le perdre.
  if (isLost(tc)) return heldPairs(tc).map(r => ({ ...r, lost_product: true, already_fired: false }))
  const fired = firedStmt()
  return matchingPairs(tc).map(r => ({ ...r, already_fired: !!fired.get(a.id, SUB_PRODUCT_TABLE, r.id) }))
}

/** Couples pas encore traités (passe régulière). */
export function pendingFor(a) {
  return pairsFor(a).filter(r => !r.already_fired)
}

export async function runSubscriptionProductPass() {
  // Les « perd » sont tenus à jour même désactivés (voir lostPass).
  for (const a of db.prepare(`SELECT * FROM automations WHERE deleted_at IS NULL AND action_type = 'steps'
    AND trigger_type = 'subscription_product'`).all()) {
    if (isLost(JSON.parse(a.trigger_config || '{}'))) { await lostPass(a); continue }
    if (!a.active) continue
    for (const row of pendingFor(a)) {
      await fire(a, row, 'auto').catch(() => {})
    }
  }
}

/** « Tester » : exécute pour un couple précis (« abonnement:contact »). */
export async function runSubscriptionProductFor(automationId, recordId) {
  const a = activeAutomations(automationId)[0]
  if (!a) throw new Error('Automatisation introuvable')
  const tc = JSON.parse(a.trigger_config || '{}')
  const row = isLost(tc)
    ? heldPairs(tc).map(r => ({ ...r, cause: 'test' })).find(r => r.id === recordId)
    : matchingPairs(tc).find(r => r.id === recordId)
  if (!row) throw new Error('Ce couple abonnement / contact ne correspond plus')
  await fire(a, row, 'manuel')
  return { ok: true, record_id: row.id }
}

/**
 * Ajout programmé (page avec premier paiement différé) : le produit n'entre
 * dans l'abonnement qu'à la date, mais l'inscription compte dès maintenant.
 */
export async function fireScheduledSubscriptionProduct(stripeSubId, contactId, stripeProductId) {
  if (!contactId || !stripeProductId) return
  const sub = db.prepare('SELECT id, stripe_id, contact_id, company_id FROM subscriptions WHERE stripe_id = ?').get(stripeSubId)
  const ct = sub && contactStmt().get(contactId)
  if (!ct) return
  const fired = firedStmt()
  for (const a of activeAutomations()) {
    const tc = JSON.parse(a.trigger_config || '{}')
    if (isLost(tc) || !productSet(tc).has(stripeProductId)) continue
    const row = rowFor(sub, ct, 'signataire', [{ name: '' }])
    if (fired.get(a.id, SUB_PRODUCT_TABLE, row.id)) continue
    await fire(a, row, 'ajout programmé').catch(() => {})
  }
}

let timer = null
let running = false
export function startSubscriptionProductWatcher(intervalMs = 30_000) {
  if (timer) return
  timer = setInterval(async () => {
    if (running) return
    running = true
    try { await runSubscriptionProductPass() } catch (e) { console.error('[subscriptionProductTrigger]', e.message) } finally { running = false }
  }, intervalMs)
  timer.unref?.()
}

// ── Reprise de l'automatisation codée « Programme partenaire → HubSpot » ─────

export const PARTNERSHIP_FLOW_ID = 'auto_partnership_hubspot'

/**
 * Crée une fois l'automatisation en blocs équivalente (même produit, même
 * propriété HubSpot, même état actif) et y reporte les contacts déjà inscrits,
 * pour qu'aucun ne soit poussé une seconde fois.
 */
export function migratePartnershipToBlocks() {
  if (db.prepare('SELECT 1 FROM automations WHERE id = ?').get(PARTNERSHIP_FLOW_ID)) return
  const old = db.prepare("SELECT * FROM automations WHERE id = 'sys_partnership_hubspot'").get()
  let cfg = {}
  try { cfg = JSON.parse(old?.action_config || '{}') } catch { /* défauts */ }
  const products = String(cfg.product_stripe_id || 'prod_VJBPMtzzB2oUxF').split(/[,\n]+/).map(x => x.trim()).filter(Boolean)
  const property = String(cfg.hubspot_property || 'subscribed_to_partnership_at').trim()
  const steps = [{ id: 'hs1', type: 'hubspot', config: { object: 'contacts', record: '{{email}}', property, value: '{{maintenant_ms}}' } }]
  db.transaction(() => {
    db.prepare(`INSERT INTO automations (id, name, description, trigger_type, trigger_config, action_type, action_config, script, active, kind, group_name)
      VALUES (?, ?, ?, 'subscription_product', ?, 'steps', ?, '', ?, 'flow', 'Ventes')`).run(
      PARTNERSHIP_FLOW_ID, 'Programme partenaire : date dans HubSpot',
      'Quand un abonnement contient le programme partenaire, son contact et le signataire reçoivent la date d’inscription dans HubSpot.',
      JSON.stringify({ type: 'subscription_product', products }), JSON.stringify({ steps }), old ? old.active : 1)
    db.prepare(`INSERT OR IGNORE INTO automation_rule_fires (automation_id, record_table, record_id)
      SELECT ?, ?, subscription_id || ':' || contact_id FROM subscription_partnership_marks WHERE outcome = 'sent'`).run(PARTNERSHIP_FLOW_ID, SUB_PRODUCT_TABLE)
  })()
}

// ── « Programme partenaire perdu → HubSpot » (Pierre-Alexandre Papillon, 2026-10-09)

export const PARTNERSHIP_LOST_FLOW_ID = 'auto_partnership_hubspot_lost'

/**
 * Crée une fois, désactivée, l'automatisation « perd » jumelle de la
 * précédente (mêmes produits). La propriété HubSpot reste à choisir dans
 * l'interface avant de l'activer.
 */
export function seedPartnershipLostFlow() {
  if (db.prepare('SELECT 1 FROM automations WHERE id = ?').get(PARTNERSHIP_LOST_FLOW_ID)) return
  let products = []
  try { products = JSON.parse(db.prepare('SELECT trigger_config FROM automations WHERE id = ?').get(PARTNERSHIP_FLOW_ID)?.trigger_config || '{}').products || [] } catch { /* défaut */ }
  if (!products.length) products = ['prod_VJBPMtzzB2oUxF']
  const steps = [{ id: 'hs1', type: 'hubspot', config: { object: 'contacts', record: '{{email}}', property: '', value: '{{maintenant_ms}}' } }]
  db.prepare(`INSERT INTO automations (id, name, description, trigger_type, trigger_config, action_type, action_config, script, active, kind, group_name)
    VALUES (?, ?, ?, 'subscription_product', ?, 'steps', ?, '', 0, 'flow', 'Ventes')`).run(
    PARTNERSHIP_LOST_FLOW_ID, 'Programme partenaire perdu : HubSpot',
    'Quand un abonnement avec le programme partenaire est annulé, ou que le programme en est retiré, une propriété HubSpot de son contact et du signataire est mise à jour.',
    JSON.stringify({ type: 'subscription_product', products, event: 'lost' }), JSON.stringify({ steps }))
}
