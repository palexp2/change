import { hasRole } from '../../../shared/roles.mjs'
import { Router } from 'express';
import { newRecordId } from '../utils/recordId.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import PDFDocument from 'pdfkit';
import { PDFDocument as PDFLibDocument } from 'pdf-lib';
import db from '../db/database.js';
import { readRelation } from '../services/customFieldsView.js';
import { requireAuth } from '../middleware/auth.js';
import { buildPartialUpdate } from '../utils/partialUpdate.js';
import { emitOrder, emitOrderItem } from '../services/realtimeEmitters.js';
import { notifyAssignment } from '../services/notifications.js';
import { getCentralControllers } from '../utils/centralController.js';
import { rescanRachatForCompany } from '../services/subscriptionEvents.js';
import { logSync } from '../services/syncLog.js';
import { deleteOrder } from '../services/orderDeletion.js';
import { writeBackRecord, createInAirtable } from '../services/airtableWriteback.js';
import {
  SHIPMENT_ITEMS_COLUMN,
  refreshShipmentItemsMirror,
  pushShipmentToAirtable,
} from '../services/shipmentAirtableLink.js';
import { parsePositiveInt, parseNonNegativeInt, validateNumericFields } from '../utils/validateNumbers.js';
import { getWritableCustomColumns, refusedAirtablePullKeys, AIRTABLE_PULL_EDIT_ERROR } from '../services/customFieldWritability.js';
import { applyOrderItemDefaults } from '../services/orderItemDefaults.js';
import { shippedCostSql, refreezeOrderShippedCosts, pieceUnitCostSql } from '../services/shippedCost.js';
import { orderRevenueSql, orderIsSubscriptionSql } from '../services/orderRevenue.js';
import { logSystemRun } from '../services/systemAutomations.js';
import { uploadsPath, ensureUploadsDir } from '../config/uploads.js'
import { parsePage } from '../utils/pagination.js'
import { localDay } from '../utils/datetime.js'
import { exportErpOrder, exportErpOrderItems } from '../services/discoveryOrderAirtable.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Colonnes que la CRÉATION d'une commande sait persister ───────────────────
//
// Le formulaire « Nouvelle commande » les propose toutes via « Modifier le
// formulaire » (cf. client/src/pages/Orders.jsx + services/formFieldCatalog.js).
// Les 8 colonnes du INSERT de base (company_id, project_id, assigned_to, status,
// priority, notes, date_commande + order_number) restent traitées à part : elles
// ont un défaut serveur. Les suivantes sont les colonnes natives ÉDITABLES qui
// s'ajoutent — mêmes règles qu'au PUT.
const CREATE_EXTRA_COLUMNS = ['farm_address_id', 'address_id', 'is_subscription', 'revenue_override_cad', 'cogs_override_cad'];

// Colonnes déjà posées par le INSERT de base : une colonne du registre qui
// porterait le même nom (champ natif adopté) les dupliquerait dans la requête.
const CREATE_BASE_COLUMNS = new Set([
  'id', 'order_number', 'company_id', 'project_id', 'assigned_to',
  'status', 'priority', 'notes', 'date_commande',
]);

const ORDER_COLUMN_COERCE = {
  is_subscription: v => (v ? 1 : 0),
  // '' / null effacent l'override → on retombe sur la valeur calculée.
  revenue_override_cad: v => (v === '' || v == null ? null : Number(v)),
  cogs_override_cad: v => (v === '' || v == null ? null : Number(v)),
};

// « Date de la commande » (miroir Airtable, affichée sur la fiche) : une
// commande née dans l'ERP la reçoit dès sa création, au format du pull
// Airtable — sinon elle reste vide jusqu'au premier aller-retour Airtable.
export function stampOrderDate(orderId, day = localDay()) {
  if (!db.pragma('table_info(orders)').some(c => c.name === 'date_de_la_commande')) return;
  db.prepare('UPDATE orders SET date_de_la_commande = ? WHERE id = ? AND date_de_la_commande IS NULL')
    .run(`${String(day).slice(0, 10)}T00:00:00.000Z`, orderId);
}

// ── Étagère de prélèvement (mode expédition) ─────────────────────────────────
//
// Deux compteurs dérivés des numéros de série du produit de la ligne, lus par
// la fiche d'article à prélever pour dire à l'opérateur quelle étagère ouvrir :
//   • refurb_serials_available : séries « Disponible - Location » en stock →
//     s'il y en a, l'étagère des reconditionnés peut servir la ligne ;
//   • product_serial_count : le produit est-il suivi par numéro de série ? Une
//     pièce qui n'en a aucun ne peut pas être arbitrée par le compteur ci-dessus
//     (l'opérateur regarde alors les reconditionnés d'abord, puis les neufs).
// Le choix d'étagère ne se pose que sur une commande d'abonnement : le calcul
// final vit côté client, ces colonnes ne portent que les faits.
const SHELF_HINT_SQL = `
    (SELECT COUNT(*) FROM serial_numbers sn_r
      WHERE sn_r.product_id = oi.product_id AND sn_r.status = 'Disponible - Location') as refurb_serials_available,
    (SELECT COUNT(*) FROM serial_numbers sn_t
      WHERE sn_t.product_id = oi.product_id) as product_serial_count`;

function serialProgress(item) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM serial_numbers WHERE order_item_id = ? AND product_id IS ?')
    .get(item.id, item.product_id).n;
  const required = count > 0 || !!db.prepare('SELECT 1 FROM serial_numbers WHERE product_id = ? LIMIT 1').get(item.product_id);
  return { required, count };
}

function missingSerials(item) {
  const { required, count } = serialProgress(item);
  return required && count < item.qty;
}

// Renvoie vers Airtable le rattachement d'un numéro de série à une ligne de
// commande (champ « Items commande »), qui se pose ICI — au scan de prélèvement
// ou d'ajout — et nulle part ailleurs. Best-effort et no-op tant que le sens du
// champ reste « Airtable → Boréal » dans /champs/serial_numbers : le sens se
// choisit champ par champ, ce write-back ne l'allume pas.
function pushSerialOrderItem(serialId) {
  writeBackRecord('serials', serialId, ['order_item_id'])
    .catch(e => console.error('write-back serials:', e.message));
}

// SQLite ne sait pas lier un booléen : une case à cocher (champ perso ou champ
// Airtable bidirectionnel) arrive en true/false et doit passer en 0/1.
function bindable(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === '' || v === undefined) return null;
  return v;
}

// Extrait les recordID Airtable (recXXXXXXXXXXXXXX) d'une valeur de champ lien
// importée d'Airtable, qui peut être : un tableau JSON (["rec…","rec…"]), une
// liste CSV ("rec…, rec…"), ou une valeur unique ("rec…"). Retourne un tableau
// de recordID dans l'ordre, dédupliqué. Tolérant : renvoie [] si vide/illisible.
const AIRTABLE_REC_RE = /rec[a-zA-Z0-9]{14}/g;
function parseAirtableRecordIds(value) {
  if (value == null || value === '') return [];
  const str = String(value);
  const matches = str.match(AIRTABLE_REC_RE) || [];
  return [...new Set(matches)];
}

// Première clé d'une valeur de colonne lien, quelle que soit sa forme (tableau
// JSON, liste séparée par des virgules, identifiant nu). Contrairement à
// parseAirtableRecordIds, accepte aussi un id Boréal.
function firstLinkKey(value) {
  if (value == null || value === '') return null;
  let items = value;
  if (typeof value === 'string') {
    const s = value.trim();
    if (s.startsWith('[')) { try { items = JSON.parse(s); } catch { items = s.split(','); } }
    else items = s.split(',');
  }
  if (!Array.isArray(items)) items = [items];
  return items.map(v => String(v ?? '').trim()).find(Boolean) || null;
}

// ── « Adresse de livraison » : deux colonnes, une seule réalité ──────────────
//
//   • `address_id`           — id Boréal ; c'est lui que lisent les envois ;
//   • `adresse_de_livraison` — miroir du champ lien Airtable (record ids) ;
//     c'est lui que la fiche affiche et que le write-back renvoie à Airtable.
//
// Selon l'endroit, l'une ou l'autre est saisie. On remplit la seconde dans la
// foulée : sans ça, choisir l'adresse dans la fiche laissait les envois partir à
// l'ancienne adresse, et l'inverse laissait Airtable sur l'ancienne.
// Référent inconnu (ni id Boréal ni record id connu) : on ne touche à rien.
// Exportée pour être testable sans passer par la route.
// Même jumelage pour l'adresse de la ferme : `farm_address_id` (Boréal) ↔
// « Adresse de la ferme (pour coordonnées géographiques) » (Airtable).
const ADDRESS_PAIRS = [
  ['address_id', 'adresse_de_livraison'],
  ['farm_address_id', 'adresse_de_la_ferme_pour_coordonnees_geographiques'],
];
export function alignAddressColumns(body) {
  const has = k => Object.prototype.hasOwnProperty.call(body, k);
  for (const [native, mirror] of ADDRESS_PAIRS) {
    const fromMirror = has(mirror);
    if (!fromMirror && !has(native)) continue;
    const key = fromMirror ? firstLinkKey(body[mirror]) : (body[native] || null);
    const addr = key
      ? db.prepare('SELECT id, airtable_id FROM adresses WHERE id = ? OR airtable_id = ?').get(key, key)
      : null;
    if (key && !addr) continue;
    body[native] = addr?.id || null;
    // Adresse née dans Boréal (sans jumeau Airtable) : la colonne miroir garde son
    // id local — il s'affiche pareil, et le write-back saute alors le champ plutôt
    // que de délier côté Airtable.
    body[mirror] = addr ? JSON.stringify([addr.airtable_id || addr.id]) : '';
  }
}

// ── Langue des documents d'installation ─────────────────────────────────────
//
// Les PDF qu'on imprime avec la marchandise se lisent à la ferme : la langue
// est celle du CONTACT de l'adresse de livraison, pas un réglage de commande.
// Le lookup Airtable `langue_du_contact_a_la_ferme` ne reste qu'en dernier
// recours — il est vide sur la grande majorité des commandes (l'adresse de la
// ferme n'est pas toujours saisie), ce qui faisait tomber tout le monde en
// français par défaut.
// Ordre : contact de l'adresse → lookup de langue porté par l'adresse →
// lookup de la commande → français.
// L'opérateur peut toujours forcer 'fr'/'en' au moment de générer.
function normalizeDocsLang(value) {
  const s = String(value ?? '').trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith('en') || s === 'anglais') return 'en';
  if (s.startsWith('fr') || s === 'français' || s === 'francais') return 'fr';
  return null;
}

export function resolveInstallationDocsLang(order) {
  const addr = order?.address_id
    ? db.prepare(
        `SELECT a.id, a.contact_id, a.langue_du_contact, a.langue_de_correspondance,
                c.first_name AS c_first, c.last_name AS c_last, c.langue AS c_langue
         FROM adresses a
         LEFT JOIN contacts c ON c.id = a.contact_id
         WHERE a.id = ?`
      ).get(order.address_id)
    : null;

  const chain = [
    ['address_contact', addr?.c_langue],
    ['address', addr?.langue_du_contact],
    ['address', addr?.langue_de_correspondance],
    ['order', order?.langue_du_contact_a_la_ferme],
  ];
  for (const [source, raw] of chain) {
    const lang = normalizeDocsLang(raw);
    if (lang) {
      return {
        lang,
        source,
        address_id: addr?.id || null,
        contact_id: addr?.contact_id || null,
        contact_name: [addr?.c_first, addr?.c_last].filter(Boolean).join(' ') || null,
      };
    }
  }
  return {
    lang: 'fr',
    source: 'default',
    address_id: addr?.id || null,
    contact_id: addr?.contact_id || null,
    contact_name: [addr?.c_first, addr?.c_last].filter(Boolean).join(' ') || null,
  };
}

const router = Router();
router.use(requireAuth);

// Re-scan best-effort des churns récents d'un client à la création/modif d'une
// commande (détection "rachat"). rescanRachatForCompany route déjà chaque event
// par safeDetectRachatForChurn (log + file de retry), mais un échec de la passe
// elle-même (SELECT, emits) ne doit pas être avalé silencieusement : on le trace
// dans sync_log au lieu d'un catch {} muet.
function rescanRachatLogged(companyId, trigger) {
  if (!companyId) return;
  try {
    const scanned = rescanRachatForCompany(companyId);
    logSync('rachat-rescan', 'manual', { status: 'success', modified: scanned });
  } catch (e) {
    logSync('rachat-rescan', 'manual', { status: 'error', error: `${trigger}: ${e.message}` });
    console.error(`rescanRachatForCompany (${trigger}, company ${companyId}):`, e.message);
  }
}

// GET /api/orders/lookup — minimal list for dropdowns
router.get('/lookup', (req, res) => {
  const rows = db.prepare(
    `SELECT o.id, o.order_number, o.company_id, c.name as company_name
     FROM orders o
     LEFT JOIN companies c ON c.id = o.company_id
     WHERE o.deleted_at IS NULL
     ORDER BY o.order_number DESC`
  ).all()
  res.json(rows)
})

// GET /api/orders
router.get('/', (req, res) => {
  const { search, status, company_id } = req.query;
  const { page, limit, limitVal, offset } = parsePage(req.query, 50);
  let where = 'WHERE o.deleted_at IS NULL';
  const params = [];

  if (search) {
    // EXISTS plutôt que JOIN : la recherche ne dépend ni de la jointure retirée
    // ni de la colonne company_name de la vue (supprimable par l'utilisateur).
    where += ' AND (EXISTS (SELECT 1 FROM companies c WHERE c.id = o.company_id AND c.name LIKE ?) OR CAST(o.order_number AS TEXT) LIKE ?)';
    const q = `%${search}%`;
    params.push(q, q);
  }
  if (status) {
    where += ' AND o.status = ?';
    params.push(status);
  }
  if (company_id) {
    where += ' AND o.company_id = ?';
    params.push(company_id);
  }

  const total = db.prepare(
    `SELECT COUNT(*) as c FROM ${readRelation('orders')} o ${where}`
  ).get(...params).c;

  const orders = db.prepare(
    `SELECT o.*,
      (SELECT SUM(oi.qty * ${pieceUnitCostSql('oi')}) FROM order_items oi WHERE oi.order_id = o.id) as total_value
     FROM ${readRelation('orders')} o
     ${where}
     ORDER BY o.created_at DESC
     LIMIT ? OFFSET ?`
  ).all(...params, limitVal, offset);

  res.json({ data: orders, total, page: parseInt(page), limit: parseInt(limit) });
});

// GET /api/orders/:id
router.get('/:id', (req, res) => {
  const order = db.prepare(
    `SELECT o.*, p.name as project_name,
      a.line1 as address_line1, a.city as address_city, a.province as address_province,
      a.postal_code as address_postal_code, a.country as address_country
     FROM ${readRelation('orders')} o
     LEFT JOIN projects p ON o.project_id = p.id
     LEFT JOIN adresses a ON o.address_id = a.id
     WHERE o.id = ? AND o.deleted_at IS NULL`
  ).get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  order.farm_address = order.farm_address_id ? db.prepare('SELECT * FROM adresses WHERE id=?').get(order.farm_address_id) || null : null;
  // Lien réciproque du System builder qui a généré la commande.
  order.discovery_forms = db.prepare(
    'SELECT id, status, created_at, submitted_at FROM customer_onboarding_responses WHERE generated_order_id=? ORDER BY created_at'
  ).all(order.id);

  const items = db.prepare(
    `SELECT oi.*, pr.name_fr as product_name, pr.name_en as product_name_en, pr.sku, pr.image_url as product_image, pr.stock_qty as product_stock, pr.location as product_location, pr.type as product_type,
     ${SHELF_HINT_SQL}
     FROM ${readRelation('order_items')} oi
     LEFT JOIN products pr ON oi.product_id = pr.id
     WHERE oi.order_id = ?
     ORDER BY oi.sort_order, oi.created_at`
  ).all(req.params.id);

  // readRelation : le tableau Envois de la fiche commande (clé de vue
  // `order_envois`) propose les mêmes champs custom que /envois, y compris les
  // champs virtuels (formule/lookup) qui ne vivent que dans la vue shipments_v.
  const shipments = db.prepare(`SELECT * FROM ${readRelation('shipments')} WHERE order_id = ? AND deleted_at IS NULL ORDER BY created_at`).all(req.params.id);

  const itemIds = items.map(i => i.id)
  let itemsWithSerials = items
  if (itemIds.length > 0) {
    const serials = db.prepare(
      `SELECT * FROM serial_numbers WHERE order_item_id IN (${itemIds.map(() => '?').join(',')}) ORDER BY serial`
    ).all(...itemIds)
    const byItem = {}
    for (const s of serials) {
      if (!byItem[s.order_item_id]) byItem[s.order_item_id] = []
      byItem[s.order_item_id].push(s)
    }
    // Champ Airtable « # de série » (order_items.de_serie) : stocke des recordID
    // Airtable bruts (JSON array, CSV ou valeur unique). On les résout en vraies
    // fiches série via serial_numbers.airtable_id pour que le client affiche des
    // liens plutôt que des recXXX. NB : ce lien Airtable peut différer de
    // order_item_id (serials[]) — d'où une résolution dédiée par recordID.
    const recIds = new Set()
    for (const i of items) {
      for (const rid of parseAirtableRecordIds(i.de_serie)) recIds.add(rid)
    }
    const serialByAirtableId = {}
    if (recIds.size > 0) {
      const ridList = [...recIds]
      const rows = db.prepare(
        `SELECT id, serial, airtable_id FROM serial_numbers WHERE airtable_id IN (${ridList.map(() => '?').join(',')})`
      ).all(...ridList)
      for (const r of rows) serialByAirtableId[r.airtable_id] = r
    }
    itemsWithSerials = items.map(i => ({
      ...i,
      serials: byItem[i.id] || [],
      // Liste ordonnée { id, serial, airtable_id } des séries référencées par
      // le champ de_serie et retrouvées en base ; les recordID orphelins (série
      // absente) sont ignorés. [] si aucune.
      de_serie_serials: parseAirtableRecordIds(i.de_serie)
        .map(rid => serialByAirtableId[rid])
        .filter(Boolean),
    }))
  }

  // order_id / project_id : la fiche distingue une facture liée DIRECTEMENT à la
  // commande (déliable depuis l'entête) d'une facture qui n'y arrive que par le
  // projet (lecture seule ici).
  const factures = db.prepare(
    `SELECT id, document_number, status, total_amount, order_id, project_id FROM factures
     WHERE (order_id = ? OR (? IS NOT NULL AND project_id = ?))
     ORDER BY document_date ASC`
  ).all(req.params.id, order.project_id, order.project_id);

  const central_controllers = getCentralControllers(order.company_id);

  // ── Rentabilité ────────────────────────────────────────────────────────────
  // Revenu et coûts calculés EXACTEMENT comme le tableau Rentabilité du dashboard
  // (server/src/routes/dashboard.js). Garder les deux alignés.
  //   Revenu : services/orderRevenue.js (abonnement — case cochée OU facture
  //            d'abonnement liée — → 1re facture HT × 38 ; achat → SUM HT).
  //   Coûts (COGS) : SUM du coût à l'envoi (services/shippedCost.js) pour les
  //            items 'Facturable' uniquement.
  // Les overrides (revenue_override_cad, cogs_override_cad) priment sur la valeur
  // calculée correspondante quand ils sont posés.
  const revenueRow = db.prepare(
    `SELECT ${orderIsSubscriptionSql('o.id', 'o.project_id', 'o.is_subscription')} AS is_sub,
            ${orderRevenueSql('o.id', 'o.project_id', 'o.is_subscription')} AS rev
     FROM orders o WHERE o.id = ?`
  ).get(req.params.id);
  const revenueComputed = revenueRow?.rev || 0;
  // Coût des marchandises : le coût GELÉ au moment de l'envoi quand il existe
  // (valeur de fabrication de chaque numéro de série + coût de la pièce pour la
  // quantité non sérialisée — cf. services/shippedCost.js), sinon la même règle
  // aux coûts d'aujourd'hui pour les lignes pas encore expédiées.
  const cogsComputed = db.prepare(
    `SELECT COALESCE(SUM(${shippedCostSql('oi')}), 0) AS cogs
     FROM order_items oi WHERE oi.order_id = ? AND oi.item_type = 'Facturable'`
  ).get(req.params.id)?.cogs || 0;
  const revOverride = order.revenue_override_cad;
  const cogsOverride = order.cogs_override_cad;
  const revenueEffective = (revOverride != null) ? revOverride : revenueComputed;
  const cogsEffective = (cogsOverride != null) ? cogsOverride : cogsComputed;
  const profitability = {
    revenue_computed: revenueComputed,
    revenue_is_subscription: !!revenueRow?.is_sub,
    revenue_override_cad: revOverride != null ? revOverride : null,
    revenue_effective: revenueEffective,
    cogs_computed: cogsComputed,
    cogs_override_cad: cogsOverride != null ? cogsOverride : null,
    // `cogs` reste le coût effectif : les consommateurs existants n'ont pas à
    // connaître l'override.
    cogs: cogsEffective,
    profit: revenueEffective - cogsEffective,
    margin_pct: revenueEffective ? ((revenueEffective - cogsEffective) / revenueEffective) * 100 : null,
  };

  // Langue par défaut des documents d'installation : la fiche l'affiche avant
  // l'impression pour que l'opérateur voie ce qui sortira (et puisse forcer).
  const docs_lang = resolveInstallationDocsLang(order);

  res.json({ ...order, items: itemsWithSerials, shipments, factures, central_controllers, profitability, docs_lang });
});

// POST /api/orders
router.post('/', (req, res) => {
  const { company_id, project_id, assigned_to, status, priority, notes, date_commande, items = [] } = req.body;

  if (!Array.isArray(items)) return res.status(400).json({ error: 'items must be an array' });
  // Valide les quantités avant d'ouvrir la transaction.
  for (const item of items) {
    if (item.qty !== undefined && item.qty !== null && parsePositiveInt(item.qty) === null) {
      return res.status(400).json({ error: 'item qty must be a positive integer' });
    }
  }

  // Overrides de revenu / coûts : mêmes bornes qu'au PUT (ils alimentent le P&L).
  const { error: numError } = validateNumericFields(req.body, [
    { key: 'revenue_override_cad' },
    { key: 'cogs_override_cad' },
  ]);
  if (numError) return res.status(400).json({ error: numError });

  alignAddressColumns(req.body);

  // Un champ Airtable en import seul est refusé en 400 explicite plutôt
  // qu'ignoré en silence : la valeur saisie serait écrasée au prochain sync.
  if (refusedAirtablePullKeys('orders', req.body).length > 0) {
    return res.status(400).json({ error: AIRTABLE_PULL_EDIT_ERROR });
  }

  // Colonnes supplémentaires effectivement fournies : natives éditables + champs
  // du registre (perso ERP, ou Airtable passés en bidirectionnel) qui sont
  // ÉDITABLES selon la règle unique de services/customFieldWritability.js.
  const extraColumns = [
    ...CREATE_EXTRA_COLUMNS,
    ...getWritableCustomColumns('orders').map(c => c.column_name),
  ];
  const extras = {};
  for (const col of extraColumns) {
    if (CREATE_BASE_COLUMNS.has(col) || col in extras) continue;
    if (!Object.prototype.hasOwnProperty.call(req.body, col)) continue;
    const raw = req.body[col];
    extras[col] = ORDER_COLUMN_COERCE[col] ? ORDER_COLUMN_COERCE[col](raw) : bindable(raw);
  }
  const extraCols = Object.keys(extras);

  const id = newRecordId();

  // Generate next order number
  const maxNum = db.prepare('SELECT MAX(order_number) as m FROM orders').get();
  const orderNumber = (maxNum?.m || 0) + 1;

  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO orders (id, order_number, company_id, project_id, assigned_to, status, priority, notes, date_commande${extraCols.map(c => `, ${c}`).join('')})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?${extraCols.map(() => ', ?').join('')})`
    ).run(id, orderNumber, company_id || null, project_id || null, assigned_to || null,
      status || 'Commande vide', priority || null, notes || null, date_commande || localDay(),
      ...extraCols.map(c => extras[c]));
    stampOrderDate(id, date_commande || localDay());

    for (const item of items) {
      const itemId = newRecordId();
      db.prepare(
        `INSERT INTO order_items (id, order_id, product_id, qty, item_type, notes)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(itemId, id, item.product_id || null, item.qty || 1,
        item.item_type || 'Facturable', item.notes || null);
      applyOrderItemDefaults(itemId);
    }
  });
  run();

  const order = db.prepare(
    `SELECT o.* FROM ${readRelation('orders')} o WHERE o.id = ?`
  ).get(id);
  const orderItems = db.prepare(
    `SELECT oi.*, pr.name_fr as product_name, pr.sku FROM order_items oi LEFT JOIN products pr ON oi.product_id = pr.id WHERE oi.order_id = ?`
  ).all(id);

  emitOrder('created', id, req.user?.id);
  notifyAssignment({
    assignedTo: assigned_to,
    actorUserId: req.user?.id,
    type: 'order:assigned',
    title: `Commande #${orderNumber} assignée à vous`,
    link: `/orders/${id}`,
  });
  // Une nouvelle commande peut être le rachat d'un churn récent du même
  // client — re-scanne les churns sans rachat des 12 derniers mois.
  rescanRachatLogged(order?.company_id, 'order-create');
  // Airtable suit en arrière-plan ; un échec est repris par la reprise périodique.
  exportErpOrder(id);
  res.status(201).json({ ...order, items: orderItems });
});

// PUT /api/orders/:id — partial update
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT id, assigned_to, order_number FROM orders WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Order not found' });

  // Les overrides de revenu et de coûts alimentent directement le P&L : un
  // `"abc"` ou un négatif doit être rejeté (400), pas stocké tel quel (NaN) ni
  // coercé silencieusement. '' / null restent permis (efface l'override →
  // retour à la valeur calculée).
  const { error: numError } = validateNumericFields(req.body, [
    { key: 'revenue_override_cad' },
    { key: 'cogs_override_cad' },
  ]);
  if (numError) return res.status(400).json({ error: numError });

  alignAddressColumns(req.body);

  // Un champ Airtable en import seul est refusé en 400 explicite (même règle
  // qu'au POST et que sur projects/payments) : l'écriture serait de toute façon
  // écrasée au prochain sync.
  if (refusedAirtablePullKeys('orders', req.body).length > 0) {
    return res.status(400).json({ error: AIRTABLE_PULL_EDIT_ERROR });
  }
  // Un champ proposé par le formulaire de création doit rester corrigeable
  // ensuite — même whitelist des deux côtés.
  const customCols = getWritableCustomColumns('orders').map(c => c.column_name);
  const { setClause, values, error } = buildPartialUpdate(req.body, {
    allowed: ['company_id', 'project_id', 'assigned_to', 'status', 'priority',
      'notes', 'address_id', 'farm_address_id', 'date_commande', 'is_subscription', 'revenue_override_cad',
      'cogs_override_cad', ...customCols],
    nonNullable: new Set(['status']),
    coerce: {
      ...ORDER_COLUMN_COERCE,
      ...Object.fromEntries(customCols.map(c => [c, bindable])),
    },
  });
  if (error) return res.status(400).json({ error });
  if (setClause) {
    db.prepare(`UPDATE orders SET ${setClause}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(...values, req.params.id);
  }

  emitOrder('updated', req.params.id, req.user?.id);

  // Write-back ERP → Airtable des champs bidirectionnels/push (ex. Notes, si son
  // sens de sync l'autorise — cf. airtable_field_directions). Best-effort,
  // fire-and-forget : n'échoue jamais la réponse et no-op si la commande n'est
  // pas liée à Airtable ou si aucun champ écrivable n'a changé.
  if (setClause) {
    writeBackRecord('orders', req.params.id, Object.keys(req.body))
      .catch(e => console.error('write-back orders:', e.message));
  }

  if ('assigned_to' in req.body) {
    notifyAssignment({
      assignedTo: req.body.assigned_to,
      prevAssignedTo: existing.assigned_to,
      actorUserId: req.user?.id,
      type: 'order:assigned',
      title: `Commande #${existing.order_number} assignée à vous`,
      link: `/orders/${req.params.id}`,
    });
  }
  const updated = db.prepare(`SELECT o.*, p.name as project_name FROM ${readRelation('orders')} o LEFT JOIN projects p ON o.project_id = p.id WHERE o.id = ?`).get(req.params.id);
  // Une modif de commande (date, company, ou items en cascade) peut affecter
  // l'éligibilité comme rachat — re-scan best-effort.
  rescanRachatLogged(updated?.company_id, 'order-update');
  res.json(updated);
});

// PATCH /api/orders/:id/status
router.patch('/:id/status', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const { status } = req.body;
  const validStatuses = ['Commande vide', "Gel d'envois", 'En attente', 'Items à fabriquer ou à acheter', 'Tous les items sont disponibles', 'Tout est dans la boite', 'Partiellement envoyé', 'JWT-config', "Envoyé aujourd'hui", 'Envoyé', 'ERREUR SYSTÈME'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  // When marking as Envoyé or Envoyé aujourd'hui, decrease stock for each item
  const shippedStatuses = ['Envoyé', "Envoyé aujourd'hui"]
  if (shippedStatuses.includes(status) && !shippedStatuses.includes(order.status)) {
    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
    const movementIds = [];
    const run = db.transaction(() => {
      db.prepare(`UPDATE orders SET status=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(status, order.id);
      for (const item of items) {
        if (!item.product_id) continue;
        const product = db.prepare('SELECT stock_qty FROM products WHERE id = ?').get(item.product_id);
        if (product) {
          db.prepare(`UPDATE products SET stock_qty=MAX(0, stock_qty - ?), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
            .run(item.qty, item.product_id);
          const movId = newRecordId();
          db.prepare(
            `INSERT INTO stock_movements (id, product_id, type, qty, reason, user_id)
             VALUES (?, ?, 'out', ?, 'Commande envoyée', ?)`
          ).run(movId, item.product_id, item.qty, req.user.id);
          movementIds.push(movId);
        }
      }
    });
    run();
    // Vers Airtable si le sens des mouvements le demande (sinon ignoré).
    for (const movId of movementIds) createInAirtable('stock_movements', movId);
  } else {
    db.prepare(`UPDATE orders SET status=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(status, req.params.id);
  }

  emitOrder('updated', req.params.id, req.user?.id);
  res.json({ message: 'Status updated', status });
});

// POST /api/orders/:id/shipments
router.post('/:id/shipments', (req, res) => {
  const order = db.prepare('SELECT id, address_id FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const { tracking_number, carrier, status, shipped_at, notes, item_ids = [], address_id } = req.body;
  for (const itemId of item_ids) {
    const item = db.prepare('SELECT * FROM order_items WHERE id = ? AND order_id = ?').get(itemId, req.params.id);
    if (item && missingSerials(item)) return res.status(400).json({ error: 'Scannez un numéro de série distinct pour chaque exemplaire avant de créer l’envoi.' });
  }
  const resolvedAddressId = address_id !== undefined ? address_id : order.address_id;
  const id = newRecordId();
  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO shipments (id, order_id, tracking_number, carrier, status, shipped_at, notes, address_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, req.params.id, tracking_number || null, carrier || null,
      status || 'À envoyer', shipped_at || null, notes || null, resolvedAddressId || null);

    if (item_ids.length > 0) {
      const stmt = db.prepare(`UPDATE order_items SET shipment_id = ?, fulfillment_status = 'Dans l''envoi' WHERE id = ? AND order_id = ?`);
      for (const itemId of item_ids) {
        stmt.run(id, itemId, req.params.id);
      }
      // Freeze unit cost if shipment is already Envoyé
      if ((status || 'À envoyer') === 'Envoyé') {
        const freezeStmt = db.prepare(`UPDATE order_items SET shipped_unit_cost = ${pieceUnitCostSql('order_items')} WHERE id = ? AND shipped_unit_cost IS NULL`);
        for (const itemId of item_ids) {
          freezeStmt.run(itemId);
        }
      }
    }
  });
  run();

  const shipment = db.prepare('SELECT * FROM shipments WHERE id = ?').get(id);
  emitOrderItem('bulk_updated', req.params.id, { shipment, item_ids }, req.user?.id);

  // Création ERP → Airtable (2-way sync), même chemin que POST /api/shipments.
  // Asynchrone et non bloquant : l'envoi existe dans l'ERP même si Airtable est
  // indisponible, et le PATCH de rattrapage le poussera plus tard. Lancé APRÈS la
  // transaction pour que les order_items assignés soient déjà liés (« items expédiés »),
  // et après le recalcul de la colonne miroir qui les transporte.
  refreshShipmentItemsMirror(id);
  createInAirtable('envois', id).catch(e => {
    console.error(`erp-create envois ${id} (async):`, e.message);
    logSync('envois', 'erp-create', { status: 'error', error: `${id}: ${e.message}` });
  });

  res.status(201).json(shipment);
});

// POST /api/orders/:id/recompute-shipped-costs — recalcule et re-gèle le coût
// des lignes déjà envoyées, avec les coûts d'aujourd'hui : valeur de fabrication
// de CHAQUE numéro de série, coût de la pièce (table Pièces) pour le reste.
//
// Le gel automatique (automation sys_order_item_shipped_cost) ne remplit que les
// lignes vides — il ne réécrit jamais l'historique. Cette route est le chemin
// explicite pour reprendre un coût faux : coût de pièce corrigé après coup,
// valeur de fabrication saisie en retard, ou valeur héritée d'Airtable. Écrite
// dans l'historique de l'automation pour que le recalcul reste visible.
router.post('/:id/recompute-shipped-costs', (req, res) => {
  const order = db.prepare('SELECT id, order_number FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  let r;
  try {
    r = refreezeOrderShippedCosts(order.id);
  } catch (e) {
    logSystemRun('sys_order_item_shipped_cost', {
      status: 'error',
      result: `Recalcul manuel · commande #${order.order_number}`,
      error: e.message,
    });
    return res.status(500).json({ error: e.message });
  }

  // Rien d'envoyé sur la commande : pas de trace, le clic n'a rien produit.
  if (r.items) logSystemRun('sys_order_item_shipped_cost', {
    status: 'success',
    result: [
      `Recalcul manuel · commande #${order.order_number} — ${r.frozen}/${r.items} ligne(s) envoyée(s) recalculée(s), total ${r.total.toFixed(2)} $`,
      ...r.details.map(d => {
        const from = d.previous != null ? `${d.previous.toFixed(2)} $ → ` : ''
        return `${d.item_id} → ${from}${d.total.toFixed(2)} $`;
      }),
    ].join('\n'),
    triggerData: { order_id: order.id, frozen: r.frozen, manual: true },
  });

  if (r.frozen) emitOrderItem('bulk_updated', order.id, { recomputed: r.frozen }, req.user?.id);
  res.json({ items: r.items, frozen: r.frozen, total: r.total });
});

// POST /api/orders/:id/items — add item to existing order
router.post('/:id/items', (req, res) => {
  const order = db.prepare('SELECT id FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const { product_id, qty, item_type, notes } = req.body;
  if (qty !== undefined && qty !== null && parsePositiveInt(qty) === null) {
    return res.status(400).json({ error: 'qty must be a positive integer' });
  }
  const itemId = newRecordId();
  db.prepare(
    `INSERT INTO order_items (id, order_id, product_id, qty, item_type, notes) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(itemId, req.params.id, product_id || null, qty || 1, item_type || 'Facturable', notes || null);
  applyOrderItemDefaults(itemId);

  db.prepare(`UPDATE orders SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(req.params.id);
  const newItem = db.prepare(`SELECT oi.*, pr.name_fr as product_name, pr.sku, pr.image_url as product_image, pr.location as product_location, pr.type as product_type, ${SHELF_HINT_SQL} FROM ${readRelation('order_items')} oi LEFT JOIN products pr ON oi.product_id = pr.id WHERE oi.id = ?`).get(itemId);
  emitOrderItem('created', req.params.id, newItem, req.user?.id);
  exportErpOrderItems(req.params.id);
  res.status(201).json(newItem);
});

// PATCH /api/orders/:id/items/reorder
router.patch('/:id/items/reorder', (req, res) => {
  const order = db.prepare('SELECT id FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Array required' });
  const stmt = db.prepare('UPDATE order_items SET sort_order=? WHERE id=? AND order_id=?');
  for (const { id, sort_order } of req.body) {
    stmt.run(sort_order, id, req.params.id);
  }
  emitOrderItem('reordered', req.params.id, { items: req.body }, req.user?.id);
  res.json({ ok: true });
});

// PATCH /api/orders/:id/items/:itemId — inline edit
router.patch('/:id/items/:itemId', (req, res) => {
  const order = db.prepare('SELECT id FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  // Valide qty (entier positif) et fulfilled_qty (entier >= 0).
  if ('qty' in req.body && parsePositiveInt(req.body.qty) === null) {
    return res.status(400).json({ error: 'qty must be a positive integer' });
  }
  if ('fulfilled_qty' in req.body && req.body.fulfilled_qty !== null &&
      parseNonNegativeInt(req.body.fulfilled_qty) === null) {
    return res.status(400).json({ error: 'fulfilled_qty must be an integer >= 0' });
  }
  // Champs personnalisés éditables (ex. « Type de document ») : la cellule du
  // tableau Articles les propose en édition, il faut donc les accepter ici.
  // « # de série » garde sa voie dédiée (dissociation seulement, plus bas).
  if (refusedAirtablePullKeys('order_items', req.body).length > 0) {
    return res.status(400).json({ error: AIRTABLE_PULL_EDIT_ERROR });
  }
  const customCols = getWritableCustomColumns('order_items').map(c => c.column_name).filter(c => c !== 'de_serie');
  for (const c of customCols) if (c in req.body) req.body[c] = bindable(req.body[c]);
  const allowed = ['product_id', 'qty', 'item_type', 'notes', 'replaced_serial', 'fulfillment_status', 'fulfilled_qty', 'shipment_id', ...customCols];
  const currentItem = db.prepare('SELECT * FROM order_items WHERE id=? AND order_id=?').get(req.params.itemId, req.params.id);
  if (!currentItem) return res.status(404).json({ error: 'Article introuvable' });
  const nextItem = { ...currentItem, ...Object.fromEntries(allowed.filter(k => k in req.body).map(k => [k, req.body[k]])) };
  const progress = serialProgress(nextItem);
  const changesPicking = ['product_id', 'qty', 'fulfillment_status', 'fulfilled_qty', 'shipment_id'].some(k => k in req.body);
  if (changesPicking && progress.required && (
    nextItem.fulfilled_qty > progress.count ||
    ((['Prélevé', "Dans l'envoi", 'Envoyé'].includes(nextItem.fulfillment_status) || nextItem.shipment_id) && progress.count < nextItem.qty)
  )) return res.status(400).json({ error: 'Scannez un numéro de série distinct pour chaque exemplaire.' });
  // La cellule « # de série » peut dissocier ses liens Airtable. Ce champ
  // est distinct du prélèvement (serial_numbers.order_item_id).
  if ('de_serie' in req.body) {
    const current = db.prepare('SELECT de_serie FROM order_items WHERE id=? AND order_id=?')
      .get(req.params.itemId, req.params.id);
    if (!current) return res.status(404).json({ error: 'Article introuvable' });
    if (refusedAirtablePullKeys('order_items', { de_serie: req.body.de_serie }).length) {
      return res.status(400).json({ error: AIRTABLE_PULL_EDIT_ERROR });
    }
    let next;
    try { next = JSON.parse(req.body.de_serie); } catch { /* validation ci-dessous */ }
    const previous = new Set(parseAirtableRecordIds(current.de_serie));
    if (!Array.isArray(next) || next.some(key => typeof key !== 'string' || !previous.has(key))) {
      return res.status(400).json({ error: 'Seule la dissociation des séries liées est permise' });
    }
    req.body.de_serie = JSON.stringify([...new Set(next)]);
    allowed.push('de_serie');
  }
  const updates = [];
  const values = [];
  for (const key of allowed) {
    if (key in req.body) { updates.push(`${key}=?`); values.push(req.body[key]); }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  // Envoi d'AVANT : « ajouter à un envoi » comme « retirer de l'envoi » changent la
  // liste des articles expédiés des DEUX envois concernés, qu'il faut rafraîchir
  // et repousser vers Airtable (cf. plus bas).
  const prevShipmentId = 'shipment_id' in req.body
    ? db.prepare('SELECT shipment_id FROM order_items WHERE id=? AND order_id=?')
      .get(req.params.itemId, req.params.id)?.shipment_id || null
    : null;
  db.prepare(`UPDATE order_items SET ${updates.join(', ')} WHERE id=? AND order_id=?`).run(...values, req.params.itemId, req.params.id);

  // Décochage en mode expédition : si on remet l'article à « À prélever » ou
  // à fulfilled_qty=0, on détache les numéros de série liés (sinon ils
  // restent collés à un item qui n'est plus prélevé). Cas pratique : le
  // picker scanne le mauvais SN, décoche, rescanne le bon.
  const isUnpicking = req.body.fulfillment_status === 'À prélever' || req.body.fulfilled_qty === 0
  if (isUnpicking) {
    const detached = db.prepare('SELECT id FROM serial_numbers WHERE order_item_id = ?').all(req.params.itemId)
    db.prepare('UPDATE serial_numbers SET order_item_id = NULL WHERE order_item_id = ?').run(req.params.itemId)
    for (const s of detached) pushSerialOrderItem(s.id)
  }

  db.prepare(`UPDATE orders SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`).run(req.params.id);
  const item = db.prepare(`SELECT oi.*, pr.name_fr as product_name, pr.sku, pr.image_url as product_image, pr.location as product_location, pr.type as product_type, ${SHELF_HINT_SQL} FROM ${readRelation('order_items')} oi LEFT JOIN products pr ON oi.product_id = pr.id WHERE oi.id=?`).get(req.params.itemId);
  // Inclure serials dans la réponse (et l'événement realtime) pour que le
  // client mette à jour ses badges sans refetch — le merge côté UI applique
  // `serials: []` quand on vient de détacher.
  const serials = db.prepare('SELECT * FROM serial_numbers WHERE order_item_id = ? ORDER BY serial').all(req.params.itemId)
  const itemWithSerials = { ...item, serials }
  emitOrderItem('updated', req.params.id, itemWithSerials, req.user?.id);

  // Write-back ERP → Airtable des colonnes dont le sens l'autorise (par défaut
  // aucune : le module « Lignes de commande » part en import seulement, le sens
  // se choisit dans la modale « Mapping Airtable » — cf. airtable_field_directions).
  // Best-effort : n'échoue jamais la réponse, no-op si la ligne n'est pas liée
  // à Airtable ou si rien d'écrivable n'a changé.
  writeBackRecord('order_items', req.params.itemId, allowed.filter(k => k in req.body))
    .catch(e => console.error('write-back order_items:', e.message));

  // « items expédiés » côté Airtable suit order_items.shipment_id : ajouter ou
  // retirer un article d'un envoi doit se voir sur la fiche envoi d'Airtable.
  // `allowEmpty` sur l'envoi quitté — le vide y est une décision de l'utilisateur
  // (dernier article retiré), pas une absence d'assignation locale.
  if ('shipment_id' in req.body) {
    const newShipmentId = req.body.shipment_id || null;
    for (const [shipmentId, allowEmpty] of [[prevShipmentId, true], [newShipmentId, false]]) {
      if (!shipmentId || (shipmentId === prevShipmentId && shipmentId === newShipmentId)) continue;
      refreshShipmentItemsMirror(shipmentId, { allowEmpty });
      pushShipmentToAirtable(shipmentId, [SHIPMENT_ITEMS_COLUMN]);
    }
  }

  res.json(itemWithSerials);
});

// Retrait partiel du prélèvement : le lien série et le compteur changent ensemble.
router.post('/:id/items/:itemId/unpick', (req, res) => {
  const { serial_id, quantity, expected_fulfilled_qty } = req.body || {};
  const serialMode = typeof serial_id === 'string' && serial_id.length > 0;
  const amount = serialMode ? 1 : parsePositiveInt(quantity);
  const expected = parseNonNegativeInt(expected_fulfilled_qty);
  if (expected === null || amount === null || (serialMode && quantity !== undefined) || (!serialMode && serial_id !== undefined)) {
    return res.status(400).json({ error: 'Indiquez une série ou une quantité entière à remettre en stock.' });
  }

  const result = db.transaction(() => {
    const item = db.prepare('SELECT * FROM order_items WHERE id = ? AND order_id = ?').get(req.params.itemId, req.params.id);
    if (!item) return { status: 404, error: 'Article introuvable dans cette commande.' };
    if (item.shipment_id || ["Dans l'envoi", 'Envoyé'].includes(item.fulfillment_status)) {
      return { status: 409, error: "Retirez d’abord l’article de son envoi." };
    }
    const currentQty = item.fulfilled_qty || 0;
    if (currentQty !== expected) return { status: 409, error: 'Le prélèvement a changé. Actualisez la commande.' };
    if (amount > currentQty) return { status: 400, error: 'La quantité dépasse le prélèvement.' };
    if (serialMode) {
      const serial = db.prepare('SELECT id FROM serial_numbers WHERE id = ? AND order_item_id = ?').get(serial_id, item.id);
      if (!serial) return { status: 409, error: 'Cette série ne fait plus partie du prélèvement.' };
      db.prepare('UPDATE serial_numbers SET order_item_id = NULL WHERE id = ?').run(serial_id);
    } else if (db.prepare('SELECT id FROM serial_numbers WHERE order_item_id = ? OR product_id = ? LIMIT 1').get(item.id, item.product_id)) {
      return { status: 400, error: 'Choisissez le numéro de série à remettre en stock.' };
    }
    const remaining = currentQty - amount;
    const status = item.fulfillment_status === 'En attente' ? 'En attente' : remaining >= item.qty ? 'Prélevé' : 'À prélever';
    db.prepare('UPDATE order_items SET fulfilled_qty = ?, fulfillment_status = ? WHERE id = ?').run(remaining, status, item.id);
    db.prepare(`UPDATE orders SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`).run(req.params.id);
    return { status: 200 };
  })();
  if (result.error) return res.status(result.status).json({ error: result.error });

  const item = db.prepare(`SELECT oi.*, pr.name_fr as product_name, pr.sku, pr.image_url as product_image, pr.location as product_location, pr.type as product_type, ${SHELF_HINT_SQL} FROM ${readRelation('order_items')} oi LEFT JOIN products pr ON oi.product_id = pr.id WHERE oi.id=?`).get(req.params.itemId);
  item.serials = db.prepare('SELECT * FROM serial_numbers WHERE order_item_id = ? ORDER BY serial').all(item.id);
  emitOrderItem('updated', req.params.id, item, req.user?.id);
  if (serialMode) pushSerialOrderItem(serial_id);
  writeBackRecord('order_items', item.id, ['fulfilled_qty', 'fulfillment_status'])
    .catch(e => console.error('write-back order_items:', e.message));
  res.json(item);
});

// POST /api/orders/:id/items/:itemId/duplicate
router.post('/:id/items/:itemId/duplicate', (req, res) => {
  const order = db.prepare('SELECT id FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const item = db.prepare('SELECT * FROM order_items WHERE id=? AND order_id=?').get(req.params.itemId, req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const newId = newRecordId();
  db.prepare('INSERT INTO order_items (id, order_id, product_id, qty, item_type, notes, sort_order) VALUES (?,?,?,?,?,?,?)')
    .run(newId, req.params.id, item.product_id, item.qty, item.item_type, item.notes, (item.sort_order || 0) + 1);
  // La copie garde le type de document de l'original, sinon prend le défaut.
  if ('cf_type_de_document' in item) db.prepare('UPDATE order_items SET cf_type_de_document=? WHERE id=?').run(item.cf_type_de_document, newId);
  applyOrderItemDefaults(newId);
  db.prepare(`UPDATE orders SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`).run(req.params.id);
  const dup = db.prepare(`SELECT oi.*, pr.name_fr as product_name, pr.sku, pr.image_url as product_image, pr.location as product_location, pr.type as product_type, ${SHELF_HINT_SQL} FROM ${readRelation('order_items')} oi LEFT JOIN products pr ON oi.product_id = pr.id WHERE oi.id=?`).get(newId);
  emitOrderItem('created', req.params.id, dup, req.user?.id);
  exportErpOrderItems(req.params.id);
  res.status(201).json(dup);
});

// DELETE /api/orders/:id/items/:itemId
router.delete('/:id/items/:itemId', (req, res) => {
  const order = db.prepare('SELECT id FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  db.prepare('DELETE FROM order_items WHERE id = ? AND order_id = ?').run(req.params.itemId, req.params.id);
  emitOrderItem('deleted', req.params.id, { id: req.params.itemId }, req.user?.id);
  res.json({ message: 'Item deleted' });
});

// Pièce désignée par un code scanné : son SKU, insensible à la casse — un
// lecteur peut renvoyer une autre casse que celle saisie dans la fiche.
function productForScannedCode(code) {
  return db.prepare(
    'SELECT * FROM products WHERE sku = ? COLLATE NOCASE AND deleted_at IS NULL'
  ).get(code) || null
}

// Statuts d'un numéro de série prélevable : seules les séries en stock (vente
// ou location) peuvent partir. Tout le reste — déjà chez un client, en retour,
// à reconditionner, détruite, non construite — refuse le scan.
const SERIAL_PICKABLE_STATUSES = ['Disponible - Vente', 'Disponible - Location']

// Séries considérées « chez le client » pour la détection de collision
// d'adresse : l'adresse (1–255) doit être unique par entreprise, sur ce qui est
// déjà installé chez elle comme sur ce qui part dans la commande en cours.
const SERIAL_AT_CLIENT_STATUSES = ['Opérationnel - Vendu', 'Opérationnel - Loué']

// Une série revenue en stock garde souvent le lien vers la ligne de sa dernière
// commande (déjà envoyée) : ce lien est un vestige, pas une réservation. Seule
// une ligne encore ouverte (commande non envoyée, ligne pas expédiée) retient
// la série.
function serialHeldByOpenLine(serial) {
  if (!serial.order_item_id) return false
  const held = db.prepare(
    `SELECT oi.fulfillment_status, oi.shipment_id, o.status, o.deleted_at
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE oi.id = ?`
  ).get(serial.order_item_id)
  if (!held || held.deleted_at || held.shipment_id) return false
  if (held.fulfillment_status === 'Envoyé') return false
  return !['Envoyé', "Envoyé aujourd'hui"].includes(held.status)
}

// Ligne à servir pour un produit donné : la première non pleine, dans l'ordre
// d'affichage. Une commande peut porter le même produit sur plusieurs lignes
// (3 capteurs sur l'une, 2 sur l'autre) : on remplit la première jusqu'à sa
// quantité, puis on passe à la suivante.
function openLineForProduct(orderId, productId) {
  if (!productId) return { lines: [], item: null }
  const lines = db.prepare(
    `SELECT * FROM order_items
      WHERE order_id = ? AND product_id = ?
        AND fulfillment_status NOT IN ('Envoyé', 'Dans l''envoi')
      ORDER BY COALESCE(sort_order, 0), created_at`
  ).all(orderId, productId)
  return { lines, item: lines.find(l => (l.fulfilled_qty || 0) < (l.qty || 1) || missingSerials(l)) || null }
}

// Collision d'adresse pour le client de la commande. Deux appareils de la même
// entreprise ne peuvent pas porter la même adresse : on regarde ce qui est déjà
// chez elle (séries opérationnelles) et ce qui est déjà prélevé sur la commande
// en cours. Renvoie le conflit trouvé, sinon null.
function serialAddressConflict(orderId, companyId, serial) {
  const address = String(serial.address ?? '').trim()
  if (!address) return null

  if (companyId) {
    const placeholders = SERIAL_AT_CLIENT_STATUSES.map(() => '?').join(', ')
    const atClient = db.prepare(
      `SELECT serial FROM serial_numbers
        WHERE company_id = ? AND id <> ? AND trim(COALESCE(address, '')) = ?
          AND status IN (${placeholders})`
    ).get(companyId, serial.id, address, ...SERIAL_AT_CLIENT_STATUSES)
    if (atClient) return { scope: 'client', address, serial: atClient.serial }
  }

  const inOrder = db.prepare(
    `SELECT sn.serial FROM serial_numbers sn
      JOIN order_items oi ON oi.id = sn.order_item_id
      WHERE oi.order_id = ? AND sn.id <> ? AND trim(COALESCE(sn.address, '')) = ?`
  ).get(orderId, serial.id, address)
  if (inOrder) return { scope: 'order', address, serial: inOrder.serial }

  return null
}

// POST /api/orders/:id/scan — barcode scanner (serial, SKU or product barcode)
router.post('/:id/scan', (req, res) => {
  const order = db.prepare('SELECT id, company_id, is_subscription FROM orders WHERE id = ?').get(req.params.id)
  if (!order) return res.status(404).json({ error: 'Order not found' })

  const { value, mode } = req.body
  if (!value || !value.trim()) return res.status(400).json({ error: 'value required' })

  const v = value.trim()

  // ── PICKING MODE: each scan increments fulfilled_qty by 1 ───────────────────
  if (mode === 'pick') {
    function pickItem(item, serialObj) {
      if (serialObj) {
        db.prepare('UPDATE serial_numbers SET order_item_id = ? WHERE id = ?').run(item.id, serialObj.id)
        pushSerialOrderItem(serialObj.id)
      }
      const newQty = serialObj ? serialProgress(item).count : Math.min((item.fulfilled_qty || 0) + 1, item.qty)
      const newStatus = newQty >= item.qty ? 'Prélevé' : item.fulfillment_status === 'En attente' ? 'En attente' : 'À prélever'
      db.prepare(`UPDATE order_items SET fulfilled_qty = ?, fulfillment_status = ? WHERE id = ?`).run(newQty, newStatus, item.id)
      const updated = db.prepare('SELECT oi.*, pr.name_fr as product_name FROM order_items oi LEFT JOIN products pr ON oi.product_id = pr.id WHERE oi.id = ?').get(item.id)
      updated.serials = db.prepare('SELECT * FROM serial_numbers WHERE order_item_id = ? ORDER BY serial').all(item.id)
      return updated
    }

    const serial = db.prepare(
      `SELECT sn.*, pr.name_fr as product_name FROM serial_numbers sn
       LEFT JOIN products pr ON sn.product_id = pr.id
       WHERE sn.serial = ? COLLATE NOCASE`
    ).get(v)

    if (serial) {
      // 1. La série doit être en stock.
      if (!SERIAL_PICKABLE_STATUSES.includes(serial.status)) {
        return res.json({ type: 'serial', action: 'not_available', serial })
      }
      // 2. Reconditionné (« Disponible - Location ») sur une commande d'achat :
      //    faisable, mais pas idéal — l'opérateur confirme. L'inverse (neuf sur
      //    un abonnement) passe sans rien demander.
      if (!order.is_subscription && serial.status === 'Disponible - Location' && !req.body.confirm) {
        return res.json({ type: 'serial', action: 'confirm_required', reason: 'refurb_on_purchase', serial })
      }
      // 3. Sa ligne : la première non pleine du produit.
      const { lines, item: openItem } = openLineForProduct(req.params.id, serial.product_id)
      // Une série déjà liée reste sur sa ligne ; la rescanner ne compte pas
      // un second exemplaire et ne la déplace jamais vers la ligne suivante.
      const linkedItem = serial.order_item_id ? lines.find(l => l.id === serial.order_item_id) : null
      if (!linkedItem && serialHeldByOpenLine(serial)) return res.status(409).json({ error: 'Ce numéro de série est déjà lié à un autre article ou envoi.' })
      const item = linkedItem || openItem
      if (!lines.length) return res.json({ type: 'serial', action: 'not_in_order', serial })
      if (!item) return res.json({ type: 'serial', action: 'lines_full', serial })
      // 4. Son adresse ne doit pas déjà exister chez ce client.
      const conflict = serialAddressConflict(req.params.id, order.company_id, serial)
      if (conflict) return res.json({ type: 'serial', action: 'address_conflict', serial, conflict })

      const updated = pickItem(item, serial)
      emitOrderItem('updated', req.params.id, updated, req.user?.id)
      return res.json({ type: 'serial', action: 'picked', serial, item: updated })
    }

    const product = productForScannedCode(v)
    if (product) {
      if (db.prepare('SELECT 1 FROM serial_numbers WHERE product_id = ? LIMIT 1').get(product.id)) {
        return res.status(400).json({ error: 'Scannez le numéro de série de chaque exemplaire, plutôt que le code produit.' })
      }
      const { lines, item } = openLineForProduct(req.params.id, product.id)
      if (!lines.length) return res.json({ type: 'sku', action: 'not_in_order', product })
      if (!item) return res.json({ type: 'sku', action: 'lines_full', product })
      const updated = pickItem(item, null)
      emitOrderItem('updated', req.params.id, updated, req.user?.id)
      return res.json({ type: 'sku', action: 'picked', product, item: updated })
    }

    return res.json({ type: 'not_found', value: v })
  }

  // ── ADD MODE (default): scan adds or links items ────────────────────────────

  // 1. Try serial number
  const serial = db.prepare(
    `SELECT sn.*, pr.name_fr as product_name, pr.sku
     FROM serial_numbers sn
     LEFT JOIN products pr ON sn.product_id = pr.id
     WHERE sn.serial = ? COLLATE NOCASE`
  ).get(v)

  if (serial) {
    let item = serial.product_id
      ? db.prepare('SELECT * FROM order_items WHERE order_id = ? AND product_id = ?').get(req.params.id, serial.product_id)
      : null

    let action = 'linked'
    if (!item) {
      const itemId = newRecordId()
      db.prepare('INSERT INTO order_items (id, order_id, product_id, qty, item_type) VALUES (?, ?, ?, 1, ?)')
        .run(itemId, req.params.id, serial.product_id || null, 'Facturable')
      applyOrderItemDefaults(itemId)
      item = db.prepare('SELECT oi.*, pr.name_fr as product_name FROM order_items oi LEFT JOIN products pr ON oi.product_id = pr.id WHERE oi.id = ?').get(itemId)
      action = 'added'
    }

    db.prepare('UPDATE serial_numbers SET order_item_id = ? WHERE id = ?').run(item.id, serial.id)
    pushSerialOrderItem(serial.id)
    db.prepare(`UPDATE orders SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`).run(req.params.id)
    emitOrderItem(action === 'added' ? 'created' : 'updated', req.params.id, item, req.user?.id)
    return res.json({ type: 'serial', action, serial, item })
  }

  // 2. Try SKU / product barcode
  const product = productForScannedCode(v)

  if (product) {
    let item = db.prepare('SELECT * FROM order_items WHERE order_id = ? AND product_id = ?').get(req.params.id, product.id)
    let action

    if (item) {
      db.prepare('UPDATE order_items SET qty = qty + 1 WHERE id = ?').run(item.id)
      item = db.prepare('SELECT oi.*, pr.name_fr as product_name FROM order_items oi LEFT JOIN products pr ON oi.product_id = pr.id WHERE oi.id = ?').get(item.id)
      action = 'incremented'
    } else {
      const itemId = newRecordId()
      db.prepare('INSERT INTO order_items (id, order_id, product_id, qty, item_type) VALUES (?, ?, ?, 1, ?)')
        .run(itemId, req.params.id, product.id, 'Facturable')
      applyOrderItemDefaults(itemId)
      item = db.prepare('SELECT oi.*, pr.name_fr as product_name FROM order_items oi LEFT JOIN products pr ON oi.product_id = pr.id WHERE oi.id = ?').get(itemId)
      action = 'added'
    }

    db.prepare(`UPDATE orders SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`).run(req.params.id)
    emitOrderItem(action === 'added' ? 'created' : 'updated', req.params.id, item, req.user?.id)
    return res.json({ type: 'sku', action, product, item })
  }

  return res.json({ type: 'not_found', value: v })
})

// POST /api/orders/:id/generate-installation-docs
// Fusionne en un seul PDF les copies locales (uploads/products/docs/*) :
//   - item_type='Remplacement' → lien_pdf_remplacement_<lang>_local
//   - sinon                     → lien_pdf_installation_<lang>_local
// où <lang> = fr|en selon resolveInstallationDocsLang (contact de l'adresse de
// livraison en tête), sauf si l'opérateur force `lang` (body ou query).
// Dedup par (product_id, doc_type) — un produit présent N fois ne génère qu'un doc.
// Si un *_local est CSV (multi-URL), tous les fichiers sont inclus.
// Les items dont le PDF local manque sont silencieusement ignorés.
router.post('/:id/generate-installation-docs', async (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  // Depuis une fiche Envoi : seulement les articles de cet envoi (repli sur
  // toute la commande s'il n'en a aucun, comme la fiche), langue de SON adresse.
  const shipmentId = req.body?.shipment_id ?? req.query?.shipment_id;
  const shipment = shipmentId
    ? db.prepare('SELECT id, address_id FROM shipments WHERE id = ? AND order_id = ? AND deleted_at IS NULL').get(shipmentId, order.id)
    : null;
  if (shipmentId && !shipment) return res.status(404).json({ error: 'Envoi introuvable pour cette commande' });

  const itemsSql = (where) => `
    SELECT oi.id, oi.item_type, oi.product_id, p.name_fr as product_name, p.sku,
      p.lien_pdf_installation_fr_local, p.lien_pdf_installation_en_local,
      p.lien_pdf_remplacement_fr_local, p.lien_pdf_remplacement_en_local
    FROM order_items oi
    LEFT JOIN products p ON oi.product_id = p.id
    WHERE ${where}
    ORDER BY oi.created_at
  `;
  let items = shipment ? db.prepare(itemsSql('oi.shipment_id = ?')).all(shipment.id) : [];
  if (items.length === 0) items = db.prepare(itemsSql('oi.order_id = ?')).all(req.params.id);

  const resolved = resolveInstallationDocsLang(shipment?.address_id ? { ...order, address_id: shipment.address_id } : order);
  const override = normalizeDocsLang(req.body?.lang ?? req.query?.lang);
  const lang = override || resolved.lang;
  const langSource = override ? 'override' : resolved.source;
  const uploadsRoot = uploadsPath();

  const merged = await PDFLibDocument.create();
  const included = [];
  const skipped = [];
  const seen = new Set();

  for (const item of items) {
    if (!item.product_id) {
      skipped.push({ item_id: item.id, sku: item.sku, name: item.product_name, reason: 'no_product' });
      continue;
    }
    const docType = item.item_type === 'Remplacement' ? 'remplacement' : 'installation';
    const dedupKey = `${item.product_id}:${docType}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const col = `lien_pdf_${docType}_${lang}_local`;
    const csvPaths = item[col];
    const paths = (csvPaths || '').split(',').map(s => s.trim()).filter(Boolean);
    if (paths.length === 0) {
      skipped.push({ item_id: item.id, sku: item.sku, name: item.product_name, doc_type: docType, lang, reason: 'no_local_copy' });
      continue;
    }

    for (const relPath of paths) {
      const absPath = path.resolve(uploadsRoot, relPath);
      // Garde-fou : doit être sous uploads/products/docs/
      const allowed = path.resolve(uploadsRoot, 'products', 'docs');
      if (!absPath.startsWith(allowed + path.sep)) {
        skipped.push({ item_id: item.id, sku: item.sku, reason: 'path_outside_allowed' });
        continue;
      }
      if (!fs.existsSync(absPath)) {
        skipped.push({ item_id: item.id, sku: item.sku, name: item.product_name, doc_type: docType, lang, path: relPath, reason: 'file_missing' });
        continue;
      }
      try {
        const bytes = fs.readFileSync(absPath);
        const src = await PDFLibDocument.load(bytes, { ignoreEncryption: true });
        const pages = await merged.copyPages(src, src.getPageIndices());
        pages.forEach(p => merged.addPage(p));
        included.push({ item_id: item.id, sku: item.sku, name: item.product_name, doc_type: docType, lang, path: relPath, pages: pages.length });
      } catch (e) {
        skipped.push({ item_id: item.id, sku: item.sku, name: item.product_name, doc_type: docType, lang, path: relPath, reason: 'parse_error', error: e.message });
      }
    }
  }

  if (merged.getPageCount() === 0) {
    return res.status(409).json({
      error: `Aucun document ${lang === 'en' ? 'anglais' : 'français'} disponible pour les items de cette commande.`,
      lang, lang_source: langSource, included, skipped,
    });
  }

  const out = await merged.save();
  const filename = `documents-commande-${order.order_number}-${lang}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.setHeader('X-Docs-Included', String(included.length));
  res.setHeader('X-Docs-Skipped', String(skipped.length));
  res.setHeader('X-Docs-Lang', lang);
  res.setHeader('X-Docs-Lang-Source', langSource);
  res.send(Buffer.from(out));
});

// DELETE /api/orders/:id
router.delete('/:id', async (req, res) => {
  const existing = db.prepare('SELECT id FROM orders WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Order not found' });

  // ?hard=true → suppression DÉFINITIVE (admin only). Supprime aussi les
  // order_items (FK ON). Réservé au nettoyage de commandes jetables (résidus de
  // tests E2E, junk). Émet 'deleted' + le trigger change_log pose un tombstone
  // → les clients retirent la commande de leur cache. Le défaut reste le
  // soft-delete (deleted_at) pour les vraies commandes.
  const hard = req.query.hard === 'true' || req.query.hard === '1';
  if (hard) {
    if (!hasRole(req.user, 'admin')) {
      return res.status(403).json({ error: 'Admin access required for permanent delete' });
    }
    try {
      db.transaction(() => {
        db.prepare('DELETE FROM order_items WHERE order_id = ?').run(req.params.id);
        db.prepare('DELETE FROM orders WHERE id = ?').run(req.params.id);
      })();
    } catch (e) {
      // FK (serials, factures…) → on refuse plutôt que de corrompre.
      return res.status(409).json({ error: 'Permanent delete blocked by dependencies: ' + e.message });
    }
    emitOrder('deleted', req.params.id, req.user?.id);
    return res.json({ message: 'Deleted permanently' });
  }

  const result = await deleteOrder(req.params.id);
  if (result.status !== 200) return res.status(result.status).json({ error: result.error, shipment_ids: result.shipment_ids });
  emitOrder('deleted', req.params.id, req.user?.id);
  res.json({ message: 'Deleted' });
});

// POST /api/orders/:id/bon-livraison — generate delivery note PDF
router.post('/:id/bon-livraison', async (req, res) => {
  const order = db.prepare(
    `SELECT o.*, c.name as company_name, c.address as company_address, c.city as company_city,
      c.province as company_province, c.country as company_country,
      a.line1 as address_line1, a.city as address_city,
      a.province as address_province, a.postal_code as address_postal_code, a.country as address_country
     FROM orders o
     LEFT JOIN companies c ON o.company_id = c.id
     LEFT JOIN adresses a ON o.address_id = a.id
     WHERE o.id = ? AND o.deleted_at IS NULL`
  ).get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const items = db.prepare(
    `SELECT oi.*, pr.name_fr as product_name, pr.sku
     FROM order_items oi
     LEFT JOIN products pr ON oi.product_id = pr.id
     WHERE oi.order_id = ?
     ORDER BY oi.created_at`
  ).all(req.params.id);

  const uploadsDir = ensureUploadsDir('bons-livraison')

  const filename = `bon-livraison-${order.order_number}-${Date.now()}.pdf`;
  const filepath = path.join(uploadsDir, filename);

  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
    const stream = fs.createWriteStream(filepath);
    doc.pipe(stream);
    stream.on('finish', resolve);
    stream.on('error', reject);

    const pageWidth = doc.page.width - 100; // margins 50 each side

    // ── Header ──────────────────────────────────────────────────────────────
    doc.fontSize(22).font('Helvetica-Bold').text('BON DE LIVRAISON', 50, 50);
    doc.fontSize(11).font('Helvetica').fillColor('#555555')
      .text(`Commande #${order.order_number}`, 50, 80);
    const dateStr = new Date().toLocaleDateString('fr-CA', { year: 'numeric', month: 'long', day: 'numeric' });
    doc.text(`Généré le ${dateStr}`, 50, 95);
    if (order.date_commande) {
      const cmdDate = new Date(order.date_commande).toLocaleDateString('fr-CA', { year: 'numeric', month: 'long', day: 'numeric' });
      doc.text(`Date de commande : ${cmdDate}`, 50, 110);
    }

    // ── Divider ──────────────────────────────────────────────────────────────
    doc.moveTo(50, 130).lineTo(50 + pageWidth, 130).strokeColor('#cccccc').lineWidth(1).stroke();

    // ── Client address ───────────────────────────────────────────────────────
    doc.fillColor('#000000').fontSize(12).font('Helvetica-Bold').text('LIVRER À', 50, 145);
    doc.fontSize(11).font('Helvetica');
    let addrY = 162;

    if (order.company_name) {
      doc.fillColor('#000000').text(order.company_name, 50, addrY);
      addrY += 15;
    }

    // Use order address if available, otherwise fall back to company address
    const hasOrderAddr = order.address_line1;
    if (hasOrderAddr) {
      doc.fillColor('#333333').text(order.address_line1, 50, addrY); addrY += 15;
      const cityLine = [order.address_city, order.address_province, order.address_postal_code].filter(Boolean).join('  ');
      if (cityLine) { doc.text(cityLine, 50, addrY); addrY += 15; }
      if (order.address_country) { doc.text(order.address_country, 50, addrY); addrY += 15; }
    } else if (order.company_address || order.company_city) {
      if (order.company_address) { doc.fillColor('#333333').text(order.company_address, 50, addrY); addrY += 15; }
      const cityLine = [order.company_city, order.company_province].filter(Boolean).join('  ');
      if (cityLine) { doc.text(cityLine, 50, addrY); addrY += 15; }
      if (order.company_country) { doc.text(order.company_country, 50, addrY); addrY += 15; }
    } else {
      doc.fillColor('#999999').text('Aucune adresse enregistrée', 50, addrY); addrY += 15;
    }

    // ── Divider ──────────────────────────────────────────────────────────────
    const tableY = addrY + 20;
    doc.moveTo(50, tableY).lineTo(50 + pageWidth, tableY).strokeColor('#cccccc').lineWidth(1).stroke();

    // ── Items table header ───────────────────────────────────────────────────
    const col = { product: 50, sku: 320, qty: 430, notes: 470 };
    const headerY = tableY + 10;
    doc.fillColor('#000000').fontSize(10).font('Helvetica-Bold');
    doc.text('PRODUIT', col.product, headerY);
    doc.text('SKU', col.sku, headerY);
    doc.text('QTÉ', col.qty, headerY);
    doc.text('NOTES', col.notes, headerY);

    doc.moveTo(50, headerY + 16).lineTo(50 + pageWidth, headerY + 16).strokeColor('#cccccc').lineWidth(0.5).stroke();

    // ── Items rows ───────────────────────────────────────────────────────────
    let rowY = headerY + 24;
    doc.font('Helvetica').fontSize(10).fillColor('#222222');

    if (items.length === 0) {
      doc.fillColor('#999999').text('Aucun article dans cette commande.', col.product, rowY);
    } else {
      for (const item of items) {
        if (rowY > doc.page.height - 100) { doc.addPage(); rowY = 50; }

        doc.fillColor('#222222').text(item.product_name || 'Produit inconnu', col.product, rowY, { width: 260, ellipsis: true });
        doc.text(item.sku || '—', col.sku, rowY, { width: 100 });
        doc.text(String(item.qty), col.qty, rowY, { width: 35 });
        if (item.notes) doc.fillColor('#666666').text(item.notes, col.notes, rowY, { width: 80, ellipsis: true });

        rowY += 18;
        doc.moveTo(50, rowY - 4).lineTo(50 + pageWidth, rowY - 4).strokeColor('#eeeeee').lineWidth(0.5).stroke();
        doc.fillColor('#222222');
      }
    }

    // ── Footer ───────────────────────────────────────────────────────────────
    const footerY = doc.page.height - 60;
    doc.moveTo(50, footerY).lineTo(50 + pageWidth, footerY).strokeColor('#cccccc').lineWidth(1).stroke();
    doc.fillColor('#999999').fontSize(9).font('Helvetica')
      .text(`ERP Orisha · Commande #${order.order_number} · ${dateStr}`, 50, footerY + 10, { align: 'center', width: pageWidth });

    doc.end();
  });

  // Store relative path in DB
  const relPath = `bons-livraison/${filename}`;
  db.prepare(`UPDATE orders SET bon_livraison_path = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(relPath, req.params.id);

  emitOrder('updated', req.params.id, req.user?.id);
  res.json({ bon_livraison_path: relPath, url: `/api/bons-livraison/${filename}` });
});

export default router;
