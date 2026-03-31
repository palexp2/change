import { Router } from 'express';
import db from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET /api/dashboard
router.get('/', (req, res) => {
  const tid = req.user.tenant_id;

  // Companies by lifecycle phase
  const companiesByPhase = db.prepare(
    `SELECT lifecycle_phase, COUNT(*) as count FROM companies WHERE tenant_id = ? GROUP BY lifecycle_phase ORDER BY count DESC`
  ).all(tid);

  // Projects by status with values
  const projectsByStatus = db.prepare(
    `SELECT status, COUNT(*) as count, SUM(value_cad) as total_value, SUM(value_cad * probability / 100.0) as weighted_value
     FROM projects WHERE tenant_id = ? GROUP BY status`
  ).all(tid);

  // Orders by status
  const ordersByStatus = db.prepare(
    `SELECT status, COUNT(*) as count FROM orders WHERE tenant_id = ? GROUP BY status`
  ).all(tid);

  // Low stock count
  const lowStockCount = db.prepare(
    `SELECT COUNT(*) as count FROM products WHERE tenant_id = ? AND active = 1 AND min_stock > 0 AND stock_qty <= min_stock`
  ).get(tid);

  // Open tickets count
  const openTickets = db.prepare(
    `SELECT COUNT(*) as count FROM tickets WHERE tenant_id = ? AND status != 'Fermé'`
  ).get(tid);

  // Monthly revenue (orders marked Envoyée this month)
  const monthlyRevenue = db.prepare(
    `SELECT COALESCE(SUM(oi.qty * oi.unit_cost), 0) as revenue
     FROM orders o
     JOIN order_items oi ON oi.order_id = o.id
     WHERE o.tenant_id = ? AND o.status = 'Envoyée'
     AND strftime('%Y-%m', o.updated_at) = strftime('%Y-%m', 'now')`
  ).get(tid);

  // Recent orders
  const recentOrders = db.prepare(
    `SELECT o.*, c.name as company_name,
      (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) as items_count,
      (SELECT SUM(oi.qty * oi.unit_cost) FROM order_items oi WHERE oi.order_id = o.id) as total_value
     FROM orders o
     LEFT JOIN companies c ON o.company_id = c.id
     WHERE o.tenant_id = ?
     ORDER BY o.created_at DESC LIMIT 5`
  ).all(tid);

  // Recent tickets
  const recentTickets = db.prepare(
    `SELECT t.*, c.name as company_name, u.name as assigned_name
     FROM tickets t
     LEFT JOIN companies c ON t.company_id = c.id
     LEFT JOIN users u ON t.assigned_to = u.id
     WHERE t.tenant_id = ?
     ORDER BY t.created_at DESC LIMIT 5`
  ).all(tid);

  // Total companies count
  const companiesTotal = db.prepare('SELECT COUNT(*) as count FROM companies WHERE tenant_id = ?').get(tid);

  // Pipeline summary
  const pipelineOpen = projectsByStatus.find(p => p.status === 'Ouvert') || { count: 0, total_value: 0, weighted_value: 0 };
  const pipelineWon = projectsByStatus.find(p => p.status === 'Gagné') || { count: 0, total_value: 0 };

  // Won this month
  const wonThisMonth = db.prepare(
    `SELECT COUNT(*) as count, SUM(value_cad) as total FROM projects WHERE tenant_id = ? AND status = 'Gagné' AND strftime('%Y-%m', updated_at) = strftime('%Y-%m', 'now')`
  ).get(tid);

  // Weekly shipments (last 16 weeks)
  const weeklyShipments = db.prepare(`
    SELECT
      date(shipped_at, '-' || ((cast(strftime('%w', shipped_at) as integer) + 6) % 7) || ' days') as week_start,
      COUNT(*) as count
    FROM shipments
    WHERE tenant_id = ? AND shipped_at IS NOT NULL AND shipped_at >= date('now', '-112 days')
    GROUP BY week_start
    ORDER BY week_start ASC
  `).all(tid);

  // Closing rate by month × type (last 12 months) — use close_date, fall back to updated_at
  const closingByMonth = db.prepare(`
    SELECT
      strftime('%Y-%m', COALESCE(close_date, updated_at)) as month,
      COALESCE(type, '') as type,
      SUM(CASE WHEN status = 'Gagné' THEN 1 ELSE 0 END) as won,
      SUM(CASE WHEN status = 'Perdu' THEN 1 ELSE 0 END) as lost
    FROM projects
    WHERE tenant_id = ?
      AND status IN ('Gagné', 'Perdu')
      AND COALESCE(close_date, updated_at) >= date('now', '-12 months')
    GROUP BY month, type
    ORDER BY month, type
  `).all(tid);

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
  });
});

export default router;
