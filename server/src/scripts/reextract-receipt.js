#!/usr/bin/env node
// Relance l'extraction IA d'un reçu existant (mêmes pages, même service que la fiche).
// Usage : node src/scripts/reextract-receipt.js <sale_receipt_id>
import 'dotenv/config'
import { join } from 'path'
import db from '../db/database.js'
import { runExtractionAndUpdate } from '../services/saleReceiptExtraction.js'

const id = process.argv[2]
if (!id) { console.error('Usage: reextract-receipt.js <sale_receipt_id>'); process.exit(1) }
const row = db.prepare('SELECT * FROM sale_receipts WHERE id=? AND deleted_at IS NULL').get(id)
if (!row) { console.error('Reçu introuvable'); process.exit(1) }
let extra = []
try { extra = JSON.parse(row.extra_pages || '[]') } catch {}
const dir = join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'receipts')
const pages = [{ filename: row.filename, file_type: row.file_type }, ...extra]
  .filter(p => p?.filename)
  .map(p => ({ filePath: join(dir, p.filename), fileExt: p.file_type }))
await runExtractionAndUpdate({ saleReceiptId: id, pages, trigger: 'manual' })
const after = db.prepare('SELECT subtotal, tps, tvq, other_taxes, total, items FROM sale_receipts WHERE id=?').get(id)
console.log(after)
process.exit(0)
