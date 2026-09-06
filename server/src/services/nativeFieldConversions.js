// Conversion des colonnes natives « calculées » en vrais champs custom
// (chantier unification des champs, palier 7).
//
// Ces colonnes n'ont JAMAIS eu de colonne SQL : elles étaient fabriquées à la
// volée par des JOIN / sous-requêtes recopiés dans chaque route (ex.
// orders.company_name). On les déclare ici comme de vrais champs custom
// (lookup/rollup/formula) portant le column_name NATIF — sans préfixe cf_,
// pour que les ids de tableDefs.js, les vues sauvegardées et les pills
// continuent de matcher — et les routes lisent la VUE <table>_v via
// readRelation() au lieu de refaire les jointures.
//
// Règles pour les routes d'une table convertie :
//   - lire `FROM ${readRelation(table)} alias` et sélectionner `alias.*` ;
//   - ne JAMAIS référencer une colonne convertie par son nom dans le SQL
//     (SELECT explicite, WHERE, ORDER BY) : l'utilisateur peut supprimer le
//     champ, la colonne disparaît alors de la vue. Pour un filtre de recherche,
//     préférer un EXISTS sur la table liée (indépendant de la vue).
//
// seedNativeFieldConversions() est idempotente, exécutée à chaque démarrage
// AVANT regenerateAllViews() :
//   - pas de ligne custom_fields pour (table, colonne) → création (sort_order
//     NULL explicite — le DEFAULT 0 ferait remonter le champ en tête) ;
//   - ligne kind='native' (personnalisation cosmétique posée avant la
//     conversion) → upgradée vers le kind cible en conservant nom, visibilité
//     et ordre choisis par l'utilisateur ;
//   - tout autre kind (déjà converti, reconverti ou supprimé par l'utilisateur)
//     → intouché. La suppression d'un champ converti reste respectée : la
//     ligne soft-deleted bloque la re-création.

import db from '../db/database.js'
import { newRecordId } from '../utils/recordId.js'

const CONVERSIONS = [
  // ── orders (table pilote) ──────────────────────────────────────────────────
  {
    table: 'orders', column: 'company_name', name: 'Entreprise',
    kind: 'lookup', type: 'text',
    config: { lookup_fk: 'company_id', lookup_target_table: 'companies', lookup_target_column: 'name', result_type: 'text' },
  },
  {
    table: 'orders', column: 'assigned_name', name: 'Assigné à',
    kind: 'lookup', type: 'text',
    config: { lookup_fk: 'assigned_to', lookup_target_table: 'users', lookup_target_column: 'name', result_type: 'text' },
  },
  {
    table: 'orders', column: 'items_count', name: 'Items',
    kind: 'rollup', type: 'number',
    config: { rollup_target_table: 'order_items', rollup_target_fk: 'order_id', rollup_target_column: null, rollup_agg: 'COUNT', result_type: 'number' },
  },
  // Colonnes du field_map « cœur » retiré (cf. retireOrdersCoreFieldMap) :
  // adoptées en kind='data' pour que leur TYPE soit connu du mapping (sans
  // quoi TYPE_COMPAT refuse le champ Airtable) et qu'elles deviennent
  // renommables / convertibles / supprimables comme n'importe quel champ.
  // Aucun ALTER, aucune vue : la colonne SQL existe déjà et porte la donnée.
  //
  // « Statut » et « # Commande » sont des FORMULES côté Airtable : Airtable les
  // calcule, Boréal les recopie. Ils restent donc en import seul — le rendu de
  // la page (badge de statut) est inchangé.
  {
    table: 'orders', column: 'order_number', name: '# Commande',
    kind: 'data', type: 'number', source: 'airtable', config: {},
  },
  {
    table: 'orders', column: 'status', name: 'Statut',
    kind: 'data', type: 'single_select', source: 'airtable', config: {},
  },
  {
    table: 'orders', column: 'priority', name: 'Priorité',
    kind: 'data', type: 'single_select', source: 'airtable', config: {},
  },
  {
    table: 'orders', column: 'notes', name: 'Notes',
    kind: 'data', type: 'long_text', source: 'airtable', config: {},
  },
  // La colonne qui porte l'abonnement dans toute la logique métier (QuickBooks,
  // dashboards, constat de revenu) : un 0/1. Le doublon texte `abonnement`,
  // jamais alimenté, part à la corbeille au même démarrage.
  {
    table: 'orders', column: 'is_subscription', name: 'Abonnement',
    kind: 'data', type: 'checkbox', source: 'airtable', config: {},
  },

  // ── tasks ──────────────────────────────────────────────────────────────────
  // contact_name (prénom + nom concaténés) reste en route : un lookup ne lit
  // qu'une colonne — candidat à une conversion « formule » plus tard.
  {
    table: 'tasks', column: 'company_name', name: 'Entreprise',
    kind: 'lookup', type: 'text',
    config: { lookup_fk: 'company_id', lookup_target_table: 'companies', lookup_target_column: 'name', result_type: 'text' },
  },
  {
    table: 'tasks', column: 'assigned_name', name: 'Responsable',
    kind: 'lookup', type: 'text',
    config: { lookup_fk: 'assigned_to', lookup_target_table: 'users', lookup_target_column: 'name', result_type: 'text' },
  },
  {
    table: 'tasks', column: 'ticket_title', name: 'Billet',
    kind: 'lookup', type: 'text',
    config: { lookup_fk: 'ticket_id', lookup_target_table: 'tickets', lookup_target_column: 'title', result_type: 'text' },
  },

  // ── tickets ────────────────────────────────────────────────────────────────
  // survey_rating : au plus un sondage par billet (index unique) → MAX équivaut
  // au JOIN historique. Les autres colonnes survey_* restent en route.
  {
    table: 'tickets', column: 'company_name', name: 'Entreprise',
    kind: 'lookup', type: 'text',
    config: { lookup_fk: 'company_id', lookup_target_table: 'companies', lookup_target_column: 'name', result_type: 'text' },
  },
  {
    table: 'tickets', column: 'assigned_name', name: 'Assigné à',
    kind: 'lookup', type: 'text',
    config: { lookup_fk: 'assigned_to', lookup_target_table: 'users', lookup_target_column: 'name', result_type: 'text' },
  },
  {
    table: 'tickets', column: 'survey_rating', name: 'Satisfaction',
    kind: 'rollup', type: 'number',
    config: { rollup_target_table: 'ticket_surveys', rollup_target_fk: 'ticket_id', rollup_target_column: 'rating', rollup_agg: 'MAX', result_type: 'number' },
  },

  // ── purchases ──────────────────────────────────────────────────────────────
  {
    table: 'purchases', column: 'product_name', name: 'Produit',
    kind: 'lookup', type: 'text',
    config: { lookup_fk: 'product_id', lookup_target_table: 'products', lookup_target_column: 'name_fr', result_type: 'text' },
  },
  {
    table: 'purchases', column: 'sku', name: 'SKU',
    kind: 'lookup', type: 'text',
    config: { lookup_fk: 'product_id', lookup_target_table: 'products', lookup_target_column: 'sku', result_type: 'text' },
  },

  // ── serial_numbers ─────────────────────────────────────────────────────────
  {
    table: 'serial_numbers', column: 'product_name', name: 'Produit',
    kind: 'lookup', type: 'text',
    config: { lookup_fk: 'product_id', lookup_target_table: 'products', lookup_target_column: 'name_fr', result_type: 'text' },
  },
  {
    table: 'serial_numbers', column: 'company_name', name: 'Entreprise',
    kind: 'lookup', type: 'text',
    config: { lookup_fk: 'company_id', lookup_target_table: 'companies', lookup_target_column: 'name', result_type: 'text' },
  },

  // ── shipments ──────────────────────────────────────────────────────────────
  // company_name (2 sauts : shipments → orders → companies) reste en route,
  // les lookups en cascade ne sont pas supportés.
  {
    table: 'shipments', column: 'order_number', name: '# Commande',
    kind: 'lookup', type: 'text',
    config: { lookup_fk: 'order_id', lookup_target_table: 'orders', lookup_target_column: 'order_number', result_type: 'text' },
  },
  // Adoption de colonnes physiques en champs `data` (« repartir à neuf » —
  // décision Guillaume 2026-09-01) : ces colonnes cœur, alimentées par le
  // field_map Airtable du module envois, cessent d'être des définitions codées
  // en dur et deviennent de vrais champs (renommables, convertibles,
  // supprimables). source='airtable' : bannière correcte dans la modale et
  // re-typage libre. Aucun ALTER TABLE (colonne déjà physique), aucune vue.
  {
    table: 'shipments', column: 'tracking_number', name: 'N° de suivi',
    kind: 'data', type: 'text', source: 'airtable', config: {},
  },
  {
    table: 'shipments', column: 'carrier', name: 'Transporteur',
    kind: 'data', type: 'text', source: 'airtable', config: {},
  },
  // Statut et notes : adoptés eux aussi depuis le retrait du field_map cœur des
  // envois (le mapping se règle désormais dans /champs/shipments). Sans ligne
  // custom_fields, leur type passait pour du texte et le picker refusait le
  // champ Airtable correspondant (« Statut » est un singleSelect).
  {
    table: 'shipments', column: 'status', name: 'Statut',
    kind: 'data', type: 'single_select', source: 'airtable', config: {},
  },
  {
    table: 'shipments', column: 'notes', name: 'Notes',
    kind: 'data', type: 'long_text', source: 'airtable', config: {},
  },
  // ── returns ────────────────────────────────────────────────────────────────
  // « N° de retour » : même forme d'adoption que orders.order_number — une
  // FORMULE Airtable (« # de retour ») tirée par le field_map cœur du miroir
  // `retours`, donc en import seul. La colonne native return_number a été
  // droppée au profit de n_de_retour par la migration
  // 026-convert-returns-return-number ; cette entrée n'est ici que pour
  // reconstruire la ligne custom_fields si elle venait à manquer.
  {
    table: 'returns', column: 'n_de_retour', name: 'N° de retour',
    kind: 'data', type: 'text', source: 'airtable', config: {},
  },
  // « Contact » : même histoire (champ lié Airtable tiré par le field_map cœur,
  // donc import seul), colonne native contact_id droppée au profit de `contact`
  // par la migration 027-convert-returns-contact. Filet de reconstruction, là
  // encore. La colonne porte une FK vers `contacts` : c'est elle qui fait le
  // rendu en pastille cliquable (recordLinkTargetOf), pas une option de champ.
  {
    table: 'returns', column: 'contact', name: 'Contact',
    kind: 'data', type: 'text', source: 'airtable', config: {},
  },
  // « Entreprise » : même conversion que orders.company_name — la colonne n'a
  // jamais existé en SQL, elle était fabriquée par un `LEFT JOIN companies` que
  // chaque route recopiait. Elle devient un LOOKUP sur `returns.company_id`
  // (le FK, lui, reste : c'est la donnée, alimentée par la clé cœur `company`
  // du miroir `retours`). Conséquence voulue : le champ est renommable,
  // convertible et supprimable depuis /champs/retours, et sa suppression le
  // retire vraiment partout (la colonne quitte la vue `returns_v`, donc le
  // snapshot client et les réponses des routes).
  {
    table: 'returns', column: 'company_name', name: 'Entreprise',
    kind: 'lookup', type: 'text', source: 'native',
    config: { lookup_fk: 'company_id', lookup_target_table: 'companies', lookup_target_column: 'name', result_type: 'text' },
  },
]

const CONFIG_COLUMNS = [
  'formula_expr', 'result_type', 'lookup_fk', 'lookup_target_table',
  'lookup_target_column', 'rollup_target_table', 'rollup_target_fk',
  'rollup_target_column', 'rollup_agg',
]

export function seedNativeFieldConversions() {
  let created = 0
  let upgraded = 0
  for (const c of CONVERSIONS) {
    const existing = db.prepare(
      `SELECT id, kind, name, source FROM custom_fields WHERE erp_table=? AND column_name=?`
    ).get(c.table, c.column)

    if (existing && existing.kind !== 'native') {
      // Déjà converti (ou reconverti/supprimé par l'utilisateur) — on n'y touche
      // pas, SAUF un nom vide (hérité d'une personnalisation native sans
      // renommage) : sans nom, le champ est inutilisable dans l'UI.
      if (!String(existing.name || '').trim()) {
        db.prepare(`UPDATE custom_fields SET name=? WHERE id=?`).run(c.name, existing.id)
      }
      // La PROVENANCE, elle, se réaligne : elle n'est pas un choix de
      // l'utilisateur mais un fait (la colonne vient d'Airtable ou non), et
      // c'est elle qui pilote la règle d'éditabilité. Une ligne convertie avant
      // que l'entrée déclare `source` gardait sinon l'ancienne valeur.
      // `deleted_at` n'est jamais touché : un champ supprimé le reste.
      if (c.source != null && existing.source !== c.source) {
        db.prepare(`UPDATE custom_fields SET source=? WHERE id=?`).run(c.source, existing.id)
      }
      continue
    }

    const cfg = Object.fromEntries(CONFIG_COLUMNS.map(k => [k, c.config[k] ?? null]))
    if (existing) {
      // Personnalisation native existante : on la promeut en champ calculé en
      // gardant le nom/visibilité/ordre choisis par l'utilisateur (nom vide =
      // jamais renommé → libellé natif).
      // `source` n'est repris que si l'entrée en déclare une : une colonne
      // adoptée depuis Airtable doit porter source='airtable' (c'est ce qui
      // pilote la règle d'éditabilité), mais les conversions qui n'en déclarent
      // pas gardent la leur au lieu d'être remises à NULL.
      const setSource = c.source != null ? ', source=?' : ''
      db.prepare(
        `UPDATE custom_fields SET name=?, kind=?, type=?${setSource}, ${CONFIG_COLUMNS.map(k => `${k}=?`).join(', ')} WHERE id=?`
      ).run(String(existing.name || '').trim() || c.name, c.kind, c.type,
        ...(c.source != null ? [c.source] : []),
        ...CONFIG_COLUMNS.map(k => cfg[k]), existing.id)
      upgraded++
    } else {
      // `source` retombe sur 'native' et jamais sur null : la colonne est NOT
      // NULL en base, et un INSERT à null arrêterait le démarrage du serveur.
      db.prepare(
        `INSERT INTO custom_fields (id, erp_table, name, column_name, type, kind, sort_order, source,
           ${CONFIG_COLUMNS.join(', ')})
         VALUES (?,?,?,?,?,?,NULL,?,${CONFIG_COLUMNS.map(() => '?').join(',')})`
      ).run(newRecordId(), c.table, c.name, c.column, c.type, c.kind, c.source ?? 'native', ...CONFIG_COLUMNS.map(k => cfg[k]))
      created++
    }
  }
  if (created || upgraded) {
    console.log(`🔁 Conversions de champs natifs : ${created} créé(s), ${upgraded} upgradé(s)`)
  }
  return { created, upgraded }
}
