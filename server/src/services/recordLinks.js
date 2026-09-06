import db from '../db/database.js'

// Résolution d'une clé d'enregistrement vers une fiche ERP : libellé + URL.
//
// Boréal et Airtable sont deux miroirs de la même réalité, et chaque
// enregistrement porte donc DEUX identités : l'`id` ERP (UUID) et l'`airtable_id`
// (`recXXXXXXXXXXXXXX`). Un champ lien d'Airtable importé dans l'ERP contient
// l'une ou l'autre selon la façon dont il a été mappé :
//
//  - mapping avec table cible (`link_target_table`) → la sync a déjà traduit les
//    record IDs en ids ERP (cf. convertValue, airtableAutoSync.js) ;
//  - mapping sans table cible → la colonne garde les `recXXXX` bruts.
//
// Ce service accepte les deux formes et renvoie la même chose : la table ERP où
// vit l'enregistrement, son libellé lisible et l'URL de sa fiche. C'est ce qui
// permet d'afficher un vrai lien cliquable pour n'importe quel champ lien
// Airtable, sans reconfigurer les mappings ni réécrire les valeurs stockées.
//
// Un `recXXXX` dont la table Airtable n'est pas miroitée dans l'ERP (Boîtes,
// Mois, Change log…) ne résout rien : l'appelant l'affiche alors en pastille
// inerte plutôt qu'en lien mort.

// Forme d'un record ID Airtable — 'rec' + 14 caractères alphanumériques.
const REC_ID = /^rec[A-Za-z0-9]{14}$/

// Une entrée par table ERP miroir d'une table Airtable (cf.
// buildAirtableTableToErp, routes/connectors.js), plus `users` (cible possible
// d'un champ lien « responsable »).
//
//  - `label` / `sub` : expressions SQL, `t` = la table, alias des jointures
//    déclarés dans `joins`. `sub` est facultatif (contexte affiché en second).
//  - `path`  : préfixe d'URL de la fiche détail, `null` si la table n'a pas de
//    fiche propre (lignes de commande, items de paie…) — le libellé s'affiche
//    alors sans lien.
//  - `airtable` : false pour les tables sans colonne `airtable_id` (users).
const SPECS = {
  companies: { label: 't.name', sub: 't.city', path: '/companies' },
  contacts: {
    label: "TRIM(COALESCE(t.first_name,'') || ' ' || COALESCE(t.last_name,''))",
    sub: 'co.name', joins: 'LEFT JOIN companies co ON co.id = t.company_id', path: '/contacts',
  },
  projects: {
    label: 't.name', sub: 'co.name',
    joins: 'LEFT JOIN companies co ON co.id = t.company_id', path: '/projects',
  },
  orders: {
    label: "'#' || COALESCE(t.order_number, '')", sub: 'co.name',
    joins: 'LEFT JOIN companies co ON co.id = t.company_id', path: '/orders',
  },
  order_items: {
    label: 'COALESCE(p.name_fr, p.name_en, p.sku)', sub: "'× ' || COALESCE(t.qty, 0)",
    joins: 'LEFT JOIN products p ON p.id = t.product_id', path: null,
  },
  products: { label: 'COALESCE(t.name_fr, t.name_en, t.sku)', sub: 't.sku', path: '/products' },
  purchases: {
    label: 'COALESCE(t.reference, p.name_fr, p.name_en, t.nom_de_la_piece)', sub: 't.supplier',
    joins: 'LEFT JOIN products p ON p.id = t.product_id', path: '/purchases',
  },
  tickets: { label: 't.title', sub: 't.status', path: '/tickets' },
  serial_numbers: {
    label: 't.serial', sub: 'COALESCE(p.name_fr, p.name_en)',
    joins: 'LEFT JOIN products p ON p.id = t.product_id', path: '/serials',
  },
  shipments: {
    label: "COALESCE('Envoi #' || o.order_number, 'Envoi')", sub: 'COALESCE(t.tracking_number, t.carrier)',
    joins: 'LEFT JOIN orders o ON o.id = t.order_id', path: '/envois',
  },
  returns: { label: "COALESCE(t.n_de_retour, 'Retour')", sub: 't.status', path: '/retours' },
  return_items: {
    label: 'COALESCE(p.name_fr, p.name_en, p.sku)', sub: "'× ' || COALESCE(t.qty, 0)",
    joins: 'LEFT JOIN products p ON p.id = t.product_id', path: null,
  },
  adresses: {
    // `line1` porte souvent l'adresse complète (ville et code postal compris) :
    // on ne la recompose pas, la ville va dans le contexte.
    label: "COALESCE(t.line1, t.adresse_ligne_1)",
    sub: "TRIM(COALESCE(t.city,'') || CASE WHEN t.postal_code IS NOT NULL AND t.postal_code != '' THEN ' ' || t.postal_code ELSE '' END)",
    path: '/adresses',
  },
  factures: { label: 't.document_number', sub: 't.status', path: '/factures' },
  soumissions: { label: 'COALESCE(t.quote_number, t.title)', sub: 't.status', path: '/soumissions' },
  assemblages: {
    label: 'COALESCE(p.name_fr, p.name_en, p.sku)', sub: "'× ' || COALESCE(t.qty_produced, 0)",
    joins: 'LEFT JOIN products p ON p.id = t.product_id', path: null,
  },
  serial_state_changes: {
    label: "COALESCE(s.serial, 'Changement d''état')", sub: 't.new_status',
    joins: 'LEFT JOIN serial_numbers s ON s.id = t.serial_id', path: null,
  },
  bom_items: {
    label: 'COALESCE(c.name_fr, c.name_en, c.sku)', sub: 't.ref_des',
    joins: 'LEFT JOIN products c ON c.id = t.component_id', path: null,
  },
  employees: {
    label: "TRIM(COALESCE(t.first_name,'') || ' ' || COALESCE(t.last_name,''))",
    sub: 't.matricule', path: '/employees',
  },
  paies: { label: "'Paie ' || COALESCE(t.number, '')", sub: 't.period_end', path: null },
  paie_items: {
    label: "TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,''))", sub: 't.start_date',
    joins: 'LEFT JOIN employees e ON e.id = t.employee_id', path: null,
  },
  subscriptions: {
    label: "COALESCE(co.name, 'Abonnement')", sub: 't.status',
    joins: 'LEFT JOIN companies co ON co.id = t.company_id', path: null,
  },
  instagram_prospects: { label: "'@' || COALESCE(t.ig_username, '')", sub: 't.follow_up_status', path: null },
  users: { label: 't.name', sub: 't.email', path: null, airtable: false },
}

export const RESOLVABLE_TABLES = Object.keys(SPECS)

// Tables qui ont une fiche à ouvrir (`path`) — les seules cibles proposées
// quand on choisit d'afficher un champ en « Lien vers … » : une table sans
// fiche ne produirait pas de lien, juste un libellé.
export const LINKABLE_TABLES = Object.keys(SPECS).filter(t => !!SPECS[t].path)

// Nombre max de clés résolues par appel — borne la taille de la requête SQL et
// de l'URL côté client (le client découpe par lots).
export const MAX_KEYS = 200

function rowsFor(table, spec, keys) {
  const byRec = spec.airtable !== false ? keys.filter(k => REC_ID.test(k)) : []
  const byId = keys.filter(k => !REC_ID.test(k))
  const clauses = []
  const params = []
  if (byId.length) {
    clauses.push(`t.id IN (${byId.map(() => '?').join(',')})`)
    params.push(...byId)
  }
  if (byRec.length) {
    clauses.push(`t.airtable_id IN (${byRec.map(() => '?').join(',')})`)
    params.push(...byRec)
  }
  if (!clauses.length) return []
  const sql = `
    SELECT t.id AS id,
           ${spec.airtable === false ? 'NULL' : 't.airtable_id'} AS airtable_id,
           ${spec.label} AS label,
           ${spec.sub || 'NULL'} AS sub
    FROM ${table} t
    ${spec.joins || ''}
    WHERE ${clauses.join(' OR ')}`
  try {
    return db.prepare(sql).all(...params)
  } catch {
    // Colonne disparue d'une table (schéma additif : ça ne devrait pas arriver,
    // mais une expression cassée ne doit pas faire tomber toute la résolution).
    return []
  }
}

// Même requête, mais sur le LIBELLÉ au lieu des identifiants. Toutes les
// colonnes ne portent pas un id : `projects.company_name` porte le NOM de
// l'entreprise (produit par une jointure au moment de la lecture). Les afficher
// en « Lien vers … » sans cette passe ne donnerait que des pastilles inertes.
function rowsForLabels(table, spec, labels) {
  const where = []
  const params = []
  if (hasDeletedAt(table)) where.push('t.deleted_at IS NULL')
  where.push(`LOWER(TRIM(${spec.label})) IN (${labels.map(() => '?').join(',')})`)
  params.push(...labels.map(l => l.toLowerCase()))
  const sql = `
    SELECT t.id AS id,
           ${spec.label} AS label,
           ${spec.sub || 'NULL'} AS sub
    FROM ${table} t
    ${spec.joins || ''}
    WHERE ${where.join(' AND ')}`
  try {
    return db.prepare(sql).all(...params)
  } catch {
    return []
  }
}

// Résout des clés (ids ERP et/ou record IDs Airtable, mélangés) vers
// { [clé demandée]: { table, id, label, sub, url } }.
//
// `hint` : table ERP à interroger en premier — celle du mapping du champ quand
// elle est connue. Sans indice (ou si l'indice ne trouve rien), on cherche dans
// les tables miroir : un record ID Airtable ne dit pas de quelle table il vient,
// c'est justement le miroir local qui le sait.
//
// `byLabel` : en dernier recours, les clés non résolues sont cherchées comme
// LIBELLÉS dans la table indiquée. Réservé aux champs qu'on a demandé à afficher
// en lien (cf. LINKABLE_TABLES) — les champs lien Airtable, eux, portent
// toujours un identifiant et n'ont rien à y gagner.
export function resolveRecordKeys(keys, { hint = null, byLabel = false } = {}) {
  const wanted = [...new Set((keys || []).map(k => String(k || '').trim()).filter(Boolean))].slice(0, MAX_KEYS)
  const out = {}
  if (!wanted.length) return out

  const order = []
  if (hint && SPECS[hint]) order.push(hint)
  // Un id ERP (UUID) n'est cherché que dans la table indiquée : les UUID ne sont
  // pas discriminants entre tables et un balayage complet coûterait cher pour
  // rien. Les record IDs Airtable, eux, se cherchent partout.
  const needBroad = wanted.some(k => REC_ID.test(k))
  if (needBroad) for (const t of RESOLVABLE_TABLES) if (t !== hint) order.push(t)

  let remaining = wanted
  for (const table of order) {
    if (!remaining.length) break
    const spec = SPECS[table]
    const rows = rowsFor(table, spec, remaining)
    if (!rows.length) continue
    const hit = new Set()
    for (const r of rows) {
      const label = (r.label || '').trim()
      const entry = {
        table,
        id: r.id,
        label: label || null,
        sub: (r.sub || '') || null,
        url: spec.path ? `${spec.path}/${r.id}` : null,
      }
      // La clé demandée peut être l'un ou l'autre des deux identifiants.
      for (const key of [r.id, r.airtable_id]) {
        if (key && remaining.includes(key)) { out[key] = entry; hit.add(key) }
      }
    }
    if (hit.size) remaining = remaining.filter(k => !hit.has(k))
  }

  if (byLabel && hint && SPECS[hint] && remaining.length) {
    const spec = SPECS[hint]
    const byLower = new Map()
    for (const r of rowsForLabels(hint, spec, remaining)) {
      const label = (r.label || '').trim()
      if (!label) continue
      // Homonymes : la première fiche l'emporte, faute de quoi choisir. Mieux
      // qu'aucun lien du tout — et le libellé affiché reste le bon.
      const k = label.toLowerCase()
      if (!byLower.has(k)) byLower.set(k, r)
    }
    for (const key of remaining) {
      const r = byLower.get(key.toLowerCase())
      if (!r) continue
      out[key] = {
        table: hint,
        id: r.id,
        label: (r.label || '').trim() || null,
        sub: (r.sub || '') || null,
        url: spec.path ? `${spec.path}/${r.id}` : null,
      }
    }
  }
  return out
}

// ── Recherche de candidats à une association ────────────────────────────────
//
// Symétrique de `resolveRecordKeys` : celle-ci traduit une clé en fiche, celle-ci
// liste les fiches d'une table cible pour que l'utilisateur en CHOISISSE une
// (associer un lien depuis une cellule de DataTable — cf.
// client/src/components/LinkCellEditor.jsx). Mêmes libellés que la résolution,
// donc mêmes pastilles avant et après l'association.
//
// Les deux identités sont renvoyées (`id` ERP + `airtable_id`) : l'appelant
// stocke celle qui a cours dans la colonne — un champ lien Airtable sans table
// cible garde des `recXXXX`, avec table cible des ids ERP.
export function searchRecords(table, q, limit = 40) {
  const spec = SPECS[table]
  if (!spec) return []
  const n = Math.max(1, Math.min(100, parseInt(limit, 10) || 40))
  const where = []
  const params = []
  if (hasDeletedAt(table)) where.push('t.deleted_at IS NULL')
  const term = String(q || '').trim()
  if (term) {
    // Recherche sur le libellé ET son contexte (le `sub` d'un contact est le nom
    // de son entreprise : « acme » doit y mener).
    const cols = spec.sub ? [spec.label, spec.sub] : [spec.label]
    where.push(`(${cols.map(c => `(${c}) LIKE ?`).join(' OR ')})`)
    for (let i = 0; i < cols.length; i++) params.push(`%${term}%`)
  }
  const sql = `
    SELECT t.id AS id,
           ${spec.airtable === false ? 'NULL' : 't.airtable_id'} AS airtable_id,
           ${spec.label} AS label,
           ${spec.sub || 'NULL'} AS sub
    FROM ${table} t
    ${spec.joins || ''}
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY label
    LIMIT ${n}`
  try {
    return db.prepare(sql).all(...params).map(r => ({
      id: r.id,
      airtable_id: r.airtable_id || null,
      label: (r.label || '').trim() || null,
      sub: (r.sub || '') || null,
      url: spec.path ? `${spec.path}/${r.id}` : null,
    }))
  } catch {
    // Même prudence que rowsFor : une expression cassée ne fait pas tomber la
    // cellule, elle rend une liste vide.
    return []
  }
}

// `deleted_at` n'existe pas partout (suppression douce inégale selon les
// tables) — le schéma ne bouge pas en cours d'exécution, on mémoïse.
const _hasDeletedAt = new Map()
function hasDeletedAt(table) {
  if (!_hasDeletedAt.has(table)) {
    let cols = []
    try { cols = db.pragma(`table_info(${table})`).map(c => c.name) } catch { cols = [] }
    _hasDeletedAt.set(table, cols.includes('deleted_at'))
  }
  return _hasDeletedAt.get(table)
}
