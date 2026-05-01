import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { qbGet, qbPost } from '../connectors/quickbooks.js'
import { getUsdCadRate } from './fx.js'
import { getStripeClient } from './stripeInvoices.js'

function getQBConfig() {
  const rows = db.prepare("SELECT key, value FROM connector_config WHERE connector='quickbooks'").all()
  return Object.fromEntries(rows.map(r => [r.key, r.value]))
}

// Recherche un fournisseur QB par nom, le crée si absent.
// Synchronise aussi avec la table companies (type=Fournisseur).
// Retourne le QB Vendor ID (string).
async function findOrCreateVendor(vendorName) {
  // 1. Chercher dans companies par nom pour récupérer un quickbooks_vendor_id déjà connu
  const existing = db.prepare(
    "SELECT id, quickbooks_vendor_id FROM companies WHERE name=? LIMIT 1"
  ).get(vendorName)

  if (existing?.quickbooks_vendor_id) return existing.quickbooks_vendor_id

  // 2. Chercher dans QB
  const safe = vendorName.replace(/'/g, "\\'")
  const q = new URLSearchParams({ query: `SELECT * FROM Vendor WHERE DisplayName = '${safe}' MAXRESULTS 1` })
  const result = await qbGet(`/query?${q}`)
  const vendors = result.QueryResponse?.Vendor || []
  let qbVendorId

  if (vendors.length > 0) {
    qbVendorId = vendors[0].Id
  } else {
    const created = await qbPost('/vendor', { DisplayName: vendorName })
    qbVendorId = created.Vendor.Id
  }

  // 3. Mettre à jour ou créer l'entreprise locale
  if (existing) {
    db.prepare("UPDATE companies SET quickbooks_vendor_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?")
      .run(qbVendorId, existing.id)
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

export async function pushAchatToQB(achatId) {
  const row = db.prepare('SELECT * FROM achats_fournisseurs WHERE id=?').get(achatId)
  if (!row) throw new Error('Achat introuvable')
  if (row.quickbooks_id) throw new Error(`Déjà publié sur QuickBooks (ID: ${row.quickbooks_id})`)

  const cfg = getQBConfig()
  if (!cfg.expense_account_id) throw new Error('Compte de dépense QuickBooks non configuré')

  if (row.type === 'purchase') {
    if (!cfg.payment_account_id) throw new Error('Compte de paiement QuickBooks non configuré')
    const purchase = {
      PaymentType: PAYMENT_TYPE_MAP[row.payment_method] || 'Cash',
      AccountRef: { value: cfg.payment_account_id },
      TxnDate: row.date_achat,
      TotalAmt: row.total_cad,
      Line: [{
        Amount: row.total_cad,
        DetailType: 'AccountBasedExpenseLineDetail',
        AccountBasedExpenseLineDetail: { AccountRef: { value: cfg.expense_account_id } },
        Description: row.description || row.category,
      }],
    }
    const qbVendorId = await resolveQBVendor(row)
    if (qbVendorId) purchase.EntityRef = { value: qbVendorId, type: 'Vendor' }
    if (row.reference) purchase.DocNumber = row.reference

    const result = await qbPost('/purchase', purchase)
    const qbId = result.Purchase.Id
    db.prepare("UPDATE achats_fournisseurs SET quickbooks_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?").run(qbId, achatId)
    return qbId
  }

  // type === 'bill'
  const vendorId = await resolveQBVendor(row)
  if (!vendorId) throw new Error('Fournisseur requis pour une facture')

  const bill = {
    VendorRef: { value: vendorId },
    TxnDate: row.date_achat,
    Line: [{
      Amount: row.total_cad,
      DetailType: 'AccountBasedExpenseLineDetail',
      AccountBasedExpenseLineDetail: { AccountRef: { value: cfg.expense_account_id } },
      Description: row.notes || row.vendor_invoice_number || row.vendor,
    }],
  }
  if (row.due_date) bill.DueDate = row.due_date
  if (row.vendor_invoice_number) bill.DocNumber = row.vendor_invoice_number

  const result = await qbPost('/bill', bill)
  const qbId = result.Bill.Id
  db.prepare("UPDATE achats_fournisseurs SET quickbooks_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?").run(qbId, achatId)
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
    return byName.id
  }

  const id = randomUUID()
  db.prepare(`
    INSERT INTO companies (id, name, type, quickbooks_vendor_id)
    VALUES (?, ?, 'Fournisseur', ?)
  `).run(id, vendorName, qbVendorId)
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

export async function importFromQB() {
  const today = new Date().toISOString().slice(0, 10)
  let inserted = 0
  let updated = 0
  const errors = []

  // ── 1. QB Bills → factures_fournisseurs ──────────────────────────────────
  let bills = []
  try {
    bills = await fetchAllQBPages('/query', 'Bill')
  } catch (e) {
    errors.push({ type: 'Bill', error: e.message })
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

  let purchases = []
  try {
    purchases = await fetchAllQBPages('/query', 'Purchase')
  } catch (e) {
    errors.push({ type: 'Purchase', error: e.message })
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

  console.log(`✅ QB import: bills ${inserted}+${updated}, dépenses ${insertedDep}+${updatedDep}, erreurs ${errors.length}`)
  return { bills: { inserted, updated }, depenses: { inserted: insertedDep, updated: updatedDep }, errors }
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

// ── Reçus de vente → QB Purchase ─────────────────────────────────────────────

// params: { expenseAccountId, paymentAccountId, vendorId, newVendorName }
export async function pushSaleReceiptToQB(receiptId, params = {}) {
  const rec = db.prepare('SELECT * FROM sale_receipts WHERE id=?').get(receiptId)
  if (!rec) throw new Error('Reçu introuvable')
  if (rec.status !== 'done') throw new Error('Le reçu doit être extrait avant de pouvoir être publié')
  if (rec.quickbooks_id) throw new Error(`Reçu déjà publié sur QuickBooks (ID: ${rec.quickbooks_id})`)

  // Résoudre les comptes : params en priorité, sinon config globale
  const cfg = getQBConfig()
  const expenseAccountId = params.expenseAccountId || cfg.expense_account_id
  const paymentAccountId = params.paymentAccountId || cfg.payment_account_id
  if (!expenseAccountId) throw new Error('Compte de dépense non spécifié')
  if (!paymentAccountId) throw new Error('Compte de paiement non spécifié')

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

  const items = JSON.parse(rec.items || '[]')

  // Construire les lignes à partir des articles extraits
  let lines = []
  if (items.length > 0) {
    lines = items.map(item => ({
      Amount: item.total || (item.unit_price * item.quantity) || 0,
      DetailType: 'AccountBasedExpenseLineDetail',
      AccountBasedExpenseLineDetail: { AccountRef: { value: expenseAccountId } },
      Description: item.description || '',
    })).filter(l => l.Amount > 0)
  }

  // Si pas d'articles ou somme ≠ total → une seule ligne avec le total
  const linesSum = lines.reduce((s, l) => s + l.Amount, 0)
  const totalAmt = rec.total || 0
  if (lines.length === 0 || Math.abs(linesSum - totalAmt) > 0.01) {
    lines = [{
      Amount: totalAmt,
      DetailType: 'AccountBasedExpenseLineDetail',
      AccountBasedExpenseLineDetail: { AccountRef: { value: expenseAccountId } },
      Description: rec.company || rec.original_name || 'Reçu',
    }]
  }

  const purchase = {
    PaymentType: PAYMENT_TYPE_MAP[rec.payment_method] || 'Cash',
    AccountRef: { value: paymentAccountId },
    TxnDate: rec.receipt_date || new Date().toISOString().slice(0, 10),
    TotalAmt: totalAmt,
    Line: lines,
  }

  if (vendorId) purchase.EntityRef = { value: vendorId, type: 'Vendor' }
  if (rec.receipt_number) purchase.DocNumber = rec.receipt_number

  const result = await qbPost('/purchase', purchase)
  const qbId = result.Purchase.Id
  db.prepare("UPDATE sale_receipts SET quickbooks_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?").run(qbId, receiptId)
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
// and description ('Canadian GST', 'Canadian QST', etc.). More robust than deriving from bt.fee alone.
function splitFeeFromRaw(bt) {
  let raw
  try { raw = JSON.parse(bt.raw || '{}') } catch { raw = {} }
  const details = Array.isArray(raw.fee_details) ? raw.fee_details : []
  let processing = 0
  let taxGst = 0
  let taxQst = 0
  for (const d of details) {
    const amt = (d.amount || 0) / 100
    if (d.type === 'tax') {
      const desc = (d.description || '').toLowerCase()
      if (/\b(qst|tvq)\b/.test(desc)) taxQst += amt
      else taxGst += amt
    } else {
      processing += amt
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

async function loadAccountsCache() {
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
  }
  return _accountsCache
}

async function resolveAccountByAcctNum(acctNum) {
  const cache = await loadAccountsCache()
  return cache.byAcctNum.get(String(acctNum)) || null
}

async function resolveTaxCodeByName(name) {
  const safe = name.replace(/'/g, "\\'")
  const q = new URLSearchParams({ query: `SELECT Id, Name FROM TaxCode WHERE Name = '${safe}' MAXRESULTS 1` })
  const r = await qbGet(`/query?${q}`)
  const tc = r.QueryResponse?.TaxCode?.[0]
  if (!tc) throw new Error(`TaxCode QB introuvable: "${name}"`)
  return tc.Id
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
    return resolveTaxCodeByName('Détaxé').catch(() => null)
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

  try { return await resolveTaxCodeByName(codeName) } catch { return null }
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

// Vérifie qu'au moins un envoi (peu importe le statut) existe sur une commande
// liée à la facture, soit directement (factures.order_id), soit via le projet
// (orders.project_id = factures.project_id).
function factureHasLinkedShipment(factureId) {
  const r = db.prepare(`
    SELECT 1 AS ok
    FROM factures f
    LEFT JOIN orders o_d ON o_d.id = f.order_id
    LEFT JOIN orders o_p ON o_p.project_id = f.project_id AND f.project_id IS NOT NULL
    WHERE f.id = ?
      AND EXISTS (
        SELECT 1 FROM shipments s
        WHERE s.order_id = o_d.id OR s.order_id = o_p.id
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
          'SELECT id, document_number, kind, revenue_recognized_at, balance_due FROM factures WHERE invoice_id=? LIMIT 1'
        ).get(bt.stripe_invoice_id)
        if (factureForBt) {
          factureKind = factureForBt.kind
          if (factureForBt.revenue_recognized_at && (factureForBt.balance_due || 0) > 0) {
            isAR = true  // constatée + AR ouvert
          } else if (factureKind !== 'subscription' && !factureHasLinkedShipment(factureForBt.id)) {
            isDeferred = true
          }
        }
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

      // Montant HT (= bt.amount - taxes ; bt.invoice_tax_* déjà en cents via Stripe)
      const invoiceTax = (bt.invoice_tax_gst || 0) + (bt.invoice_tax_qst || 0)
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
  for (const l of lines) { delete l._group }

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

  return { deposit, summary, warnings, exchangeRate, deferredFactures }
}

export async function pushDepositFromPayout(payoutStripeId) {
  const payout = db.prepare('SELECT * FROM stripe_payouts WHERE stripe_id=?').get(payoutStripeId)
  if (!payout) throw new Error(`Payout introuvable: ${payoutStripeId}`)
  if (payout.qb_deposit_id) throw new Error(`Déjà envoyé à QB (Deposit ID: ${payout.qb_deposit_id})`)

  const { deposit, summary, warnings, exchangeRate, deferredFactures } = await buildDepositFromPayout(payoutStripeId)
  const result = await qbPost('/deposit', deposit)
  const qbId = result.Deposit.Id
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
  return { qb_deposit_id: qbId, summary, warnings }
}

// Pose l'écriture comptable de l'encaissement d'un paiement HORS-STRIPE (chèque,
// virement, Interac, comptant). Les paiements Stripe sont gérés au payout (lundi)
// via pushDepositFromPayout — postInvoicePaidJE n'est pas appelée pour eux.
//
// Selon l'état de la facture :
//   - Sales Receipt (commande non constatée OU abonnement) :
//       DepositToAccountRef = Banque (selon devise)
//       Item = "Revenu perçu d'avance" (→ 23900) ou "Location / Rent" (→ 41000)
//       TaxCodeRef → QB ventile auto TPS/TVQ/TVH
//
//   - JournalEntry (AR ouvert : facture déjà constatée à l'expédition) :
//       Dr Banque (TTC) / Cr 12000 ou 12100 (selon devise) — solde l'AR
//       Pas de taxe à toucher (déjà constatée à l'expédition)
//
// Idempotent : la ligne payments porte qb_payment_id (SR) ou qb_journal_entry_id (JE).
export async function postInvoicePaidJE(paymentId, options = {}) {
  const p = db.prepare(`
    SELECT p.*, f.id AS facture_id, f.kind, f.currency AS facture_currency,
           f.document_number, f.revenue_recognized_at, f.deferred_revenue_at,
           f.amount_before_tax_cad, f.subscription_id, f.invoice_id AS stripe_invoice_id
    FROM payments p
    JOIN factures f ON f.id = p.facture_id
    WHERE p.id = ?
  `).get(paymentId)
  if (!p) throw new Error('Paiement introuvable')
  if (p.qb_journal_entry_id || p.qb_payment_id) {
    return { qb_journal_entry_id: p.qb_journal_entry_id, qb_payment_id: p.qb_payment_id, skipped: true }
  }
  if (p.direction !== 'in') throw new Error('postInvoicePaidJE attend direction=in')
  if (p.method === 'stripe') {
    return { skipped: 'paiement Stripe — comptabilisé au payout (pushDepositFromPayout)' }
  }

  const accounts = await resolveQBStripeAccounts()
  const currency = p.currency || p.facture_currency || 'CAD'
  const amount = Math.round(p.amount * 100) / 100  // HT (subtotal Stripe)

  const txnDate = (p.received_at || new Date().toISOString()).slice(0, 10)
  let exchangeRate = p.exchange_rate || 1
  if (currency === 'USD' && (!exchangeRate || exchangeRate === 1)) {
    exchangeRate = await getUsdCadRate(txnDate)
    if (!exchangeRate) throw new Error(`Taux USD→CAD indisponible pour ${txnDate}`)
  }

  const customer = await resolveQbCustomerForFacture(p.facture_id, currency)
  if (!customer) throw new Error('Pas de client QB associé à la facture (companies.id manquante)')

  // ── Cas AR : facture déjà constatée à l'expédition ─────────────────────
  // L'argent a déjà été constaté en revenu via postRevenueRecognitionJE.
  // L'encaissement solde simplement l'AR. Pas de taxe à toucher (constatée
  // au moment du constat). On utilise une JournalEntry simple.
  if (p.revenue_recognized_at) {
    const arAccountId = currency === 'USD' ? accounts.accounts_receivable_usd : accounts.accounts_receivable_cad
    const entityRef = { Type: 'Customer', EntityRef: { value: String(customer.id) } }
    const je = {
      TxnDate: txnDate,
      CurrencyRef: { value: currency },
      ExchangeRate: exchangeRate,
      PrivateNote: `Encaissement Stripe — facture #${p.document_number || p.facture_id} (solde AR ${currency})`,
      Line: [
        {
          DetailType: 'JournalEntryLineDetail',
          Amount: amount,
          Description: `Encaissement #${p.document_number || p.facture_id}`,
          JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: accounts.undeposited_funds }, Entity: entityRef },
        },
        {
          DetailType: 'JournalEntryLineDetail',
          Amount: amount,
          Description: `Encaissement #${p.document_number || p.facture_id}`,
          JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: arAccountId }, Entity: entityRef },
        },
      ],
    }
    const result = await qbPost('/journalentry', je)
    const jeId = String(result.JournalEntry?.Id || '')
    if (!jeId) throw new Error('QB n\'a pas retourné d\'Id pour le JournalEntry')
    db.prepare(`
      UPDATE payments SET qb_journal_entry_id = ?, amount_cad = ?, exchange_rate = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(jeId, Math.round(amount * exchangeRate * 100) / 100, exchangeRate, paymentId)
    return { qb_journal_entry_id: jeId, amount, currency, credit_account: `AR ${currency}` }
  }

  // ── Cas Sales Receipt : commande non constatée OU abonnement (paiement hors-Stripe) ─
  // Sales Receipt avec DepositTo=Banque (le cash arrive direct, pas de transit).
  // QB poste auto :
  //   Dr Banque (TTC)
  //   Cr [23900 Revenus perçus d'avance | 41000 Revenus de service] (HT)
  //   Cr taxes payable (TPS/TVQ/TVH via TaxCodeRef)
  const items = await resolveQBStripeItems()
  const itemId = p.kind === 'subscription' ? items.subscription : items.order
  const creditLabel = p.kind === 'subscription' ? 'Revenus de service (41000)' : 'Revenus perçus d\'avance (23900)'
  const bankAccountId = currency === 'USD' ? accounts.bank_usd : accounts.bank_cad

  // Charger l'invoice Stripe pour résoudre le TaxCode (si la facture a une référence Stripe).
  let invoiceForTax = options.invoice || null
  if (!invoiceForTax && p.stripe_invoice_id) {
    try { invoiceForTax = await getStripeClient().invoices.retrieve(p.stripe_invoice_id) }
    catch (e) { console.error(`Invoice Stripe non récupérée pour facture ${p.facture_id}:`, e.message) }
  }
  let taxCodeId = options.taxCodeId || null
  if (!taxCodeId && invoiceForTax) {
    taxCodeId = await resolveTaxCodeForInvoice(invoiceForTax)
  }

  const lineDetail = {
    ItemRef: { value: String(itemId) },
    Qty: 1,
    UnitPrice: amount,
  }
  if (taxCodeId) lineDetail.TaxCodeRef = { value: taxCodeId }

  const sr = {
    TxnDate: txnDate,
    CustomerRef: { value: String(customer.id) },
    CurrencyRef: { value: currency },
    ExchangeRate: exchangeRate,
    DepositToAccountRef: { value: bankAccountId },
    GlobalTaxCalculation: 'TaxExcluded',
    PrivateNote: `Paiement ${p.method} — facture #${p.document_number || p.facture_id} (Cr ${creditLabel})`,
    Line: [
      {
        DetailType: 'SalesItemLineDetail',
        Amount: amount,
        Description: `Paiement #${p.document_number || p.facture_id} (${p.method})`,
        SalesItemLineDetail: lineDetail,
      },
    ],
  }
  if (taxCodeId) sr.TxnTaxDetail = { TxnTaxCodeRef: { value: taxCodeId } }

  const result = await qbPost('/salesreceipt', sr)
  const srId = String(result.SalesReceipt?.Id || '')
  if (!srId) throw new Error('QB n\'a pas retourné d\'Id pour le SalesReceipt')

  db.prepare(`
    UPDATE payments
    SET qb_payment_id = ?,
        amount_cad = ?,
        exchange_rate = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(srId, Math.round(amount * exchangeRate * 100) / 100, exchangeRate, paymentId)

  // Pour les commandes non encore constatées, mémoriser deferred sur la facture
  // (postRevenueRecognitionJE libère ce passif à l'expédition : Dr 23900 / Cr 40000).
  if (!p.revenue_recognized_at && p.kind !== 'subscription' && !p.deferred_revenue_at) {
    db.prepare(`
      UPDATE factures
      SET deferred_revenue_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          deferred_revenue_amount_native = ?,
          deferred_revenue_amount_cad = ?,
          deferred_revenue_currency = ?,
          deferred_revenue_qb_ref = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(amount, Math.round(amount * exchangeRate * 100) / 100, currency, `salesreceipt:${srId}`, p.facture_id)
  }

  return { qb_payment_id: srId, amount, currency, credit_account: creditLabel }
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
// directement à invoice.paid (postInvoicePaidJE crédite 41000), pas à l'expédition.
export async function postRevenueRecognitionJE(factureId, options = {}) {
  const f = db.prepare(`
    SELECT id, document_number, kind, currency, total_amount, amount_before_tax_cad,
           deferred_revenue_at, deferred_revenue_amount_native, deferred_revenue_currency,
           revenue_recognized_at, revenue_recognized_je_id, company_id
    FROM factures WHERE id = ?
  `).get(factureId)
  if (!f) throw new Error('Facture introuvable')
  if (f.kind === 'subscription') throw new Error('Constat à l\'expédition non applicable aux abonnements')
  if (f.revenue_recognized_at) throw new Error(`Vente déjà constatée (JE ${f.revenue_recognized_je_id || '?'})`)
  // bypassShipmentCheck=true quand on déclenche depuis le toggle « Envoyée »
  // forcé manuellement (facture sans matériel physique).
  if (!options.bypassShipmentCheck && !factureHasLinkedShipment(f.id)) {
    throw new Error('Aucun envoi sur une commande liée — la vente ne peut pas encore être constatée')
  }

  const accounts = await resolveQBStripeAccounts()

  // Choix du compte de débit selon l'état d'encaissement.
  const isDeferred = !!f.deferred_revenue_at
  let amount, currency
  if (isDeferred) {
    if (!f.deferred_revenue_amount_native) throw new Error('Montant déféré inconnu — relance le push du payout')
    amount = Math.round(f.deferred_revenue_amount_native * 100) / 100
    currency = f.deferred_revenue_currency || 'CAD'
  } else {
    // Pas encaissé → on prend le HT de la facture (amount_before_tax_cad porte le subtotal
    // dans la devise native, malgré son nom historique). Devise = facture.currency.
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

  const debitAccountId = isDeferred
    ? accounts.revenue_deferred
    : (currency === 'USD' ? accounts.accounts_receivable_usd : accounts.accounts_receivable_cad)
  const debitLabel = isDeferred ? 'Revenus perçus d\'avance' : `Comptes clients ${currency}`

  // Customer tracking — Entity sur les deux lignes pour rapports par client.
  // Pas de TaxCodeRef ici : la taxe a déjà été constatée à l'encaissement (postInvoicePaidJE).
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

  db.prepare(`
    UPDATE factures
    SET revenue_recognized_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        revenue_recognized_je_id = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(String(jeId), factureId)

  return { qb_journal_entry_id: String(jeId), amount, currency, debit_account: debitLabel }
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
    SELECT p.*, f.id AS facture_id, f.kind, f.currency AS facture_currency,
           f.document_number, f.revenue_recognized_at, f.deferred_revenue_at,
           f.balance_due, f.invoice_id AS stripe_invoice_id
    FROM payments p
    JOIN factures f ON f.id = p.facture_id
    WHERE p.id = ?
  `).get(paymentId)
  if (!p) throw new Error('Paiement introuvable')
  if (p.direction !== 'out') throw new Error('processRefund attend direction=out')
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
  try {
    const inv = await getStripeClient().invoices.retrieve(stripeInvoiceId)
    return await resolveTaxCodeForInvoice(inv)
  } catch (e) {
    console.error(`Tax code non résolu pour facture ${p.facture_id}:`, e.message)
    return null
  }
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
function factureHasPendingStripeDeposit(factureId) {
  const r = db.prepare(`
    SELECT 1 AS ok
    FROM factures f
    JOIN stripe_balance_transactions bt ON bt.stripe_invoice_id = f.invoice_id
    JOIN stripe_payouts p ON p.stripe_id = bt.payout_stripe_id
    WHERE f.id = ?
      AND f.invoice_id IS NOT NULL
      AND p.qb_deposit_id IS NULL
    LIMIT 1
  `).get(factureId)
  return !!r
}

// Réconcilie l'état "constat de vente" d'une facture. Idempotent et safe :
// ne throw jamais, retourne un résultat structuré pour logging. Appelée depuis
// chaque mutation qui peut faire basculer la condition « produits envoyé »
// (PATCH shipment.status='Envoyé', PATCH facture.order_id, etc.).
//
// Cas couverts :
//   - skip 'subscription'        : kind='subscription' → constaté à invoice.paid
//   - skip 'already_recognized'  : revenue_recognized_at déjà set
//   - skip 'no_link'             : ni order_id ni project_id → pas de chemin shipment
//   - skip 'not_yet_shipped'     : aucun shipment lié à la commande/projet
//   - skip 'awaiting_deposit'    : payment Stripe en attente de push QB deposit
//                                  → la ligne du futur deposit sera 40000 direct
//   - recognized                 : JE Dr 23900|AR / Cr 40000 posée
//   - error                      : JE non posée (QB down, montant manquant, etc.)
export async function reconcileFactureRevenueRecognition(factureId) {
  const f = db.prepare(`
    SELECT id, document_number, kind, revenue_recognized_at, deferred_revenue_at,
           order_id, project_id
    FROM factures WHERE id = ?
  `).get(factureId)
  if (!f) return { status: 'skip', reason: 'not_found' }
  if (f.kind === 'subscription') {
    return { status: 'skip', facture_id: f.id, document_number: f.document_number, reason: 'subscription' }
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
