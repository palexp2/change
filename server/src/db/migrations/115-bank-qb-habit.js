/**
 * 115 — La mémoire QuickBooks du relevé.
 *
 * Demande de Charles (2026-10-06) : « DEBOURSE MCR » ne proposait rien alors
 * que QuickBooks l'avait passé 113 fois en virement depuis la marge de crédit.
 * La mémoire du relevé ne lisait que les dépenses liées à un achat de l'ERP ;
 * les virements vers un compte que l'ERP ne suit pas (la marge BNC) et les
 * dépôts n'apprenaient rien.
 *
 *   • `bank_qb_shapes` garde, pour chaque écriture QuickBooks déjà liée à une
 *     ligne, sa forme (virement vers quel compte, dépôt dans quel compte,
 *     dépense à quel fournisseur) — lue une fois, relue jamais ;
 *   • `bank_proposals.kind` accepte `qb_habit` : « refaire comme les N fois
 *     d'avant ». Le CHECK est élargi par réécriture du DDL en place (voir 022),
 *     aucune page de données touchée.
 */
export const id = '115-bank-qb-habit'
export const description = 'mémoire QuickBooks du relevé : formes des écritures liées + proposition qb_habit'

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bank_qb_shapes (
      qb_type TEXT NOT NULL,
      qb_id TEXT NOT NULL,
      shape TEXT,
      fetched_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (qb_type, qb_id)
    )
  `)

  const cur = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='bank_proposals'").get()?.sql
  if (!cur) throw new Error('DDL de bank_proposals illisible')
  if (cur.includes("'qb_habit'")) return { shapes: true, check: 'déjà élargi' }
  const next = cur.replace(/'aga_repartition','debt_payment'\)/, "'aga_repartition','debt_payment','qb_habit')")
  if (next === cur) throw new Error("CHECK de bank_proposals.kind inattendu — rien n'est modifié")

  const version = db.pragma('schema_version', { simple: true })
  db.unsafeMode(true)
  try {
    db.pragma('writable_schema = ON')
    db.prepare("UPDATE sqlite_master SET sql=? WHERE type='table' AND name='bank_proposals'").run(next)
    db.pragma(`schema_version = ${version + 1}`)
  } finally {
    db.pragma('writable_schema = OFF')
    db.unsafeMode(false)
  }
  // Relecture forcée : un DDL qui ne reparse pas annule tout.
  db.prepare('PRAGMA table_info(bank_proposals)').all()
  db.prepare('SELECT COUNT(*) AS c FROM bank_proposals').get()
  const after = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='bank_proposals'").get().sql
  if (!after.includes("'qb_habit'")) throw new Error('CHECK non élargi après réécriture')
  return { shapes: true, check: 'élargi' }
}
