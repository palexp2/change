import { mkdir, writeFile } from 'fs/promises'
import path from 'path'
import { uploadsPath } from '../config/uploads.js'

export async function downloadStripeInvoicePdf(invoice, factureId) {
  const url = invoice?.invoice_pdf
  if (!url || !factureId) return null
  const dir = uploadsPath('factures')
  await mkdir(dir, { recursive: true })
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const filePath = path.join(dir, `${factureId}.pdf`)
  await writeFile(filePath, buf)
  return `factures/${factureId}.pdf`
}
