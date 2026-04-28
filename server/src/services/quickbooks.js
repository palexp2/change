import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { qbGet, qbPost } from '../connectors/quickbooks.js'
import { getUsdCadRate } from './fx.js'

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

// Find or create a QB Customer by name
async function findOrCreateCustomer(customerName) {
  const safe = customerName.replace(/'/g, "\\'")
  const q = new URLSearchParams({ query: `SELECT * FROM Customer WHERE DisplayName = '${safe}' MAXRESULTS 1` })
  const result = await qbGet(`/query?${q}`)
  const customers = result.QueryResponse?.Customer || []

  if (customers.length > 0) return customers[0].Id

  const created = await qbPost('/customer', { DisplayName: customerName })
  return created.Customer.Id
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

// Comptes QB résolus par nom (confirmés avec l'utilisateur).
// Si un compte est renommé dans QB, mettre à jour ici.
const QB_STRIPE_ACCOUNTS = {
  bank_cad:               'Compte chèques Banque Nationale',
  bank_usd:               'Venn USD',
  revenue_subscription:   'Revenus de service',
  revenue_sale:           'Ventes',
  fees:                   'Stripe Charge Back',
  // Compte de passif pour ventes encaissées avant qu'un envoi ne soit constaté.
  // Résolu par AcctNum (23900) — fallback sur le nom si la numérotation change dans QB.
  revenue_deferred:       { acctNum: '23900', name: 'Revenus perçus d’avance' },
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
  const safe = name.replace(/'/g, "\\'")
  const q = new URLSearchParams({ query: `SELECT Id, Name FROM Account WHERE Name = '${safe}' MAXRESULTS 1` })
  const r = await qbGet(`/query?${q}`)
  const acc = r.QueryResponse?.Account?.[0]
  if (!acc) throw new Error(`Compte QB introuvable: "${name}"`)
  return acc.Id
}

async function resolveAccountByAcctNum(acctNum) {
  const safe = String(acctNum).replace(/'/g, "\\'")
  const q = new URLSearchParams({ query: `SELECT Id, Name FROM Account WHERE AcctNum = '${safe}' MAXRESULTS 1` })
  const r = await qbGet(`/query?${q}`)
  return r.QueryResponse?.Account?.[0]?.Id || null
}

async function resolveTaxCodeByName(name) {
  const safe = name.replace(/'/g, "\\'")
  const q = new URLSearchParams({ query: `SELECT Id, Name FROM TaxCode WHERE Name = '${safe}' MAXRESULTS 1` })
  const r = await qbGet(`/query?${q}`)
  const tc = r.QueryResponse?.TaxCode?.[0]
  if (!tc) throw new Error(`TaxCode QB introuvable: "${name}"`)
  return tc.Id
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
  // les lignes similaires pour faciliter la lecture.
  const LINE_GROUP_ORDER = [
    'revenue_sale',              // Ventes ponctuelles
    'revenue_deferred',          // Ventes encaissées avant envoi (passif)
    'revenue_subscription',      // Abonnements
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
  let revenueSale = 0
  let revenueSubscription = 0
  let revenueDeferred = 0
  let refundTotal = 0
  let disputeTotal = 0
  // Factures à marquer en revenu reçu d'avance après push réussi.
  // Forme : { factureId, document_number, amount_native, amount_cad, currency }
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

      // Détection "revenu perçu d'avance" : facture de vente (non-abonnement, non-remboursement)
      // dont aucune commande liée n'a encore d'envoi → la vente n'est pas encore réalisée comptablement.
      let factureForBt = null
      let isDeferred = false
      if (!isRefund && !bt.is_subscription && bt.stripe_invoice_id) {
        factureForBt = db.prepare(
          'SELECT id, document_number FROM factures WHERE invoice_id=? LIMIT 1'
        ).get(bt.stripe_invoice_id)
        if (factureForBt && !factureHasLinkedShipment(factureForBt.id)) {
          isDeferred = true
        }
      }

      const accountId = isDeferred
        ? accounts.revenue_deferred
        : (bt.is_subscription ? accounts.revenue_subscription : accounts.revenue_sale)
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

      const revenueDetail = { AccountRef: { value: accountId } }
      if (qbCustomerId) revenueDetail.Entity = { value: String(qbCustomerId), type: 'Customer' }
      let qbCode = bt.qb_tax_code
      if (!qbCode && bt.tax_details && bt.tax_details !== '[]') {
        // Fallback pour BT synchronisées avant le fix sync: tax_rate attaché mais montant nul
        // (US state tax sur client non facturable) → Détaxé, comme décidé à la sync.
        try {
          const details = JSON.parse(bt.tax_details)
          if (details.length && details.every(t => (t.amount || 0) === 0)) qbCode = '4'
        } catch {}
        if (!qbCode) warnings.push(`Taxe non mappée pour ${baseLabel}`)
      }
      if (qbCode) {
        revenueDetail.TaxCodeRef = { value: qbCode }
        // Ligne de revenu (vente ou remboursement de vente) → taxe perçue du client.
        // Sans ce champ, QB assigne arbitrairement "Purchase" et la taxe est imputée
        // en CTI au lieu de TPS/TVQ perçue, faussant la déclaration.
        revenueDetail.TaxApplicableOn = 'Sales'
      }

      // Description sobre : #FACTURE — Client (la taxe est visible via TaxCodeRef côté QB).
      const description = baseLabel

      // Record 1 : montant net (HT) — QB ajoutera la taxe via TaxCodeRef en mode TaxExcluded,
      // ce qui fera que TotalAmt = NET + taxe = montant TTC reçu du client. Deposit n'honore
      // pas TaxInclusive sur DepositLineDetail (ignore silencieusement), donc on envoie HT.
      const invoiceTax = (bt.invoice_tax_gst || 0) + (bt.invoice_tax_qst || 0)
      const netRevenueAmount = bt.amount - invoiceTax
      const revenueGroup = isRefund
        ? 'refund'
        : isDeferred
          ? 'revenue_deferred'
          : (bt.is_subscription ? 'revenue_subscription' : 'revenue_sale')
      lines.push({
        Amount: netRevenueAmount,
        DetailType: 'DepositLineDetail',
        DepositLineDetail: revenueDetail,
        Description: isDeferred ? `${description} · revenu reçu d’avance` : description,
        _group: revenueGroup,
      })

      if (isDeferred && factureForBt) {
        deferredFactures.push({
          factureId: factureForBt.id,
          document_number: factureForBt.document_number,
          amount_native: netRevenueAmount,
          currency: payout.currency || 'CAD',
        })
      }

      // Frais Stripe associés à la charge (traitement carte) : accumulés dans un bucket
      // unique pour la catégorie — une seule ligne émise à la fin.
      const feeTotal = processing + taxGst + taxQst
      if (feeTotal !== 0) {
        bucketFee('card_processing', -feeTotal, taxGst, taxQst)
        feesTotal -= feeTotal
        feesByCategory.card_processing -= feeTotal
      }

      if (isRefund) refundTotal += bt.amount
      else if (isDeferred) revenueDeferred += bt.amount
      else if (bt.is_subscription) revenueSubscription += bt.amount
      else revenueSale += bt.amount
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

  // Reconciliation check. En mode TaxExcluded, QB ajoute la taxe sur chaque ligne avec
  // TaxCodeRef, donc la somme des lignes + total des taxes extraites par QB doit égaler
  // le montant du payout. On approxime la taxe ajoutée avec bt.invoice_tax_* + bt.fee
  // (stripe_fee) — valeurs que Stripe nous a fournies.
  const linesSum = Math.round(lines.reduce((s, l) => s + l.Amount, 0) * 100) / 100
  let addedTax = 0
  for (const bt of bts) {
    if (bt.type === 'charge' || bt.type === 'payment' || bt.type === 'refund' || bt.type === 'payment_refund') {
      addedTax += (bt.invoice_tax_gst || 0) + (bt.invoice_tax_qst || 0)
    } else if (bt.type === 'stripe_fee' || bt.type === 'application_fee') {
      addedTax += -bt.fee  // Stripe prélève la taxe en + du montant HT → signe négatif pour le payout
    }
  }
  const expectedLinesSum = Math.round((payout.amount - addedTax) * 100) / 100
  const expected = Math.round(payout.amount * 100) / 100
  if (Math.abs(linesSum - expectedLinesSum) > 0.05) {
    throw new Error(
      `Incohérence: somme des lignes HT (${linesSum}) + taxes estimées (${addedTax.toFixed(2)}) ` +
      `≠ montant payout (${expected})`
    )
  }

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
    revenue_sale: Math.round(revenueSale * 100) / 100,
    revenue_subscription: Math.round(revenueSubscription * 100) / 100,
    revenue_deferred: Math.round(revenueDeferred * 100) / 100,
    deferred_factures: deferredFactures.map(f => ({
      facture_id: f.factureId,
      document_number: f.document_number,
      amount_native: Math.round(f.amount_native * 100) / 100,
      currency: f.currency,
    })),
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

  return { deposit, summary, warnings, deferredFactures, exchangeRate }
}

export async function pushDepositFromPayout(payoutStripeId) {
  const payout = db.prepare('SELECT * FROM stripe_payouts WHERE stripe_id=?').get(payoutStripeId)
  if (!payout) throw new Error(`Payout introuvable: ${payoutStripeId}`)
  if (payout.qb_deposit_id) throw new Error(`Déjà envoyé à QB (Deposit ID: ${payout.qb_deposit_id})`)

  const { deposit, summary, warnings, deferredFactures, exchangeRate } = await buildDepositFromPayout(payoutStripeId)
  const result = await qbPost('/deposit', deposit)
  const qbId = result.Deposit.Id
  db.prepare("UPDATE stripe_payouts SET qb_deposit_id=?, qb_pushed_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE stripe_id=?")
    .run(qbId, payoutStripeId)

  // Marque les factures publiées en revenu reçu d'avance (idempotent : on ne réécrit pas si déjà set).
  const stmt = db.prepare(`
    UPDATE factures
    SET deferred_revenue_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        deferred_revenue_amount_native = ?,
        deferred_revenue_amount_cad = ?,
        deferred_revenue_currency = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ? AND deferred_revenue_at IS NULL
  `)
  for (const f of deferredFactures) {
    const cad = Math.round(f.amount_native * (exchangeRate || 1) * 100) / 100
    stmt.run(f.amount_native, cad, f.currency, f.factureId)
  }
  return { qb_deposit_id: qbId, summary, warnings }
}

// Crée un Journal Entry dans QB pour reconnaître la vente :
//   DR Revenus perçus d'avance  (réduit le passif)
//   CR Ventes                   (constate le revenu)
// Montant = deferred_revenue_amount_native (HT, dans la devise de la facture).
// Marque la facture avec revenue_recognized_at + revenue_recognized_je_id.
export async function postRevenueRecognitionJE(factureId) {
  const f = db.prepare(`
    SELECT id, document_number, deferred_revenue_at, deferred_revenue_amount_native,
           deferred_revenue_currency, revenue_recognized_at, revenue_recognized_je_id, company_id
    FROM factures WHERE id = ?
  `).get(factureId)
  if (!f) throw new Error('Facture introuvable')
  if (!f.deferred_revenue_at) throw new Error('Facture non publiée en revenu reçu d’avance')
  if (f.revenue_recognized_at) throw new Error(`Vente déjà constatée (JE ${f.revenue_recognized_je_id || '?'})`)
  if (!f.deferred_revenue_amount_native) throw new Error('Montant déféré inconnu — relance le push du payout')
  if (!factureHasLinkedShipment(f.id)) throw new Error('Aucun envoi sur une commande liée — la vente ne peut pas encore être constatée')

  const accounts = await resolveQBStripeAccounts()
  const currency = f.deferred_revenue_currency || 'CAD'
  const amount = Math.round(f.deferred_revenue_amount_native * 100) / 100

  const today = new Date().toISOString().slice(0, 10)
  let exchangeRate = 1
  if (currency === 'USD') {
    exchangeRate = await getUsdCadRate(today)
    if (!exchangeRate) throw new Error(`Taux USD→CAD indisponible pour ${today}`)
  }

  const je = {
    TxnDate: today,
    CurrencyRef: { value: currency },
    ExchangeRate: exchangeRate,
    PrivateNote: `Constatation de vente — facture #${f.document_number || f.id} (envoi effectué)`,
    Line: [
      {
        DetailType: 'JournalEntryLineDetail',
        Amount: amount,
        Description: `Constatation #${f.document_number || f.id}`,
        JournalEntryLineDetail: {
          PostingType: 'Debit',
          AccountRef: { value: accounts.revenue_deferred },
        },
      },
      {
        DetailType: 'JournalEntryLineDetail',
        Amount: amount,
        Description: `Constatation #${f.document_number || f.id}`,
        JournalEntryLineDetail: {
          PostingType: 'Credit',
          AccountRef: { value: accounts.revenue_sale },
        },
      },
    ],
  }
  const result = await qbPost('/journalentry', je)
  const jeId = result.JournalEntry?.Id
  if (!jeId) throw new Error('QB n’a pas retourné d’Id pour le JournalEntry')

  db.prepare(`
    UPDATE factures
    SET revenue_recognized_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        revenue_recognized_je_id = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(String(jeId), factureId)

  return { qb_journal_entry_id: String(jeId), amount, currency }
}
