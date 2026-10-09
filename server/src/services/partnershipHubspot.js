// partnershipHubspot — « Programme partenaire » → HubSpot (2026-10-08).
//
// Quand un abonnement contient le produit « Orisha partnership program » et
// qu'un contact lui est associé, la fiche HubSpot de ce contact reçoit la date
// et l'heure du moment dans `subscribed_to_partnership_at`. Le signataire noté
// sur la ligne du produit (page avec acceptation) est inscrit lui aussi.
//
// Une passe toutes les 30 s compare l'état (abonnements × produit × contact) à
// subscription_partnership_marks : chaque couple abonnement/contact n'est
// poussé qu'une fois, quelle que soit la façon dont le lien est né (synchro
// Stripe, webhook, choix manuel du contact). Un échec est inscrit en « error » ;
// « Exécuter maintenant » le retente.

import db from '../db/database.js'
import { hsFetch, lookupContactsByEmail, isHubSpotConfigured } from '../connectors/hubspot.js'
import { logSystemRun, isSystemAutomationActive } from './systemAutomations.js'
import { siblingStripeProducts } from './stripeCatalog.js'

export const PARTNERSHIP_HUBSPOT_ID = 'sys_partnership_hubspot'

export const PARTNERSHIP_HUBSPOT_DEFAULT_CONFIG = {
  product_name: 'Orisha partnership program',
  product_stripe_id: 'prod_VJBPMtzzB2oUxF',
  hubspot_property: 'subscribed_to_partnership_at',
}

export function getPartnershipHubspotConfig() {
  const row = db.prepare('SELECT action_config FROM automations WHERE id=?').get(PARTNERSHIP_HUBSPOT_ID)
  let cfg = {}
  try { cfg = JSON.parse(row?.action_config || '{}') } catch {}
  const merged = { ...PARTNERSHIP_HUBSPOT_DEFAULT_CONFIG }
  for (const k of Object.keys(merged)) {
    if (cfg[k] != null && String(cfg[k]).trim() !== '') merged[k] = String(cfg[k]).trim()
  }
  return merged
}

/**
 * Vrai si un des articles de l'abonnement est un produit visé. Plusieurs
 * produits possibles (Charles, 2026-10-09) : ids Stripe séparés par des
 * virgules, chacun élargi à ses versions dans les autres langues du catalogue ;
 * noms aussi séparés par des virgules.
 */
export function itemsContainProduct(items, cfg, siblings = id => [id]) {
  const list = v => String(v || '').split(/[,\n]+/).map(x => x.trim()).filter(Boolean)
  const names = new Set(list(cfg.product_name).map(n => n.toLowerCase()))
  const ids = new Set(list(cfg.product_stripe_id).flatMap(id => siblings(id)))
  return (Array.isArray(items) ? items : []).some(it =>
    (it?.stripe_product_id && ids.has(it.stripe_product_id)) || names.has(String(it?.name || '').trim().toLowerCase()))
}

/**
 * Couples abonnement/contact qualifiés, pas encore poussés (ou en erreur si
 * retryErrors) : le contact de l'abonnement, et aussi le signataire noté sur la
 * ligne du produit (metadata erp_contact_id, page avec acceptation) s'il diffère.
 */
export function pendingPairs(cfg, { retryErrors = false } = {}) {
  const subs = db.prepare(`
    SELECT s.id AS subscription_id, s.stripe_id, s.contact_id, ci.items_json
      FROM subscriptions s
      JOIN subscription_current_items ci ON ci.subscription_id = s.id
  `).all()
  const contactStmt = db.prepare(`SELECT id, email, hubspot_record_id,
      TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS contact_name
    FROM contacts WHERE id = ? AND deleted_at IS NULL`)
  const markStmt = db.prepare('SELECT outcome FROM subscription_partnership_marks WHERE subscription_id = ? AND contact_id = ?')
  const out = []
  for (const s of subs) {
    let items = null
    try { items = JSON.parse(s.items_json) } catch { /* illisible */ }
    if (!itemsContainProduct(items, cfg, siblingStripeProducts)) continue
    const signers = (items || []).filter(it => itemsContainProduct([it], cfg, siblingStripeProducts))
      .map(it => it.metadata?.erp_contact_id).filter(Boolean)
    for (const cid of new Set([s.contact_id, ...signers].filter(Boolean))) {
      const ct = contactStmt.get(cid)
      if (!ct) continue
      const outcome = markStmt.get(s.subscription_id, cid)?.outcome
      if (outcome && !(retryErrors && outcome === 'error')) continue
      out.push({ subscription_id: s.subscription_id, stripe_id: s.stripe_id, contact_id: cid,
        email: ct.email, hubspot_record_id: ct.hubspot_record_id, contact_name: ct.contact_name, outcome })
    }
  }
  return out
}

function mark(pair, outcome, detail) {
  db.prepare(`
    INSERT INTO subscription_partnership_marks (subscription_id, contact_id, outcome, detail)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(subscription_id, contact_id) DO UPDATE SET
      outcome=excluded.outcome, detail=excluded.detail, at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).run(pair.subscription_id, pair.contact_id, outcome, detail || null)
}

async function hubspotIdFor(pair) {
  if (pair.hubspot_record_id) return String(pair.hubspot_record_id).replace(/\.0$/, '')
  if (!pair.email) return null
  const found = await lookupContactsByEmail([pair.email])
  return found.get(String(pair.email).trim().toLowerCase()) || null
}

async function pushPair(pair, cfg) {
  const started = Date.now()
  const label = pair.contact_name || pair.email || pair.contact_id
  const triggerData = { subscription_id: pair.subscription_id, stripe_id: pair.stripe_id, contact_id: pair.contact_id }
  try {
    const hsId = await hubspotIdFor(pair)
    if (!hsId) throw new Error(`contact introuvable dans HubSpot (${pair.email || 'sans courriel'})`)
    const now = new Date()
    await hsFetch(`/crm/v3/objects/contacts/${encodeURIComponent(hsId)}`, {
      method: 'PATCH',
      body: { properties: { [cfg.hubspot_property]: String(now.getTime()) } },
    })
    mark(pair, 'sent', `HubSpot ${hsId} · ${now.toISOString()}`)
    logSystemRun(PARTNERSHIP_HUBSPOT_ID, {
      status: 'success',
      result: `${label} → HubSpot ${hsId} : ${cfg.hubspot_property} = ${now.toISOString()} (abonnement ${pair.stripe_id || pair.subscription_id})`,
      duration_ms: Date.now() - started,
      triggerData,
    })
    return 'sent'
  } catch (e) {
    mark(pair, 'error', e.message)
    logSystemRun(PARTNERSHIP_HUBSPOT_ID, {
      status: 'error',
      error: `${label} (abonnement ${pair.stripe_id || pair.subscription_id}) : ${e.message}`,
      duration_ms: Date.now() - started,
      triggerData,
    })
    return 'error'
  }
}

/**
 * Ajout programmé (page avec premier paiement différé) : le produit n'entre
 * dans l'abonnement qu'à la date, mais l'inscription compte dès maintenant →
 * le contact est poussé tout de suite, et la passe régulière le saute ensuite.
 */
export async function pushScheduledPartnership(stripeSubId, contactId, stripeProductId) {
  if (!contactId || !isSystemAutomationActive(PARTNERSHIP_HUBSPOT_ID) || !isHubSpotConfigured()) return null
  const cfg = getPartnershipHubspotConfig()
  if (!itemsContainProduct([{ stripe_product_id: stripeProductId }], cfg, siblingStripeProducts)) return null
  const sub = db.prepare('SELECT id, stripe_id FROM subscriptions WHERE stripe_id=?').get(stripeSubId)
  const ct = sub && db.prepare(`SELECT id, email, hubspot_record_id,
      TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS contact_name
    FROM contacts WHERE id = ? AND deleted_at IS NULL`).get(contactId)
  if (!ct) return null
  if (db.prepare('SELECT 1 FROM subscription_partnership_marks WHERE subscription_id=? AND contact_id=? AND outcome=?').get(sub.id, ct.id, 'sent')) return null
  return pushPair({ subscription_id: sub.id, stripe_id: sub.stripe_id, contact_id: ct.id, email: ct.email,
    hubspot_record_id: ct.hubspot_record_id, contact_name: ct.contact_name }, cfg)
}

/** Une passe. dryRun = liste sans pousser ; retryErrors = retente les échecs. */
export async function runPartnershipHubspot({ dryRun = false, retryErrors = false } = {}) {
  const cfg = getPartnershipHubspotConfig()
  const pairs = pendingPairs(cfg, { retryErrors })
  if (dryRun) {
    return {
      summary: `${pairs.length} contact(s) à mettre à jour dans HubSpot`,
      details: pairs.map(p => ({ abonnement: p.stripe_id || p.subscription_id, contact: p.contact_name || p.email })),
    }
  }
  let sent = 0, errors = 0
  for (const p of pairs) {
    if (await pushPair(p, cfg) === 'sent') sent++
    else errors++
  }
  return { summary: `${sent} contact(s) mis à jour · ${errors} erreur(s)` }
}

let timer = null
let running = false
export function startPartnershipHubspotWatcher(intervalMs = 30_000) {
  if (timer) return
  timer = setInterval(async () => {
    if (running || !isSystemAutomationActive(PARTNERSHIP_HUBSPOT_ID) || !isHubSpotConfigured()) return
    running = true
    try { await runPartnershipHubspot() } catch (e) { console.error('[partnershipHubspot]', e.message) } finally { running = false }
  }, intervalMs)
  timer.unref?.()
}
