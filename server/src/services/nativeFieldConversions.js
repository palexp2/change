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
  // `tasks.ticket_title` retiré : c'était un lookup sur `tickets.title`, droppée
  // (migration 040). Le re-semer ferait joindre `tasks_v` sur une colonne absente.

  // ── tickets ────────────────────────────────────────────────────────────────
  // survey_rating : au plus un sondage par billet (index unique) → MAX équivaut
  // au JOIN historique. Les autres colonnes survey_* restent en route.
  // `company_name` retiré : lookup sur la FK `company_id`, droppée (040).
  // « Assigné à » n'est plus un lookup sur `assigned_to` : cette FK a été
  // droppée (migration 048, un seul « Assigné à » par billet). C'est une vraie
  // colonne texte, alimentée par le champ Airtable « Responsable » — d'où
  // l'adoption en kind='data'. Pas de `source` déclarée : la ligne existante
  // garde la sienne (le mapping, lui, décide de l'éditabilité).
  {
    table: 'tickets', column: 'assigned_name', name: 'Assigné à',
    kind: 'data', type: 'text', config: {},
  },
  {
    table: 'tickets', column: 'survey_rating', name: 'Satisfaction',
    kind: 'rollup', type: 'number',
    config: { rollup_target_table: 'ticket_surveys', rollup_target_fk: 'ticket_id', rollup_target_column: 'rating', rollup_agg: 'MAX', result_type: 'number' },
  },

  // ── purchases ──────────────────────────────────────────────────────────────
  // Plus aucune conversion : « Produit » et « SKU » étaient deux lookups sur la
  // FK `purchases.product_id`, droppée sur demande (migration 035). Les re-semer
  // ferait construire un `purchases_v` qui joint sur une colonne absente.

  // ── products ───────────────────────────────────────────────────────────────
  // « Repartir à neuf » sur les produits : plus AUCUN champ codé en dur dans
  // /champs/products. Les 12 colonnes déclarées dans tableDefs.js et les 7 que
  // seul le mapping cœur connaissait deviennent de vrais champs — renommables,
  // convertibles, supprimables, et mappables sur n'importe quel champ Airtable
  // depuis la page (cf. retirePiecesCoreFieldMap). Aucun ALTER : les colonnes
  // SQL existent déjà et portent la donnée ; l'entrée tableDefs survit pour le
  // RENDU (vignette d'image, largeur, visibilité par défaut).
  //
  // Les types collent à ceux que la page rend déjà : un type différent ferait
  // basculer la colonne sur le rendu générique des personnalisations.
  {
    table: 'products', column: 'image_url', name: 'Image',
    kind: 'data', type: 'text', source: 'airtable', config: {},
  },
  {
    table: 'products', column: 'name_fr', name: 'Nom',
    kind: 'data', type: 'text', source: 'airtable', config: {},
  },
  {
    table: 'products', column: 'name_en', name: 'Nom (EN)',
    kind: 'data', type: 'text', source: 'airtable', config: {},
  },
  {
    table: 'products', column: 'sku', name: 'SKU',
    kind: 'data', type: 'text', source: 'airtable', config: {},
  },
  // « Type » est une Sélection côté Airtable, mais la colonne ERP est du TEXTE
  // et la page la rend comme telle : on garde 'text' (le picker de mapping
  // accepte une Sélection sur une colonne texte, cf. TYPE_COMPAT).
  {
    table: 'products', column: 'type', name: 'Type',
    kind: 'data', type: 'text', source: 'airtable', config: {},
  },
  // Devise : c'est déjà le type d'affichage choisi par l'utilisateur sur cette
  // colonne (personnalisation native antérieure) — l'adoption le conserve.
  {
    table: 'products', column: 'unit_cost', name: 'Coût unitaire',
    kind: 'data', type: 'currency', source: 'airtable', config: {},
  },
  {
    table: 'products', column: 'price_cad', name: 'Prix (CAD)',
    kind: 'data', type: 'number', source: 'airtable', config: {},
  },
  {
    table: 'products', column: 'stock_qty', name: 'Quantité en inventaire',
    kind: 'data', type: 'number', source: 'airtable', config: {},
  },
  {
    table: 'products', column: 'min_stock', name: 'Stock minimum',
    kind: 'data', type: 'number', source: 'airtable', config: {},
  },
  // « Qté à cmd » (≠ « Quantité à commander », le champ Airtable homonyme) : un
  // libellé identique ferait deux champs indiscernables dans la même table.
  {
    table: 'products', column: 'order_qty', name: 'Qté à cmd',
    kind: 'data', type: 'number', source: 'airtable', config: {},
  },
  {
    table: 'products', column: 'supplier', name: 'Fournisseur',
    kind: 'data', type: 'text', source: 'airtable', config: {},
  },
  // Drapeau propre à l'ERP : aucun champ Airtable ne l'alimente.
  {
    table: 'products', column: 'is_sellable', name: 'Vendable',
    kind: 'data', type: 'checkbox', source: 'native', config: {},
  },
  // Colonnes que seul le mapping cœur connaissait — elles n'ont jamais eu de
  // ligne dans le tableau des produits. Les cinq dernières alimentent la page
  // « Priorité d'assemblage » ; leur libellé le dit, parce qu'un champ Airtable
  // jumeau (même valeur, autre colonne) porte déjà le nom court.
  {
    table: 'products', column: 'procurement_type', name: 'Approvisionnement',
    kind: 'data', type: 'text', source: 'airtable', config: {},
  },
  {
    table: 'products', column: 'weight_lbs', name: 'Poids (lbs)',
    kind: 'data', type: 'number', source: 'airtable', config: {},
  },
  {
    table: 'products', column: 'assembly_status', name: "Statut d'assemblage (priorité)",
    kind: 'data', type: 'number', source: 'airtable', config: {},
  },
  {
    table: 'products', column: 'finished_min_stock', name: 'Seuil min. produits finis (priorité)',
    kind: 'data', type: 'number', source: 'airtable', config: {},
  },
  {
    table: 'products', column: 'projected_available_qty', name: 'Qté disponible projetée',
    kind: 'data', type: 'number', source: 'airtable', config: {},
  },
  {
    table: 'products', column: 'producible_qty', name: 'Nb de produits possibles',
    kind: 'data', type: 'number', source: 'airtable', config: {},
  },
  {
    table: 'products', column: 'supplier_link', name: 'Lien fournisseur (achat)',
    kind: 'data', type: 'text', source: 'airtable', config: {},
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
  // « Convertis tous les champs natifs de cette table en champs personnalisés »
  // (/champs/serial_numbers). Les 7 colonnes scalaires du field_map cœur retiré
  // (cf. retireSerialsCoreFieldMap) plus `permissions`, la seule que l'ERP
  // possède en propre. Elles étaient codées en dur (tableDefs.js pour cinq
  // d'entre elles, la seule fiche pour les autres) : ni renommables, ni
  // re-typables, ni convertibles en formule/lookup/rollup, ni supprimables, et
  // leur type restait inconnu du picker de mapping Airtable.
  //
  // Adoption en kind='data' : aucun ALTER, aucune vue — les colonnes SQL
  // existent et portent la donnée (5 442 numéros de série). `source='airtable'`
  // pour les 7 clés du plan cœur : c'est un fait (elles s'importent d'Airtable),
  // et c'est ce qui les tient hors de la carte « champs personnalisés » de la
  // fiche, qui les affiche déjà.
  //
  // Les 3 FK (`product_id`, `company_id`, `order_item_id`) ne sont PAS adoptées
  // — même choix que sur les contacts, les projets et les articles de retour :
  // une ligne custom_fields active devient une colonne du tableau
  // (DataTable.autoCfCols) remplie d'ids bruts. Les deux premières sont pilotées
  // par la ligne du libellé joint (`mappingColumn` dans tableDefs.js :
  // « Produit », « Entreprise ») ; « Item de commande » prend sa propre ligne de
  // mapping dans /champs/serial_numbers.
  //
  // « # de série » est une FORMULE côté Airtable : Airtable la calcule, Boréal
  // la recopie — le champ reste donc en import seul.
  {
    table: 'serial_numbers', column: 'serial', name: 'Numéro de série',
    kind: 'data', type: 'text', source: 'airtable', config: {},
  },
  {
    table: 'serial_numbers', column: 'status', name: 'Statut',
    kind: 'data', type: 'single_select', source: 'airtable', config: {},
    options: {
      choices: ['Opérationnel - Vendu', 'Opérationnel - Loué', 'Disponible - Vente',
        'Disponible - Location', 'Non construit', 'À reconditionner', 'À analyser',
        'En retour', 'Détruit', "Utilisé par l'équipe Orisha", 'Inconnu'],
    },
  },
  // « Adresse » n'est pas une adresse postale mais l'adresse NUMÉRIQUE de
  // l'appareil sur son bus (144, 674…) — le champ Airtable est un Nombre. Un
  // type texte ici rendrait le champ impossible à re-mapper (TYPE_COMPAT refuse
  // un Nombre sur une colonne texte) ; la colonne du tableau garde son rendu
  // monospace, qui vient de tableDefs.js.
  {
    table: 'serial_numbers', column: 'address', name: 'Adresse',
    kind: 'data', type: 'number', source: 'airtable', config: {},
  },
  {
    table: 'serial_numbers', column: 'manufacture_date', name: 'Date de fabrication',
    kind: 'data', type: 'date', source: 'airtable', config: {},
  },
  {
    table: 'serial_numbers', column: 'last_programmed_date', name: 'Dernière programmation',
    kind: 'data', type: 'date', source: 'airtable', config: {},
  },
  // Devise : c'est ainsi que la fiche l'affiche déjà (fmtCad), et le champ
  // Airtable est un montant.
  {
    table: 'serial_numbers', column: 'manufacture_value', name: 'Valeur de fabrication',
    kind: 'data', type: 'currency', source: 'airtable', config: {},
  },
  {
    table: 'serial_numbers', column: 'notes', name: 'Notes',
    kind: 'data', type: 'long_text', source: 'airtable', config: {},
  },
  // Permissions du contrôleur central : un blob JSON déposé par l'import
  // /api/admin/import-cc-permissions, jamais par Airtable — d'où source='native'.
  // Son rendu (la grille de permissions) vient de tableDefs.js et de la fiche.
  {
    table: 'serial_numbers', column: 'permissions', name: 'Permissions',
    kind: 'data', type: 'long_text', source: 'native', config: {},
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
  // ── assemblages ────────────────────────────────────────────────────────────
  // Colonnes du field_map « cœur » retiré (cf. retireAssemblagesCoreFieldMap) :
  // adoptées en kind='data' pour que leur TYPE soit connu du mapping (sans quoi
  // le picker de /champs/assemblages les prendrait pour du texte et refuserait
  // les champs Airtable « Quantités fabriqués » / « Date ») et qu'elles
  // deviennent renommables, convertibles et supprimables. Aucun ALTER : les
  // colonnes SQL existent déjà et portent la donnée. La FK `product_id` n'est
  // PAS adoptée — elle n'est pas une colonne du tableau, une ligne custom_fields
  // en ferait apparaître une, remplie d'identifiants bruts ; son mapping est
  // piloté par la ligne « Produit » (cf. `mappingColumn` dans tableDefs.js).
  {
    table: 'assemblages', column: 'qty_produced', name: 'Qté produite',
    kind: 'data', type: 'number', source: 'airtable', config: {},
  },
  {
    table: 'assemblages', column: 'assembled_at', name: 'Date assemblage',
    kind: 'data', type: 'date', source: 'airtable', config: {},
  },

  // ── paies ──────────────────────────────────────────────────────────────────
  // Table entièrement convertie (demande depuis /champs/paies) : plus AUCUN
  // champ codé en dur. Deux familles.
  //
  // 1. Les colonnes du field_map « cœur » retiré (cf. retirePaiesCoreFieldMap),
  //    adoptées en kind='data' : leur TYPE devient connu du mapping (sans quoi
  //    TYPE_COMPAT refuserait le champ Airtable — « Statut des feuilles de
  //    temps » est une Sélection, les « Inclut … » des cases à cocher) et elles
  //    deviennent renommables / convertibles / supprimables. Aucun ALTER : les
  //    colonnes SQL existent déjà et portent la donnée.
  //    `csv` et `period_start` ne sont PAS adoptées : elles n'ont jamais été des
  //    colonnes du tableau (un blob CSV, une date interne), et leur champ
  //    Airtable a été retiré de /champs/paies (migration 051) — `csv` a même
  //    été droppée, `period_start` reste alimentée en interne seulement.
  { table: 'paies', column: 'number', name: '#', kind: 'data', type: 'number', source: 'airtable', config: {} },
  { table: 'paies', column: 'period_end', name: 'Fin de période', kind: 'data', type: 'date', source: 'airtable', config: {} },
  { table: 'paies', column: 'status', name: 'Statut', kind: 'data', type: 'single_select', source: 'airtable', config: {} },
  // Texte et non date : la valeur Airtable est recopiée telle quelle et la page
  // l'affiche brute (ce n'est pas toujours une date ISO).
  { table: 'paies', column: 'timesheets_deadline', name: 'Limite correction', kind: 'data', type: 'text', source: 'airtable', config: {} },
  { table: 'paies', column: 'nb_holiday_days', name: 'Congés fériés', kind: 'data', type: 'number', source: 'airtable', config: {} },
  { table: 'paies', column: 'total_with_charges_and_reimb', name: 'Total paie', kind: 'data', type: 'number', source: 'airtable', config: {} },
  { table: 'paies', column: 'timesheets_sent', name: 'FdT envoyées', kind: 'data', type: 'checkbox', source: 'airtable', config: {} },
  { table: 'paies', column: 'includes_hourly', name: 'Inclut horaires', kind: 'data', type: 'checkbox', source: 'airtable', config: {} },
  { table: 'paies', column: 'includes_mileage', name: 'Inclut kilométrage', kind: 'data', type: 'checkbox', source: 'airtable', config: {} },
  { table: 'paies', column: 'includes_expense_reimb', name: 'Inclut remb. dép.', kind: 'data', type: 'checkbox', source: 'airtable', config: {} },
  { table: 'paies', column: 'includes_paid_leave', name: 'Inclut congés', kind: 'data', type: 'checkbox', source: 'airtable', config: {} },
  { table: 'paies', column: 'includes_holiday_hours', name: 'Inclut fériés', kind: 'data', type: 'checkbox', source: 'airtable', config: {} },
  { table: 'paies', column: 'includes_sales_commissions', name: 'Inclut commissions', kind: 'data', type: 'checkbox', source: 'airtable', config: {} },
  //
  // 2. Les trois agrégats des lignes de paie, jusqu'ici des sous-requêtes
  //    recopiées dans routes/paies.js : de vrais rollups, donc lisibles dans la
  //    vue `paies_v`. « $ heures rég. » agrège `paie_items.regular_amount`, la
  //    colonne générée posée par la migration 038 (un rollup n'agrège qu'UNE
  //    colonne, pas un produit heures × taux).
  //    Ces rollups comptent TOUTES les lignes de la paie : routes/paies.js
  //    ramène la part de l'employé pour un non-RH.
  {
    table: 'paies', column: 'items_count', name: '# items',
    kind: 'rollup', type: 'number',
    config: { rollup_target_table: 'paie_items', rollup_target_fk: 'paie_id', rollup_target_column: null, rollup_agg: 'COUNT', result_type: 'number' },
  },
  {
    table: 'paies', column: 'total_regular_hours', name: 'Heures rég.',
    kind: 'rollup', type: 'number',
    config: { rollup_target_table: 'paie_items', rollup_target_fk: 'paie_id', rollup_target_column: 'regular_hours', rollup_agg: 'SUM', result_type: 'number' },
  },
  {
    table: 'paies', column: 'total_regular_amount', name: '$ heures rég.',
    kind: 'rollup', type: 'number',
    config: { rollup_target_table: 'paie_items', rollup_target_fk: 'paie_id', rollup_target_column: 'regular_amount', rollup_agg: 'SUM', result_type: 'number' },
  },

  // ── returns ────────────────────────────────────────────────────────────────
  // Plus aucune conversion : « N° de retour » (n_de_retour), « Contact »
  // (contact) et « Entreprise » (lookup company_name sur la FK company_id) ont
  // été DÉTRUITS par la migration 037 — leurs colonnes n'existent plus. Les
  // re-semer ici recréerait des champs sans colonne, et le lookup ferait tomber
  // la vue `returns_v` sur une FK disparue.

  // ── contacts ───────────────────────────────────────────────────────────────
  // Les 6 champs qui étaient « gérés en code » sur /champs/contacts (Prénom,
  // Nom, Email, Phone number, Entreprise, Langue — les clés du field_map cœur
  // du CRM, cf. retireContactsCoreFieldMap). Adoption en kind='data' : rien à
  // créer ni à droper, les colonnes existent et portent la donnée ; ce qu'elles
  // gagnent est d'être renommables, re-typables, convertibles et supprimables,
  // et d'avoir un TYPE connu du picker de mapping Airtable (sans quoi
  // TYPE_COMPAT refuse un champ e-mail, téléphone ou liste de choix).
  //
  // `source='airtable'` : c'est un fait — ces colonnes s'importent d'Airtable
  // (CONTACTS_FIELD_MAP_PLAN) ; c'est aussi ce qui les tient hors de la carte
  // « champs personnalisés » de la fiche contact, qui les affiche déjà en haut
  // (useExtraCustomFields écarte les colonnes de sync).
  //
  // `company_id` n'est PAS adoptée : une ligne custom_fields active devient une
  // colonne du tableau (DataTable.autoCfCols) et afficherait des ids bruts, et
  // le sens 'pull' d'un champ importé la rendrait non éditable — le picker
  // d'entreprise de la fiche casserait. C'est la ligne « Entreprise »
  // (`company_name`, colonne jointe) qui porte son mapping, via
  // `mappingColumn: 'company_id'` dans tableDefs.js.
  { table: 'contacts', column: 'first_name', name: 'Prénom', kind: 'data', type: 'text', source: 'airtable', config: {} },
  { table: 'contacts', column: 'last_name', name: 'Nom', kind: 'data', type: 'text', source: 'airtable', config: {} },
  { table: 'contacts', column: 'email', name: 'Courriel', kind: 'data', type: 'text', source: 'airtable', config: {}, options: { format: 'email' } },
  { table: 'contacts', column: 'phone', name: 'Téléphone', kind: 'data', type: 'phone', source: 'airtable', config: {} },
  {
    table: 'contacts', column: 'language', name: 'Langue',
    kind: 'data', type: 'single_select', source: 'airtable', config: {},
    options: { choices: ['French', 'English'] },
  },

  // ── projects ───────────────────────────────────────────────────────────────
  // Le champ « ID » d'Airtable (le numéro de projet, PRJ-1637) : dernière
  // colonne du field_map cœur retiré (cf. retireProjetsCoreFieldMap) à porter
  // une ligne du tableau des projets. Adoptée en kind='data' pour que son TYPE
  // soit connu du picker de mapping et qu'elle devienne renommable, convertible
  // et supprimable comme n'importe quel champ. Aucun ALTER : la colonne SQL
  // existe et porte la donnée.
  //
  // `company_id` n'est PAS adoptée (même choix que sur les contacts et les
  // commandes) : une ligne custom_fields active en ferait une colonne de tableau
  // remplie d'identifiants bruts, et le sens 'pull' d'un champ importé la rendrait
  // non éditable — le picker d'entreprise de la fiche projet casserait. C'est la
  // ligne « Entreprise » (`company_name`) qui porte son mapping, via
  // `mappingColumn: 'company_id'` dans tableDefs.js.
  //
  // « ID » est une FORMULE côté Airtable : la valeur est calculée là-bas et
  // recopiée ici, donc le champ est en import seul — le numéro de projet devient
  // non modifiable dans Boréal (il l'était déjà en pratique : toute retouche
  // était réécrite au sync suivant).
  {
    table: 'projects', column: 'name', name: 'Projet',
    kind: 'data', type: 'text', source: 'airtable', config: {},
  },

  // ── return_items ───────────────────────────────────────────────────────────
  // Les 8 clés SCALAIRES du field_map cœur retiré (cf.
  // retireRetourItemsCoreFieldMap) : adoptées en kind='data' pour que leur TYPE
  // soit connu du picker de mapping (sans quoi TYPE_COMPAT refuserait les
  // champs Airtable — « Raison du retour », « Catégorie de problème », les deux
  // « par qui » et « Doit-on remplacer ou réparer » sont des Sélections, « Date
  // de réception » une date) et qu'elles deviennent renommables, convertibles
  // et supprimables. Aucun ALTER : les colonnes SQL existent et portent la
  // donnée (jusqu'à 767 lignes remplies sur 767).
  //
  // Les libellés reprennent EXACTEMENT ceux de tableDefs.js : le nom du champ
  // devient l'en-tête de colonne (DataTable.relabeled), un libellé différent
  // aurait renommé les colonnes du tableau d'articles de la fiche retour.
  //
  // Les 4 FK (`return_id`, `serial_id`, `company_id`, `product_id`) ne sont PAS
  // adoptées — même choix que sur les contacts, les projets et les assemblages :
  // une ligne custom_fields active devient une colonne du tableau
  // (DataTable.autoCfCols) remplie d'ids bruts. Deux d'entre elles sont pilotées
  // par la ligne du libellé joint (`mappingColumn` dans tableDefs.js :
  // « N° de série », « Produit à recevoir ») ; « Retour » et « Entreprise »
  // n'ont pas de colonne affichée et prennent leur propre ligne de mapping dans
  // /champs/return_items. La 5ᵉ, `product_send_id` (« Produit à envoyer »), a
  // été droppée par la migration 046.
  {
    table: 'return_items', column: 'return_reason', name: 'Raison',
    kind: 'data', type: 'single_select', source: 'airtable', config: {},
    options: {
      choices: ['Retour de garantie avec échange immédiat', 'Retour de garantie avec échange différé',
        "Fin d'abonnement", "Le client à changé d'idée", 'Erreur de commande',
        "Retour d'équipement de courtoisie", 'Réparation - DEPRECATED'],
    },
  },
  {
    table: 'return_items', column: 'return_reason_notes', name: 'Précisions',
    kind: 'data', type: 'long_text', source: 'airtable', config: {},
  },
  {
    table: 'return_items', column: 'problem_category', name: 'Catégorie de problème',
    kind: 'data', type: 'single_select', source: 'airtable', config: {},
    options: {
      choices: ['Composante défectueuse', 'Usure prématurée', 'Mort naturelle', 'Brisé par le client',
        'Bogue software', 'Bogue hardware', 'Bogue firmware', 'Mauvais firmware',
        'Faux-positif de support', 'Analyse inconcluante', 'Erreur de commande', "Erreur d'envoi",
        'Produit perdu', 'Fin de contrat', 'Courtoisie', 'Cataclysme'],
    },
  },
  {
    table: 'return_items', column: 'action', name: 'Action',
    kind: 'data', type: 'single_select', source: 'airtable', config: {},
    options: { choices: ['Remplacer', 'Réparer', "Ni l'un ni l'autre"] },
  },
  {
    table: 'return_items', column: 'received_at', name: 'Reçu le',
    kind: 'data', type: 'date', source: 'airtable', config: {},
  },
  {
    table: 'return_items', column: 'received_by', name: 'Reçu par',
    kind: 'data', type: 'single_select', source: 'airtable', config: {},
    options: { choices: ['Martin', 'PA', 'Marc-Antoine', 'Frédéric', 'Alicia', 'Charles'] },
  },
  {
    table: 'return_items', column: 'analysis_notes', name: "Notes d'analyse",
    kind: 'data', type: 'long_text', source: 'airtable', config: {},
  },
  {
    table: 'return_items', column: 'analyzed_by', name: 'Analysé par',
    kind: 'data', type: 'single_select', source: 'airtable', config: {},
    options: { choices: ['Charles', 'Alicia', 'Marc-Antoine', 'Martin', 'PA', 'Fred', 'Legacy'] },
  },

  // ── employees ──────────────────────────────────────────────────────────────
  // « Convertis TOUS les champs de cette table en champs personnalisés »
  // (/champs/employees). La table n'avait qu'UN champ (« Photo ») : ses 28
  // autres colonnes étaient codées en dur dans tableDefs.js, donc ni
  // renommables, ni re-typables, ni convertibles en formule/lookup/rollup, ni
  // supprimables, et leur type restait inconnu du picker de mapping Airtable.
  //
  // Adoption en kind='data' : rien à créer ni à droper, les colonnes existent
  // toutes et portent la donnée. `source='airtable'` pour les 27 clés du plan
  // cœur du miroir `employees` — c'est un fait (elles s'importent d'Airtable,
  // cf. EMPLOYEES_FIELD_MAP_PLAN), et c'est aussi ce qui les tient hors de la
  // carte « champs personnalisés » de la fiche employé, qui les affiche déjà.
  { table: 'employees', column: 'first_name', name: 'Prénom', kind: 'data', type: 'text', source: 'airtable', config: {} },
  { table: 'employees', column: 'last_name', name: 'Nom', kind: 'data', type: 'text', source: 'airtable', config: {} },
  { table: 'employees', column: 'active', name: 'Actif', kind: 'data', type: 'checkbox', source: 'airtable', config: {} },
  {
    table: 'employees', column: 'accounting_department', name: 'Département',
    kind: 'data', type: 'single_select', source: 'airtable', config: {},
    options: { choices: ['R&D', 'Opérations', 'Marketing'] },
  },
  { table: 'employees', column: 'matricule', name: 'Matricule', kind: 'data', type: 'text', source: 'airtable', config: {} },
  { table: 'employees', column: 'email_work', name: 'Courriel travail', kind: 'data', type: 'text', source: 'airtable', config: {} },
  { table: 'employees', column: 'email_personal', name: 'Courriel perso', kind: 'data', type: 'text', source: 'airtable', config: {} },
  { table: 'employees', column: 'phone_work', name: 'Téléphone travail', kind: 'data', type: 'phone', source: 'airtable', config: {} },
  { table: 'employees', column: 'phone_personal', name: 'Téléphone perso', kind: 'data', type: 'phone', source: 'airtable', config: {} },
  { table: 'employees', column: 'hire_date', name: "Date d'embauche", kind: 'data', type: 'date', source: 'airtable', config: {} },
  { table: 'employees', column: 'end_date', name: 'Date de fin', kind: 'data', type: 'date', source: 'airtable', config: {} },
  { table: 'employees', column: 'birth_date', name: 'Date de naissance', kind: 'data', type: 'date', source: 'airtable', config: {} },
  {
    table: 'employees', column: 'gender', name: 'Genre',
    kind: 'data', type: 'single_select', source: 'airtable', config: {},
    options: { choices: ['Homme', 'Femme', 'Autre'] },
  },
  { table: 'employees', column: 'hours_per_week', name: 'Heures/sem', kind: 'data', type: 'number', source: 'airtable', config: {} },
  { table: 'employees', column: 'last_raise_date', name: 'Dernière augm.', kind: 'data', type: 'date', source: 'airtable', config: {} },
  { table: 'employees', column: 'is_salesperson', name: 'Vendeur', kind: 'data', type: 'checkbox', source: 'airtable', config: {} },
  { table: 'employees', column: 'is_consultant', name: 'Consultant', kind: 'data', type: 'checkbox', source: 'airtable', config: {} },
  { table: 'employees', column: 'group_insurance', name: 'Assurance coll.', kind: 'data', type: 'checkbox', source: 'airtable', config: {} },
  { table: 'employees', column: 'office_key', name: 'Clef bureau', kind: 'data', type: 'checkbox', source: 'airtable', config: {} },
  { table: 'employees', column: 'address', name: 'Adresse', kind: 'data', type: 'long_text', source: 'airtable', config: {} },
  { table: 'employees', column: 'address_verified', name: 'Adresse validée', kind: 'data', type: 'checkbox', source: 'airtable', config: {} },
  { table: 'employees', column: 'emergency_contact', name: "Contact d'urgence", kind: 'data', type: 'long_text', source: 'airtable', config: {} },
  { table: 'employees', column: 'nethris_username', name: 'Nethris username', kind: 'data', type: 'text', source: 'airtable', config: {} },
  { table: 'employees', column: 'insurance_id', name: 'ID Assurances', kind: 'data', type: 'text', source: 'airtable', config: {} },
  { table: 'employees', column: 'banking_info', name: 'Coord. bancaires', kind: 'data', type: 'text', source: 'airtable', config: {} },
  { table: 'employees', column: 'peer_reviews', name: 'Éval. par pairs', kind: 'data', type: 'long_text', source: 'airtable', config: {} },
  { table: 'employees', column: 'issues', name: 'Problèmes', kind: 'data', type: 'long_text', source: 'airtable', config: {} },
  // Colonne d'employé que l'ERP possède : le droit annuel de vacances,
  // saisi dans le bloc « Vacances » de la fiche. Hors plan cœur du miroir,
  // d'où source='native'.
  { table: 'employees', column: 'vacation_days_per_year', name: 'Vacances (j/an)', kind: 'data', type: 'number', source: 'native', config: {} },
  // Taux de commission habituel (en pourcents), propre à l'ERP lui aussi :
  // pré-rempli dans « Ajouter une commission » de la fiche projet.
  { table: 'employees', column: 'commission_rate', name: 'Commission (%)', kind: 'data', type: 'number', source: 'native', config: {} },
  // Pourcentage de vacances accumulé à chaque paie, saisi dans le bloc
  // « Vacances » de la fiche.
  { table: 'employees', column: 'vacation_pct', name: 'Vacances (%)', kind: 'data', type: 'number', source: 'native', config: {} },
  // Point de référence de la banque de vacances (date + montant), saisi lui
  // aussi dans le bloc « Vacances ».
  { table: 'employees', column: 'vacation_ref_date', name: 'Banque vacances — date réf.', kind: 'data', type: 'date', source: 'native', config: {} },
  { table: 'employees', column: 'vacation_ref_balance', name: 'Banque vacances — montant réf.', kind: 'data', type: 'currency', source: 'native', config: {} },
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
    // Choix d'une sélection (`options.choices`) : posés à la CRÉATION seulement.
    // Ce sont des valeurs de départ — l'utilisateur peut ensuite en ajouter, en
    // renommer ou en recolorer, et un semis qui les réécrirait à chaque
    // démarrage effacerait son travail.
    const opts = c.options ? JSON.stringify(c.options) : null
    if (existing) {
      // Personnalisation native existante : on la promeut en champ calculé en
      // gardant le nom/visibilité/ordre choisis par l'utilisateur (nom vide =
      // jamais renommé → libellé natif).
      // `source` n'est repris que si l'entrée en déclare une : une colonne
      // adoptée depuis Airtable doit porter source='airtable' (c'est ce qui
      // pilote la règle d'éditabilité), mais les conversions qui n'en déclarent
      // pas gardent la leur au lieu d'être remises à NULL.
      const setSource = c.source != null ? ', source=?' : ''
      // `options` : COALESCE — une personnalisation native pouvait déjà porter
      // ses propres choix (libellés / couleurs), ils font foi.
      const setOptions = opts ? ', options=COALESCE(options, ?)' : ''
      db.prepare(
        `UPDATE custom_fields SET name=?, kind=?, type=?${setSource}${setOptions}, ${CONFIG_COLUMNS.map(k => `${k}=?`).join(', ')} WHERE id=?`
      ).run(String(existing.name || '').trim() || c.name, c.kind, c.type,
        ...(c.source != null ? [c.source] : []),
        ...(opts ? [opts] : []),
        ...CONFIG_COLUMNS.map(k => cfg[k]), existing.id)
      upgraded++
    } else {
      // `source` retombe sur 'native' et jamais sur null : la colonne est NOT
      // NULL en base, et un INSERT à null arrêterait le démarrage du serveur.
      db.prepare(
        `INSERT INTO custom_fields (id, erp_table, name, column_name, type, kind, sort_order, source, options,
           ${CONFIG_COLUMNS.join(', ')})
         VALUES (?,?,?,?,?,?,NULL,?,?,${CONFIG_COLUMNS.map(() => '?').join(',')})`
      ).run(newRecordId(), c.table, c.name, c.column, c.type, c.kind, c.source ?? 'native', opts, ...CONFIG_COLUMNS.map(k => cfg[k]))
      created++
    }
  }
  if (created || upgraded) {
    console.log(`🔁 Conversions de champs natifs : ${created} créé(s), ${upgraded} upgradé(s)`)
  }
  return { created, upgraded }
}
