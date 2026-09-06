// Les choix d'une Sélection Airtable entrent dans le champ ERP correspondant.
//
// Une option ajoutée côté Airtable arrivait bien dans la DONNÉE (l'import écrit
// la valeur telle quelle), mais restait inconnue du CHAMP : pas de pastille
// colorée, absente du sélecteur, donc impossible à poser sur un autre
// enregistrement depuis Boréal. Ce module comble ce trou à chaque sync.
//
// Règle : STRICTEMENT ADDITIF. On ajoute les choix manquants, jamais on ne
// renomme, recolore, réordonne ni ne retire ce que l'utilisateur a configuré —
// c'est la même intention que le sync entrant qui ne réécrit plus le type ni le
// rendu d'un champ (cf. airtableAutoSync.syncDynamicFields).
//
// Sont ignorés : un champ dont l'import est coupé, un champ en sens 'push'
// (l'ERP est la vérité, sa liste ne se prend pas d'Airtable), un champ supprimé,
// et tout champ qui n'est pas une Sélection côté ERP.

import { v4 as uuid } from 'uuid'
import db from '../db/database.js'
import { dynamicFieldDirection, writebackModuleForTable } from './airtableWriteback.js'

// Palette des choix, dans l'ordre où la modale de champ l'attribue aux choix
// neufs (client/src/components/CustomFieldModal.jsx) — un choix venu d'Airtable
// est coloré comme s'il avait été ajouté à la main.
const SELECT_COLORS = ['gray', 'slate', 'blue', 'indigo', 'green', 'yellow', 'orange', 'red', 'purple', 'pink', 'teal']

function choiceId() {
  return `opt_${uuid().slice(0, 8)}`
}

// Fusionne `names` (choix Airtable, dans l'ordre de la base) dans la config
// `optionsJson` d'un champ Sélection. Retourne le JSON à écrire, ou null s'il
// n'y a rien de neuf. Fonction pure — testée à part.
export function mergeChoices(optionsJson, names) {
  let opts = {}
  if (optionsJson) { try { opts = JSON.parse(optionsJson) || {} } catch { opts = {} } }
  const choices = Array.isArray(opts.choices) ? opts.choices.slice() : []
  const seen = new Set(choices.map(c => String(c?.label ?? '').trim()).filter(Boolean))
  let added = 0
  for (const raw of names || []) {
    const label = String(raw ?? '').trim()
    if (!label || seen.has(label)) continue
    seen.add(label)
    choices.push({ id: choiceId(), label, color: SELECT_COLORS[(choices.length) % SELECT_COLORS.length] })
    added++
  }
  if (!added) return null
  // Même forme que normalizeSelectOptions (routes/custom-fields.js) : les défauts
  // et l'alphabétisation restent ceux du champ.
  const next = {
    choices,
    default_id: opts.default_id || null,
    default_ids: Array.isArray(opts.default_ids) ? opts.default_ids : [],
    alphabetize: !!opts.alphabetize,
  }
  if (next.alphabetize) {
    next.choices.sort((a, b) => String(a.label).localeCompare(String(b.label), 'fr', { sensitivity: 'base' }))
  }
  return { json: JSON.stringify(next), added }
}

// Même fusion pour la config de choix d'un champ NATIF (colonne déclarée dans
// tableDefs.js dont l'utilisateur a personnalisé les choix) : la forme y est
// { value, label, color } — `value` est la valeur stockée, `label` son
// affichage. Un choix venu d'Airtable naît avec sa valeur pour libellé et sans
// couleur choisie (« couleur d'origine »).
export function mergeNativeChoices(optionsJson, names) {
  let opts = {}
  if (optionsJson) { try { opts = JSON.parse(optionsJson) || {} } catch { opts = {} } }
  const choices = Array.isArray(opts.choices) ? opts.choices.slice() : []
  if (choices.length === 0) return null // pas de config → la liste vit dans le code
  const seen = new Set(choices.map(c => String(c?.value ?? c?.label ?? '').trim()).filter(Boolean))
  let added = 0
  for (const raw of names || []) {
    const value = String(raw ?? '').trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    choices.push({ value, label: value, color: null })
    added++
  }
  if (!added) return null
  return { json: JSON.stringify({ ...opts, choices }), added }
}

// Applique la fusion pour UNE colonne ERP. Retourne le nombre de choix ajoutés.
export function syncChoicesForColumn(erpTable, columnName, names, { module = null } = {}) {
  if (!Array.isArray(names) || names.length === 0) return 0
  const field = db.prepare(`
    SELECT cf.id, cf.kind, cf.type, cf.options, m.id AS mapping_id, m.import_disabled
    FROM custom_fields cf
    LEFT JOIN airtable_field_mappings m
      ON m.erp_table = cf.erp_table AND m.column_name = cf.column_name
    WHERE cf.erp_table=? AND cf.column_name=? AND cf.deleted_at IS NULL
      AND cf.kind IN ('data', 'native')
  `).get(erpTable, columnName)
  if (!field) return 0
  if (field.import_disabled === 1) return 0
  const mod = module || writebackModuleForTable(erpTable)
  if (dynamicFieldDirection(mod, columnName) === 'push') return 0

  // Champ natif : on ne complète QUE si l'utilisateur a déjà une config de
  // choix. Sans elle, la liste vient de tableDefs.js et lui en fabriquer une
  // au premier sync figerait le champ dans le dos de l'utilisateur.
  const merged = field.kind === 'native'
    ? mergeNativeChoices(field.options, names)
    : ((field.type === 'single_select' || field.type === 'multi_select')
      ? mergeChoices(field.options, names)
      : null)
  if (!merged) return 0
  db.prepare(
    `UPDATE custom_fields SET options=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`
  ).run(merged.json, field.id)
  return merged.added
}

// Passe complète sur les champs d'une table Airtable, à partir des métadonnées
// déjà récupérées par le sync (`tableFields` = table.fields de /meta/bases).
// La colonne ERP est résolue par la table de mapping — un champ resté dans un
// `field_map` « cœur » (modules pas encore basculés) n'est donc pas couvert.
export function syncSelectChoicesFromAirtable(erpTable, tableFields) {
  const defs = db.prepare(
    `SELECT airtable_field_id, airtable_field_name, column_name, import_disabled
     FROM airtable_field_mappings WHERE erp_table=? AND column_name != '__pending__'`
  ).all(erpTable)
  if (defs.length === 0) return 0
  const module = writebackModuleForTable(erpTable)

  // TOUTES les defs qui lisent le champ, pas seulement la première : un même
  // champ Airtable peut alimenter plusieurs colonnes Boréal, et chacune doit
  // recevoir les choix — sinon la seconde colonne affichait une valeur absente
  // de son propre sélecteur.
  const defsFor = (f) => defs.filter(d =>
    d.airtable_field_id === f.id || d.airtable_field_name === f.name)

  let added = 0
  const touched = new Set()
  for (const f of tableFields || []) {
    if (f?.type !== 'singleSelect' && f?.type !== 'multipleSelects') continue
    const names = (f.options?.choices || []).map(c => c?.name).filter(Boolean)
    for (const def of defsFor(f)) {
      if (def.import_disabled === 1 || touched.has(def.column_name)) continue
      touched.add(def.column_name)
      const n = syncChoicesForColumn(erpTable, def.column_name, names, { module })
      if (n) {
        added += n
        console.log(`🎨 ${erpTable}.${def.column_name} : ${n} choix ajouté(s) depuis Airtable`)
      }
    }
  }
  return added
}
