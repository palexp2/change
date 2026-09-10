/**
 * 044 — Contacts : les 6 champs codés en dur deviennent des champs personnalisés.
 *
 * Demande depuis /champs/contacts : « supprime tous les champs codés en dur
 * (drop column) Prénom, Nom, Email, Phone number, Entreprise, Langue et
 * remplace-les au besoin par des champs personnalisés s'il y a des intégrations
 * qui dépendent de ces champs. Rattache tous les fils à ces nouveaux champs. »
 *
 * Ces six-là sont les valeurs du field_map « cœur » du CRM
 * (`airtable_sync_config.field_map_contacts`), annoncées « N champs Airtable
 * gérés en code (mappés en dur, non modifiables ici) » au bas de la page. Les
 * colonnes ERP qu'ils alimentent — `first_name`, `last_name`, `email`, `phone`,
 * `company_id`, `language` — portent TOUTE l'identité d'un contact et sont lues
 * par une cinquantaine de fichiers (courriels et relances, soumissions,
 * documents, envois Novoxpress/UPS, appels, HubSpot, Stripe, recherche
 * globale…). Le `DROP COLUMN` de 035 / 037 / 040 était possible là-bas parce
 * que la donnée y était morte ; ici la demande dit elle-même de garder les
 * intégrations branchées — c'est donc la voie de 039 (Employés) qui s'applique :
 * les colonnes sont ADOPTÉES en champs personnalisés (registre `custom_fields`,
 * kind='data'), et ce qui est détruit est le CODAGE EN DUR, pas la donnée.
 *
 * Ce que ça donne, concrètement :
 *   • `field_map_contacts` passe à NULL (retireContactsCoreFieldMap) et ses 6
 *     clés deviennent des lignes de mapping ordinaires (`core_<colonne>`) : sur
 *     /champs/contacts, chacun se renomme, se re-type, se branche sur le champ
 *     Airtable de son choix ou se supprime. La note « champs Airtable gérés en
 *     code » disparaît, et les 6 champs Airtable rentrent dans le picker.
 *   • 5 colonnes adoptées en champs (`nativeFieldConversions.js`) : Prénom, Nom,
 *     Courriel, Téléphone, Langue. `company_id` ne l'est pas (une ligne
 *     custom_fields active en ferait une colonne d'ids bruts dans le tableau, et
 *     le sens « import » la rendrait non éditable — le picker d'entreprise de la
 *     fiche casserait) : son mapping est porté par la ligne « Entreprise »
 *     (`company_name`) via `mappingColumn`, comme « Produit » des assemblages.
 *   • les fils restent branchés : aucune colonne ne bouge, donc aucune route,
 *     aucun courriel et aucun connecteur ne change de source.
 *
 * Restent deux choses que le semis déclaratif ne peut pas faire, et qu'on ne
 * veut faire qu'UNE fois — exactement les deux de 039 :
 *
 * 1. L'id de la colonne « Nom ». Le tableau des contacts affichait « Prénom
 *    Nom » sous l'id `full_name`, posé sur la colonne SQL `first_name`. Le champ
 *    personnalisé, lui, s'appelle forcément `last_name` (le nom de sa colonne) :
 *    les deux auraient coexisté — deux colonnes « Nom » dans le tableau, deux
 *    lignes dans /champs/contacts. La colonne d'affichage prend donc l'id
 *    `last_name` (tableDefs.js) et les vues enregistrées qui nommaient
 *    `full_name` sont RENOMMÉES ici : les vider amputerait « Clients » et
 *    « Tous les contacts » de leur colonne principale.
 * 2. Rien à figer côté colonnes visibles : contrairement aux employés, les
 *    colonnes adoptées ont toutes leur définition d'affichage dans tableDefs.js
 *    (« Prénom » en `defaultVisible: false`), donc le tableau ne gagne aucune
 *    colonne surprise.
 *
 * Défensive : la migration ne fait que réécrire des ids de vues, et seulement
 * là où `full_name` apparaît.
 */
import db from '../database.js'

export const id = '044-contacts-fields-to-custom'
export const description =
  'Contacts : colonne « Nom » renommée full_name → last_name dans les vues enregistrées (les 6 champs cœur deviennent des champs personnalisés)'

const OLD = 'full_name'
const NEW = 'last_name'
// Seule la page /contacts est concernée : le tableau « Contacts » de la fiche
// entreprise (clé de vue `company_contacts`) nomme déjà sa colonne de nom
// `name`, et ses colonnes adoptées y arrivent masquées (tableau encastré).
const VIEW_TABLES = ['contacts']

export function up(migrationDb) {
  const d = migrationDb || db
  return { views_renamed: renameInSavedViews(d) }
}

// Les vues enregistrées référencent la colonne par son id : `visible_columns`,
// `sort`, `filters`, `color_rules`, `group_by` et `column_widths`. Repris tel
// quel des migrations 026 et 039 (même problème, même forme).
function renameInSavedViews(d) {
  const parse = (raw, fallback) => {
    try { return JSON.parse(raw ?? fallback) } catch { return JSON.parse(fallback) }
  }
  const rename = (x) => {
    if (typeof x === 'string') return x === OLD ? NEW : x
    if (x && typeof x === 'object') {
      if (x.field === OLD) return { ...x, field: NEW }
      if (x.id === OLD) return { ...x, id: NEW }
    }
    return x
  }
  const hits = (x) => (typeof x === 'string' ? x === OLD : (x?.field === OLD || x?.id === OLD))
  let renamed = 0

  const patchRow = (table, row, fields) => {
    const patch = {}
    for (const [col, kind] of Object.entries(fields)) {
      if (kind === 'list') {
        // `filters` a deux formes en base : tableau de règles (historique) ou
        // objet `{ conjunction, rules }` (barre de filtres actuelle). Traiter
        // l'objet comme un tableau ferait un TypeError en pleine transaction.
        const raw = parse(row[col], '[]')
        const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.rules) ? raw.rules : [])
        if (!list.some(hits)) continue
        patch[col] = JSON.stringify(
          Array.isArray(raw) ? raw.map(rename) : { ...raw, rules: list.map(rename) }
        )
      } else if (kind === 'map') {
        const map = parse(row[col], '{}')
        if (!Object.hasOwn(map, OLD)) continue
        const { [OLD]: moved, ...rest } = map
        patch[col] = JSON.stringify({ ...rest, [NEW]: moved })
      } else if (kind === 'scalar' && row[col] === OLD) {
        patch[col] = NEW
      }
    }
    if (!Object.keys(patch).length) return
    const sets = Object.keys(patch).map(k => `${k}=?`).join(', ')
    d.prepare(`UPDATE ${table} SET ${sets} WHERE id=?`).run(...Object.values(patch), row.id)
    renamed++
  }

  for (const table of VIEW_TABLES) {
    for (const row of d.prepare('SELECT * FROM table_view_pills WHERE table_name=?').all(table)) {
      patchRow('table_view_pills', row, {
        visible_columns: 'list', sort: 'list', filters: 'list', color_rules: 'list',
        column_widths: 'map', group_by: 'scalar',
      })
    }
    try {
      for (const row of d.prepare('SELECT * FROM table_view_configs WHERE table_name=?').all(table)) {
        patchRow('table_view_configs', row, {
          visible_columns: 'list', default_sort: 'list',
          column_widths: 'map', footer_aggregations: 'map',
        })
      }
    } catch { /* table absente */ }
    // Personnalisation d'affichage posée sur l'ANCIEN id (renommage ou masquage
    // du champ natif depuis l'en-tête du tableau) : la ligne custom_fields
    // kind='native' est indexée par l'id de tableDefs, pas par la colonne SQL.
    // Sans ce report, un « Nom » renommé par l'utilisateur reprendrait son
    // libellé d'origine — et un champ masqué réapparaîtrait.
    try {
      const native = d.prepare(
        "SELECT id FROM custom_fields WHERE erp_table=? AND column_name=? AND kind='native'"
      ).get(table, OLD)
      const taken = d.prepare(
        'SELECT id FROM custom_fields WHERE erp_table=? AND column_name=?'
      ).get(table, NEW)
      if (native && !taken) {
        d.prepare(
          "UPDATE custom_fields SET column_name=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?"
        ).run(NEW, native.id)
        renamed++
      }
    } catch { /* rien à reporter */ }
  }

  return renamed
}
