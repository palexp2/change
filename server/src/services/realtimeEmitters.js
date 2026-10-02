import { pieceUnitCostSql } from './shippedCost.js'
// Single source of truth for the realtime payloads of the pilot entities
// (orders, companies). The shape returned here MUST match what the
// corresponding list page / detail page consumes — keep in sync with the
// SELECTs in routes/orders.js GET / and routes/companies.js GET /.
//
// Called from:
//   - HTTP routes after a mutation (req.user.id available)
//   - External syncs: services/airtable.js, services/quickbooks.js,
//     services/stripe.js, services/installationFollowup.js (no actor)

import db from '../db/database.js'
import { readRelation, ACTIVITY_ENTITY_MAP } from './customFieldsView.js'
import { emit } from './realtime.js'
import { logActivity, deriveActivityLabel } from './activityLog.js'
import { storedQbUrl } from './bankQbLink.js'

function buildOrderListRow(id) {
  // company_name / assigned_name / items_count sont des champs convertis
  // (custom_fields lookup/rollup) exposés par la vue — même forme de ligne que
  // GET /api/orders (voir nativeFieldConversions.js).
  return db.prepare(
    `SELECT o.*,
      (SELECT SUM(oi.qty * ${pieceUnitCostSql('oi')}) FROM order_items oi WHERE oi.order_id = o.id) as total_value
     FROM ${readRelation('orders')} o
     WHERE o.id = ?`
  ).get(id)
}

function buildCompanyListRow(id) {
  return db.prepare(
    `SELECT c.*,
      (SELECT COUNT(*) FROM contacts ct WHERE ct.company_id = c.id) as contacts_count,
      (SELECT COUNT(*) FROM projects p WHERE p.company_id = c.id) as projects_count,
      (SELECT COUNT(*) FROM orders o WHERE o.company_id = c.id) as orders_count
     FROM companies c WHERE c.id = ?`
  ).get(id)
}

export function emitOrder(verb, id, actorUserId = null, { source = null, fields = null } = {}) {
  const payload = verb === 'deleted' ? { id } : buildOrderListRow(id)
  if (!payload) return
  emit(['orders:list', `order:${id}`], {
    type: `order:${verb}`,
    payload,
    actorUserId,
    source,
    fields,
    ts: Date.now(),
  })
  if (actorUserId) logActivity({ userId: actorUserId, entityType: 'order', entityId: id, action: verb, detail: deriveActivityLabel(payload) })
}

// `order_item:list` en plus du canal de la commande : la fiche écoute le
// second (elle fusionne l'item dans son tableau `items`), le registre des
// pastilles écoute le premier — sans lui, une ligne modifiée dans Airtable
// changeait de valeur sans dire qui l'avait touchée.
export function emitOrderItem(verb, orderId, payload, actorUserId = null, { source = null, fields = null } = {}) {
  emit([`order:${orderId}`, 'order_item:list'], {
    type: `order:item:${verb}`,
    payload,
    actorUserId,
    source,
    fields,
    ts: Date.now(),
  })
}

export function emitCompany(verb, id, actorUserId = null, { source = null, fields = null } = {}) {
  const payload = verb === 'deleted' ? { id } : buildCompanyListRow(id)
  if (!payload) return
  emit(['companies:list', `company:${id}`], {
    type: `company:${verb}`,
    payload,
    actorUserId,
    source,
    fields,
    ts: Date.now(),
  })
  if (actorUserId) logActivity({ userId: actorUserId, entityType: 'company', entityId: id, action: verb, detail: deriveActivityLabel(payload) })
}

/**
 * Notifie qu'un des sous-tableaux d'une fiche entreprise a changé (ex. liste
 * des contacts liés via contact_companies). Charge utile minimale — le client
 * choisit de re-fetcher s'il a la fiche ouverte. Plusieurs `companyIds`
 * peuvent être passés (un PATCH de principale touche deux entreprises).
 */
export function emitCompanyContactsChanged(companyIds, actorUserId = null) {
  const ids = (Array.isArray(companyIds) ? companyIds : [companyIds]).filter(Boolean)
  if (!ids.length) return
  for (const id of ids) {
    emit([`company:${id}`], {
      type: 'company:contacts_changed',
      payload: { id },
      actorUserId,
      ts: Date.now(),
    })
  }
}

function buildFactureRow(id) {
  return db.prepare(
    `SELECT f.*, co.name as company_name, p.name as project_name, o.order_number
     FROM factures f
     LEFT JOIN companies co ON f.company_id = co.id
     LEFT JOIN projects p ON f.project_id = p.id
     LEFT JOIN orders o ON f.order_id = o.id
     WHERE f.id = ?`
  ).get(id)
}

/**
 * Facture modifiée par un effet de bord plutôt que par une édition directe :
 * solde/statut recalculés après la saisie d'un paiement, un remboursement ou un
 * webhook Stripe. Même forme de ligne que GET /api/projets/factures — la fiche
 * et la liste peuvent la fusionner telle quelle.
 *
 * Pas de logActivity ici : l'événement métier est le paiement, pas la facture.
 * Journaliser les deux remplirait le fil d'activité de doublons.
 */
export function emitFacture(verb, id, actorUserId = null) {
  if (!id) return
  const payload = verb === 'deleted' ? { id } : buildFactureRow(id)
  if (!payload) return
  emit(['facture:list', `facture:${id}`], {
    type: `facture:${verb}`,
    payload,
    actorUserId,
    ts: Date.now(),
  })
}

/**
 * Abonnement écrit (édition, webhook Stripe, sync polling). Même forme de ligne
 * que GET /api/projets/abonnements/:id — la fiche ouverte la fusionne telle
 * quelle pour suivre statut, montant, dates et entreprise.
 */
export function emitSubscription(verb, id, actorUserId = null) {
  const row = db.prepare(
    `SELECT s.*, co.name as company_name
     FROM subscriptions s LEFT JOIN companies co ON s.company_id = co.id
     WHERE s.id = ?`
  ).get(id)
  emitEntity('subscription', verb, id, row, actorUserId)
}

/**
 * Les paiements/remboursements d'une facture ont changé (saisie, suppression,
 * écriture QB posée, refund Stripe). Charge utile minimale : la fiche facture
 * recharge sa section Paiements. Le solde voyage séparément via emitFacture.
 */
export function emitFacturePaymentsChanged(factureId, actorUserId = null) {
  if (!factureId) return
  emit([`facture:${factureId}`], {
    type: 'facture:payments_changed',
    payload: { id: factureId },
    actorUserId,
    ts: Date.now(),
  })
}

// ── Rapprochement bancaire ──────────────────────────────────────────────────
//
// Une ligne de relevé change SANS que personne ne clique dessus : un passage de
// vérification retrouve son écriture dans QuickBooks, une facture appariée y est
// publiée, un lien refusé est effacé. Sans ces émissions, tout ce travail restait
// invisible dans l'onglet /rapprochement resté ouvert — il fallait recharger.
//
// Charge utile = SEULEMENT les colonnes qui bougent. La route
// GET /bank/accounts/:id/transactions enrichit chaque ligne (`label`,
// `matched_label`, `vendor_name`, `proposal_count`, `qb_url` du document) et le
// client fusionne `{ ...row, ...payload }` : renvoyer la ligne entière écraserait
// ces champs-là par des `undefined`.
const BANK_TXN_LIVE_COLS = `id, account_id, status, comment, qb_txn_id, qb_txn_type,
  qb_match_method, qb_match_delta, qb_match_account, qb_match_rate`

let bankTxnLiveStmt = null

/**
 * @param {'updated'|'created'} verb
 * @param {string} id  id de la transaction bancaire
 * @param {object} payload  colonnes qui bougent + account_id (canal du compte)
 */
export function emitBankTxn(verb, id, payload) {
  if (!id || !payload?.account_id) return
  emit(['bank_transaction:list', `bank_account:${payload.account_id}`], {
    type: `bank_transaction:${verb}`,
    payload,
    actorUserId: null,
    ts: Date.now(),
  })
}

/**
 * « Ces lignes ont bougé, relis-les et dis-le ». Le point de passage unique des
 * effets de bord bancaires : un `qb_txn_id` peut être posé sans que le statut
 * change (ligne déjà comptabilisée), refreshStatuses ne le verrait pas.
 */
export function touchBankTxns(ids) {
  const list = [...new Set((Array.isArray(ids) ? ids : [ids]).filter(Boolean))]
  if (!list.length) return 0
  // Préparé à la première utilisation : au chargement du module, la table peut
  // ne pas encore exister (harnais de test, première migration).
  if (!bankTxnLiveStmt) {
    bankTxnLiveStmt = db.prepare(
      `SELECT ${BANK_TXN_LIVE_COLS} FROM bank_transactions WHERE id = ? AND deleted_at IS NULL`
    )
  }
  let n = 0
  for (const id of list) {
    const row = bankTxnLiveStmt.get(id)
    if (!row) continue
    emitBankTxn('updated', id, { ...row, qb_url: storedQbUrl(row) })
    n++
  }
  // Le classeur TRX_Orisha suit le même mouvement que l'écran : une ligne qui
  // change de statut ici est repeinte là-bas quelques secondes plus tard (un
  // seul aller-retour vers Google pour toute une rafale). Import dynamique :
  // le miroir importe la base, on ne veut pas de cycle au chargement.
  if (n) import('./trxSheetMirror.js').then((m) => m.mirrorOnChange('statut')).catch(() => {})
  return n
}

/**
 * Generic emitter for any entity. The route is responsible for shaping the
 * payload (typically a SELECT with the same JOINs as the GET /api/<entity>
 * list endpoint, so the client can splice it into table state without
 * re-querying).
 *
 * Channels: emits on `${entity}:list` AND `${entity}:${id}` so both the list
 * page and the detail page receive the event with one call. The wire message
 * carries EVERY channel the socket matched (see `emit`), so a fiche ouverte
 * par-dessus sa liste reçoit bien l'événement elle aussi.
 *
 * For deletes, pass payload = { id } (or whatever minimal shape lets the
 * client filter the row out).
 *
 * For sub-resource events (e.g. an item inside an order), prefer a dedicated
 * helper or call `emit([\`${parent}:${parentId}\`], ...)` directly — this
 * helper assumes 1:1 (entity, id).
 */
export function emitEntity(entity, verb, id, payload, actorUserId = null, { source = null, fields = null } = {}) {
  if (!entity || !verb || !id) return
  if (!payload) return
  emit([`${entity}:list`, `${entity}:${id}`], {
    type: `${entity}:${verb}`,
    payload,
    actorUserId,
    source,
    fields,
    ts: Date.now(),
  })
  if (actorUserId) logActivity({ userId: actorUserId, entityType: entity, entityId: id, action: verb, detail: deriveActivityLabel(payload) })
}


// ── Écritures venues d'une API externe (miroir Airtable) ────────────────────
//
// Une modification faite dans Airtable doit se voir dans Boréal SANS
// rafraîchir la page, et se voir *au bon endroit* : la pastille de champ mis à
// jour (client/src/lib/recordLive.jsx) a besoin de savoir QUELLES colonnes ont
// bougé et D'OÙ vient l'écriture. C'est exactement ce que le moteur de miroir
// sait, lui, au moment de son UPDATE différentiel — d'où cet émetteur unique,
// appelé pour les 21 miroirs plutôt que deux (commandes, entreprises).
//
// Table ERP → nom d'entité des canaux temps réel. Doit rester aligné avec
// ENTITY_TABLES (client/src/lib/recordLive.jsx) et avec l'`entity` passé à
// emitEntity par les routes — un nom qui diverge = un canal que personne
// n'écoute, donc une modification Airtable invisible.
export const ENTITY_BY_TABLE = {
  ...ACTIVITY_ENTITY_MAP,
  adresses: 'adresse',
  soumissions: 'soumission',
  sale_receipts: 'sale_receipt',
  paies: 'paie',
  paie_items: 'paie_item',
  serial_numbers: 'serial_number',
  serial_state_changes: 'serial_state_change',
  returns: 'return',
  return_items: 'return_item',
  order_items: 'order_item',
  stock_movements: 'stock_movement',
  assemblages: 'assemblage',
  bom_items: 'bom_item',
  instagram_prospects: 'instagram_prospect',
  subscriptions: 'subscription',
  vacations: 'vacation',
  timesheets: 'timesheet',
  journal_entries: 'journal_entry',
  activity_codes: 'activity_code',
}

// Charge utile d'une mise à jour externe : l'id et RIEN QUE les colonnes qui
// ont changé. Deux raisons de ne pas envoyer la ligne entière :
//  • les colonnes legacy Airtable (TEXT JSON) collisionnent avec les tableaux
//    agrégés des fiches (`orders.items` écrasait le vrai tableau d'articles) ;
//  • le client fusionne `{ ...record, ...payload }` : moins il y a de clés,
//    moins il y a de dégâts possibles.
function changedColumnsPayload(erpTable, id, changed) {
  const cols = (changed || []).filter(c => /^[A-Za-z_][A-Za-z0-9_]*$/.test(c))
  if (!cols.length) return { id }
  const select = `SELECT id, ${cols.map(c => `"${c}"`).join(', ')} FROM %s WHERE id = ?`
  const relation = readRelation(erpTable)
  try {
    return db.prepare(select.replace('%s', relation)).get(id) || { id }
  } catch (e) {
    // La VUE peut ignorer une colonne fraîchement ajoutée à la table (elle n'est
    // régénérée qu'explicitement). On relit alors la table physique plutôt que
    // de perdre la mise à jour.
    if (relation === erpTable) throw e
    return db.prepare(select.replace('%s', erpTable)).get(id) || { id }
  }
}

function fullRowPayload(erpTable, id) {
  return db.prepare(`SELECT * FROM ${readRelation(erpTable)} WHERE id = ?`).get(id)
}

/**
 * Une écriture RÉELLE du miroir Airtable vient d'avoir lieu.
 *
 * @param {string} erpTable  table ERP touchée
 * @param {'imported'|'updated'} outcome  verdict du différentiel
 * @param {string} id  id ERP du record
 * @param {string[]|null} changed  colonnes modifiées (null à la création)
 * @param {string} source  origine affichée par la pastille ('airtable')
 */
export function emitMirrorWrite(erpTable, outcome, id, changed = null, source = 'airtable') {
  if (!erpTable || !id) return
  const verb = outcome === 'imported' ? 'created' : 'updated'

  // Les deux entités pilotes gardent leur charge utile riche (list-row avec
  // champs joints) : les pages qui les consomment sont écrites pour elle.
  if (erpTable === 'orders') return emitOrder(verb, id, null, { source, fields: changed })
  if (erpTable === 'companies') return emitCompany(verb, id, null, { source, fields: changed })

  const payload = verb === 'created' ? fullRowPayload(erpTable, id) : changedColumnsPayload(erpTable, id, changed)
  if (!payload) return

  // Ligne de commande : elle ne vit que DANS la fiche de sa commande, sous la
  // clé `items`. Son canal est donc celui de la commande parente.
  if (erpTable === 'order_items') {
    const orderId = db.prepare('SELECT order_id FROM order_items WHERE id = ?').get(id)?.order_id
    if (orderId) emitOrderItem(verb, orderId, payload, null, { source, fields: changed })
    return
  }

  const entity = ENTITY_BY_TABLE[erpTable]
  if (!entity) return // table sans surface UI temps réel : le delta poll suffit
  emit([`${entity}:list`, `${entity}:${id}`], {
    type: `${entity}:${verb}`,
    payload,
    actorUserId: null,
    source,
    fields: changed,
    ts: Date.now(),
  })
}

/**
 * Le miroir vient de SUPPRIMER une ligne (record détruit dans Airtable).
 * `row` est la ligne lue AVANT la suppression : une ligne de commande n'est
 * diffusée que sur le canal de sa commande, qu'on ne peut plus relire après.
 */
export function emitMirrorDelete(erpTable, row, source = 'airtable') {
  if (!erpTable || !row?.id) return
  if (erpTable === 'orders') return emitOrder('deleted', row.id, null, { source })
  if (erpTable === 'companies') return emitCompany('deleted', row.id, null, { source })
  if (erpTable === 'order_items') {
    if (row.order_id) emitOrderItem('deleted', row.order_id, { id: row.id }, null, { source })
    return
  }
  const entity = ENTITY_BY_TABLE[erpTable]
  if (!entity) return
  emit([`${entity}:list`, `${entity}:${row.id}`], {
    type: `${entity}:deleted`, payload: { id: row.id }, actorUserId: null, source, ts: Date.now(),
  })
}
