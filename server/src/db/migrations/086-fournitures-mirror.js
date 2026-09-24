/**
 * Achats de fournitures (bureau, entretien, emballage…) : deux tables Airtable
 * jusqu'ici hors miroir — « Fournitures » (le catalogue) et « Achats
 * fournitures » (chaque achat, lié à sa fourniture). Demande de
 * Pierre-Alexandre Papillon (2026-09-23) : une page dans Boréal, synchronisée.
 *
 * Les deux tables étaient inscrites « excluded » au registre par la décision du
 * 2026-09-03 (aucune nouvelle table branchée) ; cette demande explicite la lève
 * pour elles deux, et pour elles seules. Servies d'emblée par le moteur unique :
 * elles n'ont jamais eu de fonction historique.
 */
export const id = '086-fournitures-mirror'
export const description = 'Miroirs Airtable Fournitures + Achats fournitures (tables, config, registre)'

const BASE = 'appB4Fehk9jYd4s4B'
const MIRRORS = [
  {
    id: 'fournitures', tableId: 'tblO0yHEvcLgqTExt', name: 'Fournitures', erpTable: 'fournitures', dependsOn: [],
    fieldMap: {
      name: 'Name', web_url: 'Lien web', image: 'Image', supplier: 'Fournisseur',
      reference_price: 'Prix de référence', unit: 'Unité de mesure', notes: 'Notes',
    },
  },
  {
    id: 'achats_fournitures', tableId: 'tblJZr06jfg6SLpUp', name: 'Achats fournitures', erpTable: 'achats_fournitures', dependsOn: ['fournitures'],
    fieldMap: { purchased_at: 'Date', fourniture: 'Fourniture', qty: 'Quantité', unit_price: 'Prix unitaire payé av. tx.' },
  },
]

const now = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fournitures (
      id              TEXT PRIMARY KEY,
      airtable_id     TEXT UNIQUE,
      name            TEXT,
      web_url         TEXT,
      image_url       TEXT,
      supplier        TEXT,
      reference_price REAL,
      unit            TEXT,
      notes           TEXT,
      created_at      TEXT DEFAULT (${now}),
      updated_at      TEXT DEFAULT (${now})
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS achats_fournitures (
      id             TEXT PRIMARY KEY,
      airtable_id    TEXT UNIQUE,
      fourniture_id  TEXT REFERENCES fournitures(id) ON DELETE SET NULL,
      purchased_at   TEXT,
      qty            REAL,
      unit_price     REAL,
      created_at     TEXT DEFAULT (${now}),
      updated_at     TEXT DEFAULT (${now})
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_achats_fournitures_fourniture ON achats_fournitures(fourniture_id)')

  const cfg = db.prepare('INSERT OR IGNORE INTO airtable_module_config (module, base_id, table_id, field_map) VALUES (?,?,?,?)')
  // La ligne « excluded » du registre occupe (base_id, table_id) : on la remplace.
  const drop = db.prepare('DELETE FROM airtable_mirrors WHERE base_id=? AND table_id=? AND id<>?')
  const mirror = db.prepare(`
    INSERT OR IGNORE INTO airtable_mirrors
      (id, base_id, table_id, airtable_name, erp_table, status, depends_on, purge_orphans, decided_by, decided_at, engine)
    VALUES (?,?,?,?,?,'mirrored',?,1,'user',${now},'unified')
  `)
  for (const m of MIRRORS) {
    cfg.run(m.id, BASE, m.tableId, JSON.stringify(m.fieldMap))
    drop.run(BASE, m.tableId, m.id)
    mirror.run(m.id, BASE, m.tableId, m.name, m.erpTable, JSON.stringify(m.dependsOn))
  }
}
