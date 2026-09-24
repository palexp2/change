// ── Le PDF de la facture, joint à l'écriture d'encaissement ─────────────────
// Quand un virement client est comptabilisé, le dépôt QuickBooks ne portait
// rien : il fallait ouvrir Stripe pour savoir ce qui avait été payé. On y
// attache donc le PDF de la facture (demande de Charles, 2026-09-19). Le
// fichier déjà téléchargé par le webhook Stripe sert en priorité ; sinon on
// redemande l'invoice à Stripe, car le lien `invoice_pdf` expire.
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import path from 'path'
import db from '../db/database.js'
import { uploadsPath } from '../config/uploads.js'
import { downloadStripeInvoicePdf } from './stripeInvoicePdf.js'
import { getStripeKey } from './stripe.js'

// Chemin absolu du PDF Stripe de la facture, téléchargé au besoin.
// null si la facture n'a pas d'invoice Stripe ou si Stripe n'en fournit pas.
export async function ensureFactureStripePdf(factureId) {
  const row = db.prepare(
    'SELECT id, invoice_id, document_number, airtable_pdf_path FROM factures WHERE id=?'
  ).get(factureId)
  if (!row) return null

  if (row.airtable_pdf_path) {
    const abs = path.join(uploadsPath(), row.airtable_pdf_path)
    if (existsSync(abs)) return { absPath: abs, relPath: row.airtable_pdf_path, facture: row }
  }
  if (!row.invoice_id) return null

  const key = getStripeKey()
  if (!key) return null
  const { default: Stripe } = await import('stripe')
  const stripe = new Stripe(key)
  const inv = await stripe.invoices.retrieve(row.invoice_id)
  if (!inv?.invoice_pdf) return null
  const relPath = await downloadStripeInvoicePdf(inv, row.id)
  if (!relPath) return null
  db.prepare("UPDATE factures SET airtable_pdf_path=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?")
    .run(relPath, row.id)
  return { absPath: path.join(uploadsPath(), relPath), relPath, facture: row }
}

// Joint ce PDF à une transaction QuickBooks. Idempotent : une transaction qui
// porte déjà un fichier du même nom est laissée telle quelle.
export async function attachFacturePdfToQbEntity({ factureId, entityType, entityId }) {
  if (!factureId || !entityType || !entityId) return { attached: false, reason: 'incomplet' }
  const pdf = await ensureFactureStripePdf(factureId)
  if (!pdf) return { attached: false, reason: 'aucun PDF Stripe' }

  const { qbGet, qbUploadAttachment } = await import('../connectors/quickbooks.js')
  const fileName = `Facture ${pdf.facture.document_number || pdf.facture.id}.pdf`

  const query = `SELECT * FROM Attachable WHERE AttachableRef.EntityRef.Type = '${entityType}' AND AttachableRef.EntityRef.Value = '${entityId}'`
  const resp = await qbGet(`/query?query=${encodeURIComponent(query)}`)
  const already = (resp?.QueryResponse?.Attachable || []).some(a => a.FileName === fileName)
  if (already) return { attached: false, reason: 'déjà jointe', fileName }

  await qbUploadAttachment({
    entityType, entityId: String(entityId),
    fileBuffer: await readFile(pdf.absPath),
    fileName, contentType: 'application/pdf',
  })
  return { attached: true, fileName }
}
