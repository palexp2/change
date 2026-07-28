import { randomUUID } from 'crypto'
import { readFileSync, existsSync } from 'fs'
import { join, extname } from 'path'
import db from '../db/database.js'
import { qbGet, qbPost, qbUploadAttachment } from '../connectors/quickbooks.js'
import { getUsdCadRate } from './fx.js'
import { getStripeClient } from './stripeInvoices.js'
import { syncStripePayouts, syncAllPayoutsBalanceTransactions, isStripeConfigured } from './stripe.js'
import { emitCompany, emitEntity } from './realtimeEmitters.js'
import { logSync } from './syncLog.js'
import { validateTaxCodeAgainstType, getTransactionType } from './fiscalStatus.js'

const SALE_RECEIPT_MIME = {
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png':  'image/png',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.pdf':  'application/pdf',
}

// Cutoff : aucune écriture comptable QB ne peut être publiée pour une facture
// dont document_date est antérieur. La compta historique est figée — toute
// correction d'avant cette date passe par QB manuellement. Mis en place suite
// aux doublons du 20 mai 2026 (race condition dans reconcileFacturesForOrder)
// et au constat erroné de factures Stripe annulées datées de 2024-2025.
// Comparaison lexicographique sûre — document_date est stocké en 'YYYY-MM-DD'.
export const QB_FACTURE_DATE_CUTOFF = '2026-05-01'

// bypassCutoff=true : court-circuite la garde du cutoff. Réservé aux écritures
// déclenchées manuellement depuis la fiche facture par un opérateur qui assume
// le posting d'une facture pré-cutoff (bouton « Forcer malgré le cutoff »).
export function assertFactureEligibleForQbWrite(factureRow, { bypassCutoff = false } = {}) {
  if (!factureRow) return
  if (bypassCutoff) return
  const docDate = factureRow.document_date
  if (docDate && docDate < QB_FACTURE_DATE_CUTOFF) {
    const label = factureRow.document_number || factureRow.id
    throw new Error(`Facture #${label} datée du ${docDate} — écriture QB bloquée (cutoff ${QB_FACTURE_DATE_CUTOFF})`)
  }
}

// QB borne DocNumber à 21 caractères (code d'erreur 2050 sinon). Certains numéros
// de reçu/facture externes (Webflow, etc.) dépassent cette limite — on tronque au
// milieu en gardant le début et la fin (tous deux discriminants), séparés par « … ».
// Retourne undefined pour une valeur vide afin de ne pas poser un DocNumber = ''.
export const QB_DOCNUMBER_MAX = 21
export function qbDocNumber(value) {
  const s = (value == null ? '' : String(value)).trim()
  if (!s) return undefined
  if (s.length <= QB_DOCNUMBER_MAX) return s
  const keep = QB_DOCNUMBER_MAX - 1 // 1 caractère réservé au séparateur « … »
  const front = Math.ceil(keep / 2)
  const back = keep - front
  return s.slice(0, front) + '…' + s.slice(-back)
}

function getQBConfig() {
  const rows = db.prepare("SELECT key, value FROM connector_config WHERE connector='quickbooks'").all()
  return Object.fromEntries(rows.map(r => [r.key, r.value]))
}

// Recherche un fournisseur QB par nom, le crée si absent.
// Synchronise aussi avec la table companies (type=Fournisseur).
// Retourne le QB Vendor ID (string).
// Extrait l'Id du conflit d'un message d'erreur QB « Nom en double » (code 6240).
// QB renvoie l'Id de l'entité qui occupe déjà le nom dans le Detail (« … : Id=425 »).
// Retourne null si le message n'est pas un conflit de nom.
export function parseDuplicateNameId(message) {
  if (!/Nom en double|Duplicate Name|"code":"6240"/i.test(message || '')) return null
  const m = /Id=(\d+)/.exec(message || '')
  return m ? m[1] : null
}

// Crée un fournisseur en gérant le conflit de nom (6240). QB impose des DisplayName
// UNIQUES entre Fournisseurs, Clients et Employés. Trois cas au conflit :
//  (a) le nom appartient à un FOURNISSEUR actif que la recherche par nom a raté
//      (accents/espaces) → on le réutilise via l'Id que QB donne dans l'erreur ;
//  (b) le nom appartient à un CLIENT/EMPLOYÉ (ou un fournisseur inactif) → on ne peut
//      pas réutiliser une autre entité comme fournisseur : on crée un fournisseur
//      distinct suffixé « (Fournisseur) ».
async function createVendorHandlingDuplicate(name) {
  try {
    const created = await qbPost('/vendor', { DisplayName: name })
    return created.Vendor.Id
  } catch (e) {
    const dupId = parseDuplicateNameId(e.message)
    if (!dupId) throw e
    // (a) L'Id renvoyé est-il un fournisseur (actif) ? Si oui, on le réutilise.
    try {
      const v = await qbGet(`/vendor/${dupId}`)
      if (v?.Vendor?.Id) return v.Vendor.Id
    } catch { /* pas un fournisseur joignable (client/employé ou inactif) → on suffixe */ }
    // (b) Conflit avec une autre liste de noms → fournisseur distinct suffixé.
    const created = await qbPost('/vendor', { DisplayName: `${name} (Fournisseur)` })
    return created.Vendor.Id
  }
}

export async function findOrCreateVendor(vendorName) {
  // 1. Chercher dans companies par nom pour récupérer un quickbooks_vendor_id déjà connu
  const existing = db.prepare(
    "SELECT id, quickbooks_vendor_id FROM companies WHERE name=? LIMIT 1"
  ).get(vendorName)

  if (existing?.quickbooks_vendor_id) return existing.quickbooks_vendor_id

  // 2. Chercher dans QB — exact, puis LIKE insensible à la casse/aux espaces
  const safe = vendorName.replace(/'/g, "\\'")
  const target = vendorName.trim().toLowerCase()
  let qbVendorId

  const exactQ = new URLSearchParams({ query: `SELECT * FROM Vendor WHERE DisplayName = '${safe}' MAXRESULTS 1` })
  const exact = await qbGet(`/query?${exactQ}`)
  const exactHit = exact.QueryResponse?.Vendor?.[0]
  if (exactHit) {
    qbVendorId = exactHit.Id
  } else {
    const likeQ = new URLSearchParams({ query: `SELECT * FROM Vendor WHERE DisplayName LIKE '${safe}' MAXRESULTS 5` })
    const like = await qbGet(`/query?${likeQ}`)
    const matched = (like.QueryResponse?.Vendor || []).find(v => (v.DisplayName || '').trim().toLowerCase() === target)
    qbVendorId = matched ? matched.Id : await createVendorHandlingDuplicate(vendorName)
  }

  // 3. Mettre à jour ou créer l'entreprise locale
  if (existing) {
    db.prepare("UPDATE companies SET quickbooks_vendor_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?")
      .run(qbVendorId, existing.id)
    emitCompany('updated', existing.id, null)
  } else {
    db.prepare(`
      INSERT OR IGNORE INTO companies (id, name, type, quickbooks_vendor_id)
      VALUES (?, ?, 'Fournisseur', ?)
    `).run(randomUUID(), vendorName, qbVendorId)
  }

  return qbVendorId
}

// ── Dépenses → QB Purchase ────────────────────────────────────────────────────

const PAYMENT_TYPE_MAP = {
  'Carte de crédit': 'CreditCard',
  'Chèque':          'Check',
  'Virement':        'Check',
  'Comptant':        'Cash',
}

// ── Push achat → QB (Purchase ou Bill selon type) ────────────────────────────

async function resolveQBVendor(row) {
  if (row.vendor_id) {
    const company = db.prepare('SELECT quickbooks_vendor_id, name FROM companies WHERE id=?').get(row.vendor_id)
    if (company?.quickbooks_vendor_id) return company.quickbooks_vendor_id
    if (company) return findOrCreateVendor(company.name)
  }
  if (row.vendor) return findOrCreateVendor(row.vendor)
  return null
}

// Erreur de validation portant le champ UI à corriger — le client encadre en
// rouge la section correspondante (expense_account, payment_account, vendor,
// tax_code, transaction_type, currency).
function fieldError(message, field) {
  return Object.assign(new Error(message), { field })
}

export async function pushAchatToQB(achatId) {
  const row = db.prepare('SELECT * FROM achats_fournisseurs WHERE id=?').get(achatId)
  if (!row) throw new Error('Achat introuvable')
  if (row.quickbooks_id) throw new Error(`Déjà publié sur QuickBooks (ID: ${row.quickbooks_id})`)

  const round2 = n => Math.round((Number(n) || 0) * 100) / 100
  const cfg = getQBConfig()

  // Comptes : modèle mémorisé sur l'achat (dernier choix pour ce fournisseur)
  // prioritaire sur la config QB globale.
  const expenseAccountId = row.expense_account_id || cfg.expense_account_id
  if (!expenseAccountId) throw fieldError('Compte de dépense QuickBooks non configuré', 'expense_account')

  // Code de taxe : achats stockent un tax_cad global (pas de split TPS/TVQ), donc on
  // fournit TxnTaxCodeRef + TotalTax sans TaxLine — QB ventile selon les taux du code.
  // Avec GlobalTaxCalculation:'TaxExcluded', la base des lignes doit être HORS taxe
  // (amount_cad) sinon QB rajoute la taxe par-dessus → double comptage. Sans code de
  // taxe, comportement historique conservé : la ligne porte total_cad, aucune taxe QB.
  const applyTax = !!(row.tax_code_id && row.tax_cad > 0)
  const lineBase = applyTax ? round2(row.amount_cad) : row.total_cad
  let taxDetail = {}
  if (applyTax) {
    taxDetail = {
      TxnTaxDetail: { TxnTaxCodeRef: { value: row.tax_code_id }, TotalTax: round2(row.tax_cad) },
      GlobalTaxCalculation: 'TaxExcluded',
    }
  }
  const lineDetail = { AccountRef: { value: expenseAccountId } }
  if (applyTax) lineDetail.TaxCodeRef = { value: row.tax_code_id }

  const persist = (qbId, paymentAccountId) => {
    db.prepare(`
      UPDATE achats_fournisseurs
      SET quickbooks_id=?, expense_account_id=?, payment_account_id=?, tax_code_id=?,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id=?
    `).run(qbId, expenseAccountId || null, paymentAccountId || null, row.tax_code_id || null, achatId)
  }

  if (row.type === 'purchase') {
    const paymentAccountId = row.payment_account_id || cfg.payment_account_id
    if (!paymentAccountId) throw fieldError('Compte de paiement QuickBooks non configuré', 'payment_account')
    const purchase = {
      PaymentType: PAYMENT_TYPE_MAP[row.payment_method] || 'Cash',
      AccountRef: { value: paymentAccountId },
      TxnDate: row.date_achat,
      TotalAmt: row.total_cad,
      Line: [{
        Amount: lineBase,
        DetailType: 'AccountBasedExpenseLineDetail',
        AccountBasedExpenseLineDetail: lineDetail,
        Description: row.description || row.category,
      }],
      ...taxDetail,
    }
    const qbVendorId = await resolveQBVendor(row)
    if (qbVendorId) purchase.EntityRef = { value: qbVendorId, type: 'Vendor' }
    if (row.reference) purchase.DocNumber = qbDocNumber(row.reference)

    const result = await qbPost('/purchase', purchase)
    const qbId = result.Purchase.Id
    persist(qbId, paymentAccountId)
    return qbId
  }

  // type === 'bill'
  const vendorId = await resolveQBVendor(row)
  if (!vendorId) throw fieldError('Fournisseur requis pour une facture', 'vendor')

  const bill = {
    VendorRef: { value: vendorId },
    TxnDate: row.date_achat,
    Line: [{
      Amount: lineBase,
      DetailType: 'AccountBasedExpenseLineDetail',
      AccountBasedExpenseLineDetail: lineDetail,
      Description: row.notes || row.vendor_invoice_number || row.vendor,
    }],
    ...taxDetail,
  }
  if (row.due_date) bill.DueDate = row.due_date
  if (row.vendor_invoice_number) bill.DocNumber = qbDocNumber(row.vendor_invoice_number)

  const result = await qbPost('/bill', bill)
  const qbId = result.Bill.Id
  persist(qbId, null)
  // CTB - Suivi : programme le paiement dans le Google Sheets (fire-and-forget,
  // import dynamique pour éviter le cycle quickbooks → ctbSheet → systemAutomations).
  import('./ctbSheet.js').then(({ appendFactureAPayer }) => appendFactureAPayer({
    vendor: row.vendor, total: row.total_cad, currency: row.currency || 'CAD',
    dueDate: row.due_date || null, source: `achat ${achatId}`,
  })).catch(() => {})
  return qbId
}

export async function syncAllAchatsToQB() {
  const cfg = getQBConfig()
  if (!cfg.expense_account_id) {
    throw new Error('Configurez les comptes QuickBooks avant de synchroniser')
  }
  const rows = db.prepare(
    "SELECT id FROM achats_fournisseurs WHERE quickbooks_id IS NULL AND status NOT IN ('Brouillon','Annulée')"
  ).all()

  let synced = 0
  const errors = []
  for (const { id } of rows) {
    try { await pushAchatToQB(id); synced++ }
    catch (e) { errors.push({ id, error: e.message }); console.error(`QB sync achat ${id}:`, e.message) }
  }
  console.log(`✅ QB achats: ${synced} publiés, ${errors.length} erreurs`)
  return { synced, errors }
}

// ── Import depuis QB → factures_fournisseurs ─────────────────────────────────

// Trouve ou crée une entreprise locale pour un fournisseur QB (sans appel API QB)
function upsertVendorCompany(qbVendorId, vendorName) {
  const byQbId = db.prepare(
    "SELECT id FROM companies WHERE quickbooks_vendor_id=?"
  ).get(qbVendorId)
  if (byQbId) return byQbId.id

  const byName = db.prepare(
    "SELECT id FROM companies WHERE name=? LIMIT 1"
  ).get(vendorName)
  if (byName) {
    db.prepare("UPDATE companies SET quickbooks_vendor_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?")
      .run(qbVendorId, byName.id)
    emitCompany('updated', byName.id, null)
    return byName.id
  }

  const id = randomUUID()
  db.prepare(`
    INSERT INTO companies (id, name, type, quickbooks_vendor_id)
    VALUES (?, ?, 'Fournisseur', ?)
  `).run(id, vendorName, qbVendorId)
  emitCompany('created', id, null)
  return id
}

function extractLines(qbLines) {
  if (!Array.isArray(qbLines)) return null
  const lines = qbLines
    .filter(l => l.DetailType === 'AccountBasedExpenseLineDetail' || l.DetailType === 'ItemBasedExpenseLineDetail')
    .map(l => {
      const acct = l.AccountBasedExpenseLineDetail?.AccountRef
      const item = l.ItemBasedExpenseLineDetail?.ItemRef
      return {
        amount:       l.Amount ?? 0,
        description:  l.Description || null,
        account_id:   acct?.value || null,
        account_name: acct?.name  || null,
        item_id:      item?.value || null,
        item_name:    item?.name  || null,
      }
    })
    .filter(l => l.amount > 0)
  return lines.length ? JSON.stringify(lines) : null
}

function mapBillStatus(bill) {
  const balance = bill.Balance ?? bill.TotalAmt ?? 0
  const total   = bill.TotalAmt ?? 0
  if (balance === 0) return 'Payée'
  if (balance < total) return 'Payée partiellement'
  if (bill.DueDate && new Date(bill.DueDate) < new Date()) return 'En retard'
  return 'Reçue'
}

async function fetchAllQBPages(path, entity) {
  const results = []
  let startPos = 1
  const pageSize = 1000
  while (true) {
    const q = encodeURIComponent(`SELECT * FROM ${entity} MAXRESULTS ${pageSize} STARTPOSITION ${startPos}`)
    const data = await qbGet(`/query?query=${q}`)
    const rows = data.QueryResponse?.[entity] || []
    results.push(...rows)
    if (rows.length < pageSize) break
    startPos += pageSize
  }
  return results
}

// Suppression d'un achat dont la transaction QB a été supprimée — mêmes side
// effects que la route DELETE (hard delete + événement realtime).
function deleteAchatsByQbId(qbId, type) {
  const rows = db.prepare('SELECT id FROM achats_fournisseurs WHERE quickbooks_id = ? AND type = ?').all(qbId, type)
  for (const r of rows) {
    db.prepare('DELETE FROM achats_fournisseurs WHERE id = ?').run(r.id)
    emitEntity('achat_fournisseur', 'deleted', r.id, { id: r.id }, null)
  }
  return rows.length
}

// Curseur incrémental : dernier import réussi (sync_log, purgé à 7 jours — bien
// en deçà de la limite de 30 jours du CDC QB), avec 15 min de marge.
function lastQbImportCursor() {
  const row = db.prepare(`
    SELECT MAX(created_at) AS d FROM sync_log WHERE module = 'qb_import' AND status = 'success'
  `).get()
  if (!row?.d) return null
  const back = new Date(new Date(row.d).getTime() - 15 * 60 * 1000)
  if (Number.isNaN(back.getTime())) return null
  return back.toISOString().slice(0, 19) + '-00:00'
}

// Import QB → achats_fournisseurs.
// - incremental: Change Data Capture (entités modifiées ET supprimées depuis le
//   dernier import réussi) — léger, tourne en tâche de fond.
// - complet (défaut) : toutes les Bills/Purchases, puis réconciliation des
//   suppressions (rows ERP dont le quickbooks_id n'existe plus dans QB).
export async function importFromQB({ incremental = false, trigger = 'manual' } = {}) {
  const t0 = Date.now()
  const today = new Date().toISOString().slice(0, 10)
  let inserted = 0
  let updated = 0
  let removed = 0
  const errors = []

  const changedSince = incremental ? lastQbImportCursor() : null
  const useCdc = incremental && !!changedSince

  // ── 0. Collecte : CDC (incrémental) ou requêtes complètes ─────────────────
  let bills = []
  let purchases = []
  const deletedIds = { Bill: [], Purchase: [] }
  let billsFetchOk = true
  let purchasesFetchOk = true

  if (useCdc) {
    try {
      const data = await qbGet(`/cdc?entities=Bill,Purchase&changedSince=${encodeURIComponent(changedSince)}`)
      const groups = data.CDCResponse?.[0]?.QueryResponse || []
      for (const g of groups) {
        for (const b of g.Bill || []) (b.status === 'Deleted' ? deletedIds.Bill : bills).push(b)
        for (const p of g.Purchase || []) (p.status === 'Deleted' ? deletedIds.Purchase : purchases).push(p)
      }
    } catch (e) {
      errors.push({ type: 'CDC', error: e.message })
      billsFetchOk = purchasesFetchOk = false
    }
  } else {
    try {
      bills = await fetchAllQBPages('/query', 'Bill')
    } catch (e) {
      errors.push({ type: 'Bill', error: e.message })
      billsFetchOk = false
    }
  }

  for (const bill of bills) {
    try {
      const qbId = String(bill.Id)
      const qbVendorId = bill.VendorRef?.value
      const vendor = bill.VendorRef?.name || bill.VendorRef?.value || 'Inconnu'
      const dateFact = bill.TxnDate || today
      const dueDate  = bill.DueDate || null
      const total    = bill.TotalAmt ?? 0
      const balance  = bill.Balance ?? total
      const amountPaid = Math.max(0, total - balance)
      const status   = mapBillStatus(bill)
      const docNum   = bill.DocNumber || null
      const notes    = bill.PrivateNote || null
      const vendorCompanyId = qbVendorId ? upsertVendorCompany(qbVendorId, vendor) : null
      const lines = extractLines(bill.Line)
      const currency = bill.CurrencyRef?.value || 'CAD'
      const exchangeRate = Number(bill.ExchangeRate) > 0 ? Number(bill.ExchangeRate) : 1

      const existing = db.prepare(
        "SELECT id FROM achats_fournisseurs WHERE quickbooks_id=? AND type='bill'"
      ).get(qbId)

      if (existing) {
        db.prepare(`
          UPDATE achats_fournisseurs
          SET vendor=?, vendor_id=?, date_achat=?, due_date=?, total_cad=?, amount_paid_cad=?,
              status=?, vendor_invoice_number=?, notes=?, lines=?, currency=?, exchange_rate=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id=?
        `).run(vendor, vendorCompanyId, dateFact, dueDate, total, amountPaid, status, docNum, notes, lines, currency, exchangeRate, existing.id)
        updated++
      } else {
        db.prepare(`
          INSERT INTO achats_fournisseurs
            (id, type, vendor, vendor_id, date_achat, due_date, amount_cad, tax_cad, total_cad, amount_paid_cad,
             status, vendor_invoice_number, notes, lines, currency, exchange_rate, quickbooks_id)
          VALUES (?, 'bill', ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          randomUUID(), vendor, vendorCompanyId, dateFact, dueDate,
          total, 0, total, amountPaid, status, docNum, notes, lines, currency, exchangeRate, qbId
        )
        inserted++
      }
    } catch (e) {
      errors.push({ type: 'Bill', qbId: bill.Id, error: e.message })
    }
  }

  // ── 2. QB Purchases avec fournisseur → achats_fournisseurs (type=purchase) ──
  const QB_PAYMENT_METHOD = {
    CreditCard: 'Carte de crédit',
    Check:      'Chèque',
    Cash:       'Comptant',
    ECheck:     'Virement',
  }

  if (!useCdc) {
    try {
      purchases = await fetchAllQBPages('/query', 'Purchase')
    } catch (e) {
      errors.push({ type: 'Purchase', error: e.message })
      purchasesFetchOk = false
    }
  }

  let insertedDep = 0, updatedDep = 0

  for (const purchase of purchases) {
    if (!purchase.EntityRef || purchase.EntityRef.type !== 'Vendor') continue
    try {
      const qbId           = String(purchase.Id)
      const qbVendorId     = purchase.EntityRef.value
      const vendor         = purchase.EntityRef.name || qbVendorId || 'Inconnu'
      const dateAchat      = purchase.TxnDate || today
      const total          = purchase.TotalAmt ?? 0
      const reference      = purchase.DocNumber || null
      const notes          = purchase.PrivateNote || null
      const paymentMethod  = QB_PAYMENT_METHOD[purchase.PaymentType] || 'Autre'
      const description    = purchase.Line?.[0]?.Description || vendor
      const vendorCompanyId = upsertVendorCompany(qbVendorId, vendor)
      const lines = extractLines(purchase.Line)
      const currency = purchase.CurrencyRef?.value || 'CAD'
      const exchangeRate = Number(purchase.ExchangeRate) > 0 ? Number(purchase.ExchangeRate) : 1

      const existing = db.prepare(
        "SELECT id FROM achats_fournisseurs WHERE quickbooks_id=? AND type='purchase'"
      ).get(qbId)

      if (existing) {
        db.prepare(`
          UPDATE achats_fournisseurs
          SET vendor=?, vendor_id=?, date_achat=?, amount_cad=?, total_cad=?, payment_method=?,
              description=?, reference=?, notes=?, lines=?, currency=?, exchange_rate=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id=?
        `).run(vendor, vendorCompanyId, dateAchat, total, total, paymentMethod, description, reference, notes, lines, currency, exchangeRate, existing.id)
        updatedDep++
      } else {
        db.prepare(`
          INSERT INTO achats_fournisseurs
            (id, type, date_achat, description, vendor, vendor_id, reference,
             amount_cad, tax_cad, total_cad, payment_method, status, notes, lines,
             currency, exchange_rate, quickbooks_id)
          VALUES (?, 'purchase', ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          randomUUID(), dateAchat, description, vendor, vendorCompanyId,
          reference, total, 0, total, paymentMethod, 'Approuvé', notes, lines, currency, exchangeRate, qbId
        )
        insertedDep++
      }
    } catch (e) {
      errors.push({ type: 'Purchase', qbId: purchase.Id, error: e.message })
    }
  }

  // ── 3. Suppressions QB → suppression des achats correspondants ────────────
  if (useCdc) {
    for (const d of deletedIds.Bill) removed += deleteAchatsByQbId(String(d.Id), 'bill')
    for (const d of deletedIds.Purchase) removed += deleteAchatsByQbId(String(d.Id), 'purchase')
  } else {
    // Réconciliation complète : un achat lié à un quickbooks_id absent de QB a
    // été supprimé/annulé dans QB. Seulement si le fetch de l'entité a réussi —
    // sinon on effacerait tout sur une simple erreur réseau.
    if (billsFetchOk) {
      const qbBillIds = new Set(bills.map(b => String(b.Id)))
      for (const r of db.prepare("SELECT id, quickbooks_id FROM achats_fournisseurs WHERE type='bill' AND quickbooks_id IS NOT NULL").all()) {
        if (!qbBillIds.has(String(r.quickbooks_id))) removed += deleteAchatsByQbId(r.quickbooks_id, 'bill')
      }
    }
    if (purchasesFetchOk) {
      const qbPurchaseIds = new Set(purchases.map(p => String(p.Id)))
      for (const r of db.prepare("SELECT id, quickbooks_id FROM achats_fournisseurs WHERE type='purchase' AND quickbooks_id IS NOT NULL").all()) {
        if (!qbPurchaseIds.has(String(r.quickbooks_id))) removed += deleteAchatsByQbId(r.quickbooks_id, 'purchase')
      }
    }
  }

  const status = errors.length ? 'error' : 'success'
  logSync('qb_import', trigger, {
    status,
    modified: inserted + updated + insertedDep + updatedDep,
    destroyed: removed,
    error: errors.length ? JSON.stringify(errors).slice(0, 500) : null,
    durationMs: Date.now() - t0,
  })
  console.log(`✅ QB import${useCdc ? ' (CDC)' : ''}: bills ${inserted}+${updated}, dépenses ${insertedDep}+${updatedDep}, supprimés ${removed}, erreurs ${errors.length}`)
  return { mode: useCdc ? 'cdc' : 'full', bills: { inserted, updated }, depenses: { inserted: insertedDep, updated: updatedDep }, removed, errors }
}

// ── Stripe Invoice → QB Sales Receipt ────────────────────────────────────────

// Find or create a QB Customer by name. Optionally with a specific currency —
// QB Online lie une devise unique par Customer ; pour USD on suffixe " USD" au
// nom (convention décidée avec la compta) et on crée le Customer en USD.
async function findOrCreateCustomer(customerName, currency = 'CAD') {
  const displayName = currency === 'USD' ? `${customerName} USD` : customerName
  const safe = displayName.replace(/'/g, "\\'")

  // Match exact d'abord (rapide)
  const exactQ = new URLSearchParams({ query: `SELECT * FROM Customer WHERE DisplayName = '${safe}' MAXRESULTS 1` })
  const exact = await qbGet(`/query?${exactQ}`)
  if ((exact.QueryResponse?.Customer || []).length > 0) return exact.QueryResponse.Customer[0].Id

  // Match LIKE pour gérer les différences de casse / espaces
  const likeQ = new URLSearchParams({ query: `SELECT * FROM Customer WHERE DisplayName LIKE '${safe}' MAXRESULTS 5` })
  const like = await qbGet(`/query?${likeQ}`)
  const candidates = like.QueryResponse?.Customer || []
  // Match insensible à la casse + trim
  const target = displayName.trim().toLowerCase()
  const matched = candidates.find(c => (c.DisplayName || '').trim().toLowerCase() === target)
  if (matched) return matched.Id

  // Création — gère "Nom en double" (code 6240) en cas de doublon non détecté.
  const payload = { DisplayName: displayName }
  if (currency && currency !== 'CAD') payload.CurrencyRef = { value: currency }
  try {
    const created = await qbPost('/customer', payload)
    return created.Customer.Id
  } catch (e) {
    if (/Nom en double|Duplicate Name|"code":"6240"/i.test(e.message)) {
      // Re-fetch large et match insensible — dernière chance
      const broadQ = new URLSearchParams({ query: `SELECT * FROM Customer WHERE DisplayName LIKE '%${safe.replace(/[%_]/g, '')}%' MAXRESULTS 20` })
      const broad = await qbGet(`/query?${broadQ}`)
      const all = broad.QueryResponse?.Customer || []
      const fallback = all.find(c => (c.DisplayName || '').trim().toLowerCase() === target)
      if (fallback) return fallback.Id
    }
    throw e
  }
}

// ── Reçus de vente → QB Purchase ou Bill ─────────────────────────────────────

// params: { type, expenseAccountId, paymentAccountId, vendorId, newVendorName, dueDate }
// type = 'purchase' (déjà payé, défaut) ou 'bill' (à payer plus tard via AP)
// Construit le mémo (PrivateNote / « Memo » QB) d'un reçu de vente publié.
// Priorité au mémo saisi par l'utilisateur ; à défaut, on reporte les
// descriptions des articles (une par ligne). QB tronque PrivateNote à 4000
// caractères — on coupe pour éviter un rejet de l'API.
// Calcule la base HORS TAXES (HT) à envoyer comme montant de ligne à QB pour un
// reçu fournisseur. QB ajoute la taxe par-dessus (GlobalTaxCalculation:'TaxExcluded'),
// donc base + taxes doit égaler le total du reçu.
// - Cas normal : subtotal + taxes ≈ total → on garde subtotal (préserve l'itemisation).
// - Cas taxes-incluses (Amazon & co.) : subtotal contient déjà la taxe (souvent
//   subtotal == total), l'invariant ne tient pas → on dérive HT = total - taxes,
//   sinon QB recompte la taxe et la double.
// - Sans total exploitable : on retombe sur subtotal, sinon total.
export function computeReceiptHtBase({ subtotal = 0, totalTax = 0, total = 0 }) {
  const round2 = x => Math.round(x * 100) / 100
  const subtotalReconciles = Math.abs((subtotal + totalTax) - total) <= 0.02
  if (total > 0 && totalTax > 0 && !subtotalReconciles) return round2(total - totalTax)
  return subtotal > 0 ? subtotal : total
}

// Mémo QB (PrivateNote, champ « Memo »). On NE veut PAS les 15 lignes d'articles dans
// le mémo : seulement la description GÉNÉRALE de la facture (l'objet principal). Un mémo
// personnalisé saisi par l'utilisateur est ajouté en tête, suivi de cette description.
// Les lignes d'articles détaillées restent publiées sur les lignes QB (Description).
//
// Règle « description » : general_description (« Description principale ») est
// toujours prioritaire — c'est le champ que l'utilisateur édite pour contrôler le mémo.
// On ne retombe sur la description de l'unique article que si general_description est vide.
export function buildReceiptMemo(memo, generalDescription = '', items = []) {
  const list = Array.isArray(items) ? items : []
  const soleDesc = list.length === 1 ? (list[0]?.description || '').trim() : ''
  const desc = (generalDescription || soleDesc || '').trim()
  const custom = (memo || '').trim()
  const note = [custom, desc].filter(Boolean).join('\n')
  return note.length > 4000 ? note.slice(0, 4000) : note
}

// Sentinel « aucune taxe » pour un tax_code_id PAR LIGNE — identique à NO_TAX côté
// client (SaleReceiptDetail.jsx). Distinct de null (« suit le code du document ») : il
// force une ligne sans aucun TaxCodeRef.
export const NO_TAX_CODE = '__none__'

// Lignes de dépense QB à partir des articles extraits : UNE ligne par article, AVEC
// sa description, pour que les lignes publiées correspondent au mémo (« chaque ligne
// d'article se retrouve des deux côtés »). Les montants sont mis à l'échelle pour que
// leur somme égale la base HT (targetHt) — ainsi les descriptions sont conservées même
// quand les prix d'articles sont taxes-incluses (au lieu de fusionner en une ligne
// générique). Sans montant d'article exploitable : une ligne unique au HT, description
// = descriptions jointes ou libellé de repli.
export function buildReceiptLines(items, targetHt, { lineDetail, fallbackDescription } = {}) {
  const round2 = x => Math.round(x * 100) / 100
  // lineDetail = détail de base (AccountRef + éventuel TaxCodeRef global). Selon le
  // tax_code_id de l'article, sa ligne reçoit (comme dans QuickBooks) :
  //  - un Id de code QB → ce TaxCodeRef précis ;
  //  - le sentinel NO_TAX_CODE → AUCUN TaxCodeRef (taxe explicitement nulle : on retire
  //    le code global hérité, sinon une ligne « sans taxe » serait taxée au code document) ;
  //  - null/absent → réutilise lineDetail tel quel (suit le code global ; identité préservée).
  const mkLine = (amount, description, taxCodeId) => {
    let detail
    if (taxCodeId === NO_TAX_CODE) {
      detail = { ...lineDetail }
      delete detail.TaxCodeRef
    } else if (taxCodeId) {
      detail = { ...lineDetail, TaxCodeRef: { value: String(taxCodeId) } }
    } else {
      detail = lineDetail
    }
    return { Amount: amount, DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: detail, Description: description }
  }
  const itemized = (Array.isArray(items) ? items : [])
    .map(it => ({
      description: (it?.description || '').trim(),
      amount: Number(it?.total) || (Number(it?.unit_price) * Number(it?.quantity)) || 0,
      taxCodeId: it?.tax_code_id || null,
    }))
    .filter(it => it.amount > 0)

  if (itemized.length > 0 && targetHt > 0) {
    const rawSum = itemized.reduce((s, it) => s + it.amount, 0)
    const scale = rawSum > 0 ? targetHt / rawSum : 1
    const lines = itemized.map(it => mkLine(round2(it.amount * scale), it.description, it.taxCodeId))
    // Reporte l'écart d'arrondi sur la dernière ligne pour que la somme = targetHt.
    const drift = round2(targetHt - lines.reduce((s, l) => s + l.Amount, 0))
    if (drift !== 0) lines[lines.length - 1].Amount = round2(lines[lines.length - 1].Amount + drift)
    return lines
  }

  const joined = (Array.isArray(items) ? items : [])
    .map(it => (it?.description || '').trim())
    .filter(Boolean)
    .join(' · ')
  return [mkLine(round2(targetHt), joined || fallbackDescription || 'Reçu')]
}

export async function pushSaleReceiptToQB(receiptId, params = {}) {
  const rec = db.prepare('SELECT * FROM sale_receipts WHERE id=? AND deleted_at IS NULL').get(receiptId)
  if (!rec) throw new Error('Reçu introuvable')
  if (rec.status !== 'done') throw new Error('Le reçu doit être extrait avant de pouvoir être publié')
  if (rec.quickbooks_id) throw new Error(`Reçu déjà publié sur QuickBooks (ID: ${rec.quickbooks_id})`)

  // 'purchase' = dépense payée, 'bill' = facture à payer, 'cc_credit' = crédit sur
  // carte de crédit (note de crédit fournisseur remboursée sur la carte). Côté API QB,
  // un CreditCardCredit est une entité Purchase avec PaymentType 'CreditCard' et
  // Credit: true — les montants restent positifs, l'entité inverse le sens.
  const type = ['bill', 'cc_credit'].includes(params.type) ? params.type : 'purchase'

  // Résoudre les comptes : params en priorité, sinon config globale
  const cfg = getQBConfig()
  const expenseAccountId = params.expenseAccountId || cfg.expense_account_id
  if (!expenseAccountId) throw fieldError('Compte de dépense non spécifié', 'expense_account')

  let paymentAccountId = null
  if (type !== 'bill') {
    paymentAccountId = params.paymentAccountId || cfg.payment_account_id
    if (!paymentAccountId) throw fieldError(type === 'cc_credit' ? 'Compte de carte de crédit non spécifié' : 'Compte de paiement non spécifié', 'payment_account')
  }

  // Résoudre le fournisseur
  let vendorId = params.vendorId || null
  if (!vendorId && params.newVendorName) {
    vendorId = await findOrCreateVendor(params.newVendorName)
  } else if (!vendorId && rec.company) {
    // fallback : chercher par nom extrait (ne crée pas automatiquement)
    const q = new URLSearchParams({ query: `SELECT * FROM Vendor WHERE DisplayName = '${rec.company.replace(/'/g, "\\'")}' MAXRESULTS 1` })
    const result = await qbGet(`/query?${q}`)
    const found = result.QueryResponse?.Vendor?.[0]
    if (found) vendorId = found.Id
  }
  if (type === 'bill' && !vendorId) throw fieldError('Fournisseur requis pour une facture à payer', 'vendor')

  // Résoudre la devise de la transaction. QB exige qu'un Bill corresponde à la
  // devise du compte AP du vendor — sinon erreur 6000. On lit la CurrencyRef du
  // vendor si dispo, sinon on retombe sur la devise extraite du reçu.
  let txnCurrency = (rec.currency || 'CAD').toUpperCase()
  // Nom d'affichage du fournisseur — pour la ligne « Programmation des factures
  // à payer » du CTB - Suivi (le DisplayName QB prime sur le nom extrait).
  let vendorDisplayName = params.newVendorName || rec.company || null
  if (vendorId) {
    // La lecture de la CurrencyRef du vendor NE DOIT PAS échouer en silence : si l'appel
    // QB tombe (429/503/timeout), on ne sait PAS si le fournisseur est en USD ou en CAD.
    // Retomber muettement sur la devise du reçu (souvent CAD) publierait une facture USD
    // avec la mauvaise devise/FX — erreur comptable invisible. On abandonne donc le push
    // avec une erreur explicite (le caller la renvoie en 400, re-push possible une fois QB
    // de nouveau joignable). Le cas légitime « vendor sans CurrencyRef » (appel OK, valeur
    // absente) conserve le fallback ci-dessous — seul un échec d'appel interrompt.
    let vRes
    try {
      vRes = await qbGet(`/vendor/${vendorId}`)
    } catch (e) {
      throw fieldError(`Impossible de lire la devise du fournisseur QB #${vendorId} (${e.message}) — push annulé pour éviter une devise/FX erronée`, 'vendor')
    }
    const vendorCurrency = vRes?.Vendor?.CurrencyRef?.value
    if (vendorCurrency) txnCurrency = vendorCurrency.toUpperCase()
    if (vRes?.Vendor?.DisplayName) vendorDisplayName = vRes.Vendor.DisplayName
  }

  // ── Garde-fou devise du compte de paiement ──────────────────────────────────
  // QB exige que le compte bancaire/carte d'un Purchase soit dans la DEVISE DE LA
  // TRANSACTION (elle-même imposée par la devise du fournisseur). Un fournisseur USD
  // payé depuis un compte CAD (ou l'inverse) est rejeté par QB avec le cryptique
  // 6000 « Vous ne pouvez utiliser qu'une seule devise étrangère par opération ».
  // On vérifie AVANT le POST et on explique quoi choisir (cas réel : Slack USD
  // publié depuis la Mastercard CAD).
  if (type !== 'bill' && paymentAccountId) {
    let acctRes
    try {
      acctRes = await qbGet(`/account/${paymentAccountId}`)
    } catch (e) {
      throw fieldError(`Impossible de lire le compte de paiement QB #${paymentAccountId} (${e.message}) — push annulé`, 'payment_account')
    }
    const acct = acctRes?.Account
    // Un crédit sur carte de crédit ne peut viser qu'un compte de type Carte de crédit
    // (QB rejette Credit:true sur un compte bancaire avec un 6000 générique).
    if (type === 'cc_credit' && acct?.AccountType && acct.AccountType !== 'Credit Card') {
      throw fieldError(`Un crédit sur carte de crédit doit cibler un compte de type Carte de crédit — « ${acct?.Name || paymentAccountId} » est de type ${acct.AccountType}.`, 'payment_account')
    }
    const acctCurrency = (acct?.CurrencyRef?.value || 'CAD').toUpperCase()
    if (acctCurrency !== txnCurrency) {
      // Meilleur effort : lister les comptes compatibles pour un message actionnable.
      let hint = ''
      try {
        const q = new URLSearchParams({ query: "SELECT * FROM Account WHERE AccountType IN ('Bank', 'Credit Card') MAXRESULTS 200" })
        const all = (await qbGet(`/query?${q}`)).QueryResponse?.Account || []
        const compatible = all
          .filter(a => ((a.CurrencyRef?.value || 'CAD').toUpperCase() === txnCurrency) && a.Active !== false)
          .map(a => a.Name)
        if (compatible.length) hint = ` Comptes ${txnCurrency} disponibles : ${compatible.join(', ')}.`
      } catch {}
      throw fieldError(
        `Le fournisseur « ${vendorDisplayName || rec.company} » est en ${txnCurrency} mais le compte de paiement `
        + `« ${acct?.Name || paymentAccountId} » est en ${acctCurrency}. Choisissez un compte en ${txnCurrency}.${hint}`,
        'payment_account',
      )
    }
  }

  const items = JSON.parse(rec.items || '[]')
  const round2 = n => Math.round(n * 100) / 100
  const txnDate = rec.receipt_date || new Date().toISOString().slice(0, 10)
  let totalAmt = rec.total || 0
  let subtotalAmt = rec.subtotal || 0
  let tpsAmt = rec.tps || 0
  let tvqAmt = rec.tvq || 0
  // other_taxes (TVH/HST d'une autre province, cf. extraction) FAIT PARTIE des taxes du
  // document : l'omettre faisait échouer l'invariant subtotal + taxes = total dans
  // computeReceiptHtBase, qui traitait alors le reçu comme « taxes incluses » et gonflait
  // la base HT de la valeur de la TVH (facture Novo Express 250715 : publiée 273,66 $ au
  // lieu de 267,85 $).
  let otherAmt = rec.other_taxes || 0

  // ── Conversion reçu → devise de la transaction ──────────────────────────────
  // La devise de la transaction est imposée par le fournisseur QB (souvent CAD),
  // pas par le reçu. Un reçu USD publié tel quel dans une opération CAD inscrirait
  // les chiffres USD comme des dollars canadiens (dépense sous-évaluée d'~35 % —
  // cas Slack : reçu 122,50 USD, fournisseur QB en CAD payé sur Mastercard CAD).
  // On convertit au taux Banque du Canada de la date du reçu (même source que les
  // payouts Stripe) et on trace la conversion dans le mémo QB.
  const recCurrency = (rec.currency || 'CAD').toUpperCase()
  let fxNote = null
  if (recCurrency !== txnCurrency) {
    const supported = (recCurrency === 'USD' && txnCurrency === 'CAD') || (recCurrency === 'CAD' && txnCurrency === 'USD')
    if (!supported) {
      throw fieldError(`Reçu en ${recCurrency} mais transaction QB en ${txnCurrency} (devise du fournisseur) — conversion non supportée. Ajustez la devise du reçu ou le fournisseur.`, 'currency')
    }
    const usdCad = await getUsdCadRate(txnDate)
    if (!usdCad) throw new Error(`Taux USD→CAD indisponible pour ${txnDate} (Banque du Canada) — impossible de convertir le reçu ${recCurrency} en ${txnCurrency}. Réessayer plus tard.`)
    const factor = recCurrency === 'USD' ? usdCad : 1 / usdCad
    const origTotal = totalAmt
    totalAmt = round2(totalAmt * factor)
    subtotalAmt = round2(subtotalAmt * factor)
    tpsAmt = round2(tpsAmt * factor)
    tvqAmt = round2(tvqAmt * factor)
    otherAmt = round2(otherAmt * factor)
    fxNote = `Converti : ${origTotal.toFixed(2)} ${recCurrency} → ${totalAmt.toFixed(2)} ${txnCurrency} @ ${usdCad} (Banque du Canada, ${txnDate})`
  }
  const totalTax = tpsAmt + tvqAmt + otherAmt

  // Base HORS TAXES (HT) à envoyer à QB. Avec GlobalTaxCalculation:'TaxExcluded',
  // QB rajoute la taxe PAR-DESSUS le montant des lignes — pour que le total final
  // de la transaction QB égale `total`, la base des lignes doit valoir total - taxes.
  // En temps normal subtotal == total - taxes et on garde subtotal (préserve la
  // ventilation par article). MAIS certaines factures — Amazon en tête — affichent
  // un prix de ligne et un sous-total TAXES INCLUSES ; l'extraction pose alors
  // subtotal = total (taxes déjà dedans) tout en remplissant TPS/TVQ. Envoyer ce
  // subtotal comme HT ferait recompter la taxe par QB → taxes comptées EN DOUBLE
  // (ex. reçu Amazon 11,19 $ → 11,19 HT + 1,46 taxe = 12,65 $ au lieu de 11,19 $).
  // On détecte l'incohérence : si subtotal + taxes ne réconcilie pas avec total, la
  // base HT est dérivée de total - taxes (auto-correction du cas taxes-incluses).
  const targetHt = computeReceiptHtBase({ subtotal: subtotalAmt, totalTax, total: totalAmt })

  // Résoudre le code de taxe à appliquer aux lignes (HT).
  // - Si l'appelant fournit explicitement params.taxCodeId (choix dans le menu déroulant),
  //   on l'utilise tel quel (chaîne = ce code QB ; null/'' = aucune taxe). Permet de poser
  //   un code groupé spécifique (ex. TPS-TVQ-repas, TPS-TVQ-kilométrage) que la déduction
  //   automatique ne saurait pas inférer des seuls montants TPS/TVQ.
  // - Sinon (param absent), on retombe sur la déduction par les montants TPS/TVQ. Sans code,
  //   QB enregistre la dépense sans ventiler la taxe — les rapports TPS/TVQ ne la récupèrent
  //   pas et la balance subtotal+taxes vs total se perd.
  let lineTaxCodeId = null
  if (params.taxCodeId !== undefined) {
    lineTaxCodeId = params.taxCodeId || null
  } else if (tpsAmt > 0 && tvqAmt > 0) lineTaxCodeId = await resolveTaxCodeByName('TPS/TVQ QC - 9,975')
  else if (tpsAmt > 0) lineTaxCodeId = await resolveTaxCodeByName('TPS')
  else if (tvqAmt > 0) lineTaxCodeId = await resolveTaxCodeByName('TVQ QC - 9,975')

  // ── Vérification du statut fiscal (cf. services/fiscalStatus.js) ──────────────
  // Le type de transaction est OBLIGATOIRE : il détermine le code de taxe QB attendu.
  // On compare le code effectivement sur le point d'être publié (résolu ci-dessus) au
  // code attendu pour ce type. Si écart → on BLOQUE, sauf si l'opérateur fournit une
  // justification explicite (forceReason) — échappatoire tracée en DB et au journal.
  // Empêche le bug « publié hors-champ » : Détaxé/Exonéré/Hors-champ donnent tous 0 $
  // de taxe mais sont 3 codes QB distincts dans des cases de rapport différentes.
  const transactionType = params.transactionType || null
  const forceReason = (params.forceReason || '').trim() || null
  if (!transactionType) {
    throw fieldError('Type de transaction requis pour vérifier le statut fiscal avant publication.', 'transaction_type')
  }
  if (!getTransactionType(transactionType)) {
    throw fieldError(`Type de transaction inconnu: "${transactionType}".`, 'transaction_type')
  }
  const selectedCodeName = await resolveTaxCodeNameById(lineTaxCodeId)
  const fiscalCheck = validateTaxCodeAgainstType(transactionType, selectedCodeName)
  if (!fiscalCheck.ok && !forceReason) {
    const sel = selectedCodeName || 'Aucune taxe'
    throw fieldError(
      `Statut fiscal : « ${fiscalCheck.typeLabel} » attend le code « ${fiscalCheck.recommendedCode} », `
      + `pas « ${sel} ». Corrigez le code de taxe, ou justifiez pour forcer.`,
      'tax_code',
    )
  }

  const lineDetail = { AccountRef: { value: expenseAccountId } }
  if (lineTaxCodeId) lineDetail.TaxCodeRef = { value: lineTaxCodeId }

  // Une ligne QB par article (avec sa description), montants mis à l'échelle sur la
  // base HT. Les descriptions des lignes publiées correspondent ainsi au mémo.
  const lines = buildReceiptLines(items, targetHt, {
    lineDetail,
    fallbackDescription: rec.company || rec.original_name,
  })

  // Mémo QB (PrivateNote, champ « Memo ») : objet principal de la facture, pas la liste
  // des articles. Plusieurs articles → résumé général ; un seul → sa description verbatim.
  // Mémo personnalisé éventuel ajouté en tête ; trace de conversion FX en queue.
  let privateNote = buildReceiptMemo(rec.memo, rec.general_description, items)
  if (fxNote) privateNote = [privateNote, fxNote].filter(Boolean).join(' — ')

  // Codes de taxe effectifs PAR LIGNE (override d'article sinon code global du document).
  // Dès qu'une ligne diffère du code global, on bascule sur la voie « par ligne » : QB
  // applique le TaxCodeRef de chaque ligne et on agrège un TaxLine[] exact par taux.
  const effectiveLines = lines.map(l => ({
    amount: l.Amount,
    taxCodeId: l.AccountBasedExpenseLineDetail?.TaxCodeRef?.value || null,
  }))
  const hasPerLineCodes = effectiveLines.some(l => (l.taxCodeId || null) !== (lineTaxCodeId || null))

  // TxnTaxDetail : sur un Purchase/Bill, fournir TxnTaxCodeRef + TotalTax SANS TaxLine
  // ne fige PAS le montant — QB ignore TotalTax et recalcule la taxe depuis le % du
  // TaxCode de chaque ligne (ex. 5% × 14,30 = 0,72 au lieu des 0,65 du reçu). Pour
  // publier le montant EXACT saisi (champs TPS/TVQ), on construit un TaxLine[] explicite
  // avec les montants tels quels — QB honore alors l'override et ne recalcule pas.
  let taxDetail = {}
  let txnTotalAmt = totalAmt
  if (hasPerLineCodes) {
    // ── Voie « code de taxe par ligne » (comme dans QuickBooks) ──────────────────
    // Chaque ligne porte déjà son TaxCodeRef → on LAISSE QB calculer la taxe lui-même
    // (GlobalTaxCalculation:'TaxExcluded', AUCUN TxnTaxDetail). Fournir un TaxLine[]
    // explicite ici déclenche une erreur de validation 6000 (« erreur lors du calcul de
    // la taxe ») dès que les lignes mélangent plusieurs codes, dont des 0 % (Détaxé/Hors
    // champ) : QB refuse de réconcilier un override par taux avec un calcul par ligne.
    taxDetail = { GlobalTaxCalculation: 'TaxExcluded' }
    // Purchase : TotalAmt est obligatoire et doit égaler base HT + taxe que QB va calculer.
    // On la recompose depuis les taux de chaque code pour rester aligné avec QB.
    if (type !== 'bill') {
      try {
        const distinct = [...new Set(effectiveLines.map(l => l.taxCodeId).filter(Boolean))]
        const ratesByCode = new Map()
        for (const code of distinct) ratesByCode.set(code, await resolveTaxCodeRates(code))
        const agg = aggregateLineTaxLines(effectiveLines, ratesByCode)
        txnTotalAmt = round2(targetHt + agg.totalTax)
      } catch (e) {
        console.warn(`pushSaleReceiptToQB: TotalAmt par ligne indisponible pour ${receiptId} (${e.message}) — fallback total extrait`)
      }
    }
  } else if (lineTaxCodeId && totalTax > 0) {
    let taxLines = null
    try {
      taxLines = await buildPurchaseTaxLines(lineTaxCodeId, { tpsAmt, tvqAmt, otherAmt, subtotalAmt })
    } catch (e) {
      console.warn(`pushSaleReceiptToQB: TaxLine exactes indisponibles pour ${receiptId} (${e.message}) — fallback auto-calc QB`)
    }
    const txnTaxDetail = { TxnTaxCodeRef: { value: lineTaxCodeId }, TotalTax: Math.round(totalTax * 100) / 100 }
    if (taxLines) txnTaxDetail.TaxLine = taxLines
    taxDetail = { TxnTaxDetail: txnTaxDetail, GlobalTaxCalculation: 'TaxExcluded' }
  }

  // CurrencyRef obligatoire dès que la devise diffère de la home currency. QB
  // rejette sinon un Bill avec un vendor non-CAD (« devise de l'opération doit
  // correspondre à celle des comptes fournisseurs »).
  // QB exige CurrencyRef + ExchangeRate pour toute opération en devise étrangère
  // (code d'erreur 2410 sinon). On utilise le taux Banque du Canada à la date du
  // reçu — même mécanisme que les payouts Stripe USD.
  let currencyFields = {}
  if (txnCurrency && txnCurrency !== 'CAD') {
    let rate = 1
    if (txnCurrency === 'USD') {
      rate = await getUsdCadRate(txnDate)
      if (!rate) throw new Error(`Taux USD→CAD indisponible pour ${txnDate} (Banque du Canada). Réessayer plus tard.`)
    }
    currencyFields = { CurrencyRef: { value: txnCurrency }, ExchangeRate: rate }
  }

  let qbId
  if (type === 'bill') {
    const bill = {
      VendorRef: { value: vendorId },
      TxnDate: txnDate,
      Line: lines,
      ...currencyFields,
      ...taxDetail,
    }
    if (params.dueDate) bill.DueDate = params.dueDate
    if (rec.receipt_number) bill.DocNumber = qbDocNumber(rec.receipt_number)
    if (privateNote) bill.PrivateNote = privateNote
    const result = await qbPost('/bill', bill)
    qbId = result.Bill.Id
    // CTB - Suivi : programme le paiement dans le Google Sheets (fire-and-forget,
    // import dynamique pour éviter le cycle quickbooks → ctbSheet → systemAutomations).
    import('./ctbSheet.js').then(({ appendFactureAPayer }) => appendFactureAPayer({
      vendor: vendorDisplayName || rec.company, total: totalAmt, currency: txnCurrency,
      dueDate: params.dueDate || null, source: `sale_receipt ${receiptId}`,
    })).catch(() => {})
  } else {
    const purchase = {
      // CreditCardCredit : PaymentType imposé à CreditCard + Credit:true (c'est ce
      // couple qui fait apparaître la transaction comme « Crédit de carte de crédit »
      // dans QB — montants positifs, sens inversé par l'entité).
      PaymentType: type === 'cc_credit' ? 'CreditCard' : (PAYMENT_TYPE_MAP[rec.payment_method] || 'Cash'),
      ...(type === 'cc_credit' ? { Credit: true } : {}),
      AccountRef: { value: paymentAccountId },
      TxnDate: txnDate,
      TotalAmt: txnTotalAmt,
      Line: lines,
      ...currencyFields,
      ...taxDetail,
    }
    if (vendorId) purchase.EntityRef = { value: vendorId, type: 'Vendor' }
    if (rec.receipt_number) purchase.DocNumber = qbDocNumber(rec.receipt_number)
    if (privateNote) purchase.PrivateNote = privateNote
    const result = await qbPost('/purchase', purchase)
    qbId = result.Purchase.Id
  }

  // Conserver les choix de comptabilisation effectivement utilisés (résolus :
  // params explicites ou déduction/config) pour servir de modèle aux prochains
  // reçus du même fournisseur. paymentAccountId est null pour un Bill.
  // due_date : l'échéance saisie/confirmée au push est persistée (Bill uniquement).
  db.prepare(`
    UPDATE sale_receipts
    SET quickbooks_id=?, quickbooks_type=?,
        expense_account_id=?, payment_account_id=?, tax_code_id=?, vendor_id=?,
        transaction_type=?, fiscal_force_reason=?,
        due_date=COALESCE(?, due_date),
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id=?
  `).run(qbId, type, expenseAccountId || null, paymentAccountId || null, lineTaxCodeId || null, vendorId || null, transactionType, forceReason, (type === 'bill' && params.dueDate) || null, receiptId)

  // Apprentissage du profil fournisseur : les choix publiés (vendor QB dans la devise
  // de la transaction, type d'entité, comptes, statut fiscal, code de taxe, termes)
  // deviennent les défauts du prochain document de ce fournisseur. Best-effort — un
  // échec ici ne doit pas invalider la transaction déjà postée.
  try {
    const { learnFromPush } = await import('./vendorProfiles.js')
    let termsDays = rec.payment_terms_days || null
    if (!termsDays && type === 'bill' && params.dueDate && rec.receipt_date) {
      const days = Math.round((Date.parse(params.dueDate) - Date.parse(rec.receipt_date)) / 86400000)
      if (Number.isInteger(days) && days > 0 && days <= 120) termsDays = days
    }
    const profileId = learnFromPush({
      company: rec.company || vendorDisplayName,
      txnCurrency, type,
      expenseAccountId: expenseAccountId || null,
      paymentAccountId: paymentAccountId || null,
      taxCodeId: lineTaxCodeId || null,
      transactionType,
      vendorId: vendorId || null,
      termsDays,
    })
    if (profileId) {
      db.prepare('UPDATE sale_receipts SET vendor_profile_id=? WHERE id=? AND vendor_profile_id IS NULL')
        .run(profileId, receiptId)
    }
  } catch (e) {
    console.warn(`pushSaleReceiptToQB: apprentissage profil fournisseur échoué pour ${receiptId}: ${e.message}`)
  }

  // Joindre la/les pièce(s) justificative(s) (images ou PDF du reçu) à l'entité QB.
  // Document multipage : on attache la page 1 (filename) + chaque page de extra_pages.
  // Une erreur d'upload ne doit pas invalider la transaction comptable déjà postée.
  try {
    const uploadsDir = join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'receipts')
    let extraPages = []
    try { extraPages = JSON.parse(rec.extra_pages || '[]') } catch {}
    const pages = [
      { filename: rec.filename, file_type: rec.file_type, original_name: rec.original_name },
      ...extraPages,
    ]
    const multi = pages.length > 1
    for (let i = 0; i < pages.length; i++) {
      const pg = pages[i]
      if (!pg?.filename) continue
      const filePath = join(uploadsDir, pg.filename)
      if (!existsSync(filePath)) {
        console.warn(`pushSaleReceiptToQB: fichier introuvable pour ${receiptId} (${filePath})`)
        continue
      }
      const ext = (pg.file_type || extname(pg.filename) || '').toLowerCase()
      const contentType = SALE_RECEIPT_MIME[ext] || 'application/octet-stream'
      const buffer = readFileSync(filePath)
      let baseName = (pg.original_name || pg.filename || `receipt${ext}`).replace(/[/\\]/g, '_')
      // Suffixe -pN pour distinguer les pages d'un même document dans QB.
      if (multi) {
        const dot = baseName.lastIndexOf('.')
        baseName = dot > 0 ? `${baseName.slice(0, dot)}-p${i + 1}${baseName.slice(dot)}` : `${baseName}-p${i + 1}`
      }
      await qbUploadAttachment({
        entityType: type === 'bill' ? 'Bill' : 'Purchase',
        entityId: qbId,
        fileBuffer: buffer,
        fileName: baseName,
        contentType,
      })
    }
  } catch (e) {
    console.error(`pushSaleReceiptToQB: attachement QB échoué pour ${receiptId}:`, e.message)
  }

  return qbId
}

// ── Stripe Payouts → QB Deposit ──────────────────────────────────────────────

// Comptes QB résolus par AcctNum (avec fallback nom). Les chiffres viennent du
// plan comptable confirmé par la compta — si un compte est renuméroté, mettre
// à jour acctNum ici (pas le nom qui peut diverger entre fichiers QB).
const QB_STRIPE_ACCOUNTS = {
  bank_cad:                  'Compte chèques Banque Nationale',
  bank_usd:                  'Venn USD',
  fees:                      'Stripe Charge Back',
  // Comptes clients (AR), scindés par devise selon le plan comptable.
  accounts_receivable_cad:   { acctNum: '12000', name: 'Comptes clients - CAD' },
  accounts_receivable_usd:   { acctNum: '12100', name: 'Comptes clients - USD' },
  // Compte de transit Stripe (= "Undeposited Funds" en convention QuickBooks).
  // Toutes les charges Stripe transitent ici entre invoice.paid et le payout du lundi.
  undeposited_funds:         { acctNum: '12900', name: 'Fonds non déposés' },
  // Compte de passif pour ventes encaissées avant qu'un envoi ne soit constaté.
  revenue_deferred:          { acctNum: '23900', name: 'Revenus perçus d’avance' },
  // Comptes de revenu — utilisés au constat de vente (Cr) et aux remboursements (Dr,
  // par décision compta : pas de compte "Retours et rabais" séparé, on contre-passe directement).
  revenue_sale:              { acctNum: '40000', name: 'Ventes' },
  revenue_subscription:      { acctNum: '41000', name: 'Revenus de service' },
}

// Codes de taxe QBO appliqués aux lignes de frais Stripe pour déclencher l'imputation
// automatique au compte de taxe approprié (QB refuse les débits directs sur les comptes
// de taxe à payer via l'API). Les noms doivent correspondre aux TaxCode présents dans QB.
const QB_STRIPE_FEE_TAX_CODES = {
  gst_only: 'TPS',                  // 5% seul
  gst_qst:  'TPS/TVQ QC - 9,975',   // combiné TPS+TVQ
  qst_only: 'TVQ QC - 9,975',       // TVQ seule (rare)
}

// Extracts processing fee vs tax-on-fee (TPS/TVQ) from a balance_transaction's fee_details.
// Stripe stores fee_details on every BT — each entry has type ('stripe_fee', 'application_fee', 'tax')
// and description ('Canadian GST', 'Canadian QST', 'Sales Tax', etc.).
//
// ⚠️ Stripe envoie de plus en plus souvent un seul entry tax avec description="Sales Tax"
// (sans préciser TPS vs TVQ). Pour Orisha (au QC), Stripe applique soit TPS seul (5 %)
// soit TPS+TVQ (14.975 %). On déduit le mix depuis le taux observé (tax / HT) :
//   - rate ≥ 10 % → TPS+TVQ, splitté proportionnellement (5/14.975 et 9.975/14.975)
//   - rate < 10 % → TPS seul
// Sans ça, tout finit en taxGst, pickFeeTaxCode choisit "TPS seul", QB calcule 5 % au
// lieu de 15 %, et la ligne "Ajustement d'arrondi taxes" finit par éponger plusieurs
// dollars de taxes manquantes au lieu des centimes d'arrondi normaux.
export function splitFeeFromRaw(bt) {
  let raw
  try { raw = JSON.parse(bt.raw || '{}') } catch { raw = {} }
  const details = Array.isArray(raw.fee_details) ? raw.fee_details : []
  let processing = 0
  let taxGst = 0
  let taxQst = 0
  let unclassifiedTax = 0
  for (const d of details) {
    const amt = (d.amount || 0) / 100
    if (d.type === 'tax') {
      const desc = (d.description || '').toLowerCase()
      if (/\b(qst|tvq)\b/.test(desc)) taxQst += amt
      else if (/\b(gst|tps|tvh|hst)\b/.test(desc)) taxGst += amt
      else unclassifiedTax += amt
    } else {
      processing += amt
    }
  }
  if (unclassifiedTax !== 0) {
    // Base HT pour calculer le taux : pour un charge BT (processing > 0), c'est le frais
    // de traitement ; pour un stripe_fee BT (processing = 0), c'est |bt.amount| (le HT du
    // frais Stripe lui-même).
    const baseHt = Math.abs(processing) > 0.001 ? Math.abs(processing) : Math.abs(bt.amount || 0)
    const rate = baseHt > 0 ? Math.abs(unclassifiedTax) / baseHt : 0
    if (rate >= 0.10) {
      taxGst += unclassifiedTax * (5 / 14.975)
      taxQst += unclassifiedTax * (9.975 / 14.975)
    } else {
      taxGst += unclassifiedTax
    }
  }
  return { processing, taxGst, taxQst }
}

async function resolveAccountByName(name) {
  const cache = await loadAccountsCache()
  const id = cache.byName.get(name)
  if (!id) throw new Error(`Compte QB introuvable: "${name}"`)
  return id
}

// Items QB utilisés pour les Sales Receipt d'encaissement Stripe. Mappent vers
// les bons comptes de revenu (configurés côté QB via IncomeAccountRef de l'item).
//   order        → "Revenu perçu d'avance" (compte 23900)
//   subscription → "Location / Rent"       (compte 41000)
const QB_STRIPE_ITEMS = {
  order: "Revenu perçu d'avance",
  subscription: 'Location / Rent',
}

let _itemsCache = null
async function resolveQBStripeItems() {
  if (_itemsCache) return _itemsCache
  const out = {}
  for (const [k, name] of Object.entries(QB_STRIPE_ITEMS)) {
    const safe = name.replace(/'/g, "\\'")
    const r = await qbGet(`/query?query=${encodeURIComponent(`SELECT Id, Name FROM Item WHERE Name = '${safe}' MAXRESULTS 1`)}`)
    const item = r.QueryResponse?.Item?.[0]
    if (!item) throw new Error(`Item QB introuvable: "${name}"`)
    out[k] = item.Id
  }
  _itemsCache = out
  return _itemsCache
}

// Cache des Accounts QB par AcctNum/Name pour éviter de hitter l'API à chaque résolution.
// Vie : durée du process. AcctNum n'est pas queryable directement (QB rejette WHERE AcctNum=…),
// donc on liste tous les comptes une fois et on filtre localement.
let _accountsCache = null

export async function loadAccountsCache() {
  if (_accountsCache) return _accountsCache
  const all = []
  let startPos = 1
  const pageSize = 1000
  while (true) {
    const q = encodeURIComponent(`SELECT Id, Name, AcctNum FROM Account MAXRESULTS ${pageSize} STARTPOSITION ${startPos}`)
    const data = await qbGet(`/query?query=${q}`)
    const rows = data.QueryResponse?.Account || []
    all.push(...rows)
    if (rows.length < pageSize) break
    startPos += pageSize
  }
  _accountsCache = {
    byAcctNum: new Map(all.filter(a => a.AcctNum).map(a => [String(a.AcctNum), a.Id])),
    byName: new Map(all.map(a => [a.Name, a.Id])),
    byId: new Map(all.map(a => [String(a.Id), { acctNum: a.AcctNum || null, name: a.Name }])),
  }
  return _accountsCache
}

export async function resolveAccountByAcctNum(acctNum) {
  const cache = await loadAccountsCache()
  return cache.byAcctNum.get(String(acctNum)) || null
}

// Construit le TxnTaxDetail.TaxLine[] avec des montants de taxe EXACTS pour un
// Purchase/Bill (override). Sans TaxLine explicite, QB ignore TotalTax et recalcule
// la taxe depuis le % du TaxCode — ce qui décale le montant du reçu (ex. 0,72 au lieu
// de 0,65). On lit les TaxRate d'ACHAT rattachés au TaxCode choisi, puis on y ventile
// les montants tps/tvq tels que saisis. Retourne null si on ne peut pas mapper (le
// caller retombe alors sur l'auto-calc QB).
// Résout les taux d'achat d'un code de taxe QB → [{id, percent}]. Un code à 0 % (ex.
// Hors champ, Détaxé, Exonéré) renvoie [] (aucun TaxRate d'achat). NE PAS avaler un
// échec d'appel : si le fetch tombe (429/503/timeout) percent resterait null et la
// ventilation par % zapperait la taxe en silence — on laisse l'erreur remonter pour
// que le caller retombe sur l'auto-calc QB plutôt que de publier une taxe muette à 0.
async function resolveTaxCodeRates(taxCodeId) {
  const tcRes = await qbGet(`/taxcode/${taxCodeId}`)
  const details = tcRes?.TaxCode?.PurchaseTaxRateList?.TaxRateDetail || []
  const rates = []
  for (const d of details) {
    const rid = d.TaxRateRef?.value
    if (!rid) continue
    const rr = await qbGet(`/taxrate/${rid}`)
    const v = Number(rr?.TaxRate?.RateValue)
    rates.push({ id: rid, percent: Number.isFinite(v) ? v : null })
  }
  return rates
}

// Agrège les TaxLine d'une transaction à codes de taxe PAR LIGNE. Pour chaque ligne
// (montant HT + son code de taxe), applique les taux du code et cumule par TaxRate.
// Retourne { taxLines, totalTax } avec NetAmountTaxable = somme des HT taxés à ce taux.
// ratesByCode : Map(taxCodeId -> [{id, percent}]). Un code sans taux (Hors champ,
// Détaxé, Exonéré) ne génère aucune taxe — sa ligne reste comptabilisée à 0 $ de taxe.
export function aggregateLineTaxLines(lines, ratesByCode) {
  const round2 = n => Math.round(n * 100) / 100
  const byRate = new Map() // rateId -> { percent, net, tax }
  for (const ln of (Array.isArray(lines) ? lines : [])) {
    const amount = Number(ln?.amount) || 0
    if (amount <= 0) continue
    const rates = ratesByCode.get(ln?.taxCodeId) || []
    for (const r of rates) {
      if (r?.percent == null) continue
      const agg = byRate.get(r.id) || { percent: r.percent, net: 0, tax: 0 }
      agg.net = round2(agg.net + amount)
      agg.tax = round2(agg.tax + amount * r.percent / 100)
      byRate.set(r.id, agg)
    }
  }
  const taxLines = []
  let totalTax = 0
  for (const [id, agg] of byRate) {
    if (agg.tax <= 0) continue
    taxLines.push({
      Amount: agg.tax,
      DetailType: 'TaxLineDetail',
      TaxLineDetail: {
        TaxRateRef: { value: String(id) },
        PercentBased: true,
        ...(agg.percent != null ? { TaxPercent: agg.percent } : {}),
        NetAmountTaxable: agg.net,
      },
    })
    totalTax = round2(totalTax + agg.tax)
  }
  return { taxLines, totalTax }
}

async function buildPurchaseTaxLines(taxCodeId, { tpsAmt = 0, tvqAmt = 0, otherAmt = 0, subtotalAmt = 0 }) {
  // % de chaque TaxRate pour distinguer TPS (~5%) de TVQ (~9,975%) sur un code groupé.
  const rates = await resolveTaxCodeRates(taxCodeId)
  if (!rates.length) return null

  const round2 = n => Math.round(n * 100) / 100
  const net = round2(subtotalAmt)
  const mkLine = (r, amt) => ({
    Amount: round2(amt),
    DetailType: 'TaxLineDetail',
    TaxLineDetail: {
      TaxRateRef: { value: String(r.id) },
      PercentBased: true,
      ...(r.percent != null ? { TaxPercent: r.percent } : {}),
      NetAmountTaxable: net,
    },
  })

  const lines = []
  if (rates.length === 1) {
    // Code à un seul taux (ex. TPS seul, ou TVH d'une autre province — stockée dans
    // other_taxes) → tout le montant de taxe va sur ce taux.
    const amt = round2(tpsAmt + tvqAmt + otherAmt)
    if (amt > 0) lines.push(mkLine(rates[0], amt))
  } else {
    // Code groupé (TPS+TVQ) → ventiler par % : ≈5% = TPS, ≈9,975% = TVQ.
    for (const r of rates) {
      let amt = 0
      if (r.percent != null && Math.abs(r.percent - 5) < 1) amt = tpsAmt
      else if (r.percent != null && Math.abs(r.percent - 9.975) < 1.5) amt = tvqAmt
      if (round2(amt) > 0) lines.push(mkLine(r, amt))
    }
  }
  return lines.length ? lines : null
}

// Erreur métier « code de taxe légitimement absent » — à distinguer d'un échec
// réseau/API transitoire de QB. Un appelant peut traiter taxCodeNotFound comme un
// null métier (poser la JE sans TaxCodeRef), mais doit PROPAGER toute autre erreur
// (blip réseau, 401/500 QB) pour faire échouer la pose et la rejouer plus tard —
// sinon la taxe disparaît silencieusement du revenu. Voir isTaxCodeNotFoundError.
class TaxCodeNotFoundError extends Error {
  constructor(name) {
    super(`TaxCode QB introuvable: "${name}"`)
    this.name = 'TaxCodeNotFoundError'
    this.taxCodeNotFound = true
    this.taxCodeName = name
  }
}

// Vrai uniquement pour l'absence métier d'un code de taxe (réponse QB valide mais
// vide). Toute autre erreur (qbGet qui throw : réseau, timeout, 4xx/5xx) renvoie
// false et doit donc être propagée par l'appelant.
export function isTaxCodeNotFoundError(e) {
  return !!(e && e.taxCodeNotFound === true)
}

async function resolveTaxCodeByName(name) {
  const safe = name.replace(/'/g, "\\'")
  const q = new URLSearchParams({ query: `SELECT Id, Name FROM TaxCode WHERE Name = '${safe}' MAXRESULTS 1` })
  const r = await qbGet(`/query?${q}`)
  const tc = r.QueryResponse?.TaxCode?.[0]
  if (!tc) throw new TaxCodeNotFoundError(name)
  return tc.Id
}

// Résout en lot des NOMS de code de taxe QB → Map(nom -> Id|null), en une seule requête.
// Sert à pré-remplir les codes de taxe par ligne calculés à l'extraction (transport
// multi-régions). Lève si QB est injoignable — l'appelant retombe alors sur des codes
// vides (l'opérateur choisit à la main). Un nom absent du fichier QB → valeur null.
export async function resolveTaxCodeIdsByName(names) {
  const unique = [...new Set((Array.isArray(names) ? names : []).filter(Boolean))]
  if (!unique.length) return new Map()
  const q = new URLSearchParams({ query: 'SELECT Id, Name FROM TaxCode WHERE Active = true MAXRESULTS 1000' })
  const r = await qbGet(`/query?${q}`)
  const byName = new Map((r.QueryResponse?.TaxCode || []).map(c => [c.Name, c.Id]))
  return new Map(unique.map(n => [n, byName.get(n) || null]))
}

// Nom d'un code de taxe QB depuis son Id (pour la vérification du statut fiscal).
// Retourne null si l'Id est vide ou introuvable.
async function resolveTaxCodeNameById(id) {
  if (!id) return null
  const safe = String(id).replace(/'/g, "\\'")
  const q = new URLSearchParams({ query: `SELECT Id, Name FROM TaxCode WHERE Id = '${safe}' MAXRESULTS 1` })
  const r = await qbGet(`/query?${q}`)
  return r.QueryResponse?.TaxCode?.[0]?.Name || null
}

// Résout le QB Customer ID pour une facture, en choisissant le Customer dans la
// bonne devise. Si le Customer dans cette devise n'existe pas encore, le crée et
// le persiste sur companies (quickbooks_customer_id pour CAD, quickbooks_customer_id_usd
// pour USD). Retourne { id, name } ou null si pas de company associée.
async function resolveQbCustomerForFacture(factureId, currency = 'CAD') {
  const row = db.prepare(`
    SELECT c.id AS company_id, c.name, c.quickbooks_customer_id, c.quickbooks_customer_id_usd
    FROM factures f
    JOIN companies c ON c.id = f.company_id
    WHERE f.id = ?
  `).get(factureId)
  if (!row?.company_id) return null

  const isUsd = String(currency).toUpperCase() === 'USD'
  const cached = isUsd ? row.quickbooks_customer_id_usd : row.quickbooks_customer_id
  if (cached) return { id: cached, name: row.name, currency: isUsd ? 'USD' : 'CAD' }

  const qbCustomerId = await findOrCreateCustomer(row.name, isUsd ? 'USD' : 'CAD')
  const col = isUsd ? 'quickbooks_customer_id_usd' : 'quickbooks_customer_id'
  db.prepare(`UPDATE companies SET ${col} = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
    .run(qbCustomerId, row.company_id)
  emitCompany('updated', row.company_id, null)
  return { id: qbCustomerId, name: row.name, currency: isUsd ? 'USD' : 'CAD' }
}

// Cache des TaxRate QB par % pour mapper les tax_rates Stripe → TaxRate QB IDs.
// Construit le TxnTaxDetail.TaxLine[] que QB Canada attend pour les JournalEntry
// (auto-génération via TxnTaxCodeRef seul ne fonctionne PAS sur les JE).
let _taxRatesCache = null

async function loadTaxRatesCache() {
  if (_taxRatesCache) return _taxRatesCache
  const all = []
  let startPos = 1
  while (true) {
    const data = await qbGet(`/query?query=${encodeURIComponent(`SELECT Id, Name, RateValue FROM TaxRate MAXRESULTS 1000 STARTPOSITION ${startPos}`)}`)
    const rows = data.QueryResponse?.TaxRate || []
    all.push(...rows)
    if (rows.length < 1000) break
    startPos += 1000
  }
  // On cache uniquement les TaxRate "ventes" (pas RTI/CTI/kilom/repas/Purchases) par juridiction.
  // Mapping confirmé avec la compta (taux en vigueur 2025-2026) :
  //   TPS 5%        → toutes les provinces (id 8)
  //   TVQ 9.975%    → Québec (id 23)
  //   TVH ON 13%    → Ontario (id 39)
  //   TVH N.-B. 15% → Nouveau-Brunswick (id 32, "TVH N.-B. 2016")
  //   TVH N.S. 14%  → Nouvelle-Écosse (id 50, taux abaissé en 2025)
  //   TVH PE 15%    → Île-du-Prince-Édouard (id 49, "TVH Î.-P.-É. 2016")
  //   TVH NL 15%    → Terre-Neuve-et-Labrador (id 55, "TVH T.-N.-L. 2016")
  const salesOnly = all.filter(r => !/RTI|CTI|kilom|repas|\(Purchases\)|sur les achats/i.test(r.Name || ''))
  const find = (re, pct) => salesOnly.find(r => Number(r.RateValue) === pct && re.test(r.Name))
  const findApprox = (re, pct) => salesOnly.find(r => Math.abs(Number(r.RateValue) - pct) < 0.01 && re.test(r.Name))

  const tpsRate = find(/^TPS$/i, 5) || find(/TPS|GST/i, 5)
  const tvqRate = findApprox(/TVQ|QST/i, 9.975)
  const hstOn = find(/^TVH ON$/i, 13)
  const hstNb = find(/^TVH N\.-B\. 2016$/i, 15) || find(/TVH N\.-B/i, 15)
  const hstNs = find(/N\.S\..*Sales|TVH N\.S\./i, 14)
  const hstPe = find(/^TVH Î\.-P\.-É\. 2016$/i, 15) || find(/Î\.-P\.-É/i, 15)
  const hstNl = find(/^TVH T\.-N\.-L\. 2016$/i, 15) || find(/T\.-N\.-L/i, 15)

  _taxRatesCache = {
    tps:    tpsRate ? { id: tpsRate.Id, percent: 5 } : null,
    tvq:    tvqRate ? { id: tvqRate.Id, percent: 9.975 } : null,
    hst_on: hstOn   ? { id: hstOn.Id,   percent: 13 } : null,
    hst_nb: hstNb   ? { id: hstNb.Id,   percent: 15 } : null,
    hst_ns: hstNs   ? { id: hstNs.Id,   percent: 14 } : null,
    hst_pe: hstPe   ? { id: hstPe.Id,   percent: 15 } : null,
    hst_nl: hstNl   ? { id: hstNl.Id,   percent: 15 } : null,
  }
  return _taxRatesCache
}

// Cache process-local des tax_rate Stripe → { country, state, percentage }.
// Permet de mapper un tax_rate id (txr_xxx) à sa juridiction sans appel répété.
const _stripeTaxRateCache = new Map()
async function getStripeTaxRateInfo(taxRateId) {
  if (!taxRateId) return null
  if (_stripeTaxRateCache.has(taxRateId)) return _stripeTaxRateCache.get(taxRateId)
  try {
    const tr = await getStripeClient().taxRates.retrieve(taxRateId)
    const info = {
      country: tr.country || null,
      state: tr.state || null,
      jurisdiction: tr.jurisdiction || null,
      percentage: Number(tr.percentage),
    }
    _stripeTaxRateCache.set(taxRateId, info)
    return info
  } catch (e) {
    console.error(`Stripe tax_rate ${taxRateId} non récupéré:`, e.message)
    _stripeTaxRateCache.set(taxRateId, null)
    return null
  }
}

// Mappe une juridiction (state Canadian abbrev: 'ON', 'NB', 'NS', 'PE', 'NL', 'QC')
// + un pourcentage à un TaxRate QB du cache. Retourne null si non mappé.
function pickQbRateForJurisdiction(rates, state, percentage) {
  const pct = Number(percentage)
  if (Math.abs(pct - 5) < 0.5) return rates.tps
  if (Math.abs(pct - 9.975) < 0.5) return rates.tvq
  if (Math.abs(pct - 13) < 0.5) return rates.hst_on
  if (Math.abs(pct - 14) < 0.5 && state === 'NS') return rates.hst_ns
  if (Math.abs(pct - 15) < 0.5) {
    if (state === 'NB') return rates.hst_nb
    if (state === 'PE') return rates.hst_pe
    if (state === 'NL') return rates.hst_nl
  }
  return null
}

// Calcule le HT post-remise d'une invoice Stripe en cents :
//   total - somme(total_taxes.amount)
// = base de la taxe (= taxable_amount sur n'importe quelle ligne tax)
// Utiliser cette valeur (pas invoice.subtotal qui est pré-remise) pour les SR/RR.
export function stripeInvoiceNetHtCents(invoice) {
  if (!invoice) return 0
  const taxes = Array.isArray(invoice.total_taxes) ? invoice.total_taxes
    : Array.isArray(invoice.total_tax_amounts) ? invoice.total_tax_amounts
    : []
  const totalTax = taxes.reduce((s, t) => s + (t.amount || 0), 0)
  return (invoice.total || 0) - totalTax
}

// Lit les taxes appliquées sur une invoice Stripe, peu importe le format (nouveau
// `total_taxes` ou legacy `total_tax_amounts`). Retourne un array uniforme :
//   [{ amount: cents, taxable_amount: cents, percentage: number, tax_rate_id: string|null }]
function extractStripeTaxes(invoice) {
  const out = []
  // Format moderne (Stripe API 2025+)
  if (Array.isArray(invoice.total_taxes)) {
    for (const t of invoice.total_taxes) {
      if (!t.amount) continue
      const taxable = t.taxable_amount || invoice.subtotal || 0
      const pct = taxable > 0 ? (t.amount / taxable) * 100 : null
      const trId = t.tax_rate_details?.tax_rate || null
      out.push({ amount: t.amount, taxable_amount: taxable, percentage: pct, tax_rate_id: trId })
    }
    return out
  }
  // Format legacy
  if (Array.isArray(invoice.total_tax_amounts)) {
    for (const t of invoice.total_tax_amounts) {
      if (!t.amount) continue
      const taxable = t.taxable_amount || invoice.subtotal || 0
      let pct = null
      let trId = null
      if (typeof t.tax_rate === 'object' && t.tax_rate?.percentage != null) {
        pct = Number(t.tax_rate.percentage)
        trId = t.tax_rate.id || null
      } else if (typeof t.tax_rate === 'string') {
        trId = t.tax_rate
        if (taxable > 0) pct = (t.amount / taxable) * 100
      } else if (taxable > 0) {
        pct = (t.amount / taxable) * 100
      }
      out.push({ amount: t.amount, taxable_amount: taxable, percentage: pct, tax_rate_id: trId })
    }
  }
  return out
}

// Construit la structure TxnTaxDetail à attacher à une JournalEntry pour ventiler
// TPS/TVQ depuis les taxes Stripe. Retourne null si pas de taxe (export US, Détaxé)
// — la JE sera postée sans TxnTaxDetail.
async function buildTxnTaxDetail(invoice, txnTaxCodeId) {
  const taxes = extractStripeTaxes(invoice)
  const totalTax = taxes.reduce((s, t) => s + t.amount, 0)
  if (totalTax === 0) return null

  const rates = await loadTaxRatesCache()

  const taxLines = []
  for (const t of taxes) {
    // Lookup juridiction Stripe pour distinguer NB/NS/PE/NL (15% ambigu sinon).
    const stripeInfo = await getStripeTaxRateInfo(t.tax_rate_id)
    const state = stripeInfo?.state || null
    const qbRate = t.percentage != null ? pickQbRateForJurisdiction(rates, state, t.percentage) : null
    if (!qbRate) continue  // taxe non mappée — TaxLine omise (à étendre si besoin)

    taxLines.push({
      Amount: Math.round(t.amount) / 100,
      DetailType: 'TaxLineDetail',
      TaxLineDetail: {
        TaxRateRef: { value: String(qbRate.id) },
        PercentBased: true,
        TaxPercent: qbRate.percent,
        NetAmountTaxable: Math.round(t.taxable_amount) / 100,
      },
    })
  }

  if (!taxLines.length) return null

  const detail = {
    TotalTax: Math.round(totalTax) / 100,
    TaxLine: taxLines,
  }
  if (txnTaxCodeId) detail.TxnTaxCodeRef = { value: txnTaxCodeId }
  return detail
}

// Résout le QB TaxCode à utiliser pour une invoice Stripe selon les taxes appliquées.
// Heuristique sur les pourcentages des tax_rates (compatible avec QB_STRIPE_FEE_TAX_CODES) :
//   - 0% ou aucune taxe (export US, Sask 0%, etc.)        → "Détaxé"
//   - TPS seul 5% (BC, Sask, Alberta, MB, Yukon, NWT, NU) → "TPS"
//   - TVQ seul 9.975% (rare)                              → "TVQ QC - 9,975"
//   - TPS 5% + TVQ 9.975% (Québec)                        → "TPS/TVQ QC - 9,975"
// HST (ON 13%, Atlantic 15%) → non géré pour l'instant, fallback "Détaxé" + warning.
async function resolveTaxCodeForInvoice(invoice) {
  const taxes = extractStripeTaxes(invoice)
  const totalTax = taxes.reduce((s, t) => s + t.amount, 0)

  if (totalTax === 0) {
    try {
      return await resolveTaxCodeByName('Détaxé')
    } catch (e) {
      if (isTaxCodeNotFoundError(e)) return null
      // Échec réseau/API transitoire : ne pas confondre avec un null métier —
      // propager pour faire échouer la pose et la rejouer (sinon JE sans TaxCode).
      console.error('resolveTaxCodeForInvoice: échec transitoire résolution "Détaxé" — pose annulée pour retry:', e.message)
      throw e
    }
  }

  // Récupérer les juridictions Stripe pour distinguer 15% NB/PE/NL et 14% NS.
  const states = new Set()
  let has5 = false, has9975 = false, has13 = false, has14 = false, has15 = false
  for (const t of taxes) {
    if (t.percentage == null) continue
    if (Math.abs(t.percentage - 5) < 0.5) has5 = true
    else if (Math.abs(t.percentage - 9.975) < 0.5) has9975 = true
    else if (Math.abs(t.percentage - 13) < 0.5) has13 = true
    else if (Math.abs(t.percentage - 14) < 0.5) has14 = true
    else if (Math.abs(t.percentage - 15) < 0.5) has15 = true
    if (t.tax_rate_id) {
      const info = await getStripeTaxRateInfo(t.tax_rate_id)
      if (info?.state) states.add(info.state)
    }
  }

  let codeName
  if (has5 && has9975) codeName = 'TPS/TVQ QC - 9,975'
  else if (has13) codeName = 'TVH ON'
  else if (has14 && states.has('NS')) codeName = 'TVH N.S.'
  else if (has15 && states.has('NB')) codeName = 'TVH N.-B. 2016'
  else if (has15 && states.has('PE')) codeName = 'TVH Î.-P.-É. 2016'
  else if (has15 && states.has('NL')) codeName = 'TVH T.-N.-L. 2016'
  else if (has5) codeName = 'TPS'
  else if (has9975) codeName = 'TVQ QC - 9,975'
  else codeName = 'Détaxé'  // fallback (devrait être rare maintenant)

  try {
    return await resolveTaxCodeByName(codeName)
  } catch (e) {
    if (isTaxCodeNotFoundError(e)) return null  // code absent en QB → null métier
    // Échec réseau/API transitoire : propager pour que l'appelant échoue et rejoue,
    // plutôt que poser le Deposit/JE sans TaxCodeRef (taxe non ventilée, sans trace).
    console.error(`resolveTaxCodeForInvoice: échec transitoire résolution "${codeName}" — pose annulée pour retry:`, e.message)
    throw e
  }
}

async function resolveQBStripeAccounts() {
  const out = {}
  for (const [k, def] of Object.entries(QB_STRIPE_ACCOUNTS)) {
    if (typeof def === 'string') {
      out[k] = await resolveAccountByName(def)
    } else {
      // Forme {acctNum, name} : essai par AcctNum, fallback par Name.
      const id = await resolveAccountByAcctNum(def.acctNum)
      out[k] = id || await resolveAccountByName(def.name)
    }
  }
  return out
}

// Comptes du constat de vente — surchargeables par l'utilisateur via l'action_config
// de l'automation système sys_revenue_recognition (AcctNum). Chaque clé mappe vers
// le compte résolu par resolveQBStripeAccounts ; une valeur vide ou égale au défaut
// garde la résolution standard (AcctNum + fallback par nom). Un AcctNum configuré
// mais introuvable en QB fait ÉCHOUER le constat (la facture part en file de retry
// avec une erreur explicite) plutôt que de poster silencieusement sur le défaut.
const REVREC_ACCOUNT_OVERRIDES = {
  deferred_acctnum: { target: 'revenue_deferred', defaultAcctNum: '23900', label: 'passif revenus différés' },
  sale_acctnum: { target: 'revenue_sale', defaultAcctNum: '40000', label: 'compte de ventes' },
  ar_cad_acctnum: { target: 'accounts_receivable_cad', defaultAcctNum: '12000', label: 'comptes clients CAD' },
  ar_usd_acctnum: { target: 'accounts_receivable_usd', defaultAcctNum: '12100', label: 'comptes clients USD' },
}

async function resolveRevenueRecognitionAccounts() {
  const accounts = await resolveQBStripeAccounts()
  let cfg = {}
  try {
    const row = db.prepare(
      "SELECT action_config FROM automations WHERE id = 'sys_revenue_recognition' AND system = 1"
    ).get()
    cfg = JSON.parse(row?.action_config || '{}')
  } catch { cfg = {} }
  for (const [key, { target, defaultAcctNum, label }] of Object.entries(REVREC_ACCOUNT_OVERRIDES)) {
    const acctNum = String(cfg[key] ?? '').trim()
    if (!acctNum || acctNum === defaultAcctNum) continue
    const id = await resolveAccountByAcctNum(acctNum)
    if (!id) {
      throw new Error(
        `Compte QB no ${acctNum} introuvable (${label}) — corriger la configuration de l'automation « Constat de vente à l'expédition »`
      )
    }
    accounts[target] = id
  }
  return accounts
}

// Vérifie que la facture est « envoyée » au sens comptable — soit via un envoi
// physique sur une commande liée (factures.order_id ou via project), soit via le
// flag is_sent_manual=1 que l'utilisateur peut activer pour les factures sans
// matériel physique (services, factures de couverture, etc.), soit automatique-
// ment pour les factures « orphelines » : kind != 'subscription' et ni order_id
// ni project_id — rien à expédier, donc la vente est constatée d'emblée et le
// payout traite la charge comme une vente réalisée (crédit 40000, pas 23900).
function factureHasLinkedShipment(factureId) {
  const r = db.prepare(`
    SELECT 1 AS ok
    FROM factures f
    LEFT JOIN orders o_d ON o_d.id = f.order_id
    LEFT JOIN orders o_p ON o_p.project_id = f.project_id AND f.project_id IS NOT NULL
    WHERE f.id = ?
      AND (
        f.is_sent_manual = 1
        OR (f.kind != 'subscription' AND f.order_id IS NULL AND f.project_id IS NULL)
        OR EXISTS (
          SELECT 1 FROM shipments s
          WHERE s.order_id = o_d.id OR s.order_id = o_p.id
        )
      )
    LIMIT 1
  `).get(factureId)
  return !!r
}

async function resolveQBStripeFeeTaxCodes() {
  const out = {}
  const missing = []
  for (const [k, name] of Object.entries(QB_STRIPE_FEE_TAX_CODES)) {
    try {
      out[k] = await resolveTaxCodeByName(name)
    } catch {
      missing.push({ key: k, name })
    }
  }
  return { codes: out, missing }
}

// Catégorie des frais Stripe, en ordre d'affichage. Les clés servent à indexer
// feesByCategory dans buildDepositFromPayout + à préfixer les descriptions QB.
const FEE_CATEGORY_LABELS = {
  card_processing:  'Traitement carte',
  pad_verification: 'Vérification PAD',
  tax_service:      'Calcul auto. des taxes',
  invoicing:        'Invoicing',
  billing:          'Billing abonnements',
  post_payment:     'Relance factures',
  other:            'Autres',
}

// Classe un stripe_fee BT en sous-catégorie selon sa description Stripe. Les
// préfixes sont stables (vérifiés sur 12 mois de données).
function classifyStripeFeeCategory(description) {
  const d = String(description || '')
  if (/^automatic taxes/i.test(d))        return 'tax_service'
  if (/^pre-authorized debit/i.test(d))   return 'pad_verification'
  if (/^invoicing\b/i.test(d))            return 'invoicing'
  if (/^billing\b/i.test(d))              return 'billing'
  if (/^post payment invoices/i.test(d))  return 'post_payment'
  return 'other'
}

// Choisit le TaxCode à appliquer sur une ligne de frais selon le mix TPS/TVQ présent
// dans fee_details. Retourne null si aucune taxe ou si le code n'est pas résolu.
function pickFeeTaxCode(taxGst, taxQst, codes) {
  const hasG = Math.abs(taxGst) > 0.001
  const hasQ = Math.abs(taxQst) > 0.001
  if (hasG && hasQ) return codes.gst_qst || null
  if (hasG) return codes.gst_only || null
  if (hasQ) return codes.qst_only || null
  return null
}

// Build the QB Deposit payload for a Stripe payout.
// Returns { deposit, summary, warnings } without sending.
// Throws if the line sum ≠ payout amount (invariant: sum(bt.net) = payout.amount).
export async function buildDepositFromPayout(payoutStripeId) {
  const payout = db.prepare('SELECT * FROM stripe_payouts WHERE stripe_id=?').get(payoutStripeId)
  if (!payout) throw new Error(`Payout introuvable: ${payoutStripeId}`)

  const bts = db.prepare(
    'SELECT * FROM stripe_balance_transactions WHERE payout_stripe_id=? ORDER BY created_date'
  ).all(payoutStripeId)
  if (bts.length === 0) throw new Error('Aucune balance_transaction synchronisée pour ce payout — lancer la sync d\'abord')

  const accounts = await resolveQBStripeAccounts()
  const feeTaxCodesResolved = await resolveQBStripeFeeTaxCodes()
  const feeTaxCodes = feeTaxCodesResolved.codes
  const bankAccountId = payout.currency === 'USD' ? accounts.bank_usd : accounts.bank_cad
  const warnings = []
  for (const m of feeTaxCodesResolved.missing) {
    warnings.push(`TaxCode QB "${m.name}" introuvable — taxes sur frais Stripe (${m.key}) non imputées (ajuster manuellement)`)
  }

  // Agrégation des frais Stripe : au lieu d'une ligne par BT (souvent des dizaines par
  // payout), on accumule dans des buckets keyés par (catégorie × code de taxe). Une ligne
  // est émise par bucket à la fin. Les BT avec des taxes dans un mix différent se
  // retrouvent dans des buckets séparés (rare, mais sûr pour l'imputation TaxCodeRef).
  const feeBuckets = new Map()
  const bucketFee = (category, amount, taxGst, taxQst) => {
    const hasTax = Math.abs(taxGst) > 0.001 || Math.abs(taxQst) > 0.001
    let code = null
    if (hasTax) {
      code = pickFeeTaxCode(taxGst, taxQst, feeTaxCodes)
      if (!code) warnings.push(`Taxe sur frais non imputée (taxGst=${taxGst.toFixed(2)}, taxQst=${taxQst.toFixed(2)}) — catégorie ${category}`)
    }
    const key = `${category}|${code || 'none'}`
    let b = feeBuckets.get(key)
    if (!b) {
      b = { category, qbTaxCode: code, amount: 0, count: 0 }
      feeBuckets.set(key, b)
    }
    b.amount += amount
    b.count += 1
  }

  // Ordre d'affichage des groupes de lignes dans le Deposit QB — regroupe visuellement
  // les lignes similaires pour faciliter la lecture (ventes → abonnements → AR →
  // remboursements → ajustements → frais).
  const LINE_GROUP_ORDER = [
    'revenue_sale',              // Ventes (commandes constatées)
    'revenue_deferred',          // Ventes encaissées avant envoi (passif 23900)
    'revenue_subscription',      // Abonnements (41000)
    'ar_settle',                 // Encaissement après expédition (solde AR 12000/12100)
    'refund',                    // Remboursements
    'adjustment',                // Ajustements / Litiges
    'fee_card_processing',       // Traitement carte
    'fee_pad_verification',      // Vérification PAD
    'fee_tax_service',           // Calcul auto. des taxes
    'fee_invoicing',             // Invoicing
    'fee_billing',               // Billing abonnements
    'fee_post_payment',          // Relance factures
    'fee_other',                 // Frais autres
    'unknown',                   // Catch-all
  ]

  const lines = []
  let feesTotal = 0        // toutes les lignes de frais émises (traitement + disputes + stripe_fee), pour le summary
  const feesByCategory = Object.fromEntries(Object.keys(FEE_CATEGORY_LABELS).map(k => [k, 0]))
  let taxesOnFeesGst = 0   // TPS sur frais Stripe (pour summary seulement — imputation via TaxCodeRef)
  let taxesOnFeesQst = 0   // TVQ sur frais Stripe (pour summary seulement)
  let chargesTotal = 0              // somme des charges entrantes (TTC)
  let chargesOrderTotal = 0         // breakdown : charges liées à des commandes (kind='order')
  let chargesSubscriptionTotal = 0  // breakdown : charges liées à des abonnements (kind='subscription')
  let refundTotal = 0
  let disputeTotal = 0
  // Factures à marquer en revenu reçu d'avance après push réussi (= constat à l'expédition).
  // Forme : { factureId, document_number, amount_native, currency }
  const deferredFactures = []
  // Factures dont la vente est constatée DIRECTEMENT par la ligne 40000 du Deposit
  // (commande déjà expédiée + soldée au moment du push → ni AR, ni deferred, ni
  // subscription). Sans ce marquage, reconcileFactureRevenueRecognition lancée
  // après le push posterait une JE Dr AR / Cr 40000 en doublon (cas REUJS7NQ-0001
  // / 577EF696-0004 / JE 17371 + 17372, payout po_1TX9vF, mai 2026).
  // Forme : { factureId, document_number }
  const directlyRecognizedFactures = []

  for (const bt of bts) {
    // Skip the payout itself — it nets against itself in our math
    if (bt.type === 'payout') continue

    const { processing, taxGst, taxQst } = splitFeeFromRaw(bt)
    taxesOnFeesGst -= taxGst
    taxesOnFeesQst -= taxQst

    const refLabel = bt.invoice_number ? `#${bt.invoice_number}` : bt.source_id

    if (bt.type === 'charge' || bt.type === 'payment' || bt.type === 'refund' || bt.type === 'payment_refund') {
      const isRefund = bt.type === 'refund' || bt.type === 'payment_refund'

      // Pivot unifié : toutes les charges et refunds créditent / débitent 12900 Fonds
      // non déposés. La nature du revenu (commande, abonnement, AR) a déjà été tranchée
      // par la JE posée à invoice.paid (postInvoicePaidJE) — ici on ne fait que matérialiser
      // le transfert du transit vers la banque.
      const baseLabel = isRefund
        ? `Remboursement ${refLabel} — ${bt.customer_name || ''}`.trim()
        : `${refLabel} — ${bt.customer_name || '(client inconnu)'}`

      let qbCustomerId = bt.qb_customer_id
      if (!qbCustomerId && bt.customer_name) {
        try {
          qbCustomerId = await findOrCreateCustomer(bt.customer_name)
          db.prepare('UPDATE stripe_balance_transactions SET qb_customer_id=? WHERE id=?').run(qbCustomerId, bt.id)
        } catch (e) {
          warnings.push(`Client QB non résolu pour ${bt.customer_name}: ${e.message}`)
        }
      }

      // Détection de l'état comptable de la facture liée — appliquée aux charges
      // ET aux refunds pour gérer les 4 cas correctement :
      //   - isAR         : facture constatée à l'expédition + AR ouvert (balance > 0).
      //                    Charge : crédite AR pour solder. Refund : débite AR pour rouvrir dette.
      //   - isDeferred   : commande pas encore expédiée. Charge : crédite 23900 (passif).
      //                    Refund : débite 23900 (annule passif).
      //   - factureKind  : 'subscription' → 41000 (immédiat), 'order' → 40000 (constaté).
      let factureForBt = null
      let isDeferred = false
      let isAR = false
      let factureKind = null
      if (bt.stripe_invoice_id) {
        factureForBt = db.prepare(
          'SELECT id, document_number, kind, revenue_recognized_at, balance_due, deferred_revenue_at FROM factures WHERE invoice_id=? LIMIT 1'
        ).get(bt.stripe_invoice_id)
        if (factureForBt) {
          factureKind = factureForBt.kind
          if (factureForBt.deferred_revenue_at) {
            // Passif 23900 « Revenus perçus d'avance » déjà matérialisé sur la facture —
            // soit par un Deposit antérieur, soit par postRevenueRecognitionJE quand le
            // constat à l'expédition a précédé ce payout (commande payée constatée avant
            // l'arrivée du payout Stripe). La contrepartie de cette charge/refund est donc
            // 23900, jamais les comptes clients. Doit primer sur le test isAR ci-dessous.
            isDeferred = true
          } else if (factureForBt.revenue_recognized_at && (factureForBt.balance_due || 0) > 0) {
            isAR = true  // constatée + AR ouvert (vente à crédit, non prépayée par Stripe)
          } else if (factureKind !== 'subscription' && !factureHasLinkedShipment(factureForBt.id)) {
            isDeferred = true
          }
        }
      }

      // Pour le link "facture" affiché dans l'Aperçu Deposit : pour les refunds,
      // préférer la facture "Remboursement" (keyée par re_xxx via source_id) à la
      // facture d'origine (keyée par stripe_invoice_id). Le calcul comptable
      // ci-dessus continue d'utiliser factureForBt (= facture d'origine) pour
      // détecter isAR/isDeferred — c'est la cinématique du *charge* d'origine
      // qui détermine le compte de crédit/débit du refund.
      let factureForRef = factureForBt
      if (isRefund && bt.source_id) {
        const refundFacture = db.prepare(
          'SELECT id, document_number FROM factures WHERE invoice_id=? LIMIT 1'
        ).get(bt.source_id)
        if (refundFacture) factureForRef = refundFacture
      }

      // Choix du compte (s'applique uniformément aux charges et refunds — bt.amount
      // négatif pour refunds inverse automatiquement le mouvement) :
      //   - isAR        → AR (12000/12100 selon devise) — solde / restaure la dette
      //   - isDeferred  → 23900 Revenus perçus d'avance — pose / annule le passif
      //   - subscription → 41000 Revenus de service
      //   - sinon       → 40000 Ventes (commande expédiée + soldée OU edge case)
      let accountId
      if (isAR) {
        accountId = (payout.currency || 'CAD') === 'USD'
          ? accounts.accounts_receivable_usd
          : accounts.accounts_receivable_cad
      } else if (isDeferred) {
        accountId = accounts.revenue_deferred
      } else if (factureKind === 'subscription' || bt.is_subscription) {
        accountId = accounts.revenue_subscription
      } else {
        accountId = accounts.revenue_sale
      }

      const detail = { AccountRef: { value: accountId } }
      if (qbCustomerId) detail.Entity = { value: String(qbCustomerId), type: 'Customer' }

      // TaxCodeRef pour ventilation auto TPS/TVQ/TVH par QB. Sur les Deposits,
      // QB calcule la taxe et l'ajoute via TaxCodeRef + GlobalTaxCalculation:'TaxExcluded'.
      let qbCode = bt.qb_tax_code
      if (!qbCode && bt.tax_details && bt.tax_details !== '[]') {
        try {
          const details = JSON.parse(bt.tax_details)
          if (details.length && details.every(t => (t.amount || 0) === 0)) qbCode = '4' // Détaxé
        } catch {}
      }
      if (qbCode) {
        detail.TaxCodeRef = { value: qbCode }
        detail.TaxApplicableOn = 'Sales'
      }

      // Montant HT (= bt.amount - taxes). bt.invoice_tax_gst/qst sont la ventilation
      // produite par classifyTaxRate. Filet défensif : si la ventilation est nulle mais
      // que tax_details porte un montant réel (tax_rate non reconnu en amont — ex. une
      // TVH provinciale au libellé exotique), on retombe sur la somme des tax_details
      // (en cents) pour soustraire quand même la taxe du HT. Sinon QB recalcule la taxe
      // via TaxCodeRef par-dessus un brut non réduit → grosse ligne « arrondi taxes ».
      let invoiceTax = (bt.invoice_tax_gst || 0) + (bt.invoice_tax_qst || 0)
      if (invoiceTax === 0 && bt.tax_details && bt.tax_details !== '[]') {
        try {
          const td = JSON.parse(bt.tax_details)
          const sumCents = td.reduce((s, t) => s + (Number(t.amount) || 0), 0)
          if (sumCents > 0) invoiceTax = Math.round(sumCents) / 100
        } catch {}
      }
      const netRevenueAmount = bt.amount - invoiceTax

      const lineDescription = isDeferred ? `${baseLabel} · revenu reçu d'avance`
        : isAR ? `${baseLabel} · solde AR ${payout.currency || 'CAD'}`
        : baseLabel
      const lineGroup = isRefund ? 'refund'
        : isDeferred ? 'revenue_deferred'
        : isAR ? 'ar_settle'
        : (bt.is_subscription ? 'revenue_subscription' : 'revenue_sale')
      lines.push({
        Amount: netRevenueAmount,
        DetailType: 'DepositLineDetail',
        DepositLineDetail: detail,
        Description: lineDescription,
        _group: lineGroup,
        _ref: {
          btType: bt.type,
          factureId: factureForRef?.id || null,
          documentNumber: factureForRef?.document_number || bt.invoice_number || null,
          invoiceId: bt.stripe_invoice_id || bt.source_id || null,
          customerName: bt.customer_name || null,
        },
      })

      // Mémoriser les factures en deferred pour marquer factures.deferred_revenue_*
      // après le push (utilisé par postRevenueRecognitionJE à l'expédition).
      if (isDeferred && factureForBt) {
        deferredFactures.push({
          factureId: factureForBt.id,
          document_number: factureForBt.document_number,
          amount_native: netRevenueAmount,
          currency: payout.currency || 'CAD',
        })
      }

      // Mémoriser les factures dont la vente est constatée DIRECTEMENT par cette
      // ligne (Cr 40000 — pas isAR, pas isDeferred, pas subscription, pas refund).
      // Évite que reconcileFactureRevenueRecognition vienne poster une JE Dr AR /
      // Cr 40000 en doublon après le push.
      if (!isRefund && !isAR && !isDeferred && factureKind === 'order' && factureForBt) {
        directlyRecognizedFactures.push({
          factureId: factureForBt.id,
          document_number: factureForBt.document_number,
        })
      }

      // Frais Stripe associés à la charge (traitement carte) : accumulés dans un bucket
      // unique pour la catégorie — une seule ligne émise à la fin (toujours dans le Deposit).
      const feeTotal = processing + taxGst + taxQst
      if (feeTotal !== 0) {
        bucketFee('card_processing', -feeTotal, taxGst, taxQst)
        feesTotal -= feeTotal
        feesByCategory.card_processing -= feeTotal
      }

      if (isRefund) refundTotal += bt.amount
      else chargesTotal += bt.amount

      // Breakdown order/subscription pour le summary UI — résolu par kind de la facture liée.
      if (!isRefund && bt.stripe_invoice_id) {
        const f = db.prepare('SELECT kind FROM factures WHERE invoice_id=? LIMIT 1').get(bt.stripe_invoice_id)
        if (f?.kind === 'subscription') chargesSubscriptionTotal += bt.amount
        else chargesOrderTotal += bt.amount
      }
    } else if (bt.type === 'adjustment' || bt.type === 'dispute') {
      lines.push({
        Amount: bt.amount,
        DetailType: 'DepositLineDetail',
        DepositLineDetail: { AccountRef: { value: accounts.fees } },
        Description: bt.type === 'dispute' ? `Dispute ${bt.source_id}` : `Ajustement ${bt.source_id}`,
        _group: 'adjustment',
      })
      feesTotal += bt.amount
      disputeTotal += bt.amount

      // Dispute fee Stripe : raw.fee_details = [{type:'stripe_fee', description:'Dispute fee', amount:1500}].
      // splitFeeFromRaw l'extrait dans `processing`. Sans bucket, le frais finit dans l'ajustement
      // d'arrondi de fin de push (cas po_1Tb8r3EO122sMsbJb2oDwaJt → Deposit 17387, mai 2026 : 15 USD
      // de dispute fee mislabellisé "Ajustement d'arrondi taxes").
      if (processing !== 0 || taxGst !== 0 || taxQst !== 0) {
        bucketFee('other', -processing, taxGst, taxQst)
        feesTotal -= processing
        feesByCategory.other -= processing
      }
    } else if (bt.type === 'refund_failure') {
      // Stripe re-crédite le montant d'un refund qui a échoué côté banque destinataire.
      // L'effet sur le solde Stripe est l'inverse exact du refund original (qui reste, lui,
      // en `refund` BT négatif). On émet une ligne miroir au montant positif, groupée avec
      // les refunds pour rester lisible dans le Deposit QB.
      lines.push({
        Amount: bt.amount,
        DetailType: 'DepositLineDetail',
        DepositLineDetail: { AccountRef: { value: accounts.fees } },
        Description: `Échec remboursement ${bt.source_id} — recrédité`,
        _group: 'refund',
      })
      refundTotal += bt.amount
    } else if (bt.type === 'stripe_fee' || bt.type === 'application_fee') {
      // stripe_fee: bt.amount est le montant HT (sans taxe), bt.fee est la taxe prélevée.
      // En mode TaxExcluded, QB ajoutera la taxe via TaxCodeRef au niveau du bucket agrégé.
      const category = classifyStripeFeeCategory(bt.description)
      bucketFee(category, bt.amount, taxGst, taxQst)
      const taxInclusiveAmount = bt.amount - bt.fee  // TTC pour le summary user-facing
      feesTotal += taxInclusiveAmount
      feesByCategory[category] += taxInclusiveAmount
    } else {
      warnings.push(`Type inconnu "${bt.type}" (${bt.stripe_id}) — ajouté aux frais`)
      lines.push({
        Amount: bt.amount,
        DetailType: 'DepositLineDetail',
        DepositLineDetail: { AccountRef: { value: accounts.fees } },
        Description: `Frais ${FEE_CATEGORY_LABELS.other} · ${bt.type} ${bt.stripe_id}`,
        _group: 'unknown',
      })
      feesTotal += bt.amount
      feesByCategory.other += bt.amount
    }
  }

  // Émission des lignes de frais agrégées — une par bucket (catégorie × code de taxe).
  // Un bucket sans taxe (ex. card_processing, pad_verification) reçoit "Exonéré Achats" :
  // les frais de Stripe dans ces catégories sont des services financiers (exonérés de
  // TPS/TVH au sens de l'Annexe V partie VII LTA), donc à tracer dans QB comme tel.
  for (const b of feeBuckets.values()) {
    const detail = { AccountRef: { value: accounts.fees } }
    detail.TaxCodeRef = { value: b.qbTaxCode || '3' }
    detail.TaxApplicableOn = 'Purchase'
    const label = FEE_CATEGORY_LABELS[b.category] || FEE_CATEGORY_LABELS.other
    lines.push({
      Amount: b.amount,
      DetailType: 'DepositLineDetail',
      DepositLineDetail: detail,
      Description: `Frais ${label} · ${b.count} opération${b.count > 1 ? 's' : ''}`,
      _group: `fee_${b.category}`,
    })
  }

  // Arrondir les montants à 2 décimales — QuickBooks rejette les nombres à haute
  // précision (ex. -1.3800000000000003 issus d'arithmétique float).
  for (const l of lines) {
    l.Amount = Math.round(l.Amount * 100) / 100
  }

  // Regrouper les lignes par type pour faciliter la lecture dans QB (ventes → abonnements
  // → remboursements → ajustements → chaque catégorie de frais). Ordre stable à l'intérieur
  // d'un groupe (chronologique, basé sur l'itération des BTs).
  const groupIdx = (g) => {
    const i = LINE_GROUP_ORDER.indexOf(g || 'unknown')
    return i === -1 ? LINE_GROUP_ORDER.length : i
  }
  lines.sort((a, b) => groupIdx(a._group) - groupIdx(b._group))
  // lineRefs : tableau parallèle aux lignes du Deposit pour l'Aperçu UI (permet
  // de rendre les lignes-facture cliquables). Extrait avant de stripper _ref —
  // _ref ne doit pas être envoyé à QB.
  const lineRefs = lines.map(l => l._ref || null)
  for (const l of lines) { delete l._group; delete l._ref }

  // Pas de check d'invariant strict — les Payment/RR transférés via update DepositTo
  // ne sont plus dans les lignes du Deposit, ce qui rend le check linesSum=payout.amount
  // non applicable. La cohérence est garantie par la cinématique elle-même.

  // Taux de change USD→CAD (Banque du Canada, date d'arrivée du payout). Sans
  // ExchangeRate explicite, QB assume 1.0 et le dépôt est comptabilisé comme si
  // 1 USD = 1 CAD, ce qui fausse HomeTotalAmt et le suivi des revenus en CAD.
  const txnDate = payout.arrival_date || payout.created_date?.slice(0, 10)
  let exchangeRate = 1
  if ((payout.currency || 'CAD').toUpperCase() === 'USD') {
    exchangeRate = await getUsdCadRate(txnDate)
    if (!exchangeRate) {
      throw new Error(
        `Taux USD→CAD indisponible pour ${txnDate} (Banque du Canada + cache local). ` +
        `Réessayer plus tard ou saisir le taux manuellement dans QB.`
      )
    }
  }

  const deposit = {
    DepositToAccountRef: { value: bankAccountId },
    TxnDate: txnDate,
    CurrencyRef: { value: payout.currency || 'CAD' },
    ExchangeRate: exchangeRate,
    // TaxExcluded: les montants de ligne sont HT (hors taxe). QB calcule la taxe via
    // TaxCodeRef et l'ajoute au TotalAmt. Indispensable pour Deposit — l'entité ignore
    // TaxInclusive sur DepositLineDetail (vérifié via API : TotalAmt comportait la
    // taxe en double côté display QB).
    GlobalTaxCalculation: 'TaxExcluded',
    PrivateNote: (() => {
      const n = (types) => bts.filter(b => types.includes(b.type)).length
      const parts = []
      const sales = n(['charge', 'payment'])
      const refunds = n(['refund', 'payment_refund'])
      const fees = n(['stripe_fee', 'application_fee'])
      const adj = n(['adjustment', 'dispute'])
      if (sales)   parts.push(`${sales} vente${sales > 1 ? 's' : ''}`)
      if (refunds) parts.push(`${refunds} remboursement${refunds > 1 ? 's' : ''}`)
      if (fees)    parts.push(`${fees} frais Stripe`)
      if (adj)     parts.push(`${adj} ajustement${adj > 1 ? 's' : ''}`)
      return `Stripe payout ${payoutStripeId} — ${parts.join(' · ')}`
    })(),
    Line: lines,
  }

  const summary = {
    payout_id: payoutStripeId,
    arrival_date: payout.arrival_date,
    currency: payout.currency,
    amount: payout.amount,
    bank_account: (() => {
      const def = QB_STRIPE_ACCOUNTS[payout.currency === 'USD' ? 'bank_usd' : 'bank_cad']
      return typeof def === 'string' ? def : def?.name
    })(),
    lines_count: lines.length,
    charges_total: Math.round(chargesTotal * 100) / 100,
    charges_orders: Math.round(chargesOrderTotal * 100) / 100,
    charges_subscriptions: Math.round(chargesSubscriptionTotal * 100) / 100,
    // Compat ancienne UI — alias des breakdowns par kind.
    revenue_sale: Math.round(chargesOrderTotal * 100) / 100,
    revenue_subscription: Math.round(chargesSubscriptionTotal * 100) / 100,
    refunds: Math.round(refundTotal * 100) / 100,
    fees_total: Math.round(feesTotal * 100) / 100,
    fees_by_category: Object.fromEntries(
      Object.entries(feesByCategory).map(([k, v]) => [k, Math.round(v * 100) / 100])
    ),
    fee_category_labels: FEE_CATEGORY_LABELS,
    taxes_on_fees_gst: Math.round(taxesOnFeesGst * 100) / 100,
    taxes_on_fees_qst: Math.round(taxesOnFeesQst * 100) / 100,
    taxes_on_fees: Math.round((taxesOnFeesGst + taxesOnFeesQst) * 100) / 100,
    disputes: Math.round(disputeTotal * 100) / 100,
  }

  // Pour le Aperçu — résoudre acctNum/name de chaque ligne via le cache (déjà
  // chargé par resolveQBStripeAccounts ci-dessus). Tableau parallèle à deposit.Line
  // pour ne pas polluer la payload envoyée à QB.
  const accountsCache = await loadAccountsCache()
  const lineAccounts = lines.map(l => {
    const id = l.DepositLineDetail?.AccountRef?.value
    return id ? (accountsCache.byId.get(String(id)) || null) : null
  })

  return { deposit, summary, warnings, exchangeRate, deferredFactures, directlyRecognizedFactures, lineAccounts, lineRefs }
}

export async function pushDepositFromPayout(payoutStripeId) {
  const payout = db.prepare('SELECT * FROM stripe_payouts WHERE stripe_id=?').get(payoutStripeId)
  if (!payout) throw new Error(`Payout introuvable: ${payoutStripeId}`)
  if (payout.qb_deposit_id) throw new Error(`Déjà envoyé à QB (Deposit ID: ${payout.qb_deposit_id})`)

  const { deposit, summary, warnings, exchangeRate, deferredFactures, directlyRecognizedFactures } = await buildDepositFromPayout(payoutStripeId)
  const result = await qbPost('/deposit', deposit)
  let created = result.Deposit
  const qbId = created.Id

  // Reconcile per-line tax rounding : QB peut arrondir TPS/TVQ séparément ou en
  // combiné, en half-up ou banker, ce qui produit un écart de ±0,01 à ±0,03 entre
  // sum(line.Amount) + QB_taxes et le payout réel. Le code n'est pas exposé par
  // l'API : on relit TotalAmt persisté et on patche le Deposit avec une ligne
  // d'ajustement si écart. Le résultat : TotalAmt = payout.amount au cent près.
  //
  // ⚠️ La réponse POST /deposit peut renvoyer un TotalAmt différent du persisté
  // (observé en prod : POST = 15194.26, GET ultérieur = 15194.27). On force donc
  // un GET après POST pour avoir le total réel et le SyncToken courant.
  const expectedTotal = Math.round(payout.amount * 100) / 100
  let persistedTotal
  let syncToken = created.SyncToken
  let persistedLines = created.Line || []
  try {
    const verify = await qbGet(`/deposit/${qbId}`)
    persistedTotal = Math.round(Number(verify.Deposit.TotalAmt || 0) * 100) / 100
    syncToken = verify.Deposit.SyncToken
    persistedLines = verify.Deposit.Line || persistedLines
  } catch (e) {
    persistedTotal = Math.round(Number(created.TotalAmt || 0) * 100) / 100
    warnings.push(`Lecture Deposit après push échouée — fallback sur TotalAmt POST: ${e.message}`)
  }
  const delta = Math.round((expectedTotal - persistedTotal) * 100) / 100
  console.log(`[push-deposit] payout=${payoutStripeId} expected=${expectedTotal} persisted=${persistedTotal} delta=${delta}`)

  // Garde-fou : l'« arrondi de taxes » ne doit éponger que du bruit d'arrondi (quelques
  // centimes). Un delta > 5 $ signale une vraie taxe mal capturée en amont (charge dont
  // la taxe n'a pas été soustraite du HT, fee non buckété…) qui se déverserait en bloc
  // dans la ligne d'ajustement. On refuse de publier : on supprime le dépôt qu'on vient
  // de créer (non réconcilié → supprimable) et on lève une erreur. qb_deposit_id n'est
  // pas encore écrit en DB, donc le payout reste republiable après correction.
  const TAX_ROUNDING_MAX = 5
  if (Math.abs(delta) > TAX_ROUNDING_MAX) {
    let cleanup = ''
    try {
      await qbPost('/deposit?operation=delete', { Id: qbId, SyncToken: syncToken })
    } catch (e) {
      cleanup = ` ⚠️ Le dépôt ${qbId} a été créé dans QuickBooks mais n'a PAS pu être supprimé (${e.message}) — le supprimer manuellement avant de réessayer.`
    }
    throw new Error(
      `Dépôt non publié : l'ajustement d'arrondi de taxes serait de ${delta.toFixed(2)} $ ` +
      `(plafond ${TAX_ROUNDING_MAX} $). Cela indique une taxe mal ventilée sur une charge ` +
      `du payout — vérifier/corriger la classification de taxe (tax_rate Stripe → code QB) ` +
      `avant de republier ce payout.${cleanup}`
    )
  }

  if (Math.abs(delta) >= 0.01) {
    const accounts = await resolveQBStripeAccounts()
    const adjustmentLine = {
      Amount: delta,
      DetailType: 'DepositLineDetail',
      DepositLineDetail: {
        AccountRef: { value: accounts.fees },
        TaxCodeRef: { value: '3' },     // Exonéré Achats — 0% pour ne rien recalculer
        TaxApplicableOn: 'Purchase',
      },
      Description: `Ajustement d'arrondi taxes (${delta >= 0 ? '+' : ''}${delta.toFixed(2)})`,
    }
    try {
      // Sparse update : Id + SyncToken obligatoires, Line remplace l'array complet.
      // QB exige aussi DepositToAccountRef, TxnDate, CurrencyRef en sparse update
      // (validé empiriquement — ValidationFault 2020 sinon). On évite les champs
      // read-only (TotalAmt, MetaData…) qui font rejeter la requête.
      const updateBody = {
        Id: qbId,
        SyncToken: syncToken,
        sparse: true,
        DepositToAccountRef: created.DepositToAccountRef,
        TxnDate: created.TxnDate,
        CurrencyRef: created.CurrencyRef,
        ...(created.ExchangeRate ? { ExchangeRate: created.ExchangeRate } : {}),
        ...(created.GlobalTaxCalculation ? { GlobalTaxCalculation: created.GlobalTaxCalculation } : {}),
        ...(created.PrivateNote ? { PrivateNote: created.PrivateNote } : {}),
        Line: [...persistedLines, adjustmentLine],
      }
      const updated = await qbPost('/deposit', updateBody)
      created = updated.Deposit
      console.log(`[push-deposit] payout=${payoutStripeId} adjustment ${delta.toFixed(2)} appliqué — nouveau TotalAmt=${created.TotalAmt}`)
    } catch (e) {
      warnings.push(`Ajustement d'arrondi de ${delta.toFixed(2)} non appliqué — Deposit reste à ${persistedTotal.toFixed(2)} (vs payout ${expectedTotal.toFixed(2)}): ${e.message}`)
    }
  }

  db.prepare("UPDATE stripe_payouts SET qb_deposit_id=?, qb_pushed_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE stripe_id=?")
    .run(qbId, payoutStripeId)

  // Marque les factures publiées en revenu reçu d'avance (passif 23900). À l'expédition,
  // postRevenueRecognitionJE poste Dr 23900 / Cr 40000 pour libérer le passif vers Ventes.
  // Idempotent : on ne réécrit pas si déjà set.
  const stmt = db.prepare(`
    UPDATE factures
    SET deferred_revenue_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        deferred_revenue_amount_native = ?,
        deferred_revenue_amount_cad = ?,
        deferred_revenue_currency = ?,
        deferred_revenue_qb_ref = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ? AND deferred_revenue_at IS NULL
  `)
  const qbRef = `deposit:${qbId}`
  for (const f of deferredFactures) {
    const cad = Math.round(f.amount_native * (exchangeRate || 1) * 100) / 100
    stmt.run(f.amount_native, cad, f.currency, qbRef, f.factureId)
  }

  // Marque les factures dont la vente vient d'être constatée par la ligne 40000 du
  // Deposit (cas charge Stripe sur commande déjà expédiée + soldée au moment du push).
  // revenue_recognized_je_id reste NULL puisqu'il n'y a pas de JournalEntry séparée —
  // le lien comptable côté UI passera par stripe_balance_transactions → stripe_payouts.qb_deposit_id.
  // Idempotent : ne réécrit pas si revenue_recognized_at est déjà posé (cas où une JE
  // a été postée manuellement avant le push, scénario rare).
  const stmtDirect = db.prepare(`
    UPDATE factures
    SET revenue_recognized_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ? AND revenue_recognized_at IS NULL
  `)
  for (const f of directlyRecognizedFactures) {
    stmtDirect.run(f.factureId)
  }

  return { qb_deposit_id: qbId, summary, warnings }
}

// Pose l'écriture comptable de l'encaissement d'un paiement HORS-STRIPE (chèque,
// virement, Interac, comptant). Les paiements Stripe sont gérés au payout (lundi)
// via pushDepositFromPayout — postPaymentDeposit n'est pas appelée pour eux.
//
// Création d'un Deposit QB :
//   DepositToAccountRef = Banque réelle (BNC CAD ou Venn USD)
//   Line.AccountRef selon l'état de la facture :
//     - revenue_recognized_at posé → AR (12000/12100) — solde l'AR ouvert par
//       le constat à l'expédition. Pas de TaxCode (taxe déjà constatée).
//     - kind='subscription'      → 41000 Revenus de service — constate le revenu.
//                                   TaxCodeRef pour ventiler TPS/TVQ/TVH.
//     - sinon (revenu différé)   → 23900 Revenus perçus d'avance — passif libéré
//                                   à l'expédition par postRevenueRecognitionJE.
//                                   TaxCodeRef idem.
//
// Idempotent : la ligne payments porte qb_deposit_id. Les rows historiques
// gardent qb_journal_entry_id (ancien JE) ou qb_payment_id (ancien SalesReceipt).
// Construit le Deposit QB d'un encaissement HORS-STRIPE sans le poster. Sert
// de base commune à postPaymentDeposit (qui poste) et previewPaymentDeposit
// (aperçu UI « comme les Stripe payouts » — aucun side effect QB : le client
// n'est pas créé s'il manque, on passe qbCustomerId=null).
// Params : { factureId, amount (TTC), currency, method, receivedAt,
//            exchangeRate?, taxCodeId?, invoice?, qbCustomerId? }.

// Mémo lisible pour le Deposit (PrivateNote + Description de ligne) : méthode en
// français + client + numéro de facture, sans jargon comptable — les comptes sont
// déjà visibles dans l'écriture QB elle-même.
const PAYMENT_METHOD_LABELS = {
  stripe: 'Paiement Stripe',
  cheque: 'Chèque',
  virement_bancaire: 'Virement bancaire',
  interac: 'Virement Interac',
  comptant: 'Paiement comptant',
  autre: 'Paiement',
}
function buildPaymentMemo(method, f) {
  const label = PAYMENT_METHOD_LABELS[method] || 'Paiement'
  const client = f.company_name ? ` de ${f.company_name}` : ''
  return `${label}${client} — facture ${f.document_number || f.id}`
}

export async function buildPaymentDeposit(params) {
  const f = db.prepare(`
    SELECT f.id, f.document_date, f.document_number, f.status, f.kind, f.currency,
           f.revenue_recognized_at, f.deferred_revenue_at, f.amount_before_tax_cad,
           f.total_amount, f.subscription_id, f.invoice_id AS stripe_invoice_id,
           c.name AS company_name
    FROM factures f LEFT JOIN companies c ON c.id = f.company_id
    WHERE f.id = ?
  `).get(params.factureId)
  if (!f) throw new Error('Facture introuvable')
  assertFactureEligibleForQbWrite(f)

  const warnings = []
  const accounts = await resolveQBStripeAccounts()
  const currency = (params.currency || f.currency || 'CAD').toUpperCase()
  const amount = Math.round(Number(params.amount) * 100) / 100
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Montant invalide')
  const method = params.method || 'autre'

  const txnDate = (params.receivedAt || new Date().toISOString()).slice(0, 10)
  let exchangeRate = params.exchangeRate || 1
  if (currency === 'USD' && (!exchangeRate || exchangeRate === 1)) {
    exchangeRate = await getUsdCadRate(txnDate)
    if (!exchangeRate) throw new Error(`Taux USD→CAD indisponible pour ${txnDate}`)
  }

  const bankAccountId = currency === 'USD' ? accounts.bank_usd : accounts.bank_cad

  // Choix du compte crédité + faut-il appliquer un TaxCode.
  let creditAccountId, creditLabel, applyTax
  if (f.revenue_recognized_at) {
    creditAccountId = currency === 'USD' ? accounts.accounts_receivable_usd : accounts.accounts_receivable_cad
    creditLabel = `Comptes clients ${currency} (solde AR)`
    applyTax = false
  } else if (f.kind === 'subscription') {
    creditAccountId = accounts.revenue_subscription
    creditLabel = 'Revenus de service (41000)'
    applyTax = true
  } else {
    creditAccountId = accounts.revenue_deferred
    creditLabel = 'Revenus perçus d\'avance (23900)'
    applyTax = true
  }

  let taxCodeId = null
  let invoiceForTax = null
  if (applyTax) {
    invoiceForTax = params.invoice || null
    if (!invoiceForTax && f.stripe_invoice_id) {
      try { invoiceForTax = await getStripeClient().invoices.retrieve(f.stripe_invoice_id) }
      catch (e) { console.error(`Invoice Stripe non récupérée pour facture ${f.id}:`, e.message) }
    }
    taxCodeId = params.taxCodeId || null
    if (!taxCodeId && invoiceForTax) {
      taxCodeId = await resolveTaxCodeForInvoice(invoiceForTax)
    }
    if (!taxCodeId) {
      warnings.push('Aucun code de taxe résolu — le Deposit sera posté sans ventilation TPS/TVQ')
    }
  }

  // amount est le montant reçu en TTC. Avec TaxCodeRef + TaxApplicableOn='Sales' et
  // GlobalTaxCalculation='TaxExcluded', QB interprète Line.Amount comme HT et ajoute la
  // taxe en sus — le Deposit serait gonflé du montant de la taxe. On déduit donc le HT
  // via le ratio subtotal/total (invoice Stripe, sinon totaux facture) pour que QB
  // recalcule la taxe et que le total du Deposit retombe sur le TTC reçu.
  let lineAmount = amount
  if (taxCodeId) {
    let subtotal = null, total = null
    if (invoiceForTax?.subtotal != null && invoiceForTax?.total != null) {
      subtotal = invoiceForTax.subtotal / 100
      total = invoiceForTax.total / 100
    } else if (f.amount_before_tax_cad && f.total_amount) {
      subtotal = f.amount_before_tax_cad
      total = f.total_amount
    }
    if (total > 0 && subtotal > 0 && Math.abs(subtotal - total) > 0.001) {
      lineAmount = Math.round(amount * (subtotal / total) * 100) / 100
    }
  }

  const lineDetail = { AccountRef: { value: creditAccountId } }
  // Entity sur DepositLineDetail utilise le format { value, type } (différent du
  // JournalEntryLineDetail.Entity qui exige { Type, EntityRef.value }).
  if (params.qbCustomerId) lineDetail.Entity = { value: String(params.qbCustomerId), type: 'Customer' }
  if (taxCodeId) {
    lineDetail.TaxCodeRef = { value: taxCodeId }
    lineDetail.TaxApplicableOn = 'Sales'
  }

  const deposit = {
    TxnDate: txnDate,
    DepositToAccountRef: { value: bankAccountId },
    CurrencyRef: { value: currency },
    ExchangeRate: exchangeRate,
    GlobalTaxCalculation: 'TaxExcluded',
    PrivateNote: buildPaymentMemo(method, f),
    Line: [
      {
        DetailType: 'DepositLineDetail',
        Amount: lineAmount,
        Description: buildPaymentMemo(method, f),
        DepositLineDetail: lineDetail,
      },
    ],
  }
  if (taxCodeId) deposit.TxnTaxDetail = { TxnTaxCodeRef: { value: taxCodeId } }

  return {
    deposit, facture: f, warnings,
    bankAccountId, creditAccountId, creditLabel, taxCodeId,
    amount, lineAmount, currency, exchangeRate, txnDate,
  }
}

// Aperçu du Deposit d'un encaissement hors-Stripe pour l'UI (sous-section
// « Dépôts directs » de Stripe Payouts) — même contrat visuel que
// buildDepositFromPayout : payload + summary + warnings, AUCUNE écriture (ni
// QB, ni DB ; le client QB manquant devient un warning au lieu d'être créé).
export async function previewPaymentDeposit(params) {
  const company = db.prepare(`
    SELECT c.name, c.quickbooks_customer_id, c.quickbooks_customer_id_usd
    FROM factures f JOIN companies c ON c.id = f.company_id
    WHERE f.id = ?
  `).get(params.factureId)
  const isUsd = String(params.currency || 'CAD').toUpperCase() === 'USD'
  const qbCustomerId = company ? (isUsd ? company.quickbooks_customer_id_usd : company.quickbooks_customer_id) : null

  const b = await buildPaymentDeposit({ ...params, qbCustomerId })
  if (!company) {
    b.warnings.push('Aucune company liée à la facture — le push échouera tant qu\'un client n\'est pas associé')
  } else if (!qbCustomerId) {
    b.warnings.push(`Client QB « ${company.name} » (${isUsd ? 'USD' : 'CAD'}) inexistant — il sera créé au moment du push`)
  }

  const accountsCache = await loadAccountsCache()
  const label = (id) => {
    const a = id ? accountsCache.byId.get(String(id)) : null
    return a ? (a.acctNum ? `${a.acctNum} ${a.name}` : a.name) : null
  }
  let taxCodeName = null
  if (b.taxCodeId) {
    try { taxCodeName = await resolveTaxCodeNameById(b.taxCodeId) } catch { taxCodeName = `#${b.taxCodeId}` }
  }

  return {
    deposit: b.deposit,
    summary: {
      document_number: b.facture.document_number,
      customer_name: company?.name || null,
      amount: b.amount,
      currency: b.currency,
      txn_date: b.txnDate,
      exchange_rate: b.exchangeRate,
      bank_account: label(b.bankAccountId),
      credit_account: label(b.creditAccountId) || b.creditLabel,
      credit_label: b.creditLabel,
      tax_code: taxCodeName,
      line_ht: b.lineAmount,
      taxes: Math.round((b.amount - b.lineAmount) * 100) / 100,
    },
    warnings: b.warnings,
  }
}

export async function postPaymentDeposit(paymentId, options = {}) {
  const p = db.prepare(`
    SELECT p.*, f.id AS facture_id
    FROM payments p
    JOIN factures f ON f.id = p.facture_id
    WHERE p.id = ?
  `).get(paymentId)
  if (!p) throw new Error('Paiement introuvable')
  if (p.qb_deposit_id || p.qb_journal_entry_id || p.qb_payment_id) {
    return {
      qb_deposit_id: p.qb_deposit_id,
      qb_journal_entry_id: p.qb_journal_entry_id,
      qb_payment_id: p.qb_payment_id,
      skipped: true,
    }
  }
  if (p.direction !== 'in') throw new Error('postPaymentDeposit attend direction=in')
  if (p.method === 'stripe') {
    return { skipped: 'paiement Stripe — comptabilisé au payout (pushDepositFromPayout)' }
  }

  const currency = (p.currency || 'CAD').toUpperCase()
  const customer = await resolveQbCustomerForFacture(p.facture_id, currency)
  if (!customer) throw new Error('Pas de client QB associé à la facture (companies.id manquante)')

  const { deposit, facture, amount, lineAmount, exchangeRate, creditLabel } = await buildPaymentDeposit({
    factureId: p.facture_id,
    amount: p.amount,
    currency,
    method: p.method,
    receivedAt: p.received_at,
    exchangeRate: p.exchange_rate,
    taxCodeId: options.taxCodeId,
    invoice: options.invoice,
    qbCustomerId: customer.id,
  })

  const result = await qbPost('/deposit', deposit)
  const depositId = String(result.Deposit?.Id || '')
  if (!depositId) throw new Error('QB n\'a pas retourné d\'Id pour le Deposit')

  db.prepare(`
    UPDATE payments
    SET qb_deposit_id = ?,
        amount_cad = ?,
        exchange_rate = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(depositId, Math.round(amount * exchangeRate * 100) / 100, exchangeRate, paymentId)

  // Pour les commandes non encore constatées, mémoriser deferred sur la facture
  // (postRevenueRecognitionJE libère ce passif à l'expédition : Dr 23900 / Cr 40000).
  // Stocker en HT (= lineAmount quand la taxe a été appliquée) pour rester cohérent
  // avec le path Stripe (pushDepositFromPayout enregistre netRevenueAmount = HT).
  if (!facture.revenue_recognized_at && facture.kind !== 'subscription' && !facture.deferred_revenue_at) {
    db.prepare(`
      UPDATE factures
      SET deferred_revenue_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          deferred_revenue_amount_native = ?,
          deferred_revenue_amount_cad = ?,
          deferred_revenue_currency = ?,
          deferred_revenue_qb_ref = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(lineAmount, Math.round(lineAmount * exchangeRate * 100) / 100, currency, `deposit:${depositId}`, p.facture_id)
  }

  return { qb_deposit_id: depositId, amount, currency, credit_account: creditLabel }
}

// Alias rétrocompatible — l'ancien nom est encore importé par routes/admin.js.
// Sera retiré quand tous les call sites auront migré.
export const postInvoicePaidJE = postPaymentDeposit

// HT réel d'une facture encaissée via Stripe : montant de la charge moins les
// taxes de la facture. Ventilation classifyTaxRate (invoice_tax_gst/qst) en
// premier, sinon somme des tax_details (même filet défensif que
// buildDepositFromPayout pour les tax_rates au libellé non reconnu, ex. TVH ON).
// null si aucune charge liée — le caller garde alors son montant d'origine.
function stripeChargeHtForFacture(invoiceId) {
  if (!invoiceId) return null
  const bt = db.prepare(`
    SELECT amount, invoice_tax_gst, invoice_tax_qst, tax_details
    FROM stripe_balance_transactions
    WHERE stripe_invoice_id = ? AND type = 'charge'
    ORDER BY created_date DESC LIMIT 1
  `).get(invoiceId)
  if (!bt) return null
  let tax = (bt.invoice_tax_gst || 0) + (bt.invoice_tax_qst || 0)
  if (tax === 0 && bt.tax_details && bt.tax_details !== '[]') {
    try {
      const cents = JSON.parse(bt.tax_details).reduce((s, t) => s + (Number(t.amount) || 0), 0)
      if (cents > 0) tax = Math.round(cents) / 100
    } catch {}
  }
  return Math.round((bt.amount - tax) * 100) / 100
}

// Crée un Journal Entry dans QB pour reconnaître la vente d'une facture liée à
// une commande, déclenché à l'expédition. Trois cas selon l'état de la facture :
//
//   1. Encaissée avant l'expédition (deferred_revenue_at posé) :
//        DR 23900 Revenus perçus d'avance        (libère le passif)
//            CR 40000 Ventes                     (constate le revenu)
//
//   2. Non encaissée à l'expédition (deferred_revenue_at null) :
//        DR 12000 / 12100 Comptes clients (selon devise)   (ouvre l'AR)
//            CR 40000 Ventes
//
// Montant : HT dans la devise de la facture. Idempotent via revenue_recognized_at.
// N'agit que sur les factures kind='order' — les abonnements sont constatés
// directement à invoice.paid (postPaymentDeposit crédite 41000), pas à l'expédition.
export async function postRevenueRecognitionJE(factureId, options = {}) {
  const f = db.prepare(`
    SELECT id, document_number, document_date, status, kind, currency, total_amount, amount_before_tax_cad,
           deferred_revenue_at, deferred_revenue_amount_native, deferred_revenue_currency,
           revenue_recognized_at, revenue_recognized_je_id, company_id, invoice_id
    FROM factures WHERE id = ?
  `).get(factureId)
  if (!f) throw new Error('Facture introuvable')
  if (f.kind === 'subscription') throw new Error('Constat à l\'expédition non applicable aux abonnements')
  if (f.status === 'Void') throw new Error(`Facture #${f.document_number || f.id} annulée (status=Void) — constatation bloquée`)
  assertFactureEligibleForQbWrite(f, { bypassCutoff: options.bypassCutoff === true })
  // bypassShipmentCheck=true quand on déclenche depuis le toggle « Envoyée »
  // forcé manuellement (facture sans matériel physique).
  if (!options.bypassShipmentCheck && !factureHasLinkedShipment(f.id)) {
    throw new Error('Aucun envoi sur une commande liée — la vente ne peut pas encore être constatée')
  }

  // Claim atomique : pose revenue_recognized_at AVANT le POST QB pour éviter le
  // race condition quand plusieurs appels concurrents (sync Airtable, shipments,
  // novoxpress) ciblent la même facture. Un seul caller gagne ; les autres voient
  // changes=0 et sortent en early-return. Si le POST QB échoue, on rollback le
  // claim (revenue_recognized_at = NULL) pour permettre une nouvelle tentative.
  const claim = db.prepare(`
    UPDATE factures
    SET revenue_recognized_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ? AND revenue_recognized_at IS NULL
  `).run(factureId)
  if (claim.changes === 0) {
    const existing = db.prepare('SELECT revenue_recognized_je_id FROM factures WHERE id = ?').get(factureId)
    throw new Error(`Vente déjà constatée (JE ${existing?.revenue_recognized_je_id || '?'})`)
  }

  // Tout ce qui suit le claim DOIT pouvoir rollback (UPDATE revenue_recognized_at=NULL)
  // si une exception remonte AVANT que le POST QB ait eu lieu. Dès qu'un JE existe en
  // QB, le rollback est interdit : on ne doit jamais remettre la facture éligible alors
  // qu'un JE a déjà été posé, sous peine de double constatation au prochain run.
  let postedJeId = null
  try {
    // Comptes standards + overrides utilisateur (automation sys_revenue_recognition).
    const accounts = await resolveRevenueRecognitionAccounts()

    // Choix du compte de débit selon l'état d'encaissement RÉEL de la facture.
    //
    //   - Commande payée (status 'Payé')  → 23900 « Revenus perçus d'avance ».
    //     Le client a déjà réglé (via Stripe) : la contrepartie du revenu constaté est
    //     toujours le passif déféré, jamais les comptes clients — même si le payout
    //     Stripe n'a pas encore été déposé en QB (donc deferred_revenue_at encore NULL
    //     au moment du constat). C'est le cas du constat-first : l'expédition précède
    //     l'arrivée du payout. Voir modèle comptable Stripe ↔ QB.
    //   - Commande non payée (À payer / En retard) → comptes clients (12000/12100) :
    //     vente à crédit, le paiement (manuel) viendra solder l'AR.
    //
    // deferred_revenue_at force aussi le pivot 23900 (passif déjà matérialisé par le
    // Deposit du payout, cas normal où le payout précède l'expédition).
    const useDeferred = !!f.deferred_revenue_at || (f.kind === 'order' && f.status === 'Payé')
    let amount, currency
    if (f.deferred_revenue_at) {
      if (!f.deferred_revenue_amount_native) throw new Error('Montant déféré inconnu — relance le push du payout')
      amount = Math.round(f.deferred_revenue_amount_native * 100) / 100
      currency = f.deferred_revenue_currency || 'CAD'
      // Garde-fou HT : le constat de vente porte toujours sur le montant avant
      // taxes. Certains montants déférés stockés avant le fix TVH du push de
      // payout incluent la taxe (TTC) — on recoupe avec la charge Stripe et on
      // constate le HT réel si le montant stocké le dépasse.
      const ht = stripeChargeHtForFacture(f.invoice_id)
      if (ht != null && ht > 0 && amount > ht + 0.01) amount = ht
    } else {
      // Montant HT de la facture (amount_before_tax_cad porte le subtotal dans la devise
      // native, malgré son nom historique). Devise = facture.currency.
      if (!f.amount_before_tax_cad) throw new Error('Montant HT inconnu sur la facture')
      amount = Math.round(f.amount_before_tax_cad * 100) / 100
      currency = f.currency || 'CAD'
    }

    const today = new Date().toISOString().slice(0, 10)
    let exchangeRate = 1
    if (currency === 'USD') {
      exchangeRate = await getUsdCadRate(today)
      if (!exchangeRate) throw new Error(`Taux USD→CAD indisponible pour ${today}`)
    }

    const debitAccountId = useDeferred
      ? accounts.revenue_deferred
      : (currency === 'USD' ? accounts.accounts_receivable_usd : accounts.accounts_receivable_cad)
    const debitLabel = useDeferred ? 'Revenus perçus d\'avance' : `Comptes clients ${currency}`

    // Customer tracking — Entity sur les deux lignes pour rapports par client.
    // Pas de TaxCodeRef ici : la taxe a déjà été constatée à l'encaissement (postPaymentDeposit).
    // Le constat de vente reste sur le HT seulement.
    const customer = await resolveQbCustomerForFacture(f.id, currency)
    const entityRef = customer ? { Type: 'Customer', EntityRef: { value: String(customer.id) } } : null

    const debitDetail = { PostingType: 'Debit', AccountRef: { value: debitAccountId } }
    const creditDetail = { PostingType: 'Credit', AccountRef: { value: accounts.revenue_sale } }
    if (entityRef) {
      debitDetail.Entity = entityRef
      creditDetail.Entity = entityRef
    }

    const je = {
      TxnDate: today,
      CurrencyRef: { value: currency },
      ExchangeRate: exchangeRate,
      PrivateNote: `Constatation de vente — facture #${f.document_number || f.id} (envoi effectué, ${debitLabel})`,
      Line: [
        {
          DetailType: 'JournalEntryLineDetail',
          Amount: amount,
          Description: `Constatation #${f.document_number || f.id}`,
          JournalEntryLineDetail: debitDetail,
        },
        {
          DetailType: 'JournalEntryLineDetail',
          Amount: amount,
          Description: `Constatation #${f.document_number || f.id}`,
          JournalEntryLineDetail: creditDetail,
        },
      ],
    }
    const result = await qbPost('/journalentry', je)
    const jeId = result.JournalEntry?.Id
    if (!jeId) throw new Error('QB n\'a pas retourné d\'Id pour le JournalEntry')
    postedJeId = String(jeId)

    // Le claim est déjà posé (revenue_recognized_at). On persiste le je_id IMMÉDIATEMENT
    // après le POST, AVANT tout update dépendant (deferred), pour fermer la fenêtre
    // d'orphelin : si un update suivant plante, le lien facture↔JE est déjà en DB.
    db.prepare(`
      UPDATE factures
      SET revenue_recognized_je_id = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(postedJeId, factureId)

    // Constat-first sur commande payée : on vient de débiter 23900 alors que le Deposit
    // du payout Stripe n'est pas encore poussé (deferred_revenue_at était NULL). On
    // matérialise le passif 23900 sur la facture pour que buildDepositFromPayout crédite
    // 23900 (et non les comptes clients) quand il déposera le payout — sinon le passif
    // posé ici resterait ouvert et les livres ne balanceraient pas. Idempotent.
    if (useDeferred && !f.deferred_revenue_at) {
      db.prepare(`
        UPDATE factures
        SET deferred_revenue_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            deferred_revenue_amount_native = ?,
            deferred_revenue_amount_cad = ?,
            deferred_revenue_currency = ?,
            deferred_revenue_qb_ref = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ? AND deferred_revenue_at IS NULL
      `).run(
        amount,
        Math.round(amount * exchangeRate * 100) / 100,
        currency,
        `recognition:${jeId}`,
        factureId,
      )
    }

    return { qb_journal_entry_id: String(jeId), amount, currency, debit_account: debitLabel }
  } catch (err) {
    if (postedJeId) {
      // Le JE existe déjà en QB : interdit de rollback le claim (sinon double constat
      // au prochain run). On (re)tente en best-effort la persistance du je_id pour
      // garantir le lien facture↔JE — si l'UPDATE post-POST avait planté, ce filet
      // referme la fenêtre d'orphelin — puis on remonte l'erreur d'origine.
      try {
        db.prepare(`
          UPDATE factures
          SET revenue_recognized_je_id = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ? AND revenue_recognized_je_id IS NULL
        `).run(postedJeId, factureId)
      } catch { /* best-effort : le claim reste posé, le JE est lié ou le sera à l'audit */ }
      throw err
    }
    // Aucun POST QB n'a eu lieu — rollback du claim, la facture redevient éligible.
    db.prepare(`
      UPDATE factures
      SET revenue_recognized_at = NULL,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND revenue_recognized_je_id IS NULL
    `).run(factureId)
    throw err
  }
}

// Pose la JE de remboursement, selon l'état comptable de la facture d'origine au
// moment du refund. Trois cas (commande), un cas (abonnement) :
//
//   1. Refund AVANT constat (commande, deferred posé) :
//        DR 23900 Revenus perçus d'avance        (annule le passif)
//            CR 12900 Fonds non déposés          (ou banque pour refund hors-Stripe)
//
//   2. Refund APRÈS constat, AR encore ouvert :
//        DR 40000 Ventes                         (contre-passe le revenu)
//            CR Comptes clients (CAD/USD)        (annule le AR — la balance due remonte)
//
//   3. Refund APRÈS constat, AR soldé :
//        DR 40000 Ventes
//            CR 12900 Fonds non déposés          (ou banque)
//
//   4. Refund d'un abonnement (toujours post-constat) :
//        DR 41000 Revenus de service
//            CR 12900 Fonds non déposés          (ou banque)
//
// La fonction prend un payment_id (direction='out') déjà créé en DB et pose la JE
// QB associée. Idempotent via payments.qb_journal_entry_id.
export async function processRefund(paymentId, options = {}) {
  const p = db.prepare(`
    SELECT p.*, f.id AS facture_id, f.document_date AS facture_document_date,
           f.status AS facture_status, f.kind, f.currency AS facture_currency,
           f.document_number, f.revenue_recognized_at, f.deferred_revenue_at,
           f.balance_due, f.invoice_id AS stripe_invoice_id
    FROM payments p
    JOIN factures f ON f.id = p.facture_id
    WHERE p.id = ?
  `).get(paymentId)
  if (!p) throw new Error('Paiement introuvable')
  if (p.direction !== 'out') throw new Error('processRefund attend direction=out')
  assertFactureEligibleForQbWrite({
    document_date: p.facture_document_date,
    document_number: p.document_number,
    id: p.facture_id,
  })
  if (p.qb_payment_id || p.qb_journal_entry_id) {
    return { qb_payment_id: p.qb_payment_id, qb_journal_entry_id: p.qb_journal_entry_id, skipped: true }
  }
  if (p.method === 'stripe') {
    return { skipped: 'refund Stripe — comptabilisé au payout (pushDepositFromPayout)' }
  }

  const accounts = await resolveQBStripeAccounts()
  const currency = p.currency || p.facture_currency || 'CAD'
  const amount = Math.round(Math.abs(p.amount) * 100) / 100  // valeur absolue (signe via direction)
  const txnDate = (p.received_at || new Date().toISOString()).slice(0, 10)
  let exchangeRate = p.exchange_rate || 1
  if (currency === 'USD' && (!exchangeRate || exchangeRate === 1)) {
    exchangeRate = await getUsdCadRate(txnDate)
    if (!exchangeRate) throw new Error(`Taux USD→CAD indisponible pour ${txnDate}`)
  }

  const customer = await resolveQbCustomerForFacture(p.facture_id, currency)
  if (!customer) throw new Error('Pas de client QB associé à la facture')

  // ── Cas AR ouvert post-constat : reste en JE (cash n'a pas bougé) ─────
  // L'argent n'a pas bougé — le refund restaure la dette. JE simple ;
  // TaxCodeRef sur JE ne fonctionne pas en QB, donc taxes non annulées
  // automatiquement (cas rare, à ajuster manuellement si nécessaire).
  if (p.revenue_recognized_at && (p.balance_due || 0) > 0) {
    const taxCodeForJe = await _resolveTaxCodeForFacturePayment(p)
    return await _postRefundJE({
      paymentId, amount, currency, exchangeRate, txnDate,
      debitAccountId: accounts.revenue_sale,
      debitLabel: 'Ventes (contre-revenu, AR rouvert)',
      creditAccountId: currency === 'USD' ? accounts.accounts_receivable_usd : accounts.accounts_receivable_cad,
      creditLabel: `Comptes clients ${currency}`,
      docNumber: p.document_number, factureId: p.facture_id,
      taxCodeId: taxCodeForJe, customerId: customer.id,
    })
  }

  // ── Refund Receipt : symétrique du Sales Receipt ──────────────────────
  // QB poste auto :
  //   Cr DepositToAccountRef (12900 ou Banque selon canal) du TTC (cash sort)
  //   Dr Item.IncomeAccountRef (23900 si order, 41000 si sub) du HT (annule revenu)
  //   Dr "TPS/TVQ à payer" du montant taxe (annule la taxe perçue, via TaxCodeRef)
  const items = await resolveQBStripeItems()
  const itemId = p.kind === 'subscription' ? items.subscription : items.order
  const debitLabel = p.kind === 'subscription' ? 'Revenus de service (41000)' : 'Revenus perçus d\'avance (23900)'

  // Compte de crédit (d'où sort le cash) : 12900 si refund Stripe, banque sinon.
  const isStripe = p.method === 'stripe'
  const creditAccountId = isStripe
    ? accounts.undeposited_funds
    : (currency === 'USD' ? accounts.bank_usd : accounts.bank_cad)
  const creditLabel = isStripe ? 'Fonds non déposés' : `Banque ${currency}`

  // Charger l'invoice Stripe pour résoudre le TaxCode (annule les taxes perçues).
  let invoiceForTax = options.invoice || null
  if (!invoiceForTax && p.stripe_invoice_id) {
    try { invoiceForTax = await getStripeClient().invoices.retrieve(p.stripe_invoice_id) }
    catch (e) { console.error(`Invoice Stripe non récupérée pour refund ${p.facture_id}:`, e.message) }
  }
  let taxCodeId = options.taxCodeId || null
  if (!taxCodeId && invoiceForTax) {
    taxCodeId = await resolveTaxCodeForInvoice(invoiceForTax)
  }

  // payment.amount stocke le montant remboursé en TTC (cash réellement sorti via Stripe).
  // Pour le RR en mode TaxExcluded, l'UnitPrice doit être en HT — sinon QB ajoute la taxe
  // par-dessus et le total enfle. On déduit le HT via le ratio subtotal/total de l'invoice
  // d'origine. Refund total → HT = subtotal. Refund partiel → HT = (amount/total) × subtotal.
  let unitPriceHt = amount
  if (taxCodeId && invoiceForTax) {
    const subtotal = (invoiceForTax.subtotal || 0) / 100
    const total = (invoiceForTax.total || 0) / 100
    if (total > 0 && subtotal > 0 && Math.abs(subtotal - total) > 0.001) {
      unitPriceHt = Math.round(amount * (subtotal / total) * 100) / 100
    }
  }

  const lineDetail = {
    ItemRef: { value: String(itemId) },
    Qty: 1,
    UnitPrice: unitPriceHt,
  }
  if (taxCodeId) lineDetail.TaxCodeRef = { value: taxCodeId }

  const rr = {
    TxnDate: txnDate,
    CustomerRef: { value: String(customer.id) },
    CurrencyRef: { value: currency },
    ExchangeRate: exchangeRate,
    DepositToAccountRef: { value: creditAccountId },
    GlobalTaxCalculation: 'TaxExcluded',
    PrivateNote: `Remboursement Stripe — facture #${p.document_number || p.facture_id} (Dr ${debitLabel} → Cr ${creditLabel})`,
    Line: [
      {
        DetailType: 'SalesItemLineDetail',
        Amount: unitPriceHt,
        Description: `Remboursement #${p.document_number || p.facture_id}`,
        SalesItemLineDetail: lineDetail,
      },
    ],
  }
  if (taxCodeId) rr.TxnTaxDetail = { TxnTaxCodeRef: { value: taxCodeId } }

  const result = await qbPost('/refundreceipt', rr)
  const rrId = String(result.RefundReceipt?.Id || '')
  if (!rrId) throw new Error('QB n\'a pas retourné d\'Id pour le RefundReceipt')

  db.prepare(`
    UPDATE payments
    SET qb_payment_id = ?,
        amount_cad = ?,
        exchange_rate = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(rrId, Math.round(amount * exchangeRate * 100) / 100, exchangeRate, paymentId)

  return { qb_payment_id: rrId, amount, currency, debit: debitLabel, credit: creditLabel }
}

// Helper : résout le QB TaxCode pour une ligne payments dont la facture a un invoice Stripe.
// Retourne null si pas de Stripe invoice (paiement manuel hors-Stripe sur une facture
// purement locale) — auquel cas la JE est posée sans TaxCodeRef et l'admin peut compléter.
async function _resolveTaxCodeForFacturePayment(p) {
  if (!p.stripe_invoice_id && !p.facture_id) return null
  // Le SELECT dans processRefund ne retourne pas stripe_invoice_id ; on le fetch.
  const stripeInvoiceId = p.stripe_invoice_id || db.prepare('SELECT invoice_id FROM factures WHERE id = ?').get(p.facture_id)?.invoice_id
  if (!stripeInvoiceId) return null
  const inv = await getStripeClient().invoices.retrieve(stripeInvoiceId)
  // resolveTaxCodeForInvoice renvoie déjà null pour un code absent et propage les
  // erreurs transitoires (réseau/API QB ou Stripe). On laisse donc remonter : poser
  // un refund sans TaxCodeRef sur un blip annulerait silencieusement la taxe.
  return await resolveTaxCodeForInvoice(inv)
}

async function _postRefundJE({ paymentId, amount, currency, exchangeRate, txnDate, debitAccountId, debitLabel, creditAccountId, creditLabel, docNumber, factureId, taxCodeId, customerId }) {
  // Entity client (rapports par client). Pour les refunds on l'attache aux deux lignes.
  const entityRef = customerId ? { Type: 'Customer', EntityRef: { value: String(customerId) } } : null

  // TaxCodeRef sur la ligne Dr (compte de revenu/AR/passif) pour annuler la taxe perçue
  // au moment de l'encaissement. QB débite TPS/TVQ à payer pour le montant correspondant.
  const debitDetail = { PostingType: 'Debit', AccountRef: { value: debitAccountId } }
  if (entityRef) debitDetail.Entity = entityRef
  if (taxCodeId) {
    debitDetail.TaxCodeRef = { value: taxCodeId }
    debitDetail.TaxApplicableOn = 'Sales'
  }

  const creditDetail = { PostingType: 'Credit', AccountRef: { value: creditAccountId } }
  if (entityRef) creditDetail.Entity = entityRef

  const je = {
    TxnDate: txnDate,
    CurrencyRef: { value: currency },
    ExchangeRate: exchangeRate,
    GlobalTaxCalculation: 'TaxExcluded',
    PrivateNote: `Remboursement — facture #${docNumber || factureId} (${debitLabel} → ${creditLabel})`,
    Line: [
      {
        DetailType: 'JournalEntryLineDetail',
        Amount: amount,
        Description: `Remboursement #${docNumber || factureId}`,
        JournalEntryLineDetail: debitDetail,
      },
      {
        DetailType: 'JournalEntryLineDetail',
        Amount: amount,
        Description: `Remboursement #${docNumber || factureId}`,
        JournalEntryLineDetail: creditDetail,
      },
    ],
  }
  const result = await qbPost('/journalentry', je)
  const jeId = String(result.JournalEntry?.Id || '')
  if (!jeId) throw new Error('QB n\'a pas retourné d\'Id pour le JournalEntry')

  db.prepare(`
    UPDATE payments
    SET qb_journal_entry_id = ?,
        amount_cad = ?,
        exchange_rate = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(jeId, Math.round(amount * exchangeRate * 100) / 100, exchangeRate, paymentId)

  return { qb_journal_entry_id: jeId, amount, currency, debit: debitLabel, credit: creditLabel }
}

// Détecte si la facture a un encaissement Stripe dont le payout n'a pas encore
// été poussé en QB Deposit. Dans ce cas, on évite de poser une JE de constat :
// quand le deposit sera poussé, buildDepositFromPayout choisira directement le
// compte 40000 (Ventes) puisque le shipment sera déjà lié — la vente est donc
// constatée par la ligne du dépôt, pas par une JE séparée.
//
// Deux états sont considérés comme « pending » :
//   1. La balance_transaction est synchronisée mais le payout n'a pas encore
//      été poussé en QB (qb_deposit_id NULL).
//   2. Stripe a encaissé la facture (paid_charge_id posé par invoice.paid)
//      mais aucune balance_transaction n'a encore été synchronisée. Stripe
//      n'émet la BT qu'au settlement (T+0 → T+2), donc il existe une fenêtre
//      où la facture est « payée Stripe-side » sans signal local. Sans cette
//      garde, reconcileFactureRevenueRecognition postait Dr AR / Cr 40000,
//      qui se faisait ensuite doubler par la ligne du futur deposit (40000
//      direct car shipment lié + balance_due=0).
export function factureHasPendingStripeDeposit(factureId) {
  const f = db.prepare(
    'SELECT id, invoice_id, paid_charge_id FROM factures WHERE id = ?'
  ).get(factureId)
  if (!f || !f.invoice_id) return false

  const pushed = db.prepare(`
    SELECT 1 AS ok
    FROM stripe_balance_transactions bt
    JOIN stripe_payouts p ON p.stripe_id = bt.payout_stripe_id
    WHERE bt.stripe_invoice_id = ?
      AND p.qb_deposit_id IS NULL
    LIMIT 1
  `).get(f.invoice_id)
  if (pushed) return true

  if (f.paid_charge_id) {
    const synced = db.prepare(`
      SELECT 1 AS ok FROM stripe_balance_transactions
      WHERE stripe_invoice_id = ?
      LIMIT 1
    `).get(f.invoice_id)
    if (!synced) return true
  }

  return false
}

// Renvoie true si une écriture QB existe déjà côté ERP témoignant de l'encaissement
// de cette facture. Couvre :
//   - une row payments direction='in' avec qb_deposit_id / qb_payment_id / qb_journal_entry_id
//     (le payment a déclenché un Deposit, SalesReceipt ou JE dans QB)
//   - une balance_transaction Stripe liée à l'invoice (poussée ou en attente — le
//     second cas est aussi capturé par factureHasPendingStripeDeposit, on garde
//     les deux pour que cette fonction reste autonome)
// Sert de garde dans reconcileFactureRevenueRecognition : si la facture est marquée
// payée mais qu'aucune trace QB d'encaissement n'existe (typiquement : facture
// marquée payée out-of-band dans Stripe sans charge ni payment ERP), poser une JE
// Dr AR / Cr 40000 ouvrirait un AR qui ne serait jamais soldé.
export function factureHasQbPaymentEntry(factureId) {
  const f = db.prepare('SELECT invoice_id FROM factures WHERE id = ?').get(factureId)
  if (!f) return false
  const pay = db.prepare(`
    SELECT 1 AS ok FROM payments
    WHERE facture_id = ? AND direction = 'in'
      AND (qb_deposit_id IS NOT NULL OR qb_payment_id IS NOT NULL OR qb_journal_entry_id IS NOT NULL)
    LIMIT 1
  `).get(factureId)
  if (pay) return true
  if (f.invoice_id) {
    const bt = db.prepare(`
      SELECT 1 AS ok FROM stripe_balance_transactions
      WHERE stripe_invoice_id = ? LIMIT 1
    `).get(f.invoice_id)
    if (bt) return true
  }
  return false
}

// Réconcilie l'état "constat de vente" d'une facture. Idempotent et safe :
// ne throw jamais, retourne un résultat structuré pour logging. Appelée depuis
// chaque mutation qui peut faire basculer la condition « produits envoyé »
// (PATCH shipment.status='Envoyé', PATCH facture.order_id, etc.).
//
// Cas couverts :
//   - skip 'subscription'        : kind='subscription' → constaté à invoice.paid
//   - skip 'voided'              : status='Void' → facture annulée, aucune constatation
//   - skip 'pre_cutoff'          : document_date < QB_FACTURE_DATE_CUTOFF → compta historique figée
//   - skip 'already_recognized'  : revenue_recognized_at déjà set
//   - skip 'no_link'             : ni order_id ni project_id → pas de chemin shipment
//   - skip 'not_yet_shipped'     : aucun shipment lié à la commande/projet
//   - skip 'awaiting_deposit'    : payment Stripe en attente de push QB deposit
//                                  → la ligne du futur deposit sera 40000 direct
//   - skip 'awaiting_payment_qb_entry' : facture marquée payée (balance_due=0)
//                                  mais aucune écriture QB n'enregistre l'encaissement
//                                  (typiquement paid out-of-band Stripe sans
//                                  payment ERP) — poser Dr AR / Cr 40000 ouvrirait
//                                  un AR fantôme que rien ne soldera
//   - recognized                 : JE Dr 23900|AR / Cr 40000 posée
//   - error                      : JE non posée (QB down, montant manquant, etc.)
export async function reconcileFactureRevenueRecognition(factureId) {
  const f = db.prepare(`
    SELECT id, document_number, document_date, status, kind, revenue_recognized_at, deferred_revenue_at,
           order_id, project_id, balance_due
    FROM factures WHERE id = ?
  `).get(factureId)
  if (!f) return { status: 'skip', reason: 'not_found' }
  if (f.kind === 'subscription') {
    return { status: 'skip', facture_id: f.id, document_number: f.document_number, reason: 'subscription' }
  }
  if (f.status === 'Void') {
    return { status: 'skip', facture_id: f.id, document_number: f.document_number, reason: 'voided' }
  }
  if (f.document_date && f.document_date < QB_FACTURE_DATE_CUTOFF) {
    return { status: 'skip', facture_id: f.id, document_number: f.document_number, reason: 'pre_cutoff' }
  }
  if (f.revenue_recognized_at) {
    return { status: 'skip', facture_id: f.id, document_number: f.document_number, reason: 'already_recognized' }
  }
  if (!f.order_id && !f.project_id) {
    return { status: 'skip', facture_id: f.id, document_number: f.document_number, reason: 'no_link' }
  }
  if (!factureHasLinkedShipment(f.id)) {
    return { status: 'skip', facture_id: f.id, document_number: f.document_number, reason: 'not_yet_shipped' }
  }
  // Si le payout Stripe correspondant est en attente de push QB, on n'émet pas
  // de JE — le futur Deposit imputera directement à 40000 (cf. buildDepositFromPayout).
  // Ne s'applique que si la facture n'a pas encore de deferred_revenue_at (sinon
  // le deposit a déjà été poussé en 23900 et on doit le libérer via JE).
  if (!f.deferred_revenue_at && factureHasPendingStripeDeposit(f.id)) {
    return { status: 'skip', facture_id: f.id, document_number: f.document_number, reason: 'awaiting_deposit' }
  }
  // Si la facture est marquée payée (balance_due = 0) mais qu'aucune écriture QB
  // n'enregistre l'encaissement (ni Deposit/SalesReceipt/JE via payments, ni
  // balance_transaction Stripe), on n'ouvre PAS d'AR — il ne serait jamais soldé.
  // Cas typique : facture marquée payée out-of-band dans Stripe (sans charge donc
  // sans payout à venir) avant qu'un payment ERP n'ait été saisi. Quand l'utilisateur
  // créera le payment via POST /api/payments, postPaymentDeposit posera Cr 23900
  // (deferred), puis le prochain trigger de reconcile fera Dr 23900 / Cr 40000.
  if ((f.balance_due || 0) <= 0 && !f.deferred_revenue_at && !factureHasQbPaymentEntry(f.id)) {
    return { status: 'skip', facture_id: f.id, document_number: f.document_number, reason: 'awaiting_payment_qb_entry' }
  }

  try {
    const r = await postRevenueRecognitionJE(f.id)
    return {
      status: 'recognized',
      facture_id: f.id,
      document_number: f.document_number,
      qb_journal_entry_id: r.qb_journal_entry_id,
      amount: r.amount,
      currency: r.currency,
      debit_account: r.debit_account,
    }
  } catch (err) {
    return {
      status: 'error',
      facture_id: f.id,
      document_number: f.document_number,
      error: err.message,
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit read-only de la constatation des revenus.
//
// `reconcileFactureRevenueRecognition` (ci-dessus) pose l'état de constatation
// dans des colonnes locales (revenue_recognized_at / revenue_recognized_je_id /
// deferred_revenue_*). En production, ces colonnes peuvent se désynchroniser :
// une JE supprimée à la main dans QB, un import Airtable partiel, un payout
// poussé sans deferred, etc. La route `/factures/:id/qb-state` ne vérifie qu'une
// facture à la fois et fait des appels QB.
//
// Cette fonction agrège, à partir des SEULES colonnes locales (aucun appel QB,
// donc instantané et exécutable en continu), toutes les factures dont l'état de
// constatation est « orphelin » — une combinaison de colonnes incohérente.
//
// Catégories (une facture peut en cumuler plusieurs) :
//   je_without_timestamp          — revenue_recognized_je_id posé mais revenue_recognized_at NULL
//   deferred_ref_without_date     — deferred_revenue_qb_ref posé mais deferred_revenue_at NULL
//   deferred_date_without_ref     — deferred_revenue_at posé mais deferred_revenue_qb_ref NULL
//   deferred_without_amount       — deferred_revenue_at posé mais deferred_revenue_amount_cad NULL
//   deferred_not_released         — passif 23900 posé + vente constatée, mais sans JE de libération
//   recognized_on_void            — facture Void mais revenue_recognized_at posé
//   subscription_with_recognition — abonnement avec colonnes de constatation/différé posées
//
// NB : le cas revenue_recognized_at posé + je_id NULL + deferred_revenue_at NULL
// n'est PAS une anomalie — c'est la « constatation directe par la ligne 40000
// d'un Deposit Stripe » (cf. buildEvents dans FactureAccountingSection.jsx).
export const RECONCILIATION_ISSUE_DEFS = {
  je_without_timestamp: {
    label: 'JE liée sans date de constatation',
    severity: 'error',
    hint: 'revenue_recognized_je_id pointe une Journal Entry mais revenue_recognized_at est NULL — la facture n\'est pas comptée comme constatée.',
  },
  deferred_ref_without_date: {
    label: 'Référence QB de différé sans date',
    severity: 'error',
    hint: 'deferred_revenue_qb_ref pointe une transaction QB mais deferred_revenue_at est NULL.',
  },
  deferred_date_without_ref: {
    label: 'Différé posé sans référence QB',
    severity: 'warning',
    hint: 'deferred_revenue_at est posé mais aucune deferred_revenue_qb_ref — le passif 23900 n\'est pas traçable jusqu\'à QB.',
  },
  deferred_without_amount: {
    label: 'Différé sans montant',
    severity: 'warning',
    hint: 'deferred_revenue_at est posé mais deferred_revenue_amount_cad est NULL.',
  },
  deferred_not_released: {
    label: 'Passif 23900 jamais libéré',
    severity: 'error',
    hint: 'Vente constatée alors qu\'un revenu perçu d\'avance est posé, mais sans JE de libération (revenue_recognized_je_id NULL) — le passif 23900 reste ouvert dans QB.',
  },
  recognized_on_void: {
    label: 'Revenu constaté sur facture annulée',
    severity: 'error',
    hint: 'La facture est au statut Void mais revenue_recognized_at est posé.',
  },
  subscription_with_recognition: {
    label: 'Abonnement avec constatation manuelle',
    severity: 'warning',
    hint: 'Les abonnements sont constatés via leur propre flux Stripe — ces colonnes ne devraient pas être posées manuellement.',
  },
}

const RECONCILIATION_SEVERITY_RANK = { error: 2, warning: 1, ok: 0 }

function detectFactureReconciliationIssues(f) {
  const issues = []
  const has = v => v != null && v !== ''
  const isVoid = String(f.status || '').toLowerCase() === 'void'
  const isSub = f.kind === 'subscription'

  if (has(f.revenue_recognized_je_id) && !has(f.revenue_recognized_at)) {
    issues.push('je_without_timestamp')
  }
  if (has(f.deferred_revenue_qb_ref) && !has(f.deferred_revenue_at)) {
    issues.push('deferred_ref_without_date')
  }
  if (has(f.deferred_revenue_at) && !has(f.deferred_revenue_qb_ref)) {
    issues.push('deferred_date_without_ref')
  }
  if (has(f.deferred_revenue_at) && f.deferred_revenue_amount_cad == null) {
    issues.push('deferred_without_amount')
  }
  if (has(f.deferred_revenue_at) && has(f.revenue_recognized_at) && !has(f.revenue_recognized_je_id)) {
    issues.push('deferred_not_released')
  }
  if (isVoid && has(f.revenue_recognized_at)) {
    issues.push('recognized_on_void')
  }
  if (isSub && (has(f.revenue_recognized_at) || has(f.deferred_revenue_at))) {
    issues.push('subscription_with_recognition')
  }
  return issues
}

export function auditFactureReconciliation() {
  const rows = db.prepare(`
    SELECT id, document_number, document_date, status, kind, currency,
           amount_before_tax_cad, total_amount, balance_due,
           revenue_recognized_at, revenue_recognized_je_id,
           deferred_revenue_at, deferred_revenue_qb_ref,
           deferred_revenue_amount_cad, deferred_revenue_currency
    FROM factures
  `).all()

  const byCode = Object.fromEntries(Object.keys(RECONCILIATION_ISSUE_DEFS).map(c => [c, 0]))
  const bySeverity = { error: 0, warning: 0 }
  const flagged = []
  let recognizedCount = 0
  let deferredOpenCount = 0

  for (const f of rows) {
    if (f.revenue_recognized_at) recognizedCount++
    if (f.deferred_revenue_at && !f.revenue_recognized_at) deferredOpenCount++

    const issues = detectFactureReconciliationIssues(f)
    if (issues.length === 0) continue
    for (const code of issues) byCode[code]++
    const severity = issues.some(c => RECONCILIATION_ISSUE_DEFS[c].severity === 'error') ? 'error' : 'warning'
    bySeverity[severity]++
    flagged.push({
      id: f.id,
      document_number: f.document_number,
      document_date: f.document_date,
      status: f.status,
      kind: f.kind,
      currency: f.currency || 'CAD',
      amount_before_tax_cad: f.amount_before_tax_cad,
      total_amount: f.total_amount,
      balance_due: f.balance_due,
      revenue_recognized_at: f.revenue_recognized_at,
      revenue_recognized_je_id: f.revenue_recognized_je_id,
      deferred_revenue_at: f.deferred_revenue_at,
      deferred_revenue_qb_ref: f.deferred_revenue_qb_ref,
      severity,
      issues,
    })
  }

  // Tri : erreurs d'abord, puis par date de document décroissante (plus récent
  // en haut — c'est ce qu'un opérateur veut corriger en priorité).
  flagged.sort((a, b) => {
    const s = RECONCILIATION_SEVERITY_RANK[b.severity] - RECONCILIATION_SEVERITY_RANK[a.severity]
    if (s !== 0) return s
    return String(b.document_date || '').localeCompare(String(a.document_date || ''))
  })

  return {
    generated_at: new Date().toISOString(),
    defs: RECONCILIATION_ISSUE_DEFS,
    summary: {
      total_factures: rows.length,
      recognized: recognizedCount,
      deferred_open: deferredOpenCount,
      flagged: flagged.length,
      errors: bySeverity.error,
      warnings: bySeverity.warning,
      by_code: byCode,
    },
    factures: flagged,
  }
}

// Réconcilie toutes les factures kind='order' liées à une commande, soit
// directement (factures.order_id), soit via le projet (factures.project_id =
// orders.project_id). Élargit le scope vs. ancien recognizeRevenueForOrder
// (qui ratait les factures rattachées au projet plutôt qu'à la commande).
export async function reconcileFacturesForOrder(orderId) {
  const order = db.prepare('SELECT id, project_id FROM orders WHERE id = ?').get(orderId)
  if (!order) return { recognized: [], skipped: [], errors: [] }

  const factures = db.prepare(`
    SELECT id, document_number FROM factures
    WHERE kind = 'order'
      AND (order_id = ? OR (project_id IS NOT NULL AND project_id = ?))
    ORDER BY created_at
  `).all(order.id, order.project_id)

  const results = { recognized: [], skipped: [], errors: [] }
  for (const f of factures) {
    const r = await reconcileFactureRevenueRecognition(f.id)
    if (r.status === 'recognized') results.recognized.push(r)
    else if (r.status === 'error') results.errors.push(r)
    else results.skipped.push(r)
  }
  return results
}

// Alias rétrocompat — préfère reconcileFacturesForOrder dans le nouveau code.
export const recognizeRevenueForOrder = reconcileFacturesForOrder

// Orchestre le job hebdomadaire « Sync + push QB des Stripe payouts » (lundi midi) :
//   1. syncStripePayouts({ fullHistory:false })  — pull les nouveaux payouts depuis Stripe
//   2. syncAllPayoutsBalanceTransactions({ onlyMissing:true }) — sync les BT manquantes
//   3. pour chaque payout réglé (status='paid') pas encore poussé en QB → buildDepositFromPayout
//      puis pushDepositFromPayout.
//
// GARDE ANTI-ERREUR : avant chaque push, on construit le Deposit (dry build) et on
// inspecte `warnings`. Un payout dont le build produit le moindre warning (client QB
// non résolu, taxe sur frais non imputée, TaxCode manquant…) n'est PAS poussé
// automatiquement — il est laissé en attente de revue manuelle. Idem pour les payouts
// non réglés ou sans balance_transaction synchronisée : on ne pousse jamais à l'aveugle.
// dryRun=true s'arrête après le build (aucun Deposit créé en QB) — utilisé pour la preview.
export async function syncAndPushStripePayouts({ dryRun = false } = {}) {
  if (!isStripeConfigured()) throw new Error('Stripe non configuré')

  // 1+2. Sync incrémentale des payouts puis des balance_transactions manquantes.
  const payoutSync = await syncStripePayouts({ fullHistory: false })
  const btSync = await syncAllPayoutsBalanceTransactions({ onlyMissing: true })

  // 3. Candidats : réglés, pas encore poussés, et ayant au moins une BT synchronisée.
  const candidates = db.prepare(`
    SELECT sp.stripe_id, sp.amount, sp.currency
    FROM stripe_payouts sp
    WHERE sp.qb_deposit_id IS NULL
      AND sp.status = 'paid'
      AND EXISTS (SELECT 1 FROM stripe_balance_transactions bt WHERE bt.payout_stripe_id = sp.stripe_id)
    ORDER BY sp.created_date
  `).all()

  const pushed = []
  const skipped = []
  const errors = []

  for (const p of candidates) {
    try {
      const { warnings } = await buildDepositFromPayout(p.stripe_id)
      if (warnings && warnings.length) {
        // Garde : warning détecté → on ne pousse pas, on laisse pour revue manuelle.
        skipped.push({ payout_id: p.stripe_id, amount: p.amount, currency: p.currency, reason: warnings.join(' ; ') })
        continue
      }
      if (dryRun) {
        pushed.push({ payout_id: p.stripe_id, amount: p.amount, currency: p.currency, dryRun: true })
        continue
      }
      const r = await pushDepositFromPayout(p.stripe_id)
      pushed.push({ payout_id: p.stripe_id, amount: p.amount, currency: p.currency, qb_deposit_id: r.qb_deposit_id })
    } catch (e) {
      errors.push({ payout_id: p.stripe_id, error: e.message })
    }
  }

  const summary =
    `Sync payouts: +${payoutSync.created} créé(s)/${payoutSync.updated} MAJ · ` +
    `BT: +${btSync.created} créé(s) (${btSync.errors.length} err) · ` +
    `${candidates.length} candidat(s) → ${pushed.length} dépôt(s) ${dryRun ? '(dry-run) ' : ''}poussé(s) · ` +
    `${skipped.length} bloqué(s) par garde · ${errors.length} erreur(s)`

  return { summary, dryRun, payoutSync, btSync, candidates: candidates.length, pushed, skipped, errors }
}
