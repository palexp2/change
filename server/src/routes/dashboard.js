import { Router } from 'express';
import db from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET /api/dashboard
router.get('/', (req, res) => {
  // Companies by lifecycle phase
  const companiesByPhase = db.prepare(
    `SELECT lifecycle_phase, COUNT(*) as count FROM companies GROUP BY lifecycle_phase ORDER BY count DESC`
  ).all();

  // Projects by status with values
  const projectsByStatus = db.prepare(
    `SELECT status, COUNT(*) as count, SUM(value_cad) as total_value, SUM(value_cad * probability / 100.0) as weighted_value
     FROM projects GROUP BY status`
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

  // Recent orders
  const recentOrders = db.prepare(
    `SELECT o.*, c.name as company_name,
      (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) as items_count,
      (SELECT SUM(oi.qty * oi.unit_cost) FROM order_items oi WHERE oi.order_id = o.id) as total_value
     FROM orders o
     LEFT JOIN companies c ON o.company_id = c.id
     ORDER BY o.created_at DESC LIMIT 5`
  ).all();

  // Recent tickets
  const recentTickets = db.prepare(
    `SELECT t.*, c.name as company_name, u.name as assigned_name
     FROM tickets t
     LEFT JOIN companies c ON t.company_id = c.id
     LEFT JOIN users u ON t.assigned_to = u.id
     ORDER BY t.created_at DESC LIMIT 5`
  ).all();

  // Total companies count
  const companiesTotal = db.prepare('SELECT COUNT(*) as count FROM companies').get();

  // Pipeline summary
  const pipelineOpen = projectsByStatus.find(p => p.status === 'Ouvert') || { count: 0, total_value: 0, weighted_value: 0 };
  const pipelineWon = projectsByStatus.find(p => p.status === 'Gagné') || { count: 0, total_value: 0 };

  // Won this month
  const wonThisMonth = db.prepare(
    `SELECT COUNT(*) as count, SUM(value_cad) as total FROM projects WHERE status = 'Gagné' AND strftime('%Y-%m', updated_at) = strftime('%Y-%m', 'now')`
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

  // Closing rate by month × type (last 12 months) — use close_date, fall back to updated_at
  const closingByMonth = db.prepare(`
    SELECT
      strftime('%Y-%m', COALESCE(close_date, updated_at)) as month,
      COALESCE(type, '') as type,
      SUM(CASE WHEN status = 'Gagné' THEN 1 ELSE 0 END) as won,
      SUM(CASE WHEN status = 'Perdu' THEN 1 ELSE 0 END) as lost
    FROM projects
    WHERE status IN ('Gagné', 'Perdu')
      AND COALESCE(close_date, updated_at) >= date('now', '-12 months')
    GROUP BY month, type
    ORDER BY month, type
  `).all();

  // Weekly support quality stats (last 16 weeks, week starts Sunday)
  const weeklySupportStats = db.prepare(`
    SELECT
      date(created_at, '-' || cast(strftime('%w', created_at) as integer) || ' days') as week_start,
      COUNT(*) as total,
      SUM(CASE WHEN numero_de_l_issue_github IS NOT NULL AND numero_de_l_issue_github != '' THEN 1 ELSE 0 END) as with_issue,
      SUM(CASE WHEN CAST(duration_minutes AS INTEGER) > 15 THEN 1 ELSE 0 END) as over_15min,
      SUM(CASE WHEN est_ce_que_le_probleme_a_ete_regle_grace_a_l_arbre IS NOT NULL AND est_ce_que_le_probleme_a_ete_regle_grace_a_l_arbre != '' THEN 1 ELSE 0 END) as with_arbre
    FROM tickets
    WHERE created_at >= date('now', '-112 days')
    GROUP BY week_start
    ORDER BY week_start DESC
  `).all();

  // Geo clients (farm addresses by province/state)
  const geoClients = db.prepare(`
    SELECT a.province, a.country, COUNT(DISTINCT co.id) as count
    FROM adresses a
    JOIN contacts ct ON ct.id = a.contact_id
    JOIN companies co ON co.id = ct.company_id
    WHERE a.address_type = 'Ferme'
      AND a.province IS NOT NULL AND a.province != ''
    GROUP BY a.province, a.country
    ORDER BY count DESC
  `).all();

  // Weekly profitability — last 16 weeks, fully-shipped orders ('Envoyé')
  // Excludes orders that are 100% replacement (no Facturable items)
  // Revenue: SUM(factures.total_amount) linked directly to order OR via order's project (1 project = 1 order)
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
            SELECT f.total_amount * 38
            FROM factures f
            WHERE (f.order_id = so.order_id
                OR (so.project_id IS NOT NULL AND f.project_id = so.project_id))
            ORDER BY COALESCE(f.document_date, f.created_at) ASC
            LIMIT 1
          ), 0)
        ELSE
          COALESCE((
            SELECT SUM(f.total_amount)
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
      CASE WHEN o.is_subscription = 1 THEN
        COALESCE((
          SELECT f.total_amount * 38
          FROM factures f
          WHERE (f.order_id = o.id
              OR (o.project_id IS NOT NULL AND f.project_id = o.project_id))
          ORDER BY COALESCE(f.document_date, f.created_at) ASC
          LIMIT 1
        ), 0)
      ELSE
        COALESCE((
          SELECT SUM(f.total_amount)
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
    },
    support: {
      openTickets: openTickets.count,
    },
    recentOrders,
    recentTickets,
    closingByMonth,
    weeklyShipments,
    weeklySupportStats,
    geoClients,
    weeklyProfitability,
    recentShippedOrders,
    replacementRate: { parkValue, last28: replacementLast28, byMonth: replacementByMonth, items: replacementItems },
  });
});

export default router;
