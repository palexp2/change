/**
 * Les collecteurs de factures savent chez qui ils vont chercher, mais la moitié
 * ne le disait pas à l'ERP : sans fournisseur déclaré, impossible de lancer la
 * collecte depuis une ligne de relevé.
 *
 * On relie chaque compte de collecte à la fiche du fournisseur qui porte son
 * nom. Rapprochement exact sur le nom ou un alias — un compte dont le nom ne
 * correspond à aucune fiche reste sans lien.
 */
export const id = '065-scraper-accounts-vendor'
export const description = 'Collecteurs de factures reliés à la fiche de leur fournisseur'

function key(name) {
  return String(name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '')
}

function parseAliases(v) {
  if (!v) return []
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : [] } catch { return [] }
}

export function up(db) {
  const profiles = db.prepare('SELECT id, name, aliases FROM vendor_profiles WHERE deleted_at IS NULL').all()
  const byKey = new Map()
  for (const p of profiles) {
    for (const n of [p.name, ...parseAliases(p.aliases)]) {
      const k = key(n); if (k && !byKey.has(k)) byKey.set(k, p.id)
    }
  }
  const rows = db.prepare('SELECT id, vendor FROM scraper_accounts WHERE vendor_profile_id IS NULL AND deleted_at IS NULL').all()
  const upd = db.prepare('UPDATE scraper_accounts SET vendor_profile_id = ? WHERE id = ?')
  for (const r of rows) {
    const id = byKey.get(key(r.vendor))
    if (id) upd.run(id, r.id)
  }
}
