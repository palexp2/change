import { randomUUID } from 'crypto'
import path from 'path'
import fs from 'fs'
import db from './../db/database.js'
import { emitEntity } from './realtimeEmitters.js'
import { logSync } from './syncLog.js'
import {
  getConfig, isDigikeyConfigured, digikeyGet, digikeyGetBinary,
} from '../connectors/digikey.js'

// ── Sync des commandes DigiKey ────────────────────────────────────────────────
// Interroge périodiquement l'Order History / Order Details de DigiKey, crée (ou
// met à jour) la facture fournisseur correspondante dans `achats_fournisseurs`
// et télécharge le PDF de facture sous uploads/factures/digikey/.
//
// Choix structurants :
//  • L'achat est créé en **Brouillon** : rien n'entre dans les livres sans un
//    clic explicite sur « Publier vers QuickBooks » depuis la fiche de l'achat.
//  • La dédup est portée par `digikey_orders` (clé = numéro de facture DigiKey,
//    à défaut le numéro de commande) ; un achat déjà publié à QB (quickbooks_id)
//    n'est jamais réécrit par la sync.
//  • Le PDF est rattaché à l'achat via la table générique `attachments` — il
//    apparaît donc dans la fiche de l'achat sans code d'affichage dédié.
//  • Sens unique : aucune écriture vers DigiKey.
//
// Les formes de réponse de DigiKey ont déjà bougé (OrderDetails v3 en PascalCase
// → OrderStatus v4 en camelCase). Toute lecture passe donc par `pick()`, qui
// essaie plusieurs noms de champ, et la réponse brute est conservée dans
// `digikey_orders.raw` pour pouvoir calibrer au premier vrai passage.

const UPLOADS_ROOT = path.resolve(process.cwd(), process.env.UPLOADS_PATH || 'uploads')
const FACTURES_DIR = path.join(UPLOADS_ROOT, 'factures', 'digikey')
const REL_DIR = 'factures/digikey' // chemin relatif à uploads/, convention CLAUDE.md

// ── Lecture tolérante des réponses ──────────────────────────────────────────

/** Premier champ non vide parmi `names`, insensible à la casse. */
export function pick(obj, names) {
  if (!obj || typeof obj !== 'object') return undefined
  const lower = new Map(Object.keys(obj).map(k => [k.toLowerCase(), k]))
  for (const n of names) {
    const key = lower.get(n.toLowerCase())
    if (key === undefined) continue
    const v = obj[key]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}

const num = v => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Premier tableau non vide parmi `names`. */
function pickArray(obj, names) {
  const v = pick(obj, names)
  return Array.isArray(v) ? v : []
}

/** ISO date-only (YYYY-MM-DD) à partir de ce que DigiKey renvoie. */
export function toDateOnly(value) {
  if (!value) return null
  const s = String(value)
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/)
  if (m) return m[1]
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

/**
 * Parcours en profondeur pour ramasser tous les numéros de facture, quel que
 * soit l'endroit où DigiKey les niche (racine, shippingDetails[], invoices[]…).
 */
export function collectInvoiceIds(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const el of node) collectInvoiceIds(el, out)
    return out
  }
  for (const [k, v] of Object.entries(node)) {
    if (/^invoice(id|number|no)$/i.test(k) && (typeof v === 'string' || typeof v === 'number')) {
      const id = String(v).trim()
      if (id && id !== '0' && !out.includes(id)) out.push(id)
    } else if (v && typeof v === 'object') {
      collectInvoiceIds(v, out)
    }
  }
  return out
}

/** Lignes d'articles normalisées, format attendu par `achats_fournisseurs.lines`. */
export function normalizeLines(raw) {
  const items = pickArray(raw, ['lineItems', 'LineItems', 'items', 'Items', 'orderLines', 'lines'])
  return items.map(it => {
    const qty = num(pick(it, ['quantityOrdered', 'quantity', 'quantityTotal', 'quantityShipped']))
    const unit = num(pick(it, ['unitPrice', 'unitCost', 'price']))
    const partNumber = pick(it, ['digiKeyPartNumber', 'digiKeyProductNumber', 'partNumber', 'manufacturerPartNumber'])
    const desc = pick(it, ['description', 'productDescription', 'detailedDescription'])
    const total = pick(it, ['totalPrice', 'extendedPrice', 'amount'])
    return {
      description: [partNumber, desc].filter(Boolean).join(' — ') || 'Article DigiKey',
      item_name: partNumber ? String(partNumber) : null,
      quantity: qty || null,
      unit_price: unit || null,
      amount: total !== undefined ? num(total) : Number((qty * unit).toFixed(2)),
    }
  })
}

/**
 * Normalise une commande DigiKey (résumé d'historique ou détail complet) en une
 * forme stable. `subtotal` est le total des produits, `total` le montant réellement
 * facturé (produits + transport + taxes).
 */
export function normalizeOrder(raw) {
  const salesOrderId = pick(raw, ['salesOrderId', 'salesorderId', 'SalesOrderId', 'salesOrderNumber', 'orderNumber'])
  const subtotal = num(pick(raw, ['subTotal', 'subtotal', 'totalProductPrice', 'totalPrice', 'orderSubTotal']))
  const tax = num(pick(raw, ['salesTax', 'tax', 'totalTax', 'taxAmount']))
  const shipping = num(pick(raw, ['freight', 'totalShipping', 'shippingCost', 'shippingAmount']))
  const declaredTotal = pick(raw, ['orderTotal', 'totalAmount', 'invoiceTotal', 'grandTotal'])
  const lines = normalizeLines(raw)

  const total = declaredTotal !== undefined
    ? num(declaredTotal)
    : Number((subtotal + shipping + tax).toFixed(2))

  return {
    salesOrderId: salesOrderId != null ? String(salesOrderId) : null,
    purchaseOrder: pick(raw, ['purchaseOrder', 'customerPurchaseOrder', 'purchaseOrderNumber', 'poNumber']) || null,
    orderDate: toDateOnly(pick(raw, ['dateEntered', 'orderDate', 'dateOrdered', 'createdDate'])),
    currency: String(pick(raw, ['currencyCode', 'currency']) || '').toUpperCase() || null,
    subtotal, tax, shipping, total,
    invoiceIds: collectInvoiceIds(raw),
    lines,
  }
}

/**
 * Champs d'`achats_fournisseurs` pour une commande DigiKey.
 * `amount_cad` = base hors taxes (produits + transport) pour que
 * amount + tax = total, invariant respecté par toute la comptabilité de l'ERP.
 */
export function buildAchatFields(order, { vendorName = 'DigiKey', currency = 'CAD', invoiceId = null } = {}) {
  const total = Number((order.total || 0).toFixed(2))
  const tax = Number((order.tax || 0).toFixed(2))
  const amount = Number((total - tax).toFixed(2))
  const label = invoiceId ? `facture ${invoiceId}` : `commande ${order.salesOrderId}`
  return {
    type: 'bill',
    date_achat: order.orderDate || new Date().toISOString().slice(0, 10),
    vendor: vendorName,
    vendor_invoice_number: invoiceId || (order.salesOrderId ? String(order.salesOrderId) : null),
    reference: order.salesOrderId ? `DigiKey ${order.salesOrderId}` : null,
    description: [`DigiKey — ${label}`, order.purchaseOrder ? `BC ${order.purchaseOrder}` : null]
      .filter(Boolean).join(' · '),
    amount_cad: amount >= 0 ? amount : 0,
    tax_cad: tax >= 0 ? tax : 0,
    total_cad: total >= 0 ? total : 0,
    currency: order.currency || currency || 'CAD',
    status: 'Brouillon',
    lines: order.lines.length ? JSON.stringify(order.lines) : null,
  }
}

// ── Persistance ─────────────────────────────────────────────────────────────

/** Fournisseur DigiKey côté `companies` (pour vendor_id), sans jamais en créer un doublon. */
function findVendorId(vendorName) {
  const row = db.prepare(
    "SELECT id FROM companies WHERE LOWER(REPLACE(TRIM(name), '-', '')) = LOWER(REPLACE(TRIM(?), '-', '')) LIMIT 1"
  ).get(vendorName)
  return row?.id || null
}

function upsertAchat(fields, existingAchatId, userId) {
  const vendorId = findVendorId(fields.vendor)

  if (existingAchatId) {
    const existing = db.prepare('SELECT id, quickbooks_id FROM achats_fournisseurs WHERE id = ?').get(existingAchatId)
    if (existing) {
      // Achat déjà publié dans QuickBooks : intouchable, la comptabilité fait foi.
      if (existing.quickbooks_id) return { id: existing.id, action: 'skipped_published' }
      db.prepare(`
        UPDATE achats_fournisseurs
        SET date_achat=?, vendor=?, vendor_id=COALESCE(?, vendor_id), vendor_invoice_number=?,
            reference=?, description=?, amount_cad=?, tax_cad=?, total_cad=?, currency=?, lines=?,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
      `).run(
        fields.date_achat, fields.vendor, vendorId, fields.vendor_invoice_number,
        fields.reference, fields.description, fields.amount_cad, fields.tax_cad,
        fields.total_cad, fields.currency, fields.lines, existing.id
      )
      const updated = db.prepare('SELECT * FROM achats_fournisseurs WHERE id = ?').get(existing.id)
      emitEntity('achat_fournisseur', 'updated', existing.id, updated, userId)
      return { id: existing.id, action: 'updated' }
    }
  }

  // Même facture déjà saisie autrement (courriel, collecte de portail, import QB) :
  // on se rattache à elle plutôt que de créer un doublon comptable.
  if (fields.vendor_invoice_number) {
    const dup = db.prepare(`
      SELECT id FROM achats_fournisseurs
      WHERE vendor_invoice_number = ? AND LOWER(TRIM(vendor)) = LOWER(TRIM(?))
      LIMIT 1
    `).get(fields.vendor_invoice_number, fields.vendor)
    if (dup) return { id: dup.id, action: 'linked_existing' }
  }

  const id = randomUUID()
  db.prepare(`
    INSERT INTO achats_fournisseurs
      (id, type, date_achat, vendor, vendor_id, vendor_invoice_number, reference, description,
       amount_cad, tax_cad, total_cad, currency, status, lines, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, fields.type, fields.date_achat, fields.vendor, vendorId, fields.vendor_invoice_number,
    fields.reference, fields.description, fields.amount_cad, fields.tax_cad, fields.total_cad,
    fields.currency, fields.status, fields.lines, userId
  )
  const created = db.prepare('SELECT * FROM achats_fournisseurs WHERE id = ?').get(id)
  emitEntity('achat_fournisseur', 'created', id, created, userId)
  return { id, action: 'created' }
}

/** Écrit le PDF sous uploads/factures/digikey/ et le rattache à l'achat. */
function storeInvoicePdf({ buffer, invoiceKey, achatId, userId }) {
  fs.mkdirSync(FACTURES_DIR, { recursive: true })
  const fileName = `digikey-${String(invoiceKey).replace(/[^A-Za-z0-9_-]/g, '_')}.pdf`
  const relPath = `${REL_DIR}/${fileName}`
  fs.writeFileSync(path.join(FACTURES_DIR, fileName), buffer)

  const already = db.prepare(`
    SELECT id FROM attachments
    WHERE entity_type='achats_fournisseurs' AND entity_id=? AND file_path=? AND deleted_at IS NULL
  `).get(achatId, relPath)
  if (!already) {
    db.prepare(`
      INSERT INTO attachments (id, entity_type, entity_id, file_name, content_type, file_size, file_path, uploaded_by)
      VALUES (?, 'achats_fournisseurs', ?, ?, 'application/pdf', ?, ?, ?)
    `).run(randomUUID(), achatId, fileName, buffer.length, relPath, userId)
  }
  return relPath
}

// ── Appels API ──────────────────────────────────────────────────────────────

function fillPath(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vars[k] ?? ''))
}

async function fetchHistory(cfg, { startDate, endDate }) {
  const qs = new URLSearchParams({ startDate, endDate })
  const raw = await digikeyGet(`${cfg.history_path}?${qs}`)
  const summaries = pickArray(raw, ['orderSummaries', 'OrderSummaries', 'salesOrders', 'orders', 'data'])
  return summaries.length ? summaries : (Array.isArray(raw) ? raw : [])
}

async function fetchOrderDetails(cfg, salesOrderId) {
  return digikeyGet(fillPath(cfg.salesorder_path, { salesOrderId }))
}

/** PDF de facture. `null` si DigiKey ne renvoie pas un PDF (pas encore facturée). */
async function fetchInvoicePdf(cfg, { salesOrderId, invoiceId }) {
  const { buffer, contentType } = await digikeyGetBinary(
    fillPath(cfg.invoice_path, { salesOrderId, invoiceId })
  )
  if (!contentType.includes('pdf') && buffer.slice(0, 4).toString() !== '%PDF') return null
  return buffer
}

// ── Point d'entrée ──────────────────────────────────────────────────────────

const AUTOMATION_ID = 'sys_digikey_orders'

/** Réglages métier (fenêtre d'historique, nom du fournisseur) — éditables dans /automations. */
export function automationConfig() {
  const row = db.prepare('SELECT action_config FROM automations WHERE id = ?').get(AUTOMATION_ID)
  let cfg = {}
  try { cfg = JSON.parse(row?.action_config || '{}') } catch {}
  return {
    lookbackDays: Number(cfg.lookback_days) > 0 ? Number(cfg.lookback_days) : 30,
    vendorName: (cfg.vendor_name || '').trim() || 'DigiKey',
  }
}

function importUserId() {
  const email = process.env.DIGIKEY_IMPORT_USER_EMAIL
  if (!email) return null
  return db.prepare('SELECT id FROM users WHERE email=?').get(email)?.id || null
}

/**
 * Sync DigiKey → ERP.
 * @param {{days?:number, trigger?:string, dryRun?:boolean}} opts
 */
export async function syncDigikey({ days, trigger = 'scheduled', dryRun = false } = {}) {
  const t0 = Date.now()
  const cfg = getConfig()
  if (!isDigikeyConfigured()) {
    const error = 'DigiKey non configuré — saisir client_id / client_secret dans Connecteurs'
    logSync('digikey', trigger, { status: 'error', error, durationMs: Date.now() - t0 })
    throw new Error(error)
  }

  const auto = automationConfig()
  const lookback = Number(days) > 0 ? Number(days) : auto.lookbackDays
  const endDate = new Date().toISOString().slice(0, 10)
  const startDate = new Date(Date.now() - lookback * 86400_000).toISOString().slice(0, 10)
  const userId = importUserId()

  const summary = { created: 0, updated: 0, skipped: 0, pdfs: 0, errors: [] }

  try {
    const summaries = await fetchHistory(cfg, { startDate, endDate })

    for (const s of summaries) {
      const head = normalizeOrder(s)
      if (!head.salesOrderId) { summary.skipped++; continue }

      try {
        const detailRaw = await fetchOrderDetails(cfg, head.salesOrderId)
        const order = normalizeOrder(detailRaw)
        order.salesOrderId = order.salesOrderId || head.salesOrderId
        order.orderDate = order.orderDate || head.orderDate
        if (!order.lines.length) order.lines = head.lines
        if (!order.total) { order.total = head.total; order.tax = head.tax }
        if (!order.invoiceIds.length) order.invoiceIds = head.invoiceIds

        const invoiceId = order.invoiceIds[0] || null
        const trackKey = invoiceId || order.salesOrderId

        const existing = db.prepare(
          'SELECT * FROM digikey_orders WHERE track_key = ? AND deleted_at IS NULL'
        ).get(trackKey)

        if (dryRun) {
          if (existing) summary.skipped++
          else summary.created++
          continue
        }

        const fields = buildAchatFields(order, {
          vendorName: auto.vendorName,
          currency: cfg.locale_currency || 'CAD',
          invoiceId,
        })
        const { id: achatId, action } = upsertAchat(fields, existing?.achat_id || null, userId)
        if (action === 'created') summary.created++
        else if (action === 'updated' || action === 'linked_existing') summary.updated++
        else summary.skipped++

        // PDF : téléchargé une seule fois, re-téléchargé si le fichier a disparu.
        let pdfPath = existing?.pdf_path || null
        const pdfMissing = !pdfPath || !fs.existsSync(path.resolve(UPLOADS_ROOT, pdfPath))
        if (invoiceId && pdfMissing) {
          try {
            const buffer = await fetchInvoicePdf(cfg, { salesOrderId: order.salesOrderId, invoiceId })
            if (buffer) {
              pdfPath = storeInvoicePdf({ buffer, invoiceKey: invoiceId, achatId, userId })
              summary.pdfs++
            }
          } catch (e) {
            summary.errors.push(`PDF facture ${invoiceId} : ${e.message}`)
          }
        }

        const rawJson = JSON.stringify(detailRaw).slice(0, 200_000)
        if (existing) {
          db.prepare(`
            UPDATE digikey_orders
            SET sales_order_id=?, invoice_id=?, achat_id=?, pdf_path=?, order_date=?,
                total=?, currency=?, raw=?, synced_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE id=?
          `).run(order.salesOrderId, invoiceId, achatId, pdfPath, order.orderDate,
            order.total, fields.currency, rawJson, existing.id)
        } else {
          db.prepare(`
            INSERT INTO digikey_orders
              (id, track_key, sales_order_id, invoice_id, achat_id, pdf_path, order_date, total, currency, raw)
            VALUES (?,?,?,?,?,?,?,?,?,?)
          `).run(randomUUID(), trackKey, order.salesOrderId, invoiceId, achatId, pdfPath,
            order.orderDate, order.total, fields.currency, rawJson)
        }
      } catch (e) {
        summary.errors.push(`Commande ${head.salesOrderId} : ${e.message}`)
      }
    }

    logSync('digikey', trigger, {
      status: summary.errors.length && !summary.created && !summary.updated ? 'error' : 'success',
      modified: summary.created + summary.updated,
      error: summary.errors.length ? summary.errors.slice(0, 3).join(' · ') : null,
      durationMs: Date.now() - t0,
    })
    return { status: 'success', ...summary, orders: summaries.length, startDate, endDate }
  } catch (e) {
    logSync('digikey', trigger, { status: 'error', error: e.message, durationMs: Date.now() - t0 })
    throw e
  }
}
