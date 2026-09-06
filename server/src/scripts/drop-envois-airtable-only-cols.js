#!/usr/bin/env node
// One-shot : supprime DÉFINITIVEMENT les champs d'Envois (shipments) qui ont été
// retirés de l'interface (corbeille des champs). Jusqu'ici la suppression d'un
// champ était un soft-delete : la ligne custom_fields était marquée deleted_at,
// le mapping Airtable passait en import_disabled=1, mais la colonne SQLite
// restait — invisible, jamais nettoyée, et restaurable par la corbeille.
//
// Ce script fait le ménage définitif :
//   - sauvegarde JSON des valeurs détruites (uploads/backups/)
//   - ALTER TABLE shipments DROP COLUMN pour chaque colonne
//   - DELETE des lignes custom_fields / airtable_field_defs
//   - airtable_field_mappings : la ligne est CONSERVÉE en import_disabled=1
//   - purge des colonnes disparues dans les vues enregistrées (table_view_pills)
//
// EXCLUSIONS volontaires (champs supprimés de l'UI mais dont la colonne SQLite
// est vivante côté serveur) :
//   - status     : colonne canonique de schema.js (CHECK 'À envoyer'/'Envoyé'),
//                  lue par le sync, le write-back et le constat de vente. Le
//                  champ reste retiré de l'UI (custom_fields deleted_at gardé),
//                  seule la colonne survit.
//   - les lignes kind='native'/'lookup' (created_at, shipped_at, pays,
//                  company_name, order_number) : colonnes natives ou virtuelles,
//                  toujours affichées dans TABLE_COLUMN_META.
//
// Usage :
//   node src/scripts/drop-envois-airtable-only-cols.js            # dry run
//   node src/scripts/drop-envois-airtable-only-cols.js --apply    # exécute

import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

const DB_PATH = process.env.DB_PATH || './data/erp.db'
const APPLY = process.argv.includes('--apply')

const db = new Database(DB_PATH)

// Colonnes purement Airtable des envois, toutes soft-deletées côté custom_fields
// et import_disabled=1 côté mapping. Aucune n'est référencée dans server/src ni
// client/src (vérifié champ par champ avant d'écrire cette liste).
const COLUMNS = [
  // Liens / rollups Airtable
  'commande', 'entreprise', 'client_final_from_commande_lie', 'retour',
  'documents', 'liens_documents_d_envois', 'etiquette_d_expedition',
  'adresse_de_livraison', 'adresse_de_depart', 'infos_destinataire',
  'infos_expediteur', 'nom_du_contact_from_adresse', 'courriel',
  'langue_de_correspondance', 'employe',
  // Poids / boites (calculs Airtable)
  'boites', 'poids_lbs', 'poids_indique_des_boites', 'poids_des_boites_non_indique',
  'nombre_de_boites_sans_poids_indique', 'somme_de_poids_de_boites',
  'cout_total_des_pieces', 'valeur_de_retour_declaree',
  // Ramassage legacy (remplacé par novoxpress_pickup_id / _details)
  'pickup', 'pickup_id', 'date_de_ramassage', 'heure_de_debut_ramassage',
  'heure_de_fin_ramassage', 'confirmation_pickup',
  // Étiquettes / tarifs legacy (remplacé par novoxpress_shipment_id, label_pdf_path)
  'shipment_rates', 'service_d_etiquettes', 'shipping_id_novoxpress', 'lien_tracking',
  // Divers Airtable
  'autonumber', 'recordid', 'type_d_items', 'feedback_message',
  'originalinvoicedate', 'originalinvoicenumber',
]

const existingCols = new Set(db.prepare('PRAGMA table_info(shipments)').all().map(c => c.name))
const present = COLUMNS.filter(c => existingCols.has(c))
const missing = COLUMNS.filter(c => !existingCols.has(c))

// Garde-fou : aucune colonne visée ne doit encore porter un champ ACTIF.
const alive = db.prepare(`
  SELECT column_name FROM custom_fields
  WHERE erp_table='shipments' AND deleted_at IS NULL
    AND column_name IN (${COLUMNS.map(() => '?').join(',')})
`).all(...COLUMNS)
if (alive.length) {
  console.error(`⛔ Champs encore actifs dans l'UI : ${alive.map(r => r.column_name).join(', ')}`)
  process.exit(1)
}

console.log(`Colonnes cibles : ${COLUMNS.length}`)
console.log(`  présentes en DB (à dropper) : ${present.length}`)
console.log(`  déjà absentes                : ${missing.length}${missing.length ? ' — ' + missing.join(', ') : ''}`)

console.log('\nContenu actuel (valeurs non vides) :')
let totalValues = 0
for (const c of present) {
  const q = db.prepare(
    `SELECT COUNT(*) as n FROM shipments WHERE [${c}] IS NOT NULL AND TRIM(CAST([${c}] AS TEXT)) != ''`
  ).get()
  totalValues += q.n
  console.log(`  ${c.padEnd(40)} ${q.n}`)
}
console.log(`  ${'TOTAL'.padEnd(40)} ${totalValues}`)

const cfRows = db.prepare(
  `SELECT id FROM custom_fields WHERE erp_table='shipments' AND column_name IN (${present.map(() => '?').join(',')})`
).all(...present)
const mapRows = db.prepare(
  `SELECT id FROM airtable_field_mappings WHERE erp_table='shipments' AND column_name IN (${present.map(() => '?').join(',')})`
).all(...present)
let defCount = 0
try {
  defCount = db.prepare(
    `SELECT COUNT(*) n FROM airtable_field_defs WHERE erp_table='shipments' AND column_name IN (${present.map(() => '?').join(',')})`
  ).get(...present).n
} catch {}

console.log(`\ncustom_fields à supprimer              : ${cfRows.length}`)
console.log(`airtable_field_mappings à désactiver   : ${mapRows.length}`)
console.log(`airtable_field_defs à supprimer     : ${defCount}`)

// Vues enregistrées : une colonne droppée qui traîne dans visible_columns/sort/
// group_by/filters laisserait une colonne fantôme dans la barre des vues.
const dropped = new Set(present)
const pills = db.prepare(`SELECT * FROM table_view_pills WHERE table_name='shipments'`).all()
const pillPatches = []
for (const p of pills) {
  const patch = {}
  const listCols = (raw) => { try { return JSON.parse(raw || '[]') } catch { return [] } }
  const vis = listCols(p.visible_columns)
  if (vis.some(c => dropped.has(c))) patch.visible_columns = JSON.stringify(vis.filter(c => !dropped.has(c)))
  const sort = listCols(p.sort)
  if (sort.some(s => dropped.has(s?.field || s?.id))) patch.sort = JSON.stringify(sort.filter(s => !dropped.has(s?.field || s?.id)))
  const filters = listCols(p.filters)
  if (filters.some(f => dropped.has(f?.field || f?.id))) patch.filters = JSON.stringify(filters.filter(f => !dropped.has(f?.field || f?.id)))
  const rules = listCols(p.color_rules)
  if (rules.some(r => dropped.has(r?.field || r?.id))) patch.color_rules = JSON.stringify(rules.filter(r => !dropped.has(r?.field || r?.id)))
  if (p.group_by && dropped.has(p.group_by)) patch.group_by = null
  let widths = {}
  try { widths = JSON.parse(p.column_widths || '{}') } catch {}
  if (Object.keys(widths).some(c => dropped.has(c))) {
    patch.column_widths = JSON.stringify(Object.fromEntries(Object.entries(widths).filter(([c]) => !dropped.has(c))))
  }
  if (Object.keys(patch).length) pillPatches.push({ id: p.id, label: p.label, patch })
}
console.log(`\nvues « Envois » à nettoyer : ${pillPatches.length}`)
for (const p of pillPatches) console.log(`  ${p.label} → ${Object.keys(p.patch).join(', ')}`)

if (!APPLY) {
  console.log('\nDry run (aucune modification). Relance avec --apply pour appliquer.')
  process.exit(0)
}

// Sauvegarde des valeurs détruites — la corbeille des champs ne pourra plus
// rien restaurer une fois la colonne droppée.
const backupDir = path.join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'backups')
fs.mkdirSync(backupDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)
const backupFile = path.join(backupDir, `shipments-airtable-cols-${stamp}.json`)
const rows = db.prepare(`SELECT id, ${present.map(c => `[${c}]`).join(', ')} FROM shipments`).all()
fs.writeFileSync(backupFile, JSON.stringify({ table: 'shipments', columns: present, rows }, null, 1))
console.log(`\n💾 Sauvegarde : ${backupFile} (${rows.length} lignes)`)

const tx = db.transaction(() => {
  // La vue shipments_v est un SELECT * : SQLite refuse un DROP COLUMN tant
  // qu'elle existe. On la recrée à l'identique juste après.
  db.exec(`DROP VIEW IF EXISTS shipments_v`)
  for (const c of present) db.exec(`ALTER TABLE shipments DROP COLUMN [${c}]`)
  db.exec(`CREATE VIEW shipments_v AS SELECT * FROM shipments`)

  const placeholders = present.map(() => '?').join(',')
  db.prepare(`DELETE FROM custom_fields WHERE erp_table='shipments' AND column_name IN (${placeholders})`).run(...present)
  // Le mapping Airtable N'EST PAS supprimé : c'est cette ligne, en
  // import_disabled=1, qui marque le champ « désactivé » dans la modale de sync.
  // Sans elle, le champ Airtable se réaffiche comme disponible à l'import — il a
  // l'air d'être revenu (et un clic suffit à le recréer). La route de
  // désactivation ne sait poser qu'un seul tombstone sans colonne par table
  // (UNIQUE(erp_table, column_name) sur '__pending__'), donc la ligne garde son
  // ancien nom de colonne : plus rien ne la lit, l'import étant coupé.
  db.prepare(`
    UPDATE airtable_field_mappings
    SET import_disabled=1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE erp_table='shipments' AND column_name IN (${placeholders})
  `).run(...present)
  try {
    db.prepare(`DELETE FROM airtable_field_defs WHERE erp_table='shipments' AND column_name IN (${placeholders})`).run(...present)
  } catch {}

  for (const { id, patch } of pillPatches) {
    const sets = Object.keys(patch).map(k => `${k}=?`).join(', ')
    db.prepare(`UPDATE table_view_pills SET ${sets} WHERE id=?`).run(...Object.values(patch), id)
  }
})
tx()

const remaining = db.prepare('PRAGMA table_info(shipments)').all().length
console.log(`\n✅ ${present.length} colonne(s) droppée(s), ${cfRows.length} champ(s) supprimé(s), ${mapRows.length} mapping(s) désactivé(s), ${pillPatches.length} vue(s) nettoyée(s). Reste ${remaining} colonnes dans shipments.`)
