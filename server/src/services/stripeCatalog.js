import db from '../db/database.js'
import { newRecordId } from '../utils/recordId.js'

// Catalogue de vente : miroir local des produits et prix Stripe. Stripe est la
// source ; chaque écriture passe par Stripe puis rafraîchit la ligne locale.
// Un prix Stripe est immuable : « changer » un prix = en créer un et archiver
// l'ancien (les abonnés existants gardent le leur).

const upsertProductStmt = () => db.prepare(`
  INSERT INTO stripe_products (id, name, description, active, metadata, created, updated, synced_at)
  VALUES (@id, @name, @description, @active, @metadata, @created, @updated, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, active=excluded.active,
    metadata=excluded.metadata, created=excluded.created, updated=excluded.updated, synced_at=excluded.synced_at
`)
const upsertPriceStmt = () => db.prepare(`
  INSERT INTO stripe_prices (id, product_id, currency, unit_amount, interval, interval_count, active, nickname, tax_behavior, created, synced_at)
  VALUES (@id, @product_id, @currency, @unit_amount, @interval, @interval_count, @active, @nickname, @tax_behavior, @created, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  ON CONFLICT(id) DO UPDATE SET product_id=excluded.product_id, currency=excluded.currency, unit_amount=excluded.unit_amount,
    interval=excluded.interval, interval_count=excluded.interval_count, active=excluded.active, nickname=excluded.nickname,
    tax_behavior=excluded.tax_behavior, created=excluded.created, synced_at=excluded.synced_at
`)

const productRow = p => ({
  id: p.id, name: p.name || '', description: p.description || null, active: p.active ? 1 : 0,
  metadata: JSON.stringify(p.metadata || {}), created: p.created || null, updated: p.updated || null,
})
const priceRow = p => ({
  id: p.id, product_id: typeof p.product === 'string' ? p.product : p.product?.id,
  currency: p.currency, unit_amount: p.unit_amount ?? null,
  interval: p.recurring?.interval || null, interval_count: p.recurring?.interval_count || null,
  active: p.active ? 1 : 0, nickname: p.nickname || null, tax_behavior: p.tax_behavior || null, created: p.created || null,
})

export function saveProduct(p) { upsertProductStmt().run(productRow(p)) }
export function savePrice(p) { upsertPriceStmt().run(priceRow(p)) }

let syncing = null
/** Relit tous les produits et prix Stripe. Un seul passage à la fois. */
export function syncStripeCatalog(stripe) {
  if (syncing) return syncing
  syncing = (async () => {
    const products = [], prices = []
    for await (const p of stripe.products.list({ limit: 100 })) products.push(p)
    for await (const p of stripe.prices.list({ limit: 100 })) prices.push(p)
    db.transaction(() => {
      for (const p of products) saveProduct(p)
      for (const p of prices) savePrice(p)
    })()
    // Première passe : les produits Stripe existants entrent comme « Anciens forfaits ».
    const first = !db.prepare("SELECT 1 FROM connector_config WHERE connector='stripe' AND key='catalog_legacy_adopted'").get()
    reconcileOffers({ legacy: first })
    if (first) db.prepare("INSERT INTO connector_config (connector, key, value) VALUES ('stripe', 'catalog_legacy_adopted', strftime('%Y-%m-%dT%H:%M:%fZ','now'))").run()
    await ensureOfferLanguages(stripe)
    // Nouveaux doublons d'un produit du catalogue (même nom) : rattachés.
    await attachStripeHistory(stripe, { fetchUnlisted: false })
    db.prepare("INSERT INTO connector_config (connector, key, value) VALUES ('stripe', 'catalog_synced_at', strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(connector, key) DO UPDATE SET value=excluded.value").run()
    return { products: products.length, prices: prices.length }
  })().finally(() => { syncing = null })
  return syncing
}

export function catalogSyncedAt() {
  return db.prepare("SELECT value FROM connector_config WHERE connector='stripe' AND key='catalog_synced_at'").get()?.value || null
}

export function listCatalog() {
  const products = db.prepare('SELECT * FROM stripe_products ORDER BY active DESC, name COLLATE NOCASE').all()
  const prices = db.prepare('SELECT * FROM stripe_prices WHERE active=1 ORDER BY currency, unit_amount').all()
  const byProduct = new Map()
  for (const p of prices) {
    if (!byProduct.has(p.product_id)) byProduct.set(p.product_id, [])
    byProduct.get(p.product_id).push(p)
  }
  return products.map(p => ({ ...p, prices: byProduct.get(p.id) || [] }))
}

export function getCatalogProduct(id) {
  const p = db.prepare('SELECT * FROM stripe_products WHERE id=?').get(id)
  if (!p) return null
  const prices = db.prepare('SELECT * FROM stripe_prices WHERE product_id=? ORDER BY active DESC, created DESC').all(id)
  return { ...p, prices }
}

const INTERVALS = new Set(['month', 'year', 'week', 'day'])

export async function createCatalogProduct(stripe, { name, description }) {
  const n = String(name || '').trim()
  if (!n) throw Object.assign(new Error('Nom requis'), { status: 400 })
  const p = await stripe.products.create({ name: n.slice(0, 250), ...(description ? { description: String(description).slice(0, 1000) } : {}) })
  saveProduct(p)
  return getCatalogProduct(p.id)
}

export async function updateCatalogProduct(stripe, id, patch) {
  const body = {}
  if ('name' in patch) {
    const n = String(patch.name || '').trim()
    if (!n) throw Object.assign(new Error('Nom requis'), { status: 400 })
    body.name = n.slice(0, 250)
  }
  // Chaîne vide : Stripe efface la description.
  if ('description' in patch) body.description = String(patch.description || '').slice(0, 1000) || ''
  if ('active' in patch) body.active = !!patch.active
  const p = await stripe.products.update(id, body)
  saveProduct(p)
  return getCatalogProduct(id)
}

/** Nouveau prix : montant (en dollars), devise cad|usd, intervalle month|year|… ou null (paiement unique). */
export async function createCatalogPrice(stripe, productId, { amount, currency, interval }) {
  const cents = Math.round(Number(amount) * 100)
  if (!Number.isFinite(cents) || cents < 0) throw Object.assign(new Error('Montant invalide'), { status: 400 })
  const cur = String(currency || '').toLowerCase()
  if (!['cad', 'usd'].includes(cur)) throw Object.assign(new Error('Devise invalide'), { status: 400 })
  const iv = interval && INTERVALS.has(interval) ? interval : null
  const p = await stripe.prices.create({
    product: productId, currency: cur, unit_amount: cents,
    // Comme les prix existants : taxes ajoutées en sus.
    tax_behavior: 'exclusive',
    ...(iv ? { recurring: { interval: iv } } : {}),
  })
  savePrice(p)
  return getCatalogProduct(productId)
}

export async function setCatalogPriceActive(stripe, priceId, active) {
  const p = await stripe.prices.update(priceId, { active: !!active })
  savePrice(p)
  return getCatalogProduct(priceRow(p).product_id)
}

// ── Produits de soumission (table products) reliés à leur produit Stripe.
// Les 4 prix de la fiche (achat CAD/USD, mensuel CAD/USD) sont la source :
// « pousser » crée dans Stripe chaque prix manquant. Rien n'est archivé
// d'office (un prix archivé ne se vend plus, même à un abonné qui l'a déjà).

// Tout produit vendable : services (catalogue seulement) et équipements vendus
// en soumission (aussi dans Pièces/Produits, où vit leur stock).
export const OFFER_WHERE = "is_sellable=1 AND active=1 AND deleted_at IS NULL"
const SERVICE_SQL = "(type IS NULL OR type='' OR type='Service')"
const OFFER_PRICE_FIELDS = [
  ['price_cad', 'cad', null], ['price_usd', 'usd', null],
  ['monthly_price_cad', 'cad', 'month'], ['monthly_price_usd', 'usd', 'month'],
]

// Langues du catalogue : chacune a son produit Stripe (nom de la fiche dans
// cette langue, repli sur le français).
export const OFFER_LANGS = [['fr', 'name_fr'], ['en', 'name_en']]

const linksOf = productId => db.prepare(`SELECT l.lang, l.stripe_product_id AS id, sp.name, sp.active
  FROM product_stripe_products l LEFT JOIN stripe_products sp ON sp.id = l.stripe_product_id
  WHERE l.product_id=? ORDER BY CASE l.lang WHEN 'fr' THEN 0 ELSE 1 END, l.lang`).all(productId)

/** Produit Stripe d'un produit du catalogue pour une langue (repli : lien principal). */
export function stripeProductFor(productId, lang) {
  if (!productId) return null
  return db.prepare('SELECT stripe_product_id FROM product_stripe_products WHERE product_id=? AND lang=?').pluck().get(productId, lang)
    || db.prepare('SELECT stripe_product_id FROM products WHERE id=?').pluck().get(productId) || null
}

/** Tous les produits Stripe (toutes langues) du même produit que `stripeProductId`. */
export function siblingStripeProducts(stripeProductId) {
  const pid = db.prepare('SELECT product_id FROM product_stripe_products WHERE stripe_product_id=?').pluck().get(stripeProductId)
    || db.prepare('SELECT product_id FROM product_stripe_aliases WHERE stripe_product_id=?').pluck().get(stripeProductId)
  return pid ? allStripeIdsOf(pid) : [stripeProductId]
}

/** Tous les produits Stripe d'un produit du catalogue : langues + anciens. */
export function allStripeIdsOf(productId) {
  return [
    ...db.prepare('SELECT stripe_product_id FROM product_stripe_products WHERE product_id=?').pluck().all(productId),
    ...db.prepare('SELECT stripe_product_id FROM product_stripe_aliases WHERE product_id=?').pluck().all(productId),
  ]
}

// Lien principal (products.stripe_product_id) : le français, sinon le premier.
function syncPrimary(productId) {
  const primary = linksOf(productId)[0]?.id || null
  db.prepare("UPDATE products SET stripe_product_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(primary, productId)
}

function setLink(productId, lang, stripeProductId) {
  db.prepare('INSERT INTO product_stripe_products (product_id, lang, stripe_product_id) VALUES (?,?,?) ON CONFLICT(product_id, lang) DO UPDATE SET stripe_product_id=excluded.stripe_product_id')
    .run(productId, lang, stripeProductId)
  syncPrimary(productId)
}

export function getOffer(id) {
  const o = db.prepare(`SELECT id, sku, name_fr, name_en, price_cad, price_usd, monthly_price_cad, monthly_price_usd, stripe_product_id, offer_legacy, active
    FROM products WHERE id=?`).get(id)
  if (!o) return null
  const links = linksOf(id)
  const prices = links.flatMap(l => db.prepare('SELECT * FROM stripe_prices WHERE product_id=? ORDER BY active DESC, created DESC').all(l.id)
    .map(p => ({ ...p, lang: l.lang })))
  const aliases = db.prepare(`SELECT a.stripe_product_id AS id, sp.name, sp.active FROM product_stripe_aliases a
    LEFT JOIN stripe_products sp ON sp.id = a.stripe_product_id WHERE a.product_id=? ORDER BY sp.created`).all(id)
  return { ...o, stripe_products: links, stripe_prices: prices, stripe_aliases: aliases, sales: salesOf(id) }
}

/** Ventes facturées par Stripe, tous produits Stripe confondus (langues + anciens). */
function salesOf(productId) {
  const ids = allStripeIdsOf(productId)
  if (!ids.length) return { lines: 0, totals: [], first: null, last: null }
  const ph = ids.map(() => '?').join(',')
  const where = `(stripe_product_id IN (${ph}) OR product_id = ?) AND COALESCE(amount, 0) > 0`
  const one = db.prepare(`SELECT COUNT(*) AS lines, MIN(COALESCE(period_start, created_at)) AS first,
    MAX(COALESCE(period_start, created_at)) AS last FROM stripe_invoice_items WHERE ${where}`).get(...ids, productId)
  const totals = db.prepare(`SELECT upper(currency) AS currency, SUM(amount) / 100.0 AS amount
    FROM stripe_invoice_items WHERE ${where} GROUP BY upper(currency)`).all(...ids, productId)
  return { ...one, totals }
}

/**
 * Rattache aux produits du catalogue leurs anciens produits Stripe : même nom
 * (FR ou EN) ou créé pour ce produit (metadata erp_product_id). Une ancienne
 * fiche « Ancien forfait » qui n'était que ce doublon est fusionnée (supprimée).
 * Les produits créés à la volée, absents des listes Stripe, sont lus un à un
 * depuis les lignes de facture et les abonnements.
 */
export async function attachStripeHistory(stripe, { fetchUnlisted = true } = {}) {
  const offers = db.prepare(`SELECT id, name_fr, name_en FROM products WHERE ${OFFER_WHERE} AND COALESCE(offer_legacy,0)=0`).all()
  const byName = new Map()
  for (const o of offers) for (const n of [o.name_fr, o.name_en]) if (n) byName.set(n.trim().toLowerCase(), o.id)
  const offerIds = new Set(offers.map(o => o.id))
  const taken = id => db.prepare('SELECT 1 FROM product_stripe_products WHERE stripe_product_id=? UNION SELECT 1 FROM product_stripe_aliases WHERE stripe_product_id=?').get(id, id)

  // Candidats : tout produit Stripe connu + ceux des factures/abonnements jamais listés.
  const known = new Map(db.prepare('SELECT id, name, metadata FROM stripe_products').all().map(p => [p.id, p]))
  const seen = new Set(db.prepare("SELECT DISTINCT stripe_product_id FROM stripe_invoice_items WHERE stripe_product_id IS NOT NULL").pluck().all())
  for (const r of db.prepare('SELECT items_json FROM subscription_current_items').all()) {
    try { for (const it of JSON.parse(r.items_json) || []) if (it.stripe_product_id) seen.add(it.stripe_product_id) } catch { /* ligne illisible */ }
  }
  const fetched = new Map()
  for (const id of seen) {
    if (!fetchUnlisted || known.has(id) || taken(id)) continue
    try { fetched.set(id, await stripe.products.retrieve(id)) } catch { /* supprimé chez Stripe */ }
  }

  const attach = db.prepare('INSERT OR IGNORE INTO product_stripe_aliases (stripe_product_id, product_id) VALUES (?, ?)')
  let attached = 0, merged = 0
  const target = (name, metadata) => {
    let meta = {}
    try { meta = typeof metadata === 'string' ? JSON.parse(metadata || '{}') : (metadata || {}) } catch { /* rien */ }
    if (meta.erp_product_id && offerIds.has(meta.erp_product_id)) return meta.erp_product_id
    return byName.get(String(name || '').trim().toLowerCase()) || null
  }
  for (const p of known.values()) {
    if (db.prepare('SELECT 1 FROM product_stripe_aliases WHERE stripe_product_id=?').get(p.id)) continue
    const pid = target(p.name, p.metadata)
    if (!pid) continue
    const link = db.prepare('SELECT product_id FROM product_stripe_products WHERE stripe_product_id=?').get(p.id)
    if (link?.product_id === pid) continue
    if (link) {
      // Fiche « Ancien forfait » faite de ce seul doublon : fusionnée dans le produit.
      const legacy = db.prepare('SELECT offer_legacy FROM products WHERE id=?').get(link.product_id)
      const others = db.prepare('SELECT COUNT(*) FROM product_stripe_products WHERE product_id=?').pluck().get(link.product_id)
      if (!legacy?.offer_legacy || others > 1 || offerIds.has(link.product_id)) continue
      db.prepare('DELETE FROM product_stripe_products WHERE stripe_product_id=?').run(p.id)
      db.prepare("UPDATE products SET active=0, stripe_product_id=NULL, deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(link.product_id)
      merged++
    }
    attach.run(p.id, pid)
    attached++
  }
  for (const [id, p] of fetched) {
    const pid = target(p.name, p.metadata)
    if (!pid) continue
    saveProduct(p)
    attach.run(id, pid)
    attached++
  }
  return { attached, merged, fetched: fetched.size }
}

export function listOffers() {
  const ids = db.prepare(`SELECT id FROM products WHERE ${OFFER_WHERE} ORDER BY COALESCE(offer_legacy,0), sku IS NULL, sku, name_fr`).pluck().all()
  return ids.map(getOffer)
}

/** Produits Stripe actifs qu'aucun produit du catalogue ne porte. */
export function listUnlinked() {
  return listCatalog().filter(p => p.active && !isInline(p)
    && !db.prepare('SELECT 1 FROM product_stripe_products WHERE stripe_product_id=? UNION SELECT 1 FROM product_stripe_aliases WHERE stripe_product_id=?').get(p.id, p.id))
}

// Produit créé à la volée pour une ligne de soumission sans produit du catalogue.
const isInline = p => { try { return JSON.parse(p.metadata || '{}').erp_inline === '1' } catch { return false } }

async function createStripeProductFor(stripe, o, lang, nameField) {
  const p = await stripe.products.create({
    name: String(o[nameField] || o.name_fr || o.sku || 'Produit').slice(0, 250),
    metadata: { erp_product_id: o.id, lang, ...(o.sku ? { sku: o.sku } : {}) },
  })
  saveProduct(p)
  setLink(o.id, lang, p.id)
}

/**
 * Produits proposés en soumission déjà reliés : chaque langue manquante reçoit
 * son produit Stripe (et ses prix). Les anciens forfaits restent tels quels.
 */
export async function ensureOfferLanguages(stripe) {
  let created = 0
  const ids = db.prepare(`SELECT id FROM products WHERE ${OFFER_WHERE} AND COALESCE(offer_legacy,0)=0
    AND EXISTS (SELECT 1 FROM product_stripe_products l WHERE l.product_id = products.id)`).pluck().all()
  for (const id of ids) {
    const o = getOffer(id)
    const have = new Set(o.stripe_products.map(l => l.lang))
    let added = false
    for (const [lang, field] of OFFER_LANGS) {
      if (have.has(lang)) continue
      await createStripeProductFor(stripe, o, lang, field)
      created++
      added = true
    }
    if (added) await pushOfferPrices(stripe, id)
  }
  return created
}

/**
 * Catalogue = produits Stripe (deux faces d'un même objet) : tout produit
 * Stripe actif sans fiche en reçoit une, et l'archivage côté Stripe archive
 * la fiche. legacy = fiches marquées « Ancien forfait » (reprise initiale).
 */
export function reconcileOffers({ legacy = false } = {}) {
  let adopted = 0
  for (const p of listUnlinked()) {
    const id = newRecordId()
    adoptStripeProduct(p.id, id)
    if (legacy) db.prepare('UPDATE products SET offer_legacy=1 WHERE id=?').run(id)
    adopted++
  }
  ensureOfferSkus()
  // Archivé dans Stripe : un service s'archive ; un équipement quitte le
  // catalogue (is_sellable=0) mais reste en inventaire.
  db.prepare(`UPDATE products SET active = (SELECT sp.active FROM stripe_products sp WHERE sp.id = products.stripe_product_id),
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE stripe_product_id IS NOT NULL AND is_sellable=1 AND ${SERVICE_SQL}
      AND active IS NOT (SELECT sp.active FROM stripe_products sp WHERE sp.id = products.stripe_product_id)`).run()
  db.prepare(`UPDATE products SET is_sellable=0, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE stripe_product_id IS NOT NULL AND is_sellable=1 AND NOT ${SERVICE_SQL}
      AND (SELECT sp.active FROM stripe_products sp WHERE sp.id = products.stripe_product_id) = 0`).run()
  return adopted
}

/** Tout produit du catalogue a un SKU : SVC-### suivant, par ordre de création. */
export function ensureOfferSkus() {
  const missing = db.prepare(`SELECT id FROM products WHERE ${OFFER_WHERE} AND ${SERVICE_SQL} AND (sku IS NULL OR trim(sku)='') ORDER BY created_at, rowid`).pluck().all()
  if (!missing.length) return 0
  let n = db.prepare("SELECT MAX(CAST(substr(sku, 5) AS INTEGER)) FROM products WHERE sku LIKE 'SVC-%'").pluck().get() || 0
  const set = db.prepare("UPDATE products SET sku=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
  db.transaction(() => { for (const id of missing) set.run(`SVC-${String(++n).padStart(3, '0')}`, id) })()
  return missing.length
}

/** Archive (ou réactive) un produit : dans Stripe et sa fiche. */
export async function setOfferActive(stripe, productId, active) {
  const o = getOffer(productId)
  if (!o) throw Object.assign(new Error('Produit introuvable'), { status: 404 })
  for (const l of o.stripe_products) saveProduct(await stripe.products.update(l.id, { active: !!active }))
  const service = db.prepare(`SELECT 1 FROM products WHERE id=? AND ${SERVICE_SQL}`).get(productId)
  // Équipement : il quitte le catalogue, pas l'inventaire.
  db.prepare(`UPDATE products SET ${service ? 'active' : 'is_sellable'}=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(active ? 1 : 0, productId)
  return getOffer(productId)
}

/** Crée dans Stripe chaque prix de la fiche qui n'y a pas d'équivalent actif. */
export async function pushOfferPrices(stripe, productId) {
  const o = getOffer(productId)
  if (!o) return o
  for (const link of o.stripe_products) {
    for (const [field, currency, interval] of OFFER_PRICE_FIELDS) {
      const cents = Math.round((Number(o[field]) || 0) * 100)
      if (cents <= 0) continue
      const exists = o.stripe_prices.some(p => p.product_id === link.id && p.active && p.currency === currency
        && p.unit_amount === cents && (p.interval || null) === interval)
      if (exists) continue
      const p = await stripe.prices.create({
        product: link.id, currency, unit_amount: cents, tax_behavior: 'exclusive',
        ...(interval ? { recurring: { interval } } : {}),
      })
      savePrice(p)
    }
  }
  return getOffer(productId)
}

/**
 * Relie un produit Stripe existant (langue devinée par son nom, ou `lang`),
 * crée les produits Stripe de toutes les langues (`create`), ou délie tout
 * (`stripe_product_id: null`).
 */
export async function linkOffer(stripe, productId, { stripe_product_id: spId, create, lang }) {
  const o = getOffer(productId)
  if (!o) throw Object.assign(new Error('Produit introuvable'), { status: 404 })
  if (create) {
    const have = new Set(o.stripe_products.map(l => l.lang))
    for (const [lg, field] of OFFER_LANGS) if (!have.has(lg)) await createStripeProductFor(stripe, o, lg, field)
    return pushOfferPrices(stripe, productId)
  }
  if (!spId) {
    db.prepare('DELETE FROM product_stripe_products WHERE product_id=?').run(productId)
    syncPrimary(productId)
    return getOffer(productId)
  }
  if (db.prepare('SELECT 1 FROM product_stripe_products WHERE stripe_product_id=? AND product_id<>?').get(spId, productId)) {
    throw Object.assign(new Error('Ce produit Stripe est déjà relié à un autre produit'), { status: 409 })
  }
  const name = db.prepare('SELECT name FROM stripe_products WHERE id=?').pluck().get(spId) || ''
  const guess = OFFER_LANGS.find(([, f]) => o[f] && o[f].trim().toLowerCase() === name.trim().toLowerCase())?.[0]
  setLink(productId, lang || guess || 'fr', spId)
  return pushOfferPrices(stripe, productId)
}

/** Produit Stripe non relié → nouveau produit de soumission, prix importés. */
export function adoptStripeProduct(stripeProductId, newId) {
  const sp = getCatalogProduct(stripeProductId)
  if (!sp) throw Object.assign(new Error('Produit Stripe introuvable'), { status: 404 })
  if (db.prepare('SELECT 1 FROM product_stripe_products WHERE stripe_product_id=?').get(sp.id)) {
    throw Object.assign(new Error('Déjà au catalogue'), { status: 409 })
  }
  const pick = (currency, interval) => sp.prices.find(p => p.active && p.currency === currency && (p.interval || null) === interval)
  const amount = (c, i) => (pick(c, i)?.unit_amount || 0) / 100
  db.prepare(`INSERT INTO products (id, name_fr, type, is_sellable, stripe_product_id, price_cad, price_usd, monthly_price_cad, monthly_price_usd)
    VALUES (?, ?, 'Service', 1, ?, ?, ?, ?, ?)`)
    .run(newId, sp.name || 'Produit', sp.id, amount('cad', null), amount('usd', null), amount('cad', 'month'), amount('usd', 'month'))
  setLink(newId, 'fr', sp.id)
  return getOffer(newId)
}
