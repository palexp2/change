// Normalise les identifiants de scraper_documents pour Amazon.
//
// L'ancien identifiant était `<commande>:<uuid du document>`, or Amazon régénère
// cet uuid à CHAQUE appel du popover : la déduplication ne mordait jamais et
// chaque tournée réinsérait une ligne (54 lignes pour 9 commandes après quelques
// passages), en re-téléchargeant à chaque fois des PDF déjà en base.
//
// L'identifiant est maintenant `<commande>:facture` / `<commande>:note-de-credit`,
// stable d'une tournée à l'autre. Le type se relit sans ambiguïté dans le nom de
// fichier enregistré à l'époque, on migre donc au lieu de jeter — ce qui évite
// aussi de re-télécharger tout l'historique à la prochaine tournée.
//
//   node src/scripts/purge-stale-scraper-docs.js [--apply]
import db from '../db/database.js'

const apply = process.argv.includes('--apply')
const STALE = `
  vendor = 'amazon'
  AND external_id LIKE '%:%'
  AND external_id NOT LIKE '%:facture'
  AND external_id NOT LIKE '%:note-de-credit%'
`

const rows = db.prepare(`SELECT * FROM scraper_documents WHERE ${STALE} ORDER BY created_at`).all()

// Une ligne par (commande, type) : on garde la plus ancienne — celle de la
// tournée qui a réellement créé le reçu (status 'imported').
const keep = new Map()
const drop = []
for (const r of rows) {
  const orderId = String(r.external_id).split(':')[0]
  const kind = /note-de-credit/.test(r.filename || '') ? 'note-de-credit' : 'facture'
  const key = `${orderId}:${kind}`
  const prior = keep.get(key)
  if (!prior || (prior.status !== 'imported' && r.status === 'imported')) {
    if (prior) drop.push(prior)
    keep.set(key, r)
  } else {
    drop.push(r)
  }
}

console.log(`${rows.length} ligne(s) au format périmé → ${keep.size} conservée(s) et renommée(s), ${drop.length} supprimée(s)`)
for (const [key, r] of keep) console.log(`  ${r.external_id}  →  ${key}${r.sale_receipt_id ? '' : '  (sans reçu)'}`)
if (!apply) {
  console.log('Simulation — relancer avec --apply.')
  process.exit(0)
}

const rename = db.prepare('UPDATE scraper_documents SET external_id = ? WHERE id = ?')
const remove = db.prepare('DELETE FROM scraper_documents WHERE id = ?')
const run = db.transaction(() => {
  // Les suppressions d'abord : l'index UNIQUE(vendor, external_id) refuserait
  // un renommage qui percuterait une ligne encore en place.
  for (const r of drop) remove.run(r.id)
  for (const [key, r] of keep) rename.run(key, r.id)
})
run()
console.log(`✅ ${keep.size} renommée(s), ${drop.length} supprimée(s)`)
