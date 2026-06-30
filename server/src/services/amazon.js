import { writeFileSync } from 'fs'
import { join } from 'path'
import { v4 as uuid } from 'uuid'
import db from '../db/database.js'
import { emitEntity } from './realtimeEmitters.js'
import { runExtractionAndUpdate } from './saleReceiptExtraction.js'
import { amazonGet, amazonPost, amazonRequest, isAmazonConfigured } from '../connectors/amazon.js'

// ── Sync des factures Amazon Business ─────────────────────────────────────────
// Récupère les factures d'achat Amazon et les fait tomber dans le pipeline
// `sale_receipts` existant (même chemin que l'ingestion Gmail : on écrit le PDF
// sur disque, on crée la ligne, puis runExtractionAndUpdate fait l'extraction IA).
//
// Flux (cf. https://docs.business.amazon.com/docs/document-api) :
//   1. POST /reports/2021-09-30/reports         → créer un rapport de réconciliation
//   2. GET  /reports/2021-09-30/reports/{id}    → poller jusqu'à status DONE
//   3. GET  /reports/2021-09-30/documents/{id}  → récupérer le doc (liste de factures)
//   4. Pour chaque facture nouvelle → télécharger le PDF (Document API) → sale_receipts
//
// ⚠️ À FINALISER À L'ONBOARDING : le `reportType` exact, le format du document de
// réconciliation, et l'endpoint précis de téléchargement PDF par facture ne sont
// documentés en détail qu'une fois l'accès API approuvé. Les seams sont en place ;
// les TODO marquent les 3 points à brancher avec les vrais champs.

const receiptsDir = join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'receipts')

const REPORTS_BASE = '/reports/2021-09-30'
// TODO(onboarding): confirmer le reportType de réconciliation des factures.
const RECONCILIATION_REPORT_TYPE = process.env.AMAZON_RECON_REPORT_TYPE || 'GET_BUSINESS_RECONCILIATION'
// Compte système auquel rattacher les reçus importés (created_by). NULL accepté.
const SYSTEM_USER_EMAIL = process.env.AMAZON_IMPORT_USER_EMAIL || null

function importUserId() {
  if (!SYSTEM_USER_EMAIL) return null
  const u = db.prepare('SELECT id FROM users WHERE email=?').get(SYSTEM_USER_EMAIL)
  return u?.id || null
}

// Crée un rapport de réconciliation et attend qu'il soit prêt, puis renvoie la
// liste brute des factures (structure dépendante du reportType — à mapper).
async function fetchReconciliationInvoices({ startDate, endDate }) {
  // 1. Créer le rapport
  const created = await amazonPost(`${REPORTS_BASE}/reports`, {
    reportType: RECONCILIATION_REPORT_TYPE,
    dataStartTime: startDate,
    dataEndTime: endDate,
  })
  const reportId = created.reportId
  if (!reportId) throw new Error('Amazon createReport: pas de reportId retourné')

  // 2. Poller jusqu'à DONE (timeout ~2 min)
  let reportDocumentId = null
  for (let attempt = 0; attempt < 24; attempt++) {
    const report = await amazonGet(`${REPORTS_BASE}/reports/${reportId}`)
    const status = report.processingStatus
    if (status === 'DONE') { reportDocumentId = report.reportDocumentId; break }
    if (status === 'FATAL' || status === 'CANCELLED') {
      throw new Error(`Amazon report ${reportId} status=${status}`)
    }
    await new Promise(r => setTimeout(r, 5000))
  }
  if (!reportDocumentId) throw new Error(`Amazon report ${reportId} non prêt (timeout)`)

  // 3. Récupérer le document (contient l'URL/le contenu de la réconciliation)
  const doc = await amazonGet(`${REPORTS_BASE}/documents/${reportDocumentId}`)

  // TODO(onboarding): le document expose typiquement une `url` S3 vers un fichier
  // (CSV/JSON/gzip) à télécharger et parser. Mapper ici vers une liste normalisée :
  //   [{ invoiceId, orderId, documentId, invoiceDate, total, currency }]
  // Tant que le format exact n'est pas confirmé, on lève une erreur explicite
  // plutôt que d'inventer un schéma.
  void doc
  throw new Error('Amazon: parsing du document de réconciliation à finaliser à l\'onboarding (voir TODO services/amazon.js)')
}

// Télécharge le PDF d'une facture via la Document API et le persiste, puis crée
// la ligne sale_receipts et déclenche l'extraction IA (idempotent par invoiceId).
async function importInvoice(inv, userId) {
  // Dédup : déjà importée ?
  const already = db.prepare('SELECT 1 FROM sale_receipts WHERE amazon_invoice_id=?').get(inv.invoiceId)
  if (already) return false

  // TODO(onboarding): endpoint exact de téléchargement du PDF de facture.
  // L'appel renvoie le binaire PDF (accept application/pdf).
  const resp = await amazonRequest('GET', `/documents/${inv.documentId}`, { accept: 'application/pdf' })
  const buffer = Buffer.from(await resp.arrayBuffer())

  const id = uuid()
  const storedName = `${id}.pdf`
  const filePath = join(receiptsDir, storedName)
  writeFileSync(filePath, buffer)

  const originalName = `Amazon-${inv.invoiceId}.pdf`
  db.prepare(`
    INSERT INTO sale_receipts (id, filename, original_name, file_type, status, created_by, source, amazon_invoice_id)
    VALUES (?, ?, ?, '.pdf', 'processing', ?, 'amazon', ?)
  `).run(id, storedName, originalName, userId, inv.invoiceId)

  const created = db.prepare('SELECT * FROM sale_receipts WHERE id=?').get(id)
  if (created) emitEntity('sale_receipt', 'created', id, { ...created, items: [] }, userId)

  runExtractionAndUpdate({ saleReceiptId: id, filePath, fileExt: '.pdf', userId, trigger: 'scheduled' })
  return true
}

// Point d'entrée de la sync (appelé par POST /sync/amazon et le cron).
export async function syncAmazon({ days = 30 } = {}) {
  if (!isAmazonConfigured()) throw new Error('Amazon Business non configuré')

  const userId = importUserId()
  const endDate = new Date().toISOString()
  const startDate = new Date(Date.now() - days * 86400_000).toISOString()

  const invoices = await fetchReconciliationInvoices({ startDate, endDate })

  let imported = 0
  for (const inv of invoices) {
    try {
      if (await importInvoice(inv, userId)) imported++
    } catch (e) {
      console.error(`❌ Amazon import facture ${inv.invoiceId}:`, e.message)
    }
  }
  return { status: 'success', imported }
}
