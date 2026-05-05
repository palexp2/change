import { Router } from 'express';
import db from '../db/database.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { getUsdCadRate } from '../services/fx.js';

const router = Router();
router.use(requireAuth);

// GET /api/dashboard
router.get('/', (req, res) => {
  // Project goal (target count + end date)
  const goalSettings = db.prepare("SELECT key, value FROM connector_config WHERE connector = 'dashboard_goal'").all();
  const goalTarget = Number(goalSettings.find(s => s.key === 'target_qty')?.value || 0);
  const goalEndDate = goalSettings.find(s => s.key === 'end_date')?.value || null;
  const goalStartDate = goalSettings.find(s => s.key === 'start_date')?.value || (new Date().getFullYear() + '-01-01');

  let goalCurrentCount = 0;
  if (goalTarget > 0 && goalEndDate) {
    // Utilise `creation` (champ canonique unifié) pour compter les projets réellement
    // créés dans la fenêtre, peu importe quand la ligne a été insérée en DB.
    goalCurrentCount = db.prepare(`
      SELECT COUNT(*) as count FROM projects
      WHERE creation >= ? AND creation <= ? AND deleted_at IS NULL
    `).get(goalStartDate + 'T00:00:00Z', goalEndDate + 'T23:59:59Z').count;
  }
  // Companies by lifecycle phase
  const companiesByPhase = db.prepare(
    `SELECT lifecycle_phase, COUNT(*) as count FROM companies GROUP BY lifecycle_phase ORDER BY count DESC`
  ).all();

  // Projects by status with values
  const projectsByStatus = db.prepare(
    `SELECT status, COUNT(*) as count, SUM(value_cad) as total_value, SUM(value_cad * probability / 100.0) as weighted_value
     FROM projects WHERE deleted_at IS NULL GROUP BY status`
  ).all();

  // Orders by status
  const ordersByStatus = db.prepare(
    `SELECT status, COUNT(*) as count FROM orders GROUP BY status`
  ).all();

  // Low stock count
  const lowStockCount = db.prepare(
    `SELECT COUNT(*) as count FROM products WHERE active = 1 AND min_stock > 0 AND stock_qty <= min_stock`
  ).get();

  // Open tickets count
  const openTickets = db.prepare(
    `SELECT COUNT(*) as count FROM tickets WHERE status != 'Fermé'`
  ).get();

  // Monthly revenue (orders marked Envoyée this month)
  const monthlyRevenue = db.prepare(
    `SELECT COALESCE(SUM(oi.qty * COALESCE(oi.shipped_unit_cost, oi.unit_cost)), 0) as revenue
     FROM orders o
     JOIN order_items oi ON oi.order_id = o.id
     WHERE o.status = 'Envoyée'
     AND strftime('%Y-%m', o.updated_at) = strftime('%Y-%m', 'now')`
  ).get();

  // Total companies count
  const companiesTotal = db.prepare('SELECT COUNT(*) as count FROM companies').get();

  // Pipeline summary
  const pipelineOpen = projectsByStatus.find(p => p.status === 'Ouvert') || { count: 0, total_value: 0, weighted_value: 0 };
  const _pipelineWon = projectsByStatus.find(p => p.status === 'Gagné') || { count: 0, total_value: 0 };

  // Won this month
  const wonThisMonth = db.prepare(
    `SELECT COUNT(*) as count, SUM(value_cad) as total FROM projects WHERE deleted_at IS NULL AND status = 'Gagné' AND strftime('%Y-%m', updated_at) = strftime('%Y-%m', 'now')`
  ).get();

  // Weekly shipments (last 16 weeks)
  const weeklyShipments = db.prepare(`
    SELECT
      date(shipped_at, '-' || ((cast(strftime('%w', shipped_at) as integer) + 6) % 7) || ' days') as week_start,
      COUNT(*) as count
    FROM shipments
    WHERE shipped_at IS NOT NULL AND shipped_at >= date('now', '-112 days')
    GROUP BY week_start
    ORDER BY week_start ASC
  `).all();

  // Projects created by month — last 24 months (current year + previous year for YoY comparison).
  // Source de date: `creation` — champ canonique, rempli pour TOUS les projets (importés
  // d'Airtable ou créés nativement dans l'ERP, voir backfill schema.js + POST projects.js).
  // Bucketing en UTC (strftime sur la valeur stockée). Airtable encode les dates « date-only »
  // en minuit UTC du jour choisi par l'utilisateur, donc le mois UTC = mois choisi. Le front
  // (`fmtDate()`) détecte ce pattern et l'affiche en UTC aussi → cohérent.
  const projectsCreatedByMonth = db.prepare(`
    SELECT strftime('%Y-%m', creation) AS month, COUNT(*) AS count
    FROM projects
    WHERE deleted_at IS NULL
      AND creation IS NOT NULL
      AND creation >= date('now', 'start of month', '-24 months')
    GROUP BY month
    ORDER BY month ASC
  `).all();

  // Closing rate by month × type (last 12 months) — use close_date, fall back to updated_at
  const closingByMonth = db.prepare(`
    SELECT
      strftime('%Y-%m', COALESCE(close_date, updated_at)) as month,
      COALESCE(type, '') as type,
      SUM(CASE WHEN status = 'Gagné' THEN 1 ELSE 0 END) as won,
      SUM(CASE WHEN status = 'Perdu' THEN 1 ELSE 0 END) as lost
    FROM projects
    WHERE deleted_at IS NULL
      AND status IN ('Gagné', 'Perdu')
      AND COALESCE(close_date, updated_at) >= date('now', '-12 months')
    GROUP BY month, type
    ORDER BY month, type
  `).all();

  // Weekly support quality stats (last 16 weeks, week starts Sunday)
  const weeklySupportStats = db.prepare(`
    SELECT
      date(created_at, '-' || cast(strftime('%w', created_at) as integer) || ' days') as week_start,
      COUNT(*) as total,
      SUM(CASE WHEN escalade IN ('Software', 'Hardware') THEN 1 ELSE 0 END) as with_issue,
      SUM(CASE WHEN CAST(duration_minutes AS INTEGER) > 15 THEN 1 ELSE 0 END) as over_15min,
      SUM(CASE WHEN est_ce_que_le_probleme_a_ete_regle_grace_a_l_arbre IS NOT NULL AND est_ce_que_le_probleme_a_ete_regle_grace_a_l_arbre != '' THEN 1 ELSE 0 END) as with_arbre
    FROM tickets
    WHERE created_at >= date('now', '-112 days')
    GROUP BY week_start
    ORDER BY week_start DESC
  `).all();

  // Geo clients — customers only, using the FIRST shipping address registered
  // (earliest adresses.created_at) per company. Excludes soft-deleted companies.
  const geoClients = db.prepare(`
    WITH ranked AS (
      SELECT ct.company_id, a.province, a.country,
        ROW_NUMBER() OVER (
          PARTITION BY ct.company_id
          ORDER BY a.created_at ASC, a.id ASC
        ) AS rn
      FROM adresses a
      JOIN contacts ct ON ct.id = a.contact_id
      WHERE a.address_type = 'Livraison'
        AND a.province IS NOT NULL AND a.province != ''
        AND ct.company_id IS NOT NULL
    )
    SELECT r.province, r.country, COUNT(*) AS count
    FROM ranked r
    JOIN companies co ON co.id = r.company_id
    WHERE r.rn = 1
      AND co.deleted_at IS NULL
      AND co.lifecycle_phase = 'Customer'
    GROUP BY r.province, r.country
    ORDER BY count DESC
  `).all();

  // Customers with no usable shipping address province (cannot be placed on the map)
  const geoClientsUnplaced = db.prepare(`
    SELECT COUNT(*) AS count
    FROM companies c
    WHERE c.deleted_at IS NULL
      AND c.lifecycle_phase = 'Customer'
      AND c.id NOT IN (
        SELECT ct.company_id FROM adresses a
        JOIN contacts ct ON ct.id = a.contact_id
        WHERE a.address_type = 'Livraison'
          AND a.province IS NOT NULL AND a.province != ''
          AND ct.company_id IS NOT NULL
      )
  `).get().count;

  // Weekly profitability — last 16 weeks, fully-shipped orders ('Envoyé')
  // Excludes orders that are 100% replacement (no Facturable items)
  // Revenue: SUM(factures.amount_before_tax_cad) — montant HT, taxes exclues
  //   (les taxes perçues doivent être remises au gouvernement, ce ne sont pas des revenus)
  //   linked directly to order OR via order's project (1 project = 1 order)
  // COGS: SUM(shipped_unit_cost or unit_cost * qty) for Facturable items only
  // Grouped by week of last shipment, split by is_subscription
  const weeklyProfitability = db.prepare(`
    WITH shipped_orders AS (
      SELECT
        o.id AS order_id,
        o.project_id,
        o.is_subscription,
        date(
          MAX(s.shipped_at),
          '-' || ((CAST(strftime('%w', MAX(s.shipped_at)) AS INTEGER) + 6) % 7) || ' days'
        ) AS week_start
      FROM orders o
      JOIN shipments s ON s.order_id = o.id
      WHERE o.status = 'Envoyé'
        AND s.shipped_at IS NOT NULL
        AND s.shipped_at >= date('now', '-112 days')
        AND EXISTS (
          SELECT 1 FROM order_items oi
          WHERE oi.order_id = o.id AND oi.item_type = 'Facturable'
        )
      GROUP BY o.id
    ),
    order_revenue AS (
      SELECT so.order_id,
        CASE WHEN so.is_subscription = 1 THEN
          COALESCE((
            SELECT f.amount_before_tax_cad * 38
            FROM factures f
            WHERE (f.order_id = so.order_id
                OR (so.project_id IS NOT NULL AND f.project_id = so.project_id))
            ORDER BY COALESCE(f.document_date, f.created_at) ASC
            LIMIT 1
          ), 0)
        ELSE
          COALESCE((
            SELECT SUM(f.amount_before_tax_cad)
            FROM factures f
            WHERE (f.order_id = so.order_id
                OR (so.project_id IS NOT NULL AND f.project_id = so.project_id))
          ), 0)
        END AS revenue
      FROM shipped_orders so
    ),
    order_cogs AS (
      SELECT oi.order_id, SUM(COALESCE(oi.shipped_unit_cost, oi.unit_cost) * oi.qty) AS cogs
      FROM order_items oi
      WHERE oi.item_type = 'Facturable'
      GROUP BY oi.order_id
    )
    SELECT
      so.week_start,
      so.is_subscription,
      SUM(COALESCE(r.revenue, 0)) AS revenue,
      SUM(COALESCE(c.cogs, 0)) AS cogs
    FROM shipped_orders so
    LEFT JOIN order_revenue r ON r.order_id = so.order_id
    LEFT JOIN order_cogs c ON c.order_id = so.order_id
    GROUP BY so.week_start, so.is_subscription
    ORDER BY so.week_start ASC
  `).all();

  // Orders shipped in last 28 days (status = 'Envoyé', last shipment date)
  const recentShippedOrders = db.prepare(`
    WITH order_cogs AS (
      SELECT oi.order_id, SUM(COALESCE(oi.shipped_unit_cost, oi.unit_cost) * oi.qty) AS cogs
      FROM order_items oi
      WHERE oi.item_type = 'Facturable'
      GROUP BY oi.order_id
    )
    SELECT
      o.id, o.order_number, o.is_subscription, o.status, o.project_id,
      c.name AS company_name, o.company_id,
      MAX(s.shipped_at) AS last_shipped_at,
      -- Revenu HT (amount_before_tax_cad) — taxes exclues, voir weeklyProfitability ci-dessus
      CASE WHEN o.is_subscription = 1 THEN
        COALESCE((
          SELECT f.amount_before_tax_cad * 38
          FROM factures f
          WHERE (f.order_id = o.id
              OR (o.project_id IS NOT NULL AND f.project_id = o.project_id))
          ORDER BY COALESCE(f.document_date, f.created_at) ASC
          LIMIT 1
        ), 0)
      ELSE
        COALESCE((
          SELECT SUM(f.amount_before_tax_cad)
          FROM factures f
          WHERE (f.order_id = o.id
              OR (o.project_id IS NOT NULL AND f.project_id = o.project_id))
        ), 0)
      END AS revenue,
      COALESCE(cogs.cogs, 0) AS cogs
    FROM orders o
    JOIN shipments s ON s.order_id = o.id
    LEFT JOIN companies c ON c.id = o.company_id
    LEFT JOIN order_cogs cogs ON cogs.order_id = o.id
    WHERE o.status = 'Envoyé'
      AND s.shipped_at IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM order_items oi
        WHERE oi.order_id = o.id AND oi.item_type = 'Facturable'
      )
    GROUP BY o.id
    HAVING MAX(s.shipped_at) >= date('now', '-28 days')
    ORDER BY MAX(s.shipped_at) DESC
  `).all();

  // Inventory valuation — "Pièces" from products (stock_qty × unit_cost)
  // + serial_numbers by status (manufacture_value), excluding statuses that
  // aren't actually held in inventory (sold, destroyed, in-use, unknown, not built)
  const EXCLUDED_SN_STATUSES = [
    'Opérationnel - Vendu',
    'Opérationnel - Loué',
    'Détruit',
    "Utilisé par l'équipe Orisha",
    'Inconnu',
    'Non construit',
  ];
  const piecesInventory = db.prepare(`
    SELECT COALESCE(SUM(stock_qty * unit_cost), 0) AS total_value,
           COALESCE(SUM(CASE WHEN stock_qty > 0 THEN 1 ELSE 0 END), 0) AS count
    FROM products
    WHERE active = 1
      AND (type IS NULL OR type NOT IN ('PIÈCE OBSOLÈTE', 'PRODUIT OBSOLÈTE'))
  `).get();
  const placeholders = EXCLUDED_SN_STATUSES.map(() => '?').join(',');
  const serialInventoryByStatus = db.prepare(`
    SELECT status,
           COUNT(*) AS count,
           COALESCE(SUM(manufacture_value), 0) AS total_value
    FROM serial_numbers
    WHERE status IS NOT NULL AND status != ''
      AND status NOT IN (${placeholders})
    GROUP BY status
    ORDER BY total_value DESC
  `).all(...EXCLUDED_SN_STATUSES);

  // Replacement rate — monthly for last 12 months
  // Cost: manufacture_value for serialized items, unit_cost×qty otherwise
  // Only Remplacement items on fully shipped orders
  const parkValue = db.prepare(`
    SELECT COALESCE(SUM(manufacture_value), 0) AS total
    FROM serial_numbers
    WHERE (
        status = 'Opérationnel - Loué'
        OR (status = 'Opérationnel - Vendu' AND statut_de_garantie = 'Sous garantie')
      )
  `).get().total;

  // Replacement cost — rolling 28 days
  const replacementLast28 = db.prepare(`
    WITH shipped_orders AS (
      SELECT o.id AS order_id, MAX(s.shipped_at) AS last_shipped_at
      FROM orders o
      JOIN shipments s ON s.order_id = o.id
      WHERE o.status = 'Envoyé'
        AND s.shipped_at IS NOT NULL
        AND s.shipped_at >= date('now', '-28 days')
      GROUP BY o.id
    ),
    sn_agg AS (
      SELECT order_item_id, SUM(manufacture_value) AS total_value
      FROM serial_numbers GROUP BY order_item_id
    )
    SELECT COALESCE(SUM(
      CASE WHEN sn_agg.total_value IS NOT NULL THEN sn_agg.total_value
           ELSE COALESCE(oi.shipped_unit_cost, oi.unit_cost) * oi.qty
      END
    ), 0) AS cost
    FROM shipped_orders so
    JOIN order_items oi ON oi.order_id = so.order_id AND oi.item_type = 'Remplacement'
    LEFT JOIN sn_agg ON sn_agg.order_item_id = oi.id
  `).get().cost;

  const replacementByMonth = db.prepare(`
    WITH shipped_orders AS (
      SELECT o.id AS order_id, MAX(s.shipped_at) AS last_shipped_at
      FROM orders o
      JOIN shipments s ON s.order_id = o.id
      WHERE o.status = 'Envoyé'
        AND s.shipped_at IS NOT NULL
        AND s.shipped_at >= date('now', '-12 months')
      GROUP BY o.id
    ),
    sn_agg AS (
      SELECT order_item_id, SUM(manufacture_value) AS total_value
      FROM serial_numbers GROUP BY order_item_id
    )
    SELECT
      strftime('%Y-%m', so.last_shipped_at) AS month,
      SUM(
        CASE WHEN sn_agg.total_value IS NOT NULL THEN sn_agg.total_value
             ELSE COALESCE(oi.shipped_unit_cost, oi.unit_cost) * oi.qty
        END
      ) AS replacement_cost,
      COUNT(DISTINCT so.order_id) AS nb_orders
    FROM shipped_orders so
    JOIN order_items oi ON oi.order_id = so.order_id AND oi.item_type = 'Remplacement'
    LEFT JOIN sn_agg ON sn_agg.order_item_id = oi.id
    GROUP BY month
    ORDER BY month ASC
  `).all();

  // Weekly shipping costs — aggregate account 65000 "Expédition, livraison et poste"
  // from achats_fournisseurs (both QB Bills and Purchases).
  // Line amounts are in transaction currency; multiply by exchange_rate for CAD.
  const shippingRows = db.prepare(`
    SELECT date_achat AS txn_date, lines, exchange_rate FROM achats_fournisseurs
    WHERE lines LIKE '%Expédition%'
      AND date_achat >= date('now', '-370 days')
  `).all();

  // Per transaction: CAD amount on the expédition account
  const shippingByDate = {};
  for (const row of shippingRows) {
    if (!row.lines) continue;
    let lines;
    try { lines = JSON.parse(row.lines); } catch { continue; }
    const fx = Number(row.exchange_rate) > 0 ? Number(row.exchange_rate) : 1;
    let amount = 0;
    for (const l of lines) {
      if (l.account_name && l.account_name.includes('Expédition')) {
        amount += (l.amount || 0) * fx;
      }
    }
    if (amount <= 0) continue;
    shippingByDate[row.txn_date] = (shippingByDate[row.txn_date] || 0) + amount;
  }

  // Rolling 28-day sum anchored on each Monday (inclusive of the Monday itself).
  // E.g. Monday 30 mars → sum all transactions from 2 mars to 30 mars inclusive.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const mondayThisWeek = new Date(today);
  mondayThisWeek.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const weeklyShippingCosts = [];
  for (let i = 3; i >= 0; i--) {
    const anchor = new Date(mondayThisWeek);
    anchor.setDate(mondayThisWeek.getDate() - i * 7);
    const windowStart = new Date(anchor);
    windowStart.setDate(anchor.getDate() - 27); // 28-day window, inclusive
    let total = 0;
    for (const [date, amt] of Object.entries(shippingByDate)) {
      const d = new Date(date + 'T00:00:00');
      if (d >= windowStart && d <= anchor) total += amt;
    }
    weeklyShippingCosts.push({
      week_start: anchor.toISOString().slice(0, 10),
      amount: Math.round(total * 100) / 100,
    });
  }

  // Replacement line items detail — last 12 months
  const replacementItems = db.prepare(`
    WITH shipped_orders AS (
      SELECT o.id AS order_id, o.order_number, c.name AS company_name,
             MAX(s.shipped_at) AS shipped_at
      FROM orders o
      JOIN shipments s ON s.order_id = o.id
      LEFT JOIN companies c ON c.id = o.company_id
      WHERE o.status = 'Envoyé'
        AND s.shipped_at IS NOT NULL
        AND s.shipped_at >= date('now', '-12 months')
      GROUP BY o.id
    ),
    sn_agg AS (
      SELECT order_item_id, SUM(manufacture_value) AS total_value
      FROM serial_numbers GROUP BY order_item_id
    )
    SELECT
      so.order_number,
      so.company_name,
      so.shipped_at,
      p.name_fr AS product_name,
      oi.qty,
      COALESCE(oi.shipped_unit_cost, oi.unit_cost) AS unit_cost,
      CASE WHEN sn_agg.total_value IS NOT NULL THEN sn_agg.total_value
           ELSE COALESCE(oi.shipped_unit_cost, oi.unit_cost) * oi.qty
      END AS total_cost
    FROM shipped_orders so
    JOIN order_items oi ON oi.order_id = so.order_id AND oi.item_type = 'Remplacement'
    LEFT JOIN products p ON p.id = oi.product_id
    LEFT JOIN sn_agg ON sn_agg.order_item_id = oi.id
    ORDER BY so.shipped_at DESC
  `).all();

  res.json({
    companies: {
      total: companiesTotal.count,
      byPhase: companiesByPhase,
    },
    projects: {
      byStatus: projectsByStatus,
      openCount: pipelineOpen.count,
      openValue: pipelineOpen.total_value || 0,
      weightedValue: pipelineOpen.weighted_value || 0,
      wonThisMonth: wonThisMonth.count,
      wonValueThisMonth: wonThisMonth.total || 0,
    },
    orders: {
      byStatus: ordersByStatus,
      monthlyRevenue: monthlyRevenue.revenue,
    },
    inventory: {
      lowStockCount: lowStockCount.count,
      valuation: {
        pieces: {
          total_value: piecesInventory.total_value,
          count: piecesInventory.count,
        },
        serialsByStatus: serialInventoryByStatus,
      },
    },
    support: {
      openTickets: openTickets.count,
    },
    closingByMonth,
    projectsCreatedByMonth,
    weeklyShipments,
    weeklySupportStats,
    geoClients,
    geoClientsUnplaced,
    weeklyProfitability,
    recentShippedOrders,
    replacementRate: { parkValue, last28: replacementLast28, byMonth: replacementByMonth, items: replacementItems },
    weeklyShippingCosts,
    projectGoal: {
      target: goalTarget,
      current: goalCurrentCount,
      start_date: goalStartDate,
      end_date: goalEndDate
    }
  });
});

// GET /api/dashboard/stripe-revenue
// Ventes et abonnements Stripe sur les 24 derniers mois, breakdown par mois
// et par type :
//   - service  → facture liée à un abonnement Stripe (subscription_id IS NOT NULL)
//   - achat    → facture sans abonnement (vente ponctuelle)
// Les remboursements (sync_source='Remboursements Stripe' + payments avec
// stripe_refund_id) sont déduits du bucket correspondant. Classification d'un
// remboursement legacy (dont subscription_id n'est pas posé) :
//   1. Si subscription_id présent → service.
//   2. Sinon, on cherche une facture originale du même client, même devise,
//      avec un montant HT proche (±0,5 $) → on prend son subscription_id.
//   3. Sinon, profil du client : si toutes ses factures Stripe sont des
//      abonnements → service ; sinon → achat (cas par défaut, plus fréquent).
// Bucketing par mois sur document_date. Filtre Stripe encaissés :
// sync_source='Factures Stripe' + status='Payé'. Hors taxes : amount_before_tax_cad
// porte le subtotal HT (en monnaie native). USD converti au taux BoC du jour
// du document_date.
router.get('/stripe-revenue', async (req, res) => {
  const sales = db.prepare(`
    SELECT id, currency, amount_before_tax_cad, document_date,
           subscription_id
    FROM factures
    WHERE sync_source = 'Factures Stripe'
      AND status = 'Payé'
      AND document_date IS NOT NULL
      AND document_date >= date('now', 'start of month', '-23 months')
  `).all();

  // Remboursements legacy stockés comme factures
  const refundFactures = db.prepare(`
    SELECT id, currency, ABS(COALESCE(amount_before_tax_cad, 0)) AS amount,
           document_date, subscription_id, company_id
    FROM factures
    WHERE sync_source = 'Remboursements Stripe'
      AND document_date IS NOT NULL
      AND document_date >= date('now', 'start of month', '-23 months')
      AND COALESCE(amount_before_tax_cad, 0) != 0
  `).all();

  // Remboursements modernes (webhook charge.refunded → table payments)
  const refundPayments = db.prepare(`
    SELECT p.id, p.received_at AS document_date, p.amount, p.currency,
           f.subscription_id
    FROM payments p
    JOIN factures f ON f.id = p.facture_id
    WHERE p.stripe_refund_id IS NOT NULL
      AND p.received_at >= date('now', 'start of month', '-23 months')
  `).all();

  const rateCache = new Map();
  async function rateFor(date) {
    if (!date) return 1;
    const key = date.slice(0, 10);
    if (rateCache.has(key)) return rateCache.get(key);
    let r = null;
    try { r = await getUsdCadRate(key); } catch { r = null; }
    const v = r || 1;
    rateCache.set(key, v);
    return v;
  }

  const matchOrig = db.prepare(`
    SELECT subscription_id
    FROM factures
    WHERE company_id = ?
      AND sync_source = 'Factures Stripe'
      AND status = 'Payé'
      AND currency = ?
      AND ABS(COALESCE(amount_before_tax_cad, 0) - ?) < 0.5
      AND document_date <= ?
    ORDER BY document_date DESC
    LIMIT 1
  `);
  const companyProfile = db.prepare(`
    SELECT
      SUM(CASE WHEN subscription_id IS NOT NULL THEN 1 ELSE 0 END) AS sub_count,
      SUM(CASE WHEN subscription_id IS NULL THEN 1 ELSE 0 END) AS order_count
    FROM factures
    WHERE company_id = ?
      AND sync_source = 'Factures Stripe'
      AND status = 'Payé'
  `);

  function classifyRefund(r) {
    if (r.subscription_id) return 'service';
    if (!r.company_id) return 'achat';
    const orig = matchOrig.get(r.company_id, r.currency || 'CAD', r.amount, r.document_date);
    if (orig) return orig.subscription_id ? 'service' : 'achat';
    const prof = companyProfile.get(r.company_id);
    if (prof && (prof.sub_count || 0) > 0 && (prof.order_count || 0) === 0) return 'service';
    return 'achat';
  }

  const byMonth = {}; // { 'YYYY-MM': { service: 0, achat: 0 } }
  function bucket(m) { if (!byMonth[m]) byMonth[m] = { service: 0, achat: 0 }; return byMonth[m]; }

  for (const r of sales) {
    const month = (r.document_date || '').slice(0, 7);
    if (!month) continue;
    const native = r.amount_before_tax_cad || 0;
    let cadAmount = native;
    if ((r.currency || 'CAD').toUpperCase() === 'USD') {
      const rate = await rateFor(r.document_date.slice(0, 10));
      cadAmount = native * rate;
    }
    const b = bucket(month);
    if (r.subscription_id) b.service += cadAmount;
    else b.achat += cadAmount;
  }

  for (const r of refundFactures) {
    const month = (r.document_date || '').slice(0, 7);
    if (!month) continue;
    let cadAmount = r.amount;
    if ((r.currency || 'CAD').toUpperCase() === 'USD') {
      const rate = await rateFor(r.document_date.slice(0, 10));
      cadAmount = r.amount * rate;
    }
    const type = classifyRefund(r);
    const b = bucket(month);
    b[type] -= cadAmount;
  }

  for (const r of refundPayments) {
    const month = (r.document_date || '').slice(0, 7);
    if (!month) continue;
    let cadAmount = r.amount;
    if ((r.currency || 'CAD').toUpperCase() === 'USD') {
      const rate = await rateFor(r.document_date.slice(0, 10));
      cadAmount = r.amount * rate;
    }
    const type = r.subscription_id ? 'service' : 'achat';
    const b = bucket(month);
    b[type] -= cadAmount;
  }

  // Round to cents for transport
  const result = Object.entries(byMonth).map(([month, v]) => ({
    month,
    service: Math.round(v.service * 100) / 100,
    achat: Math.round(v.achat * 100) / 100,
  })).sort((a, b) => a.month.localeCompare(b.month));

  res.json({ byMonth: result });
});

// GET /api/dashboard/goal
router.get('/goal', (req, res) => {
  const settings = db.prepare("SELECT key, value FROM connector_config WHERE connector = 'dashboard_goal'").all();
  const resObj = {
    target_qty: Number(settings.find(s => s.key === 'target_qty')?.value || 0),
    end_date: settings.find(s => s.key === 'end_date')?.value || '',
    start_date: settings.find(s => s.key === 'start_date')?.value || (new Date().getFullYear() + '-01-01'),
  };
  res.json(resObj);
});

// PUT /api/dashboard/goal
router.put('/goal', requireAdmin, (req, res) => {
  const { target_qty, end_date, start_date } = req.body;

  const upsert = db.prepare(`
    INSERT INTO connector_config (connector, key, value)
    VALUES ('dashboard_goal', ?, ?)
    ON CONFLICT(connector, key) DO UPDATE SET value = excluded.value
  `);

  db.transaction(() => {
    upsert.run('target_qty', String(target_qty || 0));
    upsert.run('end_date', end_date || '');
    upsert.run('start_date', start_date || (new Date().getFullYear() + '-01-01'));
  })();

  res.json({ success: true });
});

// GET /api/dashboard/subscription-events
// Retourne les événements d'abonnement classifiés par mois et catégorie pour
// le panel "Mouvements d'abonnements". Catégories couvertes (scope MVP) :
//   new      — nouveaux abonnements
//   churn    — annulations
//   winback  — création où la même entreprise a déjà eu un churn antérieur
//
// Le Net MRR par mois est inclus comme `net_mrr_delta_cad`.
//
// Réponse : { months: [{ month: 'YYYY-MM', categories: {...}, net_mrr_delta_cad }] }
//   où categories[cat] = { count, total_amount_cad, items: [{ event_id, company_id, company_name, sub_id, amount_cad_delta, event_date, details }] }
router.get('/subscription-events', (req, res) => {
  const months = parseInt(req.query.months || '12')
  const startMonth = req.query.start_month || null  // optional: 'YYYY-MM'

  // Borne basse : startMonth si fourni, sinon (today - months) au 1er.
  let cutoff
  if (startMonth) {
    cutoff = `${startMonth}-01T00:00:00Z`
  } else {
    const now = new Date()
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months + 1, 1))
    cutoff = d.toISOString()
  }

  // 1. Tous les events depuis cutoff, joints aux noms d'entreprise et stripe_id du sub
  const events = db.prepare(`
    SELECT
      e.id, e.subscription_id, e.company_id, e.event_date, e.event_type,
      e.category, e.amount_cad_delta, e.previous_amount_cad, e.new_amount_cad,
      e.currency, e.details,
      s.stripe_id, s.amount_monthly,
      co.name AS company_name
    FROM subscription_events e
    LEFT JOIN subscriptions s ON e.subscription_id = s.id
    LEFT JOIN companies co ON e.company_id = co.id
    WHERE e.event_date >= ?
      AND e.category IN ('new', 'churn')
    ORDER BY e.event_date ASC
  `).all(cutoff)

  // 2. Pour la catégorie 'winback', on a besoin de savoir si la company avait
  // déjà eu un churn AVANT l'event 'new'. On fait une seule requête pour
  // récupérer la date du premier churn de chaque company.
  const firstChurnByCompany = {}
  for (const r of db.prepare(`
    SELECT company_id, MIN(event_date) AS first_churn
    FROM subscription_events
    WHERE category = 'churn' AND company_id IS NOT NULL
    GROUP BY company_id
  `).all()) {
    if (r.company_id) firstChurnByCompany[r.company_id] = r.first_churn
  }

  // 3. Bucket par mois et catégorie
  const monthsMap = new Map()  // month → { categories: {cat: {count, total, items}}, net }
  function bucketFor(month) {
    if (!monthsMap.has(month)) {
      monthsMap.set(month, {
        month,
        categories: {
          new:     { count: 0, total_amount_cad: 0, items: [] },
          churn:   { count: 0, total_amount_cad: 0, items: [] },
          winback: { count: 0, total_amount_cad: 0, items: [] },
        },
        net_mrr_delta_cad: 0,
      })
    }
    return monthsMap.get(month)
  }

  for (const e of events) {
    const month = String(e.event_date).slice(0, 7)
    const bucket = bucketFor(month)
    const item = {
      event_id: e.id,
      subscription_id: e.subscription_id,
      stripe_subscription_id: e.stripe_id,
      company_id: e.company_id,
      company_name: e.company_name,
      event_date: e.event_date,
      amount_cad_delta: e.amount_cad_delta,
      previous_amount_cad: e.previous_amount_cad,
      new_amount_cad: e.new_amount_cad,
      currency: e.currency,
    }
    // Net MRR : tous les events 'new' et 'churn' contribuent
    if (e.amount_cad_delta != null) bucket.net_mrr_delta_cad += e.amount_cad_delta

    if (e.category === 'new') {
      // Win-back ? company avait déjà eu un churn AVANT cette date
      const firstChurn = e.company_id ? firstChurnByCompany[e.company_id] : null
      const isWinback = firstChurn && firstChurn < e.event_date
      const cat = isWinback ? 'winback' : 'new'
      bucket.categories[cat].count++
      bucket.categories[cat].total_amount_cad += (e.amount_cad_delta || 0)
      bucket.categories[cat].items.push(item)
    } else if (e.category === 'churn') {
      bucket.categories.churn.count++
      bucket.categories.churn.total_amount_cad += (e.amount_cad_delta || 0)
      bucket.categories.churn.items.push(item)
    }
  }

  // Trie par mois ASC, arrondit les sommes
  const result = [...monthsMap.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map(m => ({
      ...m,
      net_mrr_delta_cad: Math.round(m.net_mrr_delta_cad * 100) / 100,
      categories: Object.fromEntries(
        Object.entries(m.categories).map(([cat, v]) => [cat, {
          ...v,
          total_amount_cad: Math.round(v.total_amount_cad * 100) / 100,
        }])
      ),
    }))

  res.json({ months: result })
})

// GET /api/dashboard/top-products
// Agrège stripe_invoice_items par produit sur la plage [from, to] (factures payées
// uniquement). USD converti en CAD via getUsdCadRate(document_date). Retourne aussi
// la borne min des données pour alimenter le slider côté client.
router.get('/top-products', async (req, res) => {
  const { from, to } = req.query

  const conds = ["f.sync_source = 'Factures Stripe'", "f.status = 'Payé'", 'f.document_date IS NOT NULL']
  const params = []
  if (from) { conds.push('f.document_date >= ?'); params.push(from) }
  if (to)   { conds.push('f.document_date <= ?'); params.push(to) }

  const rows = db.prepare(`
    SELECT sii.product_id, sii.quantity, sii.amount, sii.currency,
           sii.facture_id, f.document_date,
           p.name_fr, p.name_en, p.sku
    FROM stripe_invoice_items sii
    JOIN factures f ON f.id = sii.facture_id
    LEFT JOIN products p ON p.id = sii.product_id
    WHERE ${conds.join(' AND ')}
  `).all(...params)

  const rateCache = new Map()
  async function rateFor(date) {
    if (!date) return 1
    const key = date.slice(0, 10)
    if (rateCache.has(key)) return rateCache.get(key)
    let r = null
    try { r = await getUsdCadRate(key) } catch { r = null }
    const v = r || 1
    rateCache.set(key, v)
    return v
  }

  const byProduct = new Map()
  for (const r of rows) {
    let cad = (r.amount || 0) / 100
    if ((r.currency || 'CAD').toUpperCase() === 'USD') {
      const rate = await rateFor((r.document_date || '').slice(0, 10))
      cad = cad * rate
    }
    const key = r.product_id || '__unlinked__'
    if (!byProduct.has(key)) {
      byProduct.set(key, {
        product_id: r.product_id,
        sku: r.sku, name_fr: r.name_fr, name_en: r.name_en,
        quantity: 0, amount_cad: 0, invoices: new Set(),
      })
    }
    const b = byProduct.get(key)
    b.quantity += r.quantity || 0
    b.amount_cad += cad
    b.invoices.add(r.facture_id)
  }

  const products = [...byProduct.values()].map(p => ({
    product_id: p.product_id,
    sku: p.sku,
    name_fr: p.name_fr,
    name_en: p.name_en,
    quantity: p.quantity,
    amount_cad: Math.round(p.amount_cad * 100) / 100,
    invoice_count: p.invoices.size,
  }))

  const minDate = db.prepare(`
    SELECT MIN(f.document_date) AS d
    FROM stripe_invoice_items sii
    JOIN factures f ON f.id = sii.facture_id
    WHERE f.sync_source = 'Factures Stripe' AND f.status = 'Payé'
      AND f.document_date IS NOT NULL
  `).get()?.d || null

  res.json({
    products,
    range: {
      min_date: minDate,
      max_date: new Date().toISOString().slice(0, 10),
    },
  })
})

export default router;
