import db from '../db/database.js'

// ── Colonnes ERP natives ouvertes au mapping Airtable, sans champ de rendu ───
//
// Une colonne native ordinaire n'a rien à faire ici : le mapping dynamique la
// gère très bien (il pose au passage une ligne custom_fields qui porte son
// rendu). Le cas traité ici est celui d'une colonne dont la valeur ERP n'est PAS
// la valeur Airtable : `projects.vendeur_ref` porte une référence
// (`employee:<id>` / `company:<id>`) qu'aucun champ Airtable ne contient — le
// nom importé doit être RÉSOLU vers un enregistrement Boréal. D'où trois
// spécificités :
//   • `ref_resolver` : la valeur importée passe par un résolveur (convertValue) ;
//   • aucune ligne custom_fields n'est créée — la colonne a déjà sa présentation
//     (le champ « Vendeur » de la fiche projet) et un champ de plus ferait un
//     doublon dans tous les tableaux ;
//   • `pull_only` : une référence Boréal ne veut rien dire dans Airtable, le
//     sens de synchronisation ne peut donc pas être inversé.
export const NATIVE_MAPPED_COLUMNS = {
  projects: {
    vendeur_ref: {
      label: 'Vendeur',
      field_type: 'text',
      ref_resolver: 'project_vendeur',
      pull_only: true,
    },
  },
}

export function nativeMappedColumn(erpTable, column) {
  return NATIVE_MAPPED_COLUMNS[erpTable]?.[column] || null
}

// ── Résolution d'une valeur Airtable vers une référence ERP ─────────────────

const AIRTABLE_REC_ID = /^rec[A-Za-z0-9]{8,}$/

// Un champ lookup renvoie un tableau, un champ texte une chaîne, un champ
// « collaborateur » un objet. On ne garde que le premier nom exploitable : une
// référence ne désigne qu'un enregistrement.
function firstLabel(val) {
  if (val === null || val === undefined) return ''
  if (Array.isArray(val)) {
    for (const v of val) {
      const s = firstLabel(v)
      if (s) return s
    }
    return ''
  }
  if (typeof val === 'object') return String(val.name || val.label || val.email || '').trim()
  return String(val).trim()
}

let _vendeurStmts = null
function vendeurStmts() {
  if (!_vendeurStmts) {
    const empName = `TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,''))`
    _vendeurStmts = {
      empByAirtable: db.prepare('SELECT id FROM employees WHERE airtable_id=? LIMIT 1'),
      compByAirtable: db.prepare('SELECT id FROM companies WHERE airtable_id=? AND deleted_at IS NULL LIMIT 1'),
      empSales: db.prepare(
        `SELECT id FROM employees WHERE ${empName} = ? COLLATE NOCASE AND is_salesperson=1
         ORDER BY active DESC LIMIT 1`),
      compVendeur: db.prepare(
        `SELECT id FROM companies WHERE name = ? COLLATE NOCASE AND deleted_at IS NULL AND is_vendeur_orisha=1
         LIMIT 1`),
      empAny: db.prepare(
        `SELECT id FROM employees WHERE ${empName} = ? COLLATE NOCASE ORDER BY active DESC LIMIT 1`),
      compAny: db.prepare(
        `SELECT id FROM companies WHERE name = ? COLLATE NOCASE AND deleted_at IS NULL ORDER BY name LIMIT 1`),
    }
  }
  return _vendeurStmts
}

/**
 * Vendeur d'un projet : `employee:<id>` quand le nom importé est celui d'un
 * employé, `company:<id>` quand c'est un partenaire (revendeur), sinon le nom
 * brut — le champ affiche alors ce que dit Airtable au lieu de rester vide, et
 * il suffit de créer l'entreprise/l'employé pour que la référence se noue au
 * prochain sync.
 *
 * On préfère un enregistrement DÉCLARÉ vendeur (employé « vendeur », entreprise
 * « vendeur Orisha ») à un homonyme quelconque : c'est ce que l'utilisateur voit
 * dans le sélecteur du champ.
 */
export function resolveProjectVendeurRef(val) {
  const label = firstLabel(val)
  if (!label) return null
  const s = vendeurStmts()

  // Lien Airtable : la cellule porte des record IDs, résolubles seulement si
  // l'enregistrement lié est lui-même importé dans Boréal.
  if (AIRTABLE_REC_ID.test(label)) {
    const emp = s.empByAirtable.get(label)
    if (emp) return `employee:${emp.id}`
    const comp = s.compByAirtable.get(label)
    if (comp) return `company:${comp.id}`
    return null
  }

  const name = label.replace(/\s+/g, ' ')
  const empSales = s.empSales.get(name)
  if (empSales) return `employee:${empSales.id}`
  const compVendeur = s.compVendeur.get(name)
  if (compVendeur) return `company:${compVendeur.id}`
  const empAny = s.empAny.get(name)
  if (empAny) return `employee:${empAny.id}`
  const compAny = s.compAny.get(name)
  if (compAny) return `company:${compAny.id}`
  return name
}

const REF_RESOLVERS = {
  project_vendeur: resolveProjectVendeurRef,
}

// Valeur ERP à écrire pour un mapping à résolveur, ou `undefined` si le
// résolveur est inconnu (l'appelant retombe alors sur la conversion normale).
export function resolveRefValue(resolver, val) {
  const fn = REF_RESOLVERS[resolver]
  return fn ? fn(val) : undefined
}
