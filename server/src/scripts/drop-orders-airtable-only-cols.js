#!/usr/bin/env node
// One-shot : détruit DÉFINITIVEMENT les colonnes purement Airtable de `orders`
// dont le champ a été retiré de l'interface (corbeille des champs).
//
// Jusqu'ici, supprimer un champ était un soft-delete : la ligne custom_fields
// passait en deleted_at, le mapping Airtable en import_disabled=1, mais la
// colonne SQLite restait — invisible, transportée dans aucun snapshot, jamais
// nettoyée. Même opération que drop-envois-airtable-only-cols.js et
// drop-factures-airtable-only-cols.js, sur la table des commandes.
//
// Ce que fait le script :
//   - sauvegarde JSON des valeurs détruites (uploads/backups/)
//   - ALTER TABLE orders DROP COLUMN pour chaque colonne
//   - DELETE des lignes custom_fields / airtable_field_defs
//   - airtable_field_mappings : la ligne est CONSERVÉE en import_disabled=1
//     (c'est elle qui marque le champ « désactivé » ; sans elle le champ
//     Airtable se réaffiche comme disponible et un clic le recrée)
//   - purge des colonnes disparues dans les vues enregistrées
//     (table_view_pills ET table_view_configs — column_widths y traînait)
//   - régénération de `orders_v` par regenerateView() : contrairement à
//     shipments_v, la vue des commandes n'est PAS un simple SELECT * (elle
//     porte les lookups company_name / assigned_name et le rollup items_count),
//     donc la recréer « à l'identique » à la main la casserait.
//
// EXCLUSIONS volontaires — colonnes dont le champ est supprimé de l'UI mais
// dont la valeur est encore LUE quelque part (vérifiées une par une) :
//   - langue_du_contact_a_la_ferme : routes/orders.js choisit fr/en pour les
//     documents d'installation dessus.
//   - autonumber : repli de libellé d'une commande sans numéro dans les records
//     récents (client/src/lib/useRecentRecords.js) ; déclarée à ce titre dans
//     SNAPSHOT_KEEP.orders (db/snapshotFields.js).
//   - date_du_premier_envoi : cible d'un lookup ACTIF sur factures et d'un
//     rollup ACTIF sur projects. La dropper viderait ces deux champs.
//
// Usage :
//   node src/scripts/drop-orders-airtable-only-cols.js            # dry run
//   node src/scripts/drop-orders-airtable-only-cols.js --apply    # exécute

import fs from 'node:fs'
import path from 'node:path'
import db from '../db/database.js'
import { regenerateView } from '../services/customFieldsView.js'

const APPLY = process.argv.includes('--apply')
const TABLE = 'orders'

// Liste ARRÊTÉE après audit (code serveur, code client, automatisations, règles
// de champ, vues enregistrées, champs calculés d'autres tables). Elle est
// explicite et non recalculée : une suppression de champ faite demain ne doit
// pas être emportée en silence par une réexécution de ce script.
const COLUMNS = [
  // Rollups / formules Airtable sur les items
  'a_envoyer', 'nombre_d_items', 'nombre_d_items_a_envoyer', 'nombre_d_items_envoyes',
  'items_pret_pour_un_nouvel_envoi', 'scan_items', 'type_de_procurement',
  // LoRa / doublons d'adresses
  'adresses_lora_a_envoyer', 'statut_lora_en_double',
  // Documents / langue
  'documents', 'langue_des_documents', 'avertissement_langue_des_documents',
  'langue_du_contact_du_livraison', 'seulement_imprimer_les_documents',
  'slugs_attendus',
  // Signature de relâche
  'besoin_d_une_signature_pour_relacher_la_commande',
  'besoin_d_une_signature_pour_relacher_la_commande_lecture_seule', 'signature',
  // Adresse / contact recopiés depuis l'adresse liée
  'courriel_from_adresse_de_livraison', 'nom_from_adresse_de_livraison',
  'province_etat_de_la_ferme',
  // Drop ship
  'statut_drop_ship', 'factures_drop_ship',
  // Facturation / valeurs calculées côté Airtable
  'lien_facture', 'id_facture_s', 'cout_total', 'rentabilite',
  'valeur_cad_from_projet', 'valeur_des_factures_lies_au_projet',
  'valeur_de_la_facure_lie_au_projet_ou_a_la_commande',
  'total_des_factures_payees_du_projet_cad_av_tx', 'factures_lies_au_projet',
  'mensualite_cad_du_projet_associe', 'mois_du_projet', 'type_de_projet',
  'veleur_des_projets',
  // Divers Airtable
  'moratoire', 'snippet', 'types', 'record_id', 'abonnement',
  'controleurs_operationnels', 'ne_pas_envoyer_de_courriels',
  'date_du_dernier_envoi', 'raisons_pour_delai_de_plus_de_1_jour_ouvrable',
  'notes_2', 'feedback_message_creation_d_envoi',
  // Champ de test e2e (colonne cf_*, champ supprimé)
  'cf_e2e_date_format_probe',
]

const EXCLUDED = ['langue_du_contact_a_la_ferme', 'autonumber', 'date_du_premier_envoi']

const existingCols = new Set(db.pragma(`table_info(${TABLE})`).map(c => c.name))
const present = COLUMNS.filter(c => existingCols.has(c))
const missing = COLUMNS.filter(c => !existingCols.has(c))

// ── Garde-fous. Chacun ARRÊTE le script : mieux vaut ne rien détruire que
//    détruire une colonne redevenue vivante entre l'audit et l'exécution.
const stop = (msg) => { console.error(`⛔ ${msg}`); process.exit(1) }

if (COLUMNS.some(c => EXCLUDED.includes(c))) {
  stop(`Une colonne exclue figure dans la liste : ${COLUMNS.filter(c => EXCLUDED.includes(c)).join(', ')}`)
}
if (!present.length) {
  console.log('Rien à faire : aucune des colonnes visées n’existe encore.')
  process.exit(0)
}

const ph = present.map(() => '?').join(',')

const alive = db.prepare(`
  SELECT column_name, name FROM custom_fields
  WHERE erp_table=? AND deleted_at IS NULL AND column_name IN (${ph})
`).all(TABLE, ...present)
if (alive.length) stop(`Champs encore ACTIFS dans l'UI : ${alive.map(r => `${r.column_name} (${r.name})`).join(', ')}`)

const importedStill = db.prepare(`
  SELECT column_name, airtable_field_name FROM airtable_field_mappings
  WHERE erp_table=? AND import_disabled IS NOT 1 AND column_name IN (${ph})
`).all(TABLE, ...present)
if (importedStill.length) {
  stop(`Import Airtable encore ACTIF : ${importedStill.map(r => `${r.column_name} ← ${r.airtable_field_name}`).join(', ')}`)
}

// Un lookup / rollup d'une AUTRE table qui viserait une de ces colonnes serait
// vidé en silence (c'est le cas de date_du_premier_envoi, d'où son exclusion).
const dependents = db.prepare(`
  SELECT erp_table, name, kind, lookup_target_column, rollup_target_column
  FROM custom_fields
  WHERE deleted_at IS NULL
    AND ((lookup_target_table=? AND lookup_target_column IN (${ph}))
      OR (rollup_target_table=? AND rollup_target_column IN (${ph})))
`).all(TABLE, ...present, TABLE, ...present)
if (dependents.length) {
  stop(`Champs calculés qui en dépendent : ${dependents.map(d => `${d.erp_table}.${d.name} (${d.kind} → ${d.lookup_target_column || d.rollup_target_column})`).join(', ')}`)
}

// ── État des lieux
console.log(`Table : ${TABLE} — ${existingCols.size} colonnes`)
console.log(`Colonnes visées : ${COLUMNS.length}`)
console.log(`  présentes en DB (à dropper) : ${present.length}`)
console.log(`  déjà absentes               : ${missing.length}${missing.length ? ' — ' + missing.join(', ') : ''}`)
console.log(`Exclusions volontaires : ${EXCLUDED.join(', ')}`)

console.log('\nValeurs non vides qui seront détruites :')
let totalValues = 0
for (const c of present) {
  const { n } = db.prepare(
    `SELECT COUNT(*) AS n FROM ${TABLE} WHERE [${c}] IS NOT NULL AND TRIM(CAST([${c}] AS TEXT)) != ''`
  ).get()
  totalValues += n
  if (n) console.log(`  ${c.padEnd(62)} ${n}`)
}
console.log(`  ${'TOTAL'.padEnd(62)} ${totalValues}`)

const cfRows = db.prepare(`SELECT id FROM custom_fields WHERE erp_table=? AND column_name IN (${ph})`).all(TABLE, ...present)
const mapRows = db.prepare(`SELECT id FROM airtable_field_mappings WHERE erp_table=? AND column_name IN (${ph})`).all(TABLE, ...present)
let defCount = 0
try {
  defCount = db.prepare(`SELECT COUNT(*) n FROM airtable_field_defs WHERE erp_table=? AND column_name IN (${ph})`).get(TABLE, ...present).n
} catch { /* table héritée absente */ }

console.log(`\ncustom_fields à supprimer             : ${cfRows.length}`)
console.log(`airtable_field_mappings à désactiver : ${mapRows.length} (conservés en import_disabled=1)`)
console.log(`airtable_field_defs à supprimer      : ${defCount}`)

// ── Vues enregistrées : une colonne droppée qui traîne dans visible_columns /
//    sort / filters / group_by / column_widths laisserait une colonne fantôme.
const dropped = new Set(present)
const parse = (raw, fallback) => { try { return JSON.parse(raw || fallback) } catch { return JSON.parse(fallback) } }
const withoutDropped = (arr, key) => arr.filter(x => !dropped.has(key ? (x?.[key] ?? x?.id) : x))

function pillPatch(p) {
  const patch = {}
  const vis = parse(p.visible_columns, '[]')
  if (vis.some(c => dropped.has(c))) patch.visible_columns = JSON.stringify(withoutDropped(vis))
  const sort = parse(p.sort, '[]')
  if (sort.some(s => dropped.has(s?.field || s?.id))) patch.sort = JSON.stringify(withoutDropped(sort, 'field'))
  const filters = parse(p.filters, '[]')
  if (filters.some(f => dropped.has(f?.field || f?.id))) patch.filters = JSON.stringify(withoutDropped(filters, 'field'))
  const rules = parse(p.color_rules, '[]')
  if (rules.some(r => dropped.has(r?.field || r?.id))) patch.color_rules = JSON.stringify(withoutDropped(rules, 'field'))
  if (p.group_by && dropped.has(p.group_by)) patch.group_by = null
  const widths = parse(p.column_widths, '{}')
  if (Object.keys(widths).some(c => dropped.has(c))) {
    patch.column_widths = JSON.stringify(Object.fromEntries(Object.entries(widths).filter(([c]) => !dropped.has(c))))
  }
  return patch
}

const pillPatches = []
for (const p of db.prepare(`SELECT * FROM table_view_pills WHERE table_name=?`).all(TABLE)) {
  const patch = pillPatch(p)
  if (Object.keys(patch).length) pillPatches.push({ id: p.id, label: p.label, patch })
}
console.log(`\nvues « Commandes » à nettoyer : ${pillPatches.length}`)
for (const p of pillPatches) console.log(`  ${p.label} → ${Object.keys(p.patch).join(', ')}`)

// table_view_configs : la config par défaut de la table (hors vues nommées).
// Le script des envois ne la touchait pas ; les commandes y ont des largeurs de
// colonnes mémorisées, dont celles de colonnes droppées.
const configPatches = []
for (const c of db.prepare(`SELECT * FROM table_view_configs WHERE table_name=?`).all(TABLE)) {
  const patch = {}
  const vis = parse(c.visible_columns, '[]')
  if (vis.some(x => dropped.has(x))) patch.visible_columns = JSON.stringify(withoutDropped(vis))
  const sort = parse(c.default_sort, '[]')
  if (sort.some(s => dropped.has(s?.field || s?.id))) patch.default_sort = JSON.stringify(withoutDropped(sort, 'field'))
  const widths = parse(c.column_widths, '{}')
  if (Object.keys(widths).some(x => dropped.has(x))) {
    patch.column_widths = JSON.stringify(Object.fromEntries(Object.entries(widths).filter(([x]) => !dropped.has(x))))
  }
  const aggs = parse(c.footer_aggregations, '{}')
  if (Object.keys(aggs).some(x => dropped.has(x))) {
    patch.footer_aggregations = JSON.stringify(Object.fromEntries(Object.entries(aggs).filter(([x]) => !dropped.has(x))))
  }
  if (Object.keys(patch).length) configPatches.push({ id: c.id, patch })
}
console.log(`config de table à nettoyer : ${configPatches.length}${configPatches.length ? ' — ' + configPatches.flatMap(p => Object.keys(p.patch)).join(', ') : ''}`)

if (!APPLY) {
  console.log('\nDry run (aucune modification). Relance avec --apply pour appliquer.')
  process.exit(0)
}

// ── Sauvegarde AVANT destruction, hors transaction : écrire un fichier n'est
//    pas annulable, et c'est le seul filet une fois la colonne droppée (la
//    corbeille des champs n'aura plus rien à restaurer).
const backupDir = path.join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'backups')
fs.mkdirSync(backupDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)
const backupFile = path.join(backupDir, `${TABLE}-airtable-cols-${stamp}.json`)
const rows = db.prepare(`SELECT id, ${present.map(c => `[${c}]`).join(', ')} FROM ${TABLE}`).all()
fs.writeFileSync(backupFile, JSON.stringify({ table: TABLE, columns: present, purged_at: new Date().toISOString(), rows }, null, 1))
console.log(`\n💾 Sauvegarde : ${backupFile} (${rows.length} lignes)`)

const tx = db.transaction(() => {
  // La vue référence les colonnes (ne serait-ce que par SELECT *) : SQLite
  // refuse le DROP COLUMN tant qu'elle existe.
  db.exec(`DROP VIEW IF EXISTS ${TABLE}_v`)
  for (const c of present) db.exec(`ALTER TABLE ${TABLE} DROP COLUMN [${c}]`)

  db.prepare(`DELETE FROM custom_fields WHERE erp_table=? AND column_name IN (${ph})`).run(TABLE, ...present)
  db.prepare(`
    UPDATE airtable_field_mappings
    SET import_disabled=1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE erp_table=? AND column_name IN (${ph})
  `).run(TABLE, ...present)
  try {
    db.prepare(`DELETE FROM airtable_field_defs WHERE erp_table=? AND column_name IN (${ph})`).run(TABLE, ...present)
  } catch { /* table héritée absente */ }

  for (const { id, patch } of pillPatches) {
    const sets = Object.keys(patch).map(k => `${k}=?`).join(', ')
    db.prepare(`UPDATE table_view_pills SET ${sets} WHERE id=?`).run(...Object.values(patch), id)
  }
  for (const { id, patch } of configPatches) {
    const sets = Object.keys(patch).map(k => `${k}=?`).join(', ')
    db.prepare(`UPDATE table_view_configs SET ${sets} WHERE id=?`).run(...Object.values(patch), id)
  }
})
tx()

// Hors transaction : regenerateView fait ses propres DDL et lit custom_fields
// (déjà nettoyée) pour rebâtir les couches de champs virtuels.
regenerateView(TABLE)

const remaining = db.pragma(`table_info(${TABLE})`).length
const viewOk = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='view' AND name=?").get(`${TABLE}_v`)
console.log(`\n✅ ${present.length} colonne(s) droppée(s), ${cfRows.length} champ(s) détruit(s), ${mapRows.length} mapping(s) coupé(s), ${pillPatches.length} vue(s) + ${configPatches.length} config nettoyées.`)
console.log(`   Reste ${remaining} colonnes dans ${TABLE}. Vue ${TABLE}_v ${viewOk ? 'régénérée' : '⛔ ABSENTE'}.`)
