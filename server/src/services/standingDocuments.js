// La pièce qui revient chaque mois (Charles, 2026-10-06).
//
// Certains paiements n'ont jamais de facture : le loyer, un prêt, une
// location. Leur justificatif est un document unique et durable — le bail,
// l'avis de loyer de l'année, le contrat — qu'on joint à CHAQUE écriture du
// fournisseur dans QuickBooks. Les autres fournisseurs (une facture par achat)
// n'en ont pas : leur pièce est la facture elle-même.
//
// Décision, sans liste codée en dur :
//   1. le fournisseur est un paiement FIXE ET RÉCURRENT — au moins 4 mois
//      distincts sur 13, montant stable, et presque jamais de facture lue ;
//   2. le Drive contient un PDF à son nom, peu nombreux (un contrat, pas une
//      pile de factures mensuelles) ; on prend le plus récent déjà reçu à la
//      date de la ligne, en préférant celui dont la période (« 2026-2027 »)
//      couvre cette date ;
//   3. le dernier choix de l'humain pour ce fournisseur (joint / pas joint)
//      fait foi ensuite.
import db from '../db/database.js'
import { getDriveClient } from '../connectors/google.js'
import { qbGet, qbUploadAttachment } from '../connectors/quickbooks.js'

const fold = (v) => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

// Mots qui ne distinguent personne : on cherche le Drive avec les autres.
const GENERIC = new Set(['societe', 'immobiliere', 'immobilier', 'inc', 'ltee', 'limitee', 'enr', 'canada',
  'quebec', 'groupe', 'services', 'service', 'compagnie', 'corporation', 'corp', 'les', 'des', 'and', 'the',
  'gestion', 'entreprises', 'entreprise', 'banque', 'nationale', 'cie'])

function distinctiveTokens(vendor) {
  return fold(vendor).split(' ').filter((t) => t.length >= 4 && !GENERIC.has(t)).sort((a, b) => b.length - a.length)
}

/** Paiement fixe et récurrent, d'après ce qui a été publié dans QuickBooks. */
export function isFixedRecurring(vendor) {
  const key = fold(vendor)
  if (!key) return false
  const rows = db.prepare(`
    SELECT vendor, date_achat, total_cad FROM achats_fournisseurs
    WHERE quickbooks_id IS NOT NULL AND date_achat >= date('now', '-13 months') AND vendor IS NOT NULL
  `).all().filter((r) => fold(r.vendor) === key)
  const months = new Set(rows.map((r) => String(r.date_achat).slice(0, 7)))
  if (months.size < 4) return false
  // Montant stable : le plus fréquent revient au moins une fois sur deux.
  const counts = new Map()
  for (const r of rows) { const k = Math.round(Math.abs(r.total_cad || 0)); counts.set(k, (counts.get(k) || 0) + 1) }
  if (Math.max(...counts.values()) < rows.length / 2) return false
  // Presque jamais de facture lue pour lui : sinon la pièce, c'est la facture.
  const receipts = db.prepare(`
    SELECT company FROM sale_receipts WHERE deleted_at IS NULL AND receipt_date >= date('now', '-13 months')
  `).all().filter((r) => fold(r.company) === key).length
  return receipts < rows.length / 4
}

async function drive() {
  const acc = db.prepare("SELECT id FROM connector_oauth WHERE connector='google' ORDER BY updated_at DESC LIMIT 1").get()
  if (!acc) return null
  return getDriveClient(acc.id)
}

const driveCache = new Map()
async function vendorPdfs(vendor) {
  const tokens = distinctiveTokens(vendor).slice(0, 2)
  if (!tokens.length) return []
  const k = tokens.join('|')
  const hit = driveCache.get(k)
  if (hit && Date.now() - hit.at < 3600_000) return hit.files
  const d = await drive()
  if (!d) return []
  const q = `mimeType='application/pdf' and trashed=false and (${tokens.map((t) => `name contains '${t}'`).join(' or ')})`
  const r = await d.files.list({
    q, fields: 'files(id,name,createdTime,modifiedTime,webViewLink)', pageSize: 50,
    supportsAllDrives: true, includeItemsFromAllDrives: true, corpora: 'allDrives',
  })
  // Le même fichier copié dans plusieurs dossiers ne compte qu'une fois.
  const seen = new Set()
  const files = (r.data.files || []).filter((f) => fold(f.name).split(' ').some((w) => tokens.includes(w)))
    .filter((f) => (seen.has(f.name) ? false : seen.add(f.name)))
  driveCache.set(k, { at: Date.now(), files })
  return files
}

const CONTRACT = /bail|contrat|entente|lease|avis|convention/i

// « 2026-2027 » ou « 2026 » dans le nom : la période que le document couvre.
function coverage(name) {
  const m = /(20\d{2})\s*[-_à]\s*(20\d{2})/.exec(name)
  if (m) return [Number(m[1]), Number(m[2])]
  const y = /(?:^|\D)(20\d{2})(?:\D|$)/.exec(name)
  return y ? [Number(y[1]), Number(y[1])] : null
}

/** Le document à joindre à cette ligne, ou `null`. */
export async function standingDocFor(txn, vendor) {
  if (!vendor || !(txn?.amount < 0) || txn.matched_type === 'receipt') return null
  const choice = db.prepare('SELECT * FROM standing_doc_choices WHERE vendor_key=?').get(fold(vendor))
  if (!choice && !isFixedRecurring(vendor)) return null
  const files = await vendorPdfs(vendor)
  // Une pile de PDF à son nom = des factures, pas un contrat.
  if (!files.length || files.length > 8) return null
  const day = String(txn.txn_date).slice(0, 10)
  const year = Number(day.slice(0, 4))
  const received = files.filter((f) => String(f.createdTime).slice(0, 10) <= day)
  // Seul un document DURABLE se joint : une période d'un an ou plus dans le
  // nom (« 2026-2027 »), ou un mot de contrat. Une facture n'en a pas.
  const durable = (f) => !!/(20\d{2})\s*[-_à]\s*(20\d{2})/.exec(f.name) || CONTRACT.test(f.name)
  const pool = (received.length ? received : files).filter(durable)
  const score = (f) => {
    const c = coverage(f.name)
    return (c && c[0] <= year && year <= c[1] ? 2 : 0) + (CONTRACT.test(f.name) ? 1 : 0)
  }
  const best = [...pool].sort((a, b) => score(b) - score(a) || String(b.createdTime).localeCompare(String(a.createdTime)))[0]
  if (!best) return null
  return {
    drive_file_id: best.id,
    file_name: best.name,
    url: best.webViewLink || `https://drive.google.com/file/d/${best.id}/view`,
    checked: choice ? choice.choice === 'on' : true,
  }
}

/** Retient le choix, et joint le document à l'écriture QuickBooks de la ligne. */
export async function applyStandingDoc(txn, vendor, { drive_file_id, file_name, attach }) {
  db.prepare(`INSERT INTO standing_doc_choices (vendor_key, choice, drive_file_id, file_name, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(vendor_key) DO UPDATE SET choice=excluded.choice, drive_file_id=excluded.drive_file_id,
      file_name=excluded.file_name, updated_at=excluded.updated_at`)
    .run(fold(vendor), attach ? 'on' : 'off', drive_file_id || null, file_name || null)
  if (!attach) return { attached: false }
  if (txn.matched_type !== 'achat' || !txn.matched_id) throw new Error('Aucune écriture liée à cette ligne')
  const achat = db.prepare('SELECT type, quickbooks_id FROM achats_fournisseurs WHERE id=?').get(txn.matched_id)
  if (!achat?.quickbooks_id) throw new Error('Écriture pas encore dans QuickBooks')
  const entityType = achat.type === 'bill' ? 'Bill' : 'Purchase'
  const q = `SELECT * FROM Attachable WHERE AttachableRef.EntityRef.Type = '${entityType}' AND AttachableRef.EntityRef.Value = '${achat.quickbooks_id}'`
  const existing = await qbGet(`/query?query=${encodeURIComponent(q)}`)
  if ((existing?.QueryResponse?.Attachable || []).some((a) => a.FileName === file_name)) return { attached: true, already: true }
  const d = await drive()
  if (!d) throw new Error('Aucun compte Google connecté')
  const res = await d.files.get({ fileId: drive_file_id, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' })
  await qbUploadAttachment({
    entityType, entityId: achat.quickbooks_id,
    fileBuffer: Buffer.from(res.data), fileName: file_name, contentType: 'application/pdf',
  })
  return { attached: true }
}
