import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { qbGet, qbPost } from '../connectors/quickbooks.js'

function getQBConfig(tenantId) {
  const rows = db.prepare("SELECT key, value FROM connector_config WHERE tenant_id=? AND connector='quickbooks'").all(tenantId)
  return Object.fromEntries(rows.map(r => [r.key, r.value]))
}

// Recherche un fournisseur QB par nom, le crée si absent.
// Synchronise aussi avec la table companies (type=Fournisseur).
// Retourne le QB Vendor ID (string).
async function findOrCreateVendor(vendorName, tenantId) {
  // 1. Chercher dans companies par nom pour récupérer un quickbooks_vendor_id déjà connu
  const existing = db.prepare(
    "SELECT id, quickbooks_vendor_id FROM companies WHERE tenant_id=? AND name=? LIMIT 1"
  ).get(tenantId, vendorName)

  if (existing?.quickbooks_vendor_id) return existing.quickbooks_vendor_id

  // 2. Chercher dans QB
  const safe = vendorName.replace(/'/g, "\\'")
  const q = new URLSearchParams({ query: `SELECT * FROM Vendor WHERE DisplayName = '${safe}' MAXRESULTS 1` })
  const result = await qbGet(`/query?${q}`, tenantId)
  const vendors = result.QueryResponse?.Vendor || []
  let qbVendorId

  if (vendors.length > 0) {
    qbVendorId = vendors[0].Id
  } else {
    const created = await qbPost('/vendor', tenantId, { DisplayName: vendorName })
    qbVendorId = created.Vendor.Id
  }

  // 3. Mettre à jour ou créer l'entreprise locale
  if (existing) {
    db.prepare("UPDATE companies SET quickbooks_vendor_id=?, updated_at=datetime('now') WHERE id=?")
      .run(qbVendorId, existing.id)
  } else {
    db.prepare(`
      INSERT OR IGNORE INTO companies (id, tenant_id, name, type, quickbooks_vendor_id)
      VALUES (?, ?, ?, 'Fournisseur', ?)
    `).run(randomUUID(), tenantId, vendorName, qbVendorId)
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

export async function pushDepenseToQB(tenantId, depenseId) {
  const dep = db.prepare('SELECT * FROM depenses WHERE id=? AND tenant_id=?').get(depenseId, tenantId)
  if (!dep) throw new Error('Dépense introuvable')
  if (dep.quickbooks_id) throw new Error(`Dépense déjà publiée sur QuickBooks (ID: ${dep.quickbooks_id})`)

  const cfg = getQBConfig(tenantId)
  if (!cfg.expense_account_id) throw new Error('Compte de dépense QuickBooks non configuré')
  if (!cfg.payment_account_id) throw new Error('Compte de paiement QuickBooks non configuré')

  const purchase = {
    PaymentType: PAYMENT_TYPE_MAP[dep.payment_method] || 'Cash',
    AccountRef: { value: cfg.payment_account_id },
    TxnDate: dep.date_depense,
    TotalAmt: dep.total_cad,
    Line: [{
      Amount: dep.total_cad,
      DetailType: 'AccountBasedExpenseLineDetail',
      AccountBasedExpenseLineDetail: { AccountRef: { value: cfg.expense_account_id } },
      Description: dep.description || dep.category,
    }],
  }

  if (dep.vendor_id || dep.vendor) {
    let qbVendorId = null
    if (dep.vendor_id) {
      const company = db.prepare('SELECT quickbooks_vendor_id, name FROM companies WHERE id=?').get(dep.vendor_id)
      if (company?.quickbooks_vendor_id) qbVendorId = company.quickbooks_vendor_id
      else if (company) qbVendorId = await findOrCreateVendor(company.name, tenantId)
    } else {
      qbVendorId = await findOrCreateVendor(dep.vendor, tenantId)
    }
    if (qbVendorId) purchase.EntityRef = { value: qbVendorId, type: 'Vendor' }
  }

  if (dep.reference) purchase.DocNumber = dep.reference

  const result = await qbPost('/purchase', tenantId, purchase)
  const qbId = result.Purchase.Id
  db.prepare("UPDATE depenses SET quickbooks_id=?, updated_at=datetime('now') WHERE id=?").run(qbId, depenseId)
  return qbId
}

export async function syncAllDepensesToQB(tenantId) {
  const cfg = getQBConfig(tenantId)
  if (!cfg.expense_account_id || !cfg.payment_account_id) {
    throw new Error('Configurez les comptes QuickBooks avant de synchroniser')
  }

  const rows = db.prepare(
    "SELECT id FROM depenses WHERE tenant_id=? AND quickbooks_id IS NULL AND status NOT IN ('Brouillon')"
  ).all(tenantId)

  let synced = 0
  const errors = []
  for (const { id } of rows) {
    try {
      await pushDepenseToQB(tenantId, id)
      synced++
    } catch (e) {
      errors.push({ id, error: e.message })
      console.error(`QB sync dépense ${id}:`, e.message)
    }
  }
  console.log(`✅ QB dépenses: ${synced} publiées, ${errors.length} erreurs`)
  return { synced, errors }
}

// ── Factures fournisseurs → QB Bill ──────────────────────────────────────────

export async function pushFactureToQB(tenantId, factureId) {
  const fac = db.prepare('SELECT * FROM factures_fournisseurs WHERE id=? AND tenant_id=?').get(factureId, tenantId)
  if (!fac) throw new Error('Facture introuvable')
  if (fac.quickbooks_id) throw new Error(`Facture déjà publiée sur QuickBooks (ID: ${fac.quickbooks_id})`)

  const cfg = getQBConfig(tenantId)
  if (!cfg.expense_account_id) throw new Error('Compte de dépense QuickBooks non configuré')

  let vendorId = null
  if (fac.vendor_id) {
    const company = db.prepare('SELECT quickbooks_vendor_id, name FROM companies WHERE id=?').get(fac.vendor_id)
    if (company?.quickbooks_vendor_id) vendorId = company.quickbooks_vendor_id
    else if (company) vendorId = await findOrCreateVendor(company.name, tenantId)
  }
  if (!vendorId) vendorId = await findOrCreateVendor(fac.vendor, tenantId)

  const bill = {
    VendorRef: { value: vendorId },
    TxnDate: fac.date_facture,
    Line: [{
      Amount: fac.total_cad,
      DetailType: 'AccountBasedExpenseLineDetail',
      AccountBasedExpenseLineDetail: { AccountRef: { value: cfg.expense_account_id } },
      Description: fac.notes || fac.vendor_invoice_number || fac.vendor,
    }],
  }

  if (fac.due_date) bill.DueDate = fac.due_date
  if (fac.vendor_invoice_number) bill.DocNumber = fac.vendor_invoice_number

  const result = await qbPost('/bill', tenantId, bill)
  const qbId = result.Bill.Id
  db.prepare("UPDATE factures_fournisseurs SET quickbooks_id=?, updated_at=datetime('now') WHERE id=?").run(qbId, factureId)
  return qbId
}

export async function syncAllFacturesToQB(tenantId) {
  const cfg = getQBConfig(tenantId)
  if (!cfg.expense_account_id) {
    throw new Error('Configurez les comptes QuickBooks avant de synchroniser')
  }

  const rows = db.prepare(
    "SELECT id FROM factures_fournisseurs WHERE tenant_id=? AND quickbooks_id IS NULL AND status NOT IN ('Brouillon', 'Annulée')"
  ).all(tenantId)

  let synced = 0
  const errors = []
  for (const { id } of rows) {
    try {
      await pushFactureToQB(tenantId, id)
      synced++
    } catch (e) {
      errors.push({ id, error: e.message })
      console.error(`QB sync facture ${id}:`, e.message)
    }
  }
  console.log(`✅ QB factures: ${synced} publiées, ${errors.length} erreurs`)
  return { synced, errors }
}

// ── Import depuis QB → factures_fournisseurs ─────────────────────────────────

// Trouve ou crée une entreprise locale pour un fournisseur QB (sans appel API QB)
function upsertVendorCompany(tenantId, qbVendorId, vendorName) {
  const byQbId = db.prepare(
    "SELECT id FROM companies WHERE tenant_id=? AND quickbooks_vendor_id=?"
  ).get(tenantId, qbVendorId)
  if (byQbId) return byQbId.id

  const byName = db.prepare(
    "SELECT id FROM companies WHERE tenant_id=? AND name=? LIMIT 1"
  ).get(tenantId, vendorName)
  if (byName) {
    db.prepare("UPDATE companies SET quickbooks_vendor_id=?, updated_at=datetime('now') WHERE id=?")
      .run(qbVendorId, byName.id)
    return byName.id
  }

  const id = randomUUID()
  db.prepare(`
    INSERT INTO companies (id, tenant_id, name, type, quickbooks_vendor_id)
    VALUES (?, ?, ?, 'Fournisseur', ?)
  `).run(id, tenantId, vendorName, qbVendorId)
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

async function fetchAllQBPages(path, tenantId, entity) {
  const results = []
  let startPos = 1
  const pageSize = 1000
  while (true) {
    const q = encodeURIComponent(`SELECT * FROM ${entity} MAXRESULTS ${pageSize} STARTPOSITION ${startPos}`)
    const data = await qbGet(`/query?query=${q}`, tenantId)
    const rows = data.QueryResponse?.[entity] || []
    results.push(...rows)
    if (rows.length < pageSize) break
    startPos += pageSize
  }
  return results
}

export async function importFromQB(tenantId) {
  const today = new Date().toISOString().slice(0, 10)
  let inserted = 0
  let updated = 0
  const errors = []

  // ── 1. QB Bills → factures_fournisseurs ──────────────────────────────────
  let bills = []
  try {
    bills = await fetchAllQBPages('/query', tenantId, 'Bill')
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
      const vendorCompanyId = qbVendorId ? upsertVendorCompany(tenantId, qbVendorId, vendor) : null
      const lines = extractLines(bill.Line)

      const existing = db.prepare(
        "SELECT id FROM factures_fournisseurs WHERE quickbooks_id=? AND tenant_id=?"
      ).get(qbId, tenantId)

      if (existing) {
        db.prepare(`
          UPDATE factures_fournisseurs
          SET vendor=?, vendor_id=?, date_facture=?, due_date=?, total_cad=?, amount_paid_cad=?,
              status=?, vendor_invoice_number=?, notes=?, lines=?, updated_at=datetime('now')
          WHERE id=? AND tenant_id=?
        `).run(vendor, vendorCompanyId, dateFact, dueDate, total, amountPaid, status, docNum, notes, lines, existing.id, tenantId)
        updated++
      } else {
        db.prepare(`
          INSERT INTO factures_fournisseurs
            (id, tenant_id, vendor, vendor_id, date_facture, due_date, amount_cad, tax_cad, total_cad, amount_paid_cad, status, vendor_invoice_number, notes, lines, quickbooks_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          randomUUID(), tenantId, vendor, vendorCompanyId, dateFact, dueDate,
          total, 0, total, amountPaid, status, docNum, notes, lines, qbId
        )
        inserted++
      }
    } catch (e) {
      errors.push({ type: 'Bill', qbId: bill.Id, error: e.message })
    }
  }

  // ── 2. QB Purchases avec fournisseur → depenses ──────────────────────────
  const QB_PAYMENT_METHOD = {
    CreditCard: 'Carte de crédit',
    Check:      'Chèque',
    Cash:       'Comptant',
    ECheck:     'Virement',
  }

  let purchases = []
  try {
    purchases = await fetchAllQBPages('/query', tenantId, 'Purchase')
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
      const dateDepense    = purchase.TxnDate || today
      const total          = purchase.TotalAmt ?? 0
      const reference      = purchase.DocNumber || null
      const notes          = purchase.PrivateNote || null
      const paymentMethod  = QB_PAYMENT_METHOD[purchase.PaymentType] || 'Autre'
      const description    = purchase.Line?.[0]?.Description || vendor
      const vendorCompanyId = upsertVendorCompany(tenantId, qbVendorId, vendor)
      const lines = extractLines(purchase.Line)

      const existing = db.prepare(
        "SELECT id FROM depenses WHERE quickbooks_id=? AND tenant_id=?"
      ).get(qbId, tenantId)

      if (existing) {
        db.prepare(`
          UPDATE depenses
          SET vendor=?, vendor_id=?, date_depense=?, amount_cad=?, payment_method=?,
              description=?, reference=?, notes=?, lines=?, updated_at=datetime('now')
          WHERE id=? AND tenant_id=?
        `).run(vendor, vendorCompanyId, dateDepense, total, paymentMethod, description, reference, notes, lines, existing.id, tenantId)
        updatedDep++
      } else {
        db.prepare(`
          INSERT INTO depenses
            (id, tenant_id, date_depense, description, vendor, vendor_id, reference, amount_cad, tax_cad, payment_method, status, notes, lines, quickbooks_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          randomUUID(), tenantId, dateDepense, description, vendor, vendorCompanyId,
          reference, total, 0, paymentMethod, 'Approuvé', notes, lines, qbId
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

// ── Reçus de vente → QB Purchase ─────────────────────────────────────────────

// params: { expenseAccountId, paymentAccountId, vendorId, newVendorName }
export async function pushSaleReceiptToQB(tenantId, receiptId, params = {}) {
  const rec = db.prepare('SELECT * FROM sale_receipts WHERE id=? AND tenant_id=?').get(receiptId, tenantId)
  if (!rec) throw new Error('Reçu introuvable')
  if (rec.status !== 'done') throw new Error('Le reçu doit être extrait avant de pouvoir être publié')
  if (rec.quickbooks_id) throw new Error(`Reçu déjà publié sur QuickBooks (ID: ${rec.quickbooks_id})`)

  // Résoudre les comptes : params en priorité, sinon config globale
  const cfg = getQBConfig(tenantId)
  const expenseAccountId = params.expenseAccountId || cfg.expense_account_id
  const paymentAccountId = params.paymentAccountId || cfg.payment_account_id
  if (!expenseAccountId) throw new Error('Compte de dépense non spécifié')
  if (!paymentAccountId) throw new Error('Compte de paiement non spécifié')

  // Résoudre le fournisseur
  let vendorId = params.vendorId || null
  if (!vendorId && params.newVendorName) {
    vendorId = await findOrCreateVendor(params.newVendorName, tenantId)
  } else if (!vendorId && rec.company) {
    // fallback : chercher par nom extrait (ne crée pas automatiquement)
    const q = new URLSearchParams({ query: `SELECT * FROM Vendor WHERE DisplayName = '${rec.company.replace(/'/g, "\\'")}' MAXRESULTS 1` })
    const result = await qbGet(`/query?${q}`, tenantId)
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

  const result = await qbPost('/purchase', tenantId, purchase)
  const qbId = result.Purchase.Id
  db.prepare("UPDATE sale_receipts SET quickbooks_id=?, updated_at=datetime('now') WHERE id=?").run(qbId, receiptId)
  return qbId
}
