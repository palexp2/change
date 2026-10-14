/**
 * 128 — Budget marketing : une facture = une dépense.
 *
 * La détection importait chaque ligne d'une facture QB comme une dépense
 * distincte (Chez Victor du 2026-10-01 : poutine, pourboire, canotier… en 5
 * lignes). Charles, 2026-10-13 : « je veux la facture complète ». La détection
 * réunit désormais les lignes par transaction ; ici on réunit celles déjà en
 * base : la première ligne garde le total, les autres passent à la corbeille.
 * Statut retenu : pertinente si une ligne l'était, sinon à valider si une
 * l'était, sinon celui de la première.
 */
export const id = '128-marketing-expenses-one-per-invoice'
export const description = 'Budget marketing : lignes d\'une même facture réunies'

export function up(db) {
  const groups = db.prepare(`
    SELECT acctnum, qb_txn_id FROM marketing_expenses
    WHERE deleted_at IS NULL AND qb_txn_id IS NOT NULL
    GROUP BY acctnum, qb_txn_id HAVING COUNT(*) > 1
  `).all()
  const lines = db.prepare(`
    SELECT * FROM marketing_expenses WHERE deleted_at IS NULL AND acctnum=? AND qb_txn_id=?
    ORDER BY created_at, id
  `)
  const keep = db.prepare(`
    UPDATE marketing_expenses SET import_key=?, amount=?, amount_foreign=?, memo=?, status=?,
      notified_at=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?
  `)
  const drop = db.prepare(`
    UPDATE marketing_expenses SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      import_key = import_key || '#fusion-' || id WHERE id=?
  `)
  const r2 = n => Math.round(Number(n) * 100) / 100
  for (const g of groups) {
    const rows = lines.all(g.acctnum, g.qb_txn_id)
    const [first, ...rest] = rows
    const statuses = rows.map(r => r.status)
    const status = statuses.includes('relevant') ? 'relevant'
      : statuses.includes('pending') ? 'pending' : first.status
    const memos = [...new Set(rows.map(r => r.memo).filter(Boolean))]
    const foreign = rows.every(r => r.amount_foreign == null) ? null
      : r2(rows.reduce((s, r) => s + Number(r.amount_foreign || 0), 0))
    const notified = rows.every(r => r.notified_at) ? first.notified_at : null
    for (const r of rest) drop.run(r.id)
    keep.run(`${g.acctnum}|${g.qb_txn_id}|txn`, r2(rows.reduce((s, r) => s + Number(r.amount), 0)),
      foreign, memos.length === 1 ? memos[0] : null, status, notified, first.id)
  }
}
