import { readFileSync } from 'fs'
import { spawnSync } from 'child_process'
import db from '../db/database.js'
import { emitEntity } from './realtimeEmitters.js'

const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.webp']

const SYSTEM_PROMPT = `Tu es un assistant spécialisé dans l'extraction de données de reçus et factures de vente.
Extrait toutes les informations disponibles et retourne un JSON valide avec exactement cette structure:
{
  "receipt_date": "YYYY-MM-DD ou null",
  "company": "nom de l'entreprise/magasin ou null",
  "address": "adresse complète ou null",
  "receipt_number": "numéro de reçu/facture ou null",
  "items": [{"description": "...", "quantity": 1, "unit_price": 0.00, "total": 0.00}],
  "subtotal": 0.00,
  "tps": 0.00,
  "tvq": 0.00,
  "other_taxes": 0.00,
  "total": 0.00,
  "payment_method": "méthode de paiement ou null",
  "currency": "CAD",
  "notes": "autres informations pertinentes ou null"
}
Retourne UNIQUEMENT le JSON, sans texte supplémentaire ni balises markdown.
Si une valeur est inconnue, utilise null pour les chaînes et 0 pour les nombres.`

export async function extractWithOpenAI(filePath, fileExt) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY non configuré')

  let messages

  if (IMAGE_EXT.includes(fileExt)) {
    const fileBuffer = readFileSync(filePath)
    const base64 = fileBuffer.toString('base64')
    const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' }
    const mime = mimeMap[fileExt] || 'image/jpeg'

    messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Voici un reçu de vente. Extrait toutes les données disponibles.' },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}`, detail: 'high' } },
        ],
      },
    ]
  } else {
    const result = spawnSync('pdftotext', ['-layout', filePath, '-'], { encoding: 'utf8', timeout: 30000 })
    const pdfText = result.stdout?.trim() || ''
    if (!pdfText) throw new Error('Impossible d\'extraire le texte du PDF')

    messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Voici le contenu textuel d'un reçu de vente:\n\n${pdfText.slice(0, 8000)}` },
    ]
  }

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o', messages, max_tokens: 2000, temperature: 0 }),
  })

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}))
    throw new Error(err.error?.message || `OpenAI HTTP ${resp.status}`)
  }

  const data = await resp.json()
  const content = data.choices?.[0]?.message?.content?.trim() || ''
  const cleaned = content.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
  return JSON.parse(cleaned)
}

function fetchSaleReceiptRow(id) {
  const row = db.prepare('SELECT * FROM sale_receipts WHERE id=?').get(id)
  if (!row) return null
  return { ...row, items: JSON.parse(row.items || '[]') }
}

export async function runExtractionAndUpdate({ saleReceiptId, filePath, fileExt, userId = null }) {
  try {
    // Si la ligne a été supprimée pendant que l'extraction tournait, on s'arrête
    // proprement : évite un appel OpenAI inutile et un UPDATE sur une ligne masquée.
    const existing = db.prepare('SELECT deleted_at FROM sale_receipts WHERE id=?').get(saleReceiptId)
    if (!existing || existing.deleted_at) return
    const extracted = await extractWithOpenAI(filePath, fileExt)
    db.prepare(`
      UPDATE sale_receipts SET
        status='done',
        receipt_date=?, company=?, address=?, receipt_number=?,
        subtotal=?, tps=?, tvq=?, other_taxes=?, total=?,
        payment_method=?, currency=?, items=?, raw_data=?,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id=? AND deleted_at IS NULL
    `).run(
      extracted.receipt_date || null,
      extracted.company || null,
      extracted.address || null,
      extracted.receipt_number || null,
      extracted.subtotal || 0,
      extracted.tps || 0,
      extracted.tvq || 0,
      extracted.other_taxes || 0,
      extracted.total || 0,
      extracted.payment_method || null,
      extracted.currency || 'CAD',
      JSON.stringify(extracted.items || []),
      JSON.stringify(extracted),
      saleReceiptId,
    )
    const updated = fetchSaleReceiptRow(saleReceiptId)
    if (updated) emitEntity('sale_receipt', 'updated', saleReceiptId, updated, userId)
  } catch (err) {
    console.error('Receipt extraction error:', err.message)
    db.prepare(`UPDATE sale_receipts SET status='error', error_message=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=? AND deleted_at IS NULL`)
      .run(err.message, saleReceiptId)
    const errored = fetchSaleReceiptRow(saleReceiptId)
    if (errored && !errored.deleted_at) emitEntity('sale_receipt', 'updated', saleReceiptId, errored, userId)
  }
}
