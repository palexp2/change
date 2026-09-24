/**
 * « Responsable de la commande » : la fiche le choisit désormais parmi les
 * utilisateurs de l'app (colonne native `assigned_to`). Jusqu'ici il n'existait
 * que comme miroir du lien Airtable vers « Employés et partenaires » — une table
 * non miroitée, donc des identifiants `rec…` illisibles. Demande de
 * Pierre-Alexandre Papillon (2026-09-23).
 *
 * Remplit `assigned_to` depuis le miroir quand il est vide. Les noms des
 * enregistrements Airtable ont été relus le 2026-09-23 ; le rapprochement se fait
 * sur le NOM de l'utilisateur (pas son id) pour survivre à un compte recréé.
 * Frédéric Carrier n'a pas de compte : ses commandes restent sans responsable.
 * Rien n'est poussé vers Airtable, et aucune notification n'est émise.
 */
export const id = '088-orders-responsable-from-airtable'
export const description = 'orders.assigned_to rempli depuis le lien Airtable « Responsable de la commande »'

const MIRROR = 'responsable_de_la_commande'

const AIRTABLE_NAMES = {
  recGsRX3JJHti3Ee4: 'Philippe Chabot',
  recZUVHmEKlh1tVpN: 'Pierre-Alexandre Papillon',
  recfme4VUoHfbfcZM: 'Guillaume Lambert',
  reccWtXjNKNISnxew: 'Martin Audesse',
  rectUu0fV5bFIs2ao: 'Marc-Antoine Plante',
}

export function up(db) {
  const cols = new Set(db.pragma('table_info(orders)').map(c => c.name))
  if (!cols.has(MIRROR) || !cols.has('assigned_to')) return { skipped: 'colonnes absentes' }
  const rows = db.prepare(`SELECT id, ${MIRROR} AS link FROM orders WHERE assigned_to IS NULL AND ${MIRROR} IS NOT NULL AND ${MIRROR} <> ''`).all()
  const findUser = db.prepare('SELECT id FROM users WHERE name = ? LIMIT 1')
  const set = db.prepare('UPDATE orders SET assigned_to = ? WHERE id = ? AND assigned_to IS NULL')
  const userOf = new Map()
  let filled = 0
  for (const row of rows) {
    let ids
    try { ids = JSON.parse(row.link) } catch { ids = String(row.link).split(',') }
    const key = (Array.isArray(ids) ? ids : [ids]).map(v => String(v ?? '').trim()).find(Boolean)
    const name = key && AIRTABLE_NAMES[key]
    if (!name) continue
    if (!userOf.has(name)) userOf.set(name, findUser.get(name)?.id || null)
    const userId = userOf.get(name)
    if (userId) filled += set.run(userId, row.id).changes
  }
  return { filled, candidates: rows.length }
}
