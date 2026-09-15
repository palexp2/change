/**
 * Les paiements émis nomment leur bénéficiaire dans le libellé, pas dans le
 * champ « destinataire » — resté vide sur presque tous. Le lien vers la fiche
 * du fournisseur se pose donc aussi à partir du libellé.
 *
 * Même prudence qu'à la migration précédente : nom identique, ou identique une
 * fois les suffixes légaux retirés. Un libellé qui ne désigne pas un
 * fournisseur (« Visa CAD », « Vir Desj CAD à BNC ») ne trouve rien et reste
 * sans lien, ce qui est le bon résultat.
 */
export const id = '064-payments-vendor-from-label'
export const description = 'Paiements émis : lien vers la fiche fournisseur déduit aussi du libellé'

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
  const profiles = db.prepare('SELECT id, name, aliases FROM vendor_profiles WHERE deleted_at IS NULL').all()
  const exact = new Map(); const loose = new Map()
  for (const p of profiles) {
    for (const n of [p.name, ...parseAliases(p.aliases)]) {
      const k = key(n); if (k && !exact.has(k)) exact.set(k, p.id)
      const s = strippedKey(n); if (s && !loose.has(s)) loose.set(s, p.id)
    }
  }
  const rows = db.prepare(`
    SELECT id, label FROM treasury_payments
    WHERE vendor_profile_id IS NULL AND label IS NOT NULL AND deleted_at IS NULL
  `).all()
  const upd = db.prepare('UPDATE treasury_payments SET vendor_profile_id = ? WHERE id = ?')
  for (const r of rows) {
    const id = exact.get(key(r.label)) || loose.get(strippedKey(r.label))
    if (id) upd.run(id, r.id)
  }
}
