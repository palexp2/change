/**
 * Ménage des reçus créés par l'autodétection Gmail (michel@ / pap@).
 *
 * Deux dégâts distincts :
 *  1. Quatre passes de sync simultanées (double clic sur « Synchroniser ») ont
 *     inséré 2 à 4 copies du même message — la dédup lit puis insère, avec des
 *     appels réseau entre les deux.
 *  2. L'autodétection sur la boîte du comptable a avalé des fils de discussion :
 *     factures déjà comptabilisées via pap@ et images de signature citées dans
 *     les réponses (image002/003/004).
 *
 * Stratégie : dédup par hash SHA-256 du fichier (le nom et le Message-ID ne sont
 * pas fiables). Dans chaque groupe on garde la copie publiée à QuickBooks, sinon
 * la plus ancienne. Les pièces reconnues comme du bruit sont supprimées en entier.
 *
 * Même sémantique que DELETE /api/sale-receipts/:id : soft-delete pour les pièces
 * issues d'un courriel (sinon le sync les réimporte), purge du fichier disque.
 *
 * Usage : node src/scripts/cleanup-gmail-autodetect-duplicates.js [--apply]
 */
import { createHash } from 'crypto'
import { existsSync, readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import db from '../db/database.js'
import { syncReceiptAnomalies } from '../services/transactionAnomalies.js'

const APPLY = process.argv.includes('--apply')
const uploadsDir = join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'receipts')

// Pièces sans valeur comptable : images de signature/captures citées dans les
// fils transférés au comptable. Toutes les copies partent, aucune n'est gardée.
const JUNK_ORIGINAL_NAMES = new Set(['image002.jpg', 'image003.png', 'image004.png'])
const JUNK_NAME_PATTERNS = [/^Notes\s*:/i]
// Corps de courriel matérialisé en PDF depuis une réponse/transfert du lot
// autodétecté du 1er août : c'est le fil de discussion, pas la facture (la vraie
// pièce est déjà en base par la boîte d'origine).
const REPLY_PDF_BATCH = /^\s*(re|r[ée]p|fwd?|fw|tr)\s*:/i
const BATCH_START = '2026-08-01'

const rows = db.prepare(`
  SELECT id, filename, original_name, company, total, created_at, quickbooks_id, source, gmail_message_id, extra_pages
  FROM sale_receipts WHERE deleted_at IS NULL ORDER BY created_at
`).all()

// 1. Backfill du hash de contenu — sert aussi de garde-fou aux syncs futurs.
const hashOf = new Map()
let hashed = 0
for (const r of rows) {
  const p = join(uploadsDir, r.filename || '')
  if (!r.filename || !existsSync(p)) continue
  const h = createHash('sha256').update(readFileSync(p)).digest('hex')
  hashOf.set(r.id, h)
  if (APPLY) db.prepare('UPDATE sale_receipts SET content_sha256=? WHERE id=?').run(h, r.id)
  hashed++
}

// 2. Sélection des suppressions.
const isJunk = r =>
  JUNK_ORIGINAL_NAMES.has(r.original_name || '') ||
  JUNK_NAME_PATTERNS.some(re => re.test(r.original_name || '')) ||
  (r.created_at >= BATCH_START && r.source === 'email' && REPLY_PDF_BATCH.test(r.original_name || ''))

const groups = new Map()
for (const r of rows) {
  const h = hashOf.get(r.id)
  if (!h) continue
  if (!groups.has(h)) groups.set(h, [])
  groups.get(h).push(r)
}

const toDelete = []
// Un reçu publié à QuickBooks n'est jamais supprimé ici : effacer la fiche ERP
// laisserait l'écriture QB en place, donc une double comptabilisation invisible.
// Quand deux copies d'un même fichier sont toutes deux publiées, c'est un vrai
// doublon comptable — à arbitrer dans QuickBooks, pas ici.
const doublePosted = []
for (const group of groups.values()) {
  const posted = group.filter(r => r.quickbooks_id)
  if (posted.length > 1) doublePosted.push(posted)
  if (group.every(isJunk)) { toDelete.push(...group.filter(r => !r.quickbooks_id)); continue }
  if (group.length < 2) continue
  // Garder la copie publiée à QuickBooks, à défaut la plus ancienne.
  const keep = posted[0] || group[0]
  toDelete.push(...group.filter(r => r.id !== keep.id && !r.quickbooks_id))
}

console.log(`Reçus actifs : ${rows.length} — hashés : ${hashed}`)
console.log(`À supprimer : ${toDelete.length}\n`)
const byName = {}
for (const r of toDelete) {
  const k = `${r.original_name} | ${r.company ?? ''} | ${r.total ?? ''}`
  byName[k] = (byName[k] || 0) + 1
}
for (const [k, n] of Object.entries(byName).sort()) console.log(`  ${String(n).padStart(2)} × ${k}`)

if (doublePosted.length) {
  console.log('\n⚠️  Doublons DÉJÀ publiés à QuickBooks — non touchés, à arbitrer dans QB :')
  for (const grp of doublePosted) {
    console.log(`  ${grp[0].original_name} | ${grp[0].company} | ${grp[0].total}`)
    for (const r of grp) console.log(`     QB ${r.quickbooks_id} · ${r.created_at.slice(0, 16)} · ${r.id}`)
  }
}

if (!APPLY) {
  console.log('\n(dry-run — relancer avec --apply pour exécuter)')
  process.exit(0)
}

let softDeleted = 0, hardDeleted = 0
const stampSoft = db.prepare("UPDATE sale_receipts SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?")
for (const r of toDelete) {
  let extra = []
  try { extra = JSON.parse(r.extra_pages || '[]') } catch { /* champ vide ou corrompu */ }
  for (const name of [r.filename, ...extra.map(p => p.filename)]) {
    if (!name) continue
    try { const fp = join(uploadsDir, name); if (existsSync(fp)) unlinkSync(fp) } catch { /* déjà absent */ }
  }
  if (r.gmail_message_id) { stampSoft.run(r.id); softDeleted++ }
  else {
    db.prepare('DELETE FROM sale_receipts WHERE id=?').run(r.id)
    db.prepare('DELETE FROM sale_receipt_events WHERE receipt_id=?').run(r.id)
    hardDeleted++
  }
}
// Les pièces n'existent plus : leurs anomalies « doublon » ouvertes se résolvent
// (même geste que DELETE /api/sale-receipts/:id), y compris celles portées par la
// copie conservée qui pointait vers les copies supprimées.
const anomalyIds = db.prepare(
  "SELECT DISTINCT entity_id FROM transaction_anomalies WHERE entity_type='sale_receipt' AND status='open'"
).all().map(r => r.entity_id)
for (const id of anomalyIds) {
  try { syncReceiptAnomalies(id) } catch (e) { console.warn(`Anomaly re-scan ${id}: ${e.message}`) }
}

console.log(`\n✅ ${softDeleted} soft-delete (courriel) · ${hardDeleted} suppressions définitives · ${anomalyIds.length} anomalies re-scannées`)
