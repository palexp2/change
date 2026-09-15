/**
 * Suite de la précédente : trois comptes de collecte portaient une chaîne vide
 * au lieu d'aucune valeur, et passaient donc au travers du rapprochement.
 */
export const id = '066-scraper-vendor-empty-string'
export const description = 'Collecteurs : lien fournisseur posé aussi sur les valeurs vides'

function key(name) {
  return String(name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function up(db) {
  db.exec("UPDATE scraper_accounts SET vendor_profile_id = NULL WHERE trim(COALESCE(vendor_profile_id,'')) = ''")
  const profiles = db.prepare('SELECT id, name FROM vendor_profiles WHERE deleted_at IS NULL').all()
  const byKey = new Map(profiles.map(p => [key(p.name), p.id]))
  const rows = db.prepare('SELECT id, vendor FROM scraper_accounts WHERE vendor_profile_id IS NULL AND deleted_at IS NULL').all()
  const upd = db.prepare('UPDATE scraper_accounts SET vendor_profile_id = ? WHERE id = ?')
  for (const r of rows) {
    const id = byKey.get(key(r.vendor))
    if (id) upd.run(id, r.id)
  }
}
