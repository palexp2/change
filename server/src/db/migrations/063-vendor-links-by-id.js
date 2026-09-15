/**
 * Relier par identifiant ce qui n'était relié que par du texte.
 *
 * Les paiements émis, les abonnements fournisseurs et les règles bancaires
 * désignaient leur fournisseur par un nom tapé à la main : un « Inc. » en trop
 * ou une faute de frappe, et la fiche du fournisseur n'était plus retrouvée —
 * sa particularité ne s'affichait plus, son moyen de paiement habituel ne
 * remontait plus.
 *
 * On ajoute le lien véritable à côté du nom (qui reste affiché), et on le pose
 * une fois pour tout l'existant. Le rapprochement est volontairement
 * conservateur : nom identique, ou identique une fois retirés les suffixes
 * légaux. Jamais de ressemblance partielle — c'est exactement ce qui avait fait
 * atterrir les achats Digi-Key chez Li-Cor.
 */
export const id = '063-vendor-links-by-id'
export const description = 'Paiements, abonnements et règles bancaires reliés à la fiche fournisseur par identifiant'

const LEGAL_SUFFIXES = new Set([
  'inc', 'inc.', 'llc', 'ltd', 'ltd.', 'ltée', 'ltee', 'limited', 'corp', 'corp.',
  'corporation', 'co', 'co.', 'company', 'sa', 'sas', 'sarl', 'gmbh', 'bv', 'nv',
  'pbc', 'plc', 'pte', 'pty', 'ag', 'ab', 'oy', 'srl', 'spa', 'kk', 'llp', 'lp',
])

function key(name) {
  return String(name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '')
}

function strippedKey(name) {
  const words = String(name || '').trim().split(/[\s,]+/).filter(Boolean)
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1].toLowerCase())) words.pop()
  return key(words.join(' '))
}

function parseAliases(v) {
  if (!v) return []
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : [] } catch { return [] }
}

export function up(db) {
  for (const sql of [
    'ALTER TABLE treasury_payments ADD COLUMN vendor_profile_id TEXT',
    'ALTER TABLE vendor_subscriptions ADD COLUMN vendor_profile_id TEXT',
  ]) { try { db.exec(sql) } catch { /* déjà là */ } }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_treasury_payments_vendor ON treasury_payments(vendor_profile_id);
    CREATE INDEX IF NOT EXISTS idx_vendor_subscriptions_vendor ON vendor_subscriptions(vendor_profile_id);
  `)

  const profiles = db.prepare('SELECT id, name, aliases FROM vendor_profiles WHERE deleted_at IS NULL').all()
  const exact = new Map()
  const loose = new Map()
  for (const p of profiles) {
    for (const n of [p.name, ...parseAliases(p.aliases)]) {
      const k = key(n); if (k && !exact.has(k)) exact.set(k, p.id)
      const s = strippedKey(n); if (s && !loose.has(s)) loose.set(s, p.id)
    }
  }
  const resolve = (name) => exact.get(key(name)) || loose.get(strippedKey(name)) || null

  const link = (table, nameCol) => {
    const rows = db.prepare(`SELECT id, ${nameCol} AS n FROM ${table} WHERE vendor_profile_id IS NULL AND ${nameCol} IS NOT NULL`).all()
    const upd = db.prepare(`UPDATE ${table} SET vendor_profile_id = ? WHERE id = ?`)
    let n = 0
    for (const r of rows) { const id = resolve(r.n); if (id) { upd.run(id, r.id); n++ } }
    return n
  }

  link('treasury_payments', 'recipient')
  link('vendor_subscriptions', 'vendor')

  // Règles bancaires : celles qui nomment un vrai fournisseur se relient ; les
  // autres (frais, intérêts, salaires) n'en ont pas et restent telles quelles.
  const rules = db.prepare('SELECT id, vendor_name, name FROM bank_rules WHERE vendor_profile_id IS NULL AND deleted_at IS NULL').all()
  const updRule = db.prepare('UPDATE bank_rules SET vendor_profile_id = ? WHERE id = ?')
  for (const r of rules) {
    const id = resolve(r.vendor_name) || resolve(r.name)
    if (id) updRule.run(id, r.id)
  }
}
