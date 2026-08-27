// Relevés mensuels de fournisseurs prépayés (Twilio & co).
//
// Un fournisseur prépayé envoie, à la fin du mois ou au début du suivant, DEUX
// documents qui récapitulent le mois écoulé : la facture d'usage et le reçu de
// paiement. Ces documents ne se comptabilisent pas : la dépense est déjà dans
// QuickBooks via les recharges de la carte pendant le mois. La seule chose à
// faire, c'est de les JOINDRE aux transactions QB du mois correspondant, pour
// que la pièce justificative soit accrochée aux écritures.
//
// La détection est ancrée sur les comptes prépayés (prepaid_accounts) : un
// document dont le fournisseur est un compte prépayé actif EST un relevé
// mensuel. Aucun fournisseur codé en dur.
import { randomUUID } from 'crypto'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import db from '../db/database.js'
import { qbGet, qbUploadAttachment, qbEntityUrl } from '../connectors/quickbooks.js'

const MONTHS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']

const QB_URL_SLUGS = { Purchase: 'expense', Bill: 'bill', VendorCredit: 'vendorcredit' }

const daysInMonth = (y, m1) => new Date(Date.UTC(y, m1, 0)).getUTCDate()

const MIME = {
  '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
}

// Nom de fournisseur comparable : minuscules, accents et ponctuation retirés,
// suffixes de forme juridique enlevés (« Twilio, Inc. » === « Twilio »).
export function normalizeVendorName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[.,]/g, ' ')
    .replace(/\b(inc|llc|ltd|ltee|limited|corp|corporation|co|sa|sas|gmbh)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Même fournisseur, autre devise : QuickBooks force un fournisseur par devise, d'où
// les « Twilio  USD » / « Slack Technologies - USD » à côté du fournisseur CAD. Pour
// retrouver TOUTES les transactions du mois, on considère ces variantes comme le
// même fournisseur.
export function isSameVendorFamily(accountVendor, qbDisplayName) {
  const base = normalizeVendorName(accountVendor)
  if (!base) return false
  const stripCurrency = s => s.replace(/\b(usd|cad|eur|us|ca)\b/g, ' ').replace(/\s+/g, ' ').trim()
  return stripCurrency(normalizeVendorName(qbDisplayName)) === stripCurrency(base)
}

export function monthLabel(month) {
  const [y, m] = String(month || '').split('-')
  const name = MONTHS_FR[Number(m) - 1]
  return name ? `${name} ${y}` : month
}

// Mois couvert par le document, dans l'ordre de fiabilité :
//   1. période de service extraite (« juillet 2026 », « 2026-07 », « 07/2026 »)
//   2. mois encodé dans le nom de fichier du fournisseur (…-2026-07-IV…)
//   3. mois de la date du document — replié sur le mois précédent quand le
//      document est daté dans les premiers jours (facture émise le 1er ou le 2
//      pour le mois qui vient de se terminer).
export function resolveStatementMonth(row) {
  const period = String(row?.service_period || '').trim()
  if (period) {
    const iso = period.match(/(20\d{2})-(0[1-9]|1[0-2])/)
    if (iso) return { month: `${iso[1]}-${iso[2]}`, source: 'période couverte' }
    const slash = period.match(/\b(0?[1-9]|1[0-2])\s*[/-]\s*(20\d{2})\b/)
    if (slash) return { month: `${slash[2]}-${String(slash[1]).padStart(2, '0')}`, source: 'période couverte' }
    const lower = period.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    const year = period.match(/\b(20\d{2})\b/)
    const idx = MONTHS_FR.findIndex(m => lower.includes(m.normalize('NFD').replace(/[\u0300-\u036f]/g, '')))
    if (idx >= 0 && year) return { month: `${year[1]}-${String(idx + 1).padStart(2, '0')}`, source: 'période couverte' }
  }
  const fromName = String(row?.original_name || '').match(/(20\d{2})-(0[1-9]|1[0-2])(?!\d)/)
  if (fromName) return { month: `${fromName[1]}-${fromName[2]}`, source: 'nom du fichier' }
  const date = String(row?.receipt_date || '')
  const m = date.match(/^(20\d{2})-(0[1-9]|1[0-2])-(\d{2})$/)
  if (m) {
    if (Number(m[3]) <= 5) {
      const prev = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1))
      prev.setUTCMonth(prev.getUTCMonth() - 1)
      return { month: prev.toISOString().slice(0, 7), source: 'date du document (mois précédent)' }
    }
    return { month: `${m[1]}-${m[2]}`, source: 'date du document' }
  }
  return null
}

// Twilio envoie DEUX documents chaque mois : la facture d'usage (nom de fichier
// « AC…-2026-07-IV<id>.pdf ») et le reçu de paiement des recharges déjà comptées
// via detectTwilioBankRecharges (nom de fichier « receipt--AC…2026-07….pdf »).
// Seule la facture doit alimenter le ledger prépayé — le reçu ferait double
// emploi avec les recharges déjà enregistrées.
export function isPaymentReceiptDocument(row) {
  const name = String(row?.original_name || row?.filename || '')
  return /^receipt[-_]/i.test(name)
}

// Facture (consommation) du mois : upsert d'une entrée 'facture' du ledger
// prépayé à partir du montant extrait du document, une seule fois par document
// (unicité sur sale_receipt_id) — un rattachement répété ou une correction
// d'extraction met à jour l'entrée existante plutôt que d'en créer une autre.
export function recordStatementLedgerEntry(row, { accountId, month }) {
  if (isPaymentReceiptDocument(row)) return null
  const amount = Math.round((Number(row?.total) || 0) * 100) / 100
  if (!(amount > 0)) return null
  const entryDate = `${month}-${String(daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)))).padStart(2, '0')}`
  const description = `Facture ${monthLabel(month)} — relevé joint automatiquement`
  const existing = db.prepare(`
    SELECT id FROM prepaid_ledger_entries WHERE sale_receipt_id = ? AND deleted_at IS NULL
  `).get(row.id)
  if (existing) {
    db.prepare(`
      UPDATE prepaid_ledger_entries
      SET entry_date = ?, amount = ?, description = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(entryDate, amount, description, existing.id)
    return { id: existing.id, amount, month, created: false }
  }
  const id = randomUUID()
  db.prepare(`
    INSERT INTO prepaid_ledger_entries (id, account_id, entry_date, type, amount, description, source, sale_receipt_id)
    VALUES (?,?,?,'facture',?,?,'manuel',?)
  `).run(id, accountId, entryDate, amount, description, row.id)
  return { id, amount, month, created: true }
}

// Compte prépayé correspondant au fournisseur du document, s'il y en a un.
export function findPrepaidAccountForVendor(company) {
  const target = normalizeVendorName(company)
  if (!target) return null
  const accounts = db.prepare(
    'SELECT * FROM prepaid_accounts WHERE active = 1 AND deleted_at IS NULL').all()
  return accounts.find(a =>
    normalizeVendorName(a.vendor) === target || normalizeVendorName(a.qb_vendor_name) === target) || null
}

// Détection complète : le document est-il un relevé mensuel d'un fournisseur
// prépayé, et de quel mois ? Retourne null quand ce n'en est pas un — c'est ce
// null qui masque le bouton dans l'interface.
export function detectPrepaidStatement(row) {
  const account = findPrepaidAccountForVendor(row?.company)
  if (!account) return null
  const resolved = resolveStatementMonth(row)
  if (!resolved) return null
  let attached = null
  try { attached = row.month_attach_result ? JSON.parse(row.month_attach_result) : null } catch {}
  return {
    account_id: account.id,
    vendor: account.qb_vendor_name || account.vendor,
    month: resolved.month,
    month_label: monthLabel(resolved.month),
    month_source: resolved.source,
    attached_at: row.month_attach_at || null,
    attached_month: row.month_attach_month || null,
    attached_result: attached,
  }
}

// Ids QB du fournisseur, toutes devises confondues.
async function resolveVendorIds(account) {
  const name = (account.qb_vendor_name || account.vendor || '').replace(/'/g, "\\'")
  const q = encodeURIComponent(`SELECT Id, DisplayName FROM Vendor WHERE DisplayName LIKE '%${name}%'`)
  const data = await qbGet(`/query?query=${q}`)
  return (data.QueryResponse?.Vendor || [])
    .filter(v => isSameVendorFamily(account.qb_vendor_name || account.vendor, v.DisplayName))
    .map(v => ({ id: String(v.Id), name: v.DisplayName }))
}

// Transactions QB du fournisseur (toutes devises) datées dans la fenêtre.
async function fetchVendorTxnsInRange(vendorIds, start, end) {
  const ids = new Set(vendorIds.map(v => v.id))
  const out = []
  for (const [entity, vendorOf] of [
    ['Purchase', t => t.EntityRef?.value],
    ['Bill', t => t.VendorRef?.value],
    ['VendorCredit', t => t.VendorRef?.value],
  ]) {
    const q = encodeURIComponent(
      `SELECT * FROM ${entity} WHERE TxnDate >= '${start}' AND TxnDate <= '${end}' MAXRESULTS 1000`)
    const data = await qbGet(`/query?query=${q}`)
    for (const t of data.QueryResponse?.[entity] || []) {
      if (!ids.has(String(vendorOf(t) || ''))) continue
      out.push({
        qb_txn_type: entity,
        qb_txn_id: String(t.Id),
        entry_date: t.TxnDate,
        amount: Number(t.TotalAmt) || 0,
        currency: t.CurrencyRef?.value || null,
      })
    }
  }
  return out.sort((a, b) => a.entry_date.localeCompare(b.entry_date))
}

// Pièces jointes déjà présentes sur une transaction QB — sert à ne pas
// téléverser deux fois le même fichier quand on relance le rattachement.
async function existingAttachmentNames(entityType, entityId) {
  const query = `SELECT * FROM Attachable WHERE AttachableRef.EntityRef.Type = '${entityType}' AND AttachableRef.EntityRef.Value = '${entityId}'`
  const resp = await qbGet(`/query?query=${encodeURIComponent(query)}`)
  return new Set((resp?.QueryResponse?.Attachable || []).map(a => a.FileName).filter(Boolean))
}

// Pages du document (page 1 + extra_pages), avec chemin absolu et type MIME.
function statementFiles(row) {
  const dir = join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'receipts')
  let extra = []
  try { extra = JSON.parse(row.extra_pages || '[]') } catch {}
  const pages = [
    { filename: row.filename, file_type: row.file_type, original_name: row.original_name },
    ...extra,
  ]
  return pages
    .filter(p => p?.filename && existsSync(join(dir, p.filename)))
    .map(p => ({
      path: join(dir, p.filename),
      name: p.original_name || p.filename,
      contentType: MIME[p.file_type] || 'application/octet-stream',
    }))
}

// Joint le document à toutes les transactions QB du fournisseur datées dans le
// mois. Idempotent : une transaction qui porte déjà un fichier du même nom est
// sautée. Le résultat est persisté sur le reçu pour être affiché ensuite.
export async function attachStatementToMonthQb(receiptId, { month = null } = {}) {
  const row = db.prepare('SELECT * FROM sale_receipts WHERE id=? AND deleted_at IS NULL').get(receiptId)
  if (!row) throw new Error('Document introuvable')
  const detection = detectPrepaidStatement(row)
  if (!detection) throw new Error("Ce document n'est pas un relevé mensuel de fournisseur prépayé")
  const targetMonth = month || detection.month
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(targetMonth)) throw new Error('Mois invalide (YYYY-MM attendu)')

  const files = statementFiles(row)
  if (!files.length) throw new Error('Fichier du document introuvable sur le serveur')

  const account = db.prepare('SELECT * FROM prepaid_accounts WHERE id=?').get(detection.account_id)
  const vendorIds = await resolveVendorIds(account)
  if (!vendorIds.length) throw new Error(`Fournisseur QB introuvable : « ${account.qb_vendor_name || account.vendor} »`)

  const start = `${targetMonth}-01`
  const endDate = new Date(Date.UTC(Number(targetMonth.slice(0, 4)), Number(targetMonth.slice(5, 7)), 0))
  const end = endDate.toISOString().slice(0, 10)
  const txns = await fetchVendorTxnsInRange(vendorIds, start, end)

  const results = []
  for (const t of txns) {
    const already = await existingAttachmentNames(t.qb_txn_type, t.qb_txn_id)
    const uploaded = []
    let skipped = 0
    for (const f of files) {
      if (already.has(f.name)) { skipped++; continue }
      await qbUploadAttachment({
        entityType: t.qb_txn_type,
        entityId: t.qb_txn_id,
        fileBuffer: readFileSync(f.path),
        fileName: f.name,
        contentType: f.contentType,
      })
      uploaded.push(f.name)
    }
    results.push({
      qb_txn_type: t.qb_txn_type,
      qb_txn_id: t.qb_txn_id,
      entry_date: t.entry_date,
      amount: t.amount,
      uploaded: uploaded.length,
      skipped,
      qb_url: QB_URL_SLUGS[t.qb_txn_type] ? qbEntityUrl(QB_URL_SLUGS[t.qb_txn_type], t.qb_txn_id) : null,
    })
  }

  const ledgerEntry = recordStatementLedgerEntry(row, { accountId: account.id, month: targetMonth })

  const summary = {
    month: targetMonth,
    vendor: detection.vendor,
    transactions: results,
    attached: results.reduce((s, r) => s + r.uploaded, 0),
    skipped: results.reduce((s, r) => s + r.skipped, 0),
    files: files.map(f => f.name),
    ledger_entry: ledgerEntry,
  }
  db.prepare(`
    UPDATE sale_receipts
    SET month_attach_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        month_attach_month = ?, month_attach_result = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(targetMonth, JSON.stringify(summary), receiptId)
  return summary
}
