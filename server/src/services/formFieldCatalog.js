import db from '../db/database.js'
import { isColumnWritable } from './customFieldWritability.js'
import { writebackModuleForTable } from './airtableWriteback.js'

// ── Catalogue des champs proposables au formulaire de création ───────────────
//
// « Modifier le formulaire » (components/RecordForm.jsx) ne proposait que les
// champs codés en dur par la page. Sur une table dont l'essentiel des colonnes
// vient du registre de champs (custom_fields : champs perso ERP + colonnes
// adoptées d'Airtable), ça revenait à n'offrir qu'une poignée de champs alors
// que la fiche en affiche des dizaines.
//
// Ce catalogue rend le reste disponible, en écartant tout ce qui n'a PAS de
// saisie manuelle :
//   • champs calculés par Airtable — formule, rollup, lookup, count
//     (repérés par `airtable_field_defs.options.source`) ;
//   • champs auto — Autonumber, Record ID, date de création / de modification ;
//   • pièces jointes (`options.format = 'attachment'`) : la colonne stocke des
//     URL de fichiers, pas une valeur qu'on tape ;
//   • champs lien : la colonne stocke des identifiants d'enregistrement, la
//     saisie passe par un picker dédié (règle CLAUDE.md des champs référence),
//     pas par une zone de texte ;
//   • champs virtuels de l'ERP (formule / lookup / rollup / bouton / liaison) —
//     seul `kind='data'` est une vraie colonne saisissable.
//
// Un champ Airtable encore en sens « import » reste LISTÉ mais non cochable
// (`writable: false` + raison) : le proposer donnerait une valeur écrasée au
// prochain sync (règle unique — services/customFieldWritability.js). Le montrer
// grisé, avec la raison, vaut mieux que de le faire disparaître sans explication
// — l'utilisateur voit le champ, comprend pourquoi il est verrouillé, et sait
// que passer son sens de sync en bidirectionnel (/champs/orders) le débloque.

// Valeurs de `airtable_field_defs.options.source` : le champ est calculé par
// Airtable, sa colonne ERP n'est qu'une recopie.
const COMPUTED_AIRTABLE_SOURCES = new Set([
  'formula', 'rollup', 'lookup', 'multipleLookupValues', 'count',
  'createdTime', 'lastModifiedTime', 'createdBy', 'lastModifiedBy',
  'autoNumber', 'button', 'externalSyncSource',
])

// Champs Airtable auto dont le type normalisé (number / text) ne trahit plus la
// nature : Airtable les remplit seul, l'ERP les recopie.
const AUTO_COLUMNS = new Set(['autonumber', 'record_id', 'created_time', 'last_modified_time'])

// Type de registre → type de contrôle attendu par RecordForm.
function controlType(row, defOptions) {
  const t = row.type || row.field_type || 'text'
  if (t === 'long_text') return 'textarea'
  if (t === 'single_select') return 'select'
  if (t === 'multi_select') return 'select'
  if (t === 'checkbox') return 'checkbox'
  if (t === 'date') return 'date'
  if (t === 'number') return defOptions?.format === 'currency' ? 'currency' : 'number'
  if (t === 'url') return 'url'
  if (defOptions?.format === 'email') return 'email'
  if (defOptions?.format === 'url') return 'url'
  return 'text'
}

function parseJson(raw) {
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

function choicesOf(defOptions, cfOptions) {
  const fromDef = Array.isArray(defOptions?.choices) ? defOptions.choices : []
  if (fromDef.length) return fromDef
  const fromCf = Array.isArray(cfOptions?.choices) ? cfOptions.choices : []
  return fromCf
}

export const AIRTABLE_IMPORT_ONLY_REASON =
  "Champ importé d'Airtable (sens import) — passez-le en bidirectionnel dans /champs pour pouvoir le saisir"

// Champs du registre proposables à la création pour `erpTable`.
// Retourne [{ field, label, type, options?, decimals?, writable, readonly_reason? }],
// triés par libellé.
export function formFieldCatalog(erpTable) {
  const rows = db.prepare(`
    SELECT cf.column_name, cf.name, cf.type, cf.decimals, cf.source,
           cf.options AS cf_options,
           m.id AS mapping_id, m.import_disabled,
           d.field_type, d.options AS def_options
    FROM custom_fields cf
    LEFT JOIN airtable_field_mappings m
      ON m.erp_table = cf.erp_table AND m.column_name = cf.column_name
    LEFT JOIN airtable_field_defs d
      ON d.erp_table = cf.erp_table AND d.column_name = cf.column_name
    WHERE cf.erp_table = ? AND cf.deleted_at IS NULL AND cf.kind = 'data'
      AND (cf.hidden IS NULL OR cf.hidden = 0)
  `).all(erpTable)

  const module = writebackModuleForTable(erpTable)
  const out = []
  for (const row of rows) {
    if (AUTO_COLUMNS.has(row.column_name)) continue
    const defOptions = parseJson(row.def_options)
    const cfOptions = parseJson(row.cf_options)
    if (defOptions?.source && COMPUTED_AIRTABLE_SOURCES.has(defOptions.source)) continue
    if (defOptions?.format === 'attachment') continue
    if (row.field_type === 'link' || row.type === 'link' || cfOptions?.airtable_link_hint) continue

    const writable = isColumnWritable(erpTable, row, module)
    const type = controlType(row, defOptions)
    const choices = type === 'select' ? choicesOf(defOptions, cfOptions) : []
    out.push({
      field: row.column_name,
      label: row.name || row.column_name,
      type,
      ...(choices.length ? { options: choices } : {}),
      ...(row.decimals != null ? { decimals: row.decimals } : {}),
      writable,
      ...(writable ? {} : { readonly_reason: AIRTABLE_IMPORT_ONLY_REASON }),
    })
  }
  // Un select sans choix connu n'offrirait qu'une liste vide : on le rétrograde
  // en saisie libre plutôt que de proposer un champ impossible à remplir.
  for (const f of out) {
    if (f.type === 'select' && !f.options) f.type = 'text'
  }
  return out.sort((a, b) => a.label.localeCompare(b.label, 'fr'))
}

export default formFieldCatalog
