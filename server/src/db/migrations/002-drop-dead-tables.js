/**
 * 002 — Suppression des tables que plus aucun code ne lit.
 *
 * Relevé du 2026-09-02 : 180 tables en base pour 158 déclarées dans schema.js.
 * L'écart n'est pas un bug de schema.js — plusieurs tables sont créées ailleurs
 * (change_log par db/changeLog.js, email_relance_drafts par
 * services/relanceEmail.js) et sont bien vivantes. Chaque candidate a donc été
 * vérifiée par recherche de son nom dans server/src et client/src avant d'entrer
 * dans cette liste. Les tables gardées, et pourquoi :
 *
 *   change_log              vivante — 20 fichiers, colonne vertébrale des deltas client
 *   tenants                 vivante — routes/documents.js y lit le nom de l'entreprise
 *                           pour l'en-tête des PDF de soumission (0 ligne, donc repli
 *                           sur « Orisha », mais la supprimer casserait la route)
 *   email_relance_drafts    vivante — services/relanceEmail.js
 *   vendor_directory_legacy gardée exprès — copie de sécurité du dernier état du doc
 *                           fournisseurs, et son existence est ce qui empêche la
 *                           migration vendor_directory de se rejouer (schema.js)
 *
 * Le gros morceau supprimé ici est un moteur de tables générique abandonné
 * (base_tables / base_fields / base_records / base_views / base_interfaces…),
 * 30 302 lignes de records stockés en JSON, zéro référence dans le code. Il
 * duplique précisément les modules Airtable — ses 23 tables s'appellent
 * « Entreprises », « Contacts », « Commandes »… Le miroir a besoin d'un schéma
 * typé, pas de JSON dans une colonne `data` : cette voie est abandonnée pour de
 * bon, pas mise en pause.
 *
 * Le reste : des prédécesseurs du registre de champs actuel (custom_field_defs,
 * field_values), une config renommée depuis longtemps (airtable_inventaire_config
 * → airtable_projets_config, cf. schema.js), et deux fonctionnalités retirées
 * dont l'automation figure dans RETIRED_SYSTEM_AUTOMATION_IDS
 * (services/systemAutomations.js) : le registre des entreprises du Québec
 * (sys_req_import, carte UI supprimée) et la revue hebdomadaire Slack
 * (sys_weekly_review_slack).
 *
 * Chaque table est écrite en JSON avant suppression, sous
 * uploads/db-archive/dropped-<horodatage>/. Une sauvegarde complète de la base a
 * par ailleurs été prise avant l'exécution.
 */

import { mkdirSync, writeFileSync } from 'fs'
import path from 'path'

export const id = '002-drop-dead-tables'
export const description = 'Supprime 18 tables sans aucune référence dans le code (dump JSON préalable)'

// Ordre significatif : les tables porteuses d'un REFERENCES vers base_tables
// doivent partir avant elle (foreign_keys = ON).
const DEAD_TABLES = [
  // Moteur de tables génériques abandonné
  'base_interface_blocks',
  'base_interface_pages',
  'base_interfaces',
  'base_record_links',
  'base_views',
  'base_records',
  'base_fields',
  'base_tables',
  'record_history',
  // Prédécesseurs du registre de champs
  'field_values',
  'custom_field_defs',
  // Config renommée en airtable_projets_config
  'airtable_inventaire_config',
  // Restes de fonctionnalités
  'email_relance_sent',
  'month_close_acks',
  'month_close_periods',
  'req_entreprises',
  'weekly_review_sections',
  'weekly_reviews',
]

function archiveDir() {
  // `path.resolve` et non `path.join` : UPLOADS_PATH peut être absolu (c'est le
  // cas des essais à blanc sur une copie de la base), et un join l'aurait
  // concaténé derrière le cwd au lieu de le respecter.
  const base = path.resolve(process.cwd(), process.env.UPLOADS_PATH || 'uploads')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dir = path.join(base, 'db-archive', `dropped-${stamp}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function up(db) {
  const present = DEAD_TABLES.filter(t =>
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t))
  if (!present.length) return

  const dir = archiveDir()
  let archived = 0

  for (const table of present) {
    const rows = db.prepare(`SELECT * FROM "${table}"`).all()
    const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(table)?.sql || null
    writeFileSync(
      path.join(dir, `${table}.json`),
      JSON.stringify({ table, dropped_at: new Date().toISOString(), ddl, row_count: rows.length, rows }, null, 2)
    )
    archived += rows.length
  }

  // Les triggers et index attachés partent avec leur table ; les vues n'ont
  // jamais couvert ces tables (regenerateAllViews ne travaille que sur
  // ALLOWED_TABLES). Un DROP suffit donc.
  for (const table of present) db.exec(`DROP TABLE "${table}"`)

  console.log(`↪ ${present.length} tables mortes supprimées (${archived} lignes archivées) → ${dir}`)
}
