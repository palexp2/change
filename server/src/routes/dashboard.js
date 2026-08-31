import { Router } from 'express';
import db from '../db/database.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { getUsdCadRate } from '../services/fx.js';
import { diffSnapshots, enrichItemsWithErpProductId } from '../services/subscriptionItemsSnapshot.js';
import { qbGet, onQbMutation } from '../connectors/quickbooks.js';

const router = Router();
router.use(requireAuth);

// GET /api/dashboard
router.get('/', (req, res) => {
  // Isolation des pannes par widget — chaque sous-requête est exécutée dans un
  // `safe()` qui capture l'erreur, la journalise et la consigne dans `errors`
  // (renvoyé au client sous `_errors`), tout en retournant un fallback inerte.
  // Une seule sous-requête cassée ne doit JAMAIS vider tout le tableau de bord :
  // le reste des indicateurs continue de s'afficher (cockpit-style). La clé
  // passée à `safe()` correspond au champ de réponse / à la section côté client
  // (cf. ERROR_KEYS dans Dashboard.jsx) pour un mapping erreur → widget direct.
  const errors = {};
  const safe = (key, fn, fallback) => {
    try {
      return fn();
    } catch (e) {
      errors[key] = e?.message || String(e);
      console.error(`[dashboard] section "${key}" a échoué:`, e);
      return fallback;
    }
  };

  // Project goal (target count + end date)
  const goalSettings = safe('projectGoal', () => db.prepare("SELECT key, value FROM connector_config WHERE connector = 'dashboard_goal'").all(), []);
  const goalTarget = Number(goalSettings.find(s => s.key === 'target_qty')?.value || 0);
  const goalEndDate = goalSettings.find(s => s.key === 'end_date')?.value || null;
  const goalStartDate = goalSettings.find(s => s.key === 'start_date')?.value || (new Date().getFullYear() + '-01-01');

  let goalCurrentCount = 0;
  if (goalTarget > 0 && goalEndDate) {
    // Utilise `creation` (champ canonique unifié) pour compter les projets réellement
    // créés dans la fenêtre, peu importe quand la ligne a été insérée en DB.
    goalCurrentCount = safe('projectGoal', () => db.prepare(`
      SELECT COUNT(*) as count FROM projects
      WHERE creation >= ? AND creation <= ? AND deleted_at IS NULL
    `).get(goalStartDate + 'T00:00:00Z', goalEndDate + 'T23:59:59Z').count, 0);
  }
  // Companies by lifecycle phase
  const companiesByPhase = safe('companies', () => db.prepare(
    `SELECT lifecycle_phase, COUNT(*) as count FROM companies GROUP BY lifecycle_phase ORDER BY count DESC`
  ).all(), []);

  // Projects by status with values
  const projectsByStatus = safe('projects', () => db.prepare(
    `SELECT status, COUNT(*) as count, SUM(value_cad) as total_value, SUM(value_cad * probability / 100.0) as weighted_value
     FROM projects WHERE deleted_at IS NULL GROUP BY status`
  ).all(), []);

  // Orders by status
  const ordersByStatus = safe('orders', () => db.prepare(
    `SELECT status, COUNT(*) as count FROM orders WHERE deleted_at IS NULL GROUP BY status`
  ).all(), []);

  // Low stock count
  const lowStockCount = safe('inventory', () => db.prepare(
    `SELECT COUNT(*) as count FROM products WHERE active = 1 AND min_stock > 0 AND stock_qty <= min_stock`
  ).get(), { count: 0 });

  // Open tickets count
  const openTickets = safe('support', () => db.prepare(
    `SELECT COUNT(*) as count FROM tickets WHERE status != 'Fermé'`
  ).get(), { count: 0 });

  // Monthly revenue (orders marked Envoyée this month)
  const monthlyRevenue = safe('orders', () => db.prepare(
    `SELECT COALESCE(SUM(oi.qty * COALESCE(oi.shipped_unit_cost, oi.unit_cost)), 0) as revenue
     FROM orders o
     JOIN order_items oi ON oi.order_id = o.id
     WHERE o.status = 'Envoyée'
     AND o.deleted_at IS NULL
     AND strftime('%Y-%m', o.updated_at) = strftime('%Y-%m', 'now')`
  ).get(), { revenue: 0 });

  // Total companies count
  const companiesTotal = safe('companies', () => db.prepare('SELECT COUNT(*) as count FROM companies WHERE deleted_at IS NULL').get(), { count: 0 });

  // Pipeline summary
  const pipelineOpen = projectsByStatus.find(p => p.status === 'Ouvert') || { count: 0, total_value: 0, weighted_value: 0 };
  const _pipelineWon = projectsByStatus.find(p => p.status === 'Gagné') || { count: 0, total_value: 0 };

  // Won this month
  const wonThisMonth = safe('projects', () => db.prepare(
    `SELECT COUNT(*) as count, SUM(value_cad) as total FROM projects WHERE deleted_at IS NULL AND status = 'Gagné' AND strftime('%Y-%m', updated_at) = strftime('%Y-%m', 'now')`
  ).get(), { count: 0, total: 0 });

  // Weekly shipments (last 16 weeks)
  const weeklyShipments = safe('weeklyShipments', () => db.prepare(`
    SELECT
      date(shipped_at, '-' || ((cast(strftime('%w', shipped_at) as integer) + 6) % 7) || ' days') as week_start,
      COUNT(*) as count
    FROM shipments
    WHERE shipped_at IS NOT NULL AND shipped_at >= date('now', '-112 days')
    GROUP BY week_start
    ORDER BY week_start ASC
  `).all(), []);

  // Projects created by month — last 24 months (current year + previous year for YoY comparison).
  // Source de date: `creation` — champ canonique, rempli pour TOUS les projets (importés
  // d'Airtable ou créés nativement dans l'ERP, voir backfill schema.js + POST projects.js).
  // Bucketing en UTC (strftime sur la valeur stockée). Airtable encode les dates « date-only »
  // en minuit UTC du jour choisi par l'utilisateur, donc le mois UTC = mois choisi. Le front
  // (`fmtDate()`) détecte ce pattern et l'affiche en UTC aussi → cohérent.
  const projectsCreatedByMonth = safe('projectsCreatedByMonth', () => db.prepare(`
    SELECT strftime('%Y-%m', creation) AS month, COUNT(*) AS count
    FROM projects
    WHERE deleted_at IS NULL
      AND creation IS NOT NULL
      AND creation >= date('now', 'start of month', '-24 months')
    GROUP BY month
    ORDER BY month ASC
  `).all(), []);

  // Closing rate by month × type (last 12 months).
  // Statut du projet : le champ « Vendu » (`cf_vendu`, single select Oui/Non) fait foi —
  // et non la colonne `status`, qui est restée à 'Ouvert' sur la totalité des projets
  // importés d'Airtable et ne distingue donc jamais gagné/perdu.
  // Date de bucketing : `close_date` quand elle est renseignée, sinon `creation` (champ
  // canonique rempli pour tous les projets). L'ancien repli sur `updated_at` datait de la
  // dernière synchro, ce qui empilait tous les projets dans le mois courant.
  const closingByMonth = safe('closingByMonth', () => db.prepare(`
    SELECT
      strftime('%Y-%m', COALESCE(NULLIF(close_date, ''), creation)) as month,
      COALESCE(type, '') as type,
      SUM(CASE WHEN cf_vendu = 'Oui' THEN 1 ELSE 0 END) as won,
      SUM(CASE WHEN cf_vendu = 'Non' THEN 1 ELSE 0 END) as lost
    FROM projects
    WHERE deleted_at IS NULL
      AND cf_vendu IN ('Oui', 'Non')
      AND COALESCE(NULLIF(close_date, ''), creation) >= date('now', '-12 months')
    GROUP BY month, type
    ORDER BY month, type
  `).all(), []);

  // Tickets created by month — last 24 months (current year + previous year for YoY comparison).
  // On retourne le compte de billets et la somme des durées (minutes) bucketés par mois UTC,
  // pour permettre au front d'alterner entre les deux métriques sans seconde requête.
  const ticketsByMonth = safe('ticketsByMonth', () => db.prepare(`
    SELECT
      strftime('%Y-%m', created_at) AS month,
      COUNT(*) AS count,
      COALESCE(SUM(CAST(duration_minutes AS INTEGER)), 0) AS minutes
    FROM tickets
    WHERE created_at IS NOT NULL
      AND created_at >= date('now', 'start of month', '-24 months')
    GROUP BY month
    ORDER BY month ASC
  `).all(), []);

  // Weekly support quality stats (last 16 weeks, week starts Sunday)
  const weeklySupportStats = safe('weeklySupportStats', () => db.prepare(`
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
  `).all(), []);

  // Geo clients — customers only, using the FIRST shipping address registered
  // (earliest adresses.created_at) per company. Excludes soft-deleted companies.
  const geoClients = safe('geoClients', () => db.prepare(`
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
  `).all(), []);

  // Customers with no usable shipping address province (cannot be placed on the map)
  const geoClientsUnplaced = safe('geoClients', () => db.prepare(`
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
  `).get().count, 0);

  // Weekly profitability — last 16 weeks, fully-shipped orders ('Envoyé')
  // Excludes orders that are 100% replacement (no Facturable items)
  // Revenue: SUM(factures.amount_before_tax_cad) — montant HT, taxes exclues
  //   (les taxes perçues doivent être remises au gouvernement, ce ne sont pas des revenus)
  //   linked directly to order OR via order's project (1 project = 1 order)
  // COGS: SUM(shipped_unit_cost or unit_cost * qty) for Facturable items only
  // Grouped by week of last shipment, split by is_subscription
  const weeklyProfitability = safe('weeklyProfitability', () => db.prepare(`
    WITH shipped_orders AS (
      SELECT
        o.id AS order_id,
        o.project_id,
        o.is_subscription,
        o.revenue_override_cad,
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
        -- L'override manuel (revenue_override_cad) prime sur le calcul factures.
        CASE WHEN so.revenue_override_cad IS NOT NULL THEN so.revenue_override_cad
        WHEN so.is_subscription = 1 THEN
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
  `).all(), []);

  // Orders shipped in the last 140 days (status = 'Envoyé', last shipment date).
  // 140j couvre la fenêtre 28j glissante du point le plus ancien du graphe (16 semaines) :
  // le point ~15 semaines en arrière agrège jusqu'à 21 jours avant son lundi (~132j).
  // Le tableau filtre ensuite côté client par fenêtre du point cliqué (ou 28j par défaut).
  const recentShippedOrders = safe('recentShippedOrders', () => db.prepare(`
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
      -- Revenu HT (amount_before_tax_cad) — taxes exclues, voir weeklyProfitability ci-dessus.
      -- L'override manuel (revenue_override_cad) prime sur le calcul factures.
      CASE WHEN o.revenue_override_cad IS NOT NULL THEN o.revenue_override_cad
      WHEN o.is_subscription = 1 THEN
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
    HAVING MAX(s.shipped_at) >= date('now', '-140 days')
    ORDER BY MAX(s.shipped_at) DESC
  `).all(), []);

  // Inventory valuation — "Pièces" alignée sur la vue « Valeur inventaire »
  // de la table products (id pill 997d024c). Filtres et source identiques :
  //   - type ∉ {JWT, SYSTEM, PIÈCE OBSOLÈTE, PRODUIT OBSOLÈTE}
  //   - type non vide (la vue requiert is_not_empty)
  //   - exclut les produits sérialisés (besoin_d_un_numero_de_serie != '1.0') —
  //     leur valeur est portée par serial_numbers.manufacture_value
  //     (cf. serialInventoryByStatus ci-dessous), sinon double-comptage.
  //   - deleted_at IS NULL
  //   - Valeur : colonne `valeur_inventaire` (formule Airtable FIFO synchronisée),
  //     pas stock_qty × unit_cost — la FIFO plafonne les stocks négatifs et
  //     reflète le coût réel d'acquisition, ce que la vue UI affiche.
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
  const piecesInventory = safe('inventory', () => db.prepare(`
    SELECT COALESCE(SUM(CAST(valeur_inventaire AS REAL)), 0) AS total_value,
           COUNT(*) AS count
    FROM products
    WHERE (besoin_d_un_numero_de_serie IS NULL OR besoin_d_un_numero_de_serie != '1.0')
      AND type IS NOT NULL AND type != ''
      AND type NOT IN ('JWT', 'SYSTEM', 'PIÈCE OBSOLÈTE', 'PRODUIT OBSOLÈTE')
      AND deleted_at IS NULL
  `).get(), { total_value: 0, count: 0 });
  const placeholders = EXCLUDED_SN_STATUSES.map(() => '?').join(',');
  const serialInventoryByStatus = safe('inventory', () => db.prepare(`
    SELECT status,
           COUNT(*) AS count,
           COALESCE(SUM(manufacture_value), 0) AS total_value
    FROM serial_numbers
    WHERE status IS NOT NULL AND status != ''
      AND status NOT IN (${placeholders})
    GROUP BY status
    ORDER BY total_value DESC
  `).all(...EXCLUDED_SN_STATUSES), []);

  // Replacement rate — monthly for last 12 months
  // Cost: manufacture_value for serialized items, unit_cost×qty otherwise
  // Only Remplacement items on fully shipped orders
  const parkValue = safe('replacementRate', () => db.prepare(`
    SELECT COALESCE(SUM(manufacture_value), 0) AS total
    FROM serial_numbers
    WHERE (
        status = 'Opérationnel - Loué'
        OR (status = 'Opérationnel - Vendu' AND statut_de_garantie = 'Sous garantie')
      )
  `).get().total, 0);

  // Replacement cost — rolling 28 days
  const replacementLast28 = safe('replacementRate', () => db.prepare(`
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
  `).get().cost, 0);

  const replacementByMonth = safe('replacementRate', () => db.prepare(`
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
  `).all(), []);

  // Weekly shipping costs — aggregate account 65000 "Expédition, livraison et poste"
  // from achats_fournisseurs (both QB Bills and Purchases).
  // Line amounts are in transaction currency; multiply by exchange_rate for CAD.
  const shippingRows = safe('weeklyShippingCosts', () => db.prepare(`
    SELECT date_achat AS txn_date, lines, exchange_rate FROM achats_fournisseurs
    WHERE lines LIKE '%Expédition%'
      AND date_achat >= date('now', '-370 days')
  `).all(), []);

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
  const replacementItems = safe('replacementRate', () => db.prepare(`
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
  `).all(), []);

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
    ticketsByMonth,
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
    },
    // Carte des sections en panne : { <clé section> : <message d'erreur> }.
    // Vide si tout s'est bien chargé. Le client (Dashboard.jsx) l'utilise pour
    // afficher un encart d'erreur ciblé sur le widget concerné plutôt que de
    // laisser un graphique vide (qui se confondrait avec « aucune donnée »).
    _errors: errors
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
// sync_source='Factures Stripe' + status='Payé'. Hors taxes : on lit
// `montant_avant_taxes` (string) — c'est l'unique champ HT garanti en monnaie
// native pour toutes les sources de sync. `amount_before_tax_cad` est mixte
// (CAD home pour les factures importées d'Airtable, natif pour celles via
// webhook Stripe seul) et n'est pas fiable. USD converti au taux BoC à la
// date d'arrivée du payout (cohérent avec le push QB Deposit), fallback sur
// le document_date.
router.get('/stripe-revenue', async (req, res) => {
  const sales = db.prepare(`
    SELECT id, currency, montant_avant_taxes, document_date,
           subscription_id, paid_charge_id, paid_payment_intent, invoice_id
    FROM factures
    WHERE sync_source = 'Factures Stripe'
      AND status = 'Payé'
      AND document_date IS NOT NULL
      AND document_date >= date('now', 'start of month', '-23 months')
  `).all();

  // Remboursements legacy stockés comme factures
  const refundFactures = db.prepare(`
    SELECT id, currency, ABS(COALESCE(CAST(montant_avant_taxes AS REAL), 0)) AS amount,
           document_date, subscription_id, company_id, invoice_id
    FROM factures
    WHERE sync_source = 'Remboursements Stripe'
      AND document_date IS NOT NULL
      AND document_date >= date('now', 'start of month', '-23 months')
      AND COALESCE(CAST(montant_avant_taxes AS REAL), 0) != 0
  `).all();

  // Remboursements modernes (webhook charge.refunded → table payments)
  const refundPayments = db.prepare(`
    SELECT p.id, p.received_at AS document_date, p.amount, p.currency,
           p.stripe_refund_id, f.subscription_id
    FROM payments p
    JOIN factures f ON f.id = p.facture_id
    WHERE p.stripe_refund_id IS NOT NULL
      AND p.received_at >= date('now', 'start of month', '-23 months')
  `).all();

  // Lookups payout — même conventions que le drilldown ci-dessous : pour une
  // vente on tente charge_id → invoice_id → payment_intent ; pour un
  // remboursement legacy on cherche par refund_id (stocké dans factures.invoice_id);
  // pour un remboursement moderne on cherche par stripe_refund_id sur payments.
  const aggLookupPayoutByCharge = db.prepare(
    "SELECT payout_stripe_id FROM stripe_balance_transactions WHERE source_id=? AND type IN ('charge','payment')"
  );
  const aggLookupPayoutByInvoice = db.prepare(
    "SELECT payout_stripe_id FROM stripe_balance_transactions WHERE stripe_invoice_id=? AND type IN ('charge','payment') ORDER BY created_date DESC LIMIT 1"
  );
  // Map<payment_intent_id → payout_stripe_id> — préchargée une fois par requête.
  // payment_intent n'a pas de colonne dédiée dans stripe_balance_transactions
  // (il vit dans `raw.source.payment_intent`), donc le fallback historique
  // utilisait `raw LIKE '%pi_xxx%'` ce qui faisait un full scan + LIKE par
  // ligne. Pour ~2000 ventes sans match charge/invoice, ça représentait ~12s.
  // Un seul scan + json_extract en C suffit (~50ms) et le reste devient O(1).
  const aggPayoutByPI = new Map();
  for (const r of db.prepare(
    "SELECT payout_stripe_id, json_extract(raw, '$.source.payment_intent') AS pi FROM stripe_balance_transactions WHERE type IN ('charge','payment') AND payout_stripe_id IS NOT NULL"
  ).all()) {
    if (r.pi && !aggPayoutByPI.has(r.pi)) aggPayoutByPI.set(r.pi, r.payout_stripe_id);
  }
  const aggLookupPayoutByRefund = db.prepare(
    "SELECT payout_stripe_id FROM stripe_balance_transactions WHERE source_id=? AND type IN ('refund','payment_refund')"
  );
  const aggLookupPayoutArrival = db.prepare('SELECT arrival_date FROM stripe_payouts WHERE stripe_id=?');

  function payoutArrivalForSale(r) {
    let pid = null;
    if (r.paid_charge_id) pid = aggLookupPayoutByCharge.get(r.paid_charge_id)?.payout_stripe_id || null;
    if (!pid && r.invoice_id) pid = aggLookupPayoutByInvoice.get(r.invoice_id)?.payout_stripe_id || null;
    if (!pid && r.paid_payment_intent) pid = aggPayoutByPI.get(r.paid_payment_intent) || null;
    return pid ? (aggLookupPayoutArrival.get(pid)?.arrival_date || null) : null;
  }
  function payoutArrivalForRefundFacture(r) {
    if (!r.invoice_id) return null;
    const pid = aggLookupPayoutByRefund.get(r.invoice_id)?.payout_stripe_id || null;
    return pid ? (aggLookupPayoutArrival.get(pid)?.arrival_date || null) : null;
  }
  function payoutArrivalForRefundPayment(r) {
    if (!r.stripe_refund_id) return null;
    const pid = aggLookupPayoutByRefund.get(r.stripe_refund_id)?.payout_stripe_id || null;
    return pid ? (aggLookupPayoutArrival.get(pid)?.arrival_date || null) : null;
  }

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
      AND ABS(COALESCE(CAST(montant_avant_taxes AS REAL), 0) - ?) < 0.5
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

  // Convention : taux BoC à la date d'arrivée du payout lié si dispo, sinon
  // fallback sur le document_date (taux historique au moment de la facturation).
  // Cohérent avec le drilldown /stripe-revenue/factures et le push QB Deposit.
  for (const r of sales) {
    const month = (r.document_date || '').slice(0, 7);
    if (!month) continue;
    const native = parseFloat(r.montant_avant_taxes) || 0;
    let cadAmount = native;
    if ((r.currency || 'CAD').toUpperCase() === 'USD') {
      const rateDate = payoutArrivalForSale(r) || r.document_date.slice(0, 10);
      const rate = await rateFor(rateDate);
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
      const rateDate = payoutArrivalForRefundFacture(r) || r.document_date.slice(0, 10);
      const rate = await rateFor(rateDate);
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
      const rateDate = payoutArrivalForRefundPayment(r) || r.document_date.slice(0, 10);
      const rate = await rateFor(rateDate);
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

// GET /api/dashboard/stripe-revenue/factures?month=YYYY-MM&type=service|achat
// Liste détaillée pour le drilldown du widget « Abonnements » / « Ventes » :
// factures Stripe payées du mois + remboursements legacy stockés comme factures.
// Retourne, par ligne : devise originale, montant natif, montant CAD converti
// au taux BoC du document_date, et arrival_date du payout associé (NULL si
// pas encore versé / introuvable).
router.get('/stripe-revenue/factures', async (req, res) => {
  const { month, type } = req.query;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'month requis au format YYYY-MM' });
  }
  if (type && type !== 'service' && type !== 'achat') {
    return res.status(400).json({ error: 'type doit être service ou achat' });
  }

  // Montants HT en devise native via `montant_avant_taxes` (string toujours en
  // monnaie native, peu importe la source de sync). Pour les remboursements,
  // on prend la valeur absolue (peut être négative en DB).
  // f.subscription_id stocke soit l'UUID ERP soit le Stripe ID (`sub_xxx`)
  // selon la source de la facture — on joint sur les deux pour récupérer
  // l'intervalle de récurrence (mensuel / annuel) côté abonnement.
  const rows = db.prepare(`
    SELECT f.id, f.document_number, f.document_date, f.status,
           f.company_id, c.name AS company_name,
           f.currency, f.montant_avant_taxes, f.subscription_id, f.sync_source,
           f.invoice_id, f.paid_charge_id, f.paid_payment_intent,
           f.revenue_recognized_at,
           s.interval_type
    FROM factures f
    LEFT JOIN companies c ON f.company_id = c.id
    LEFT JOIN subscriptions s
      ON f.subscription_id IS NOT NULL
      AND (s.id = f.subscription_id OR s.stripe_id = f.subscription_id)
    WHERE f.sync_source IN ('Factures Stripe', 'Remboursements Stripe')
      AND f.document_date IS NOT NULL
      AND substr(f.document_date, 1, 7) = ?
    ORDER BY f.document_date DESC, f.document_number DESC
  `).all(month);

  // Même filtre que le widget : Stripe payées + remboursements. Pour les
  // ventes payées, on filtre directement par `subscription_id`. Pour les
  // remboursements, on applique la même heuristique de classification que
  // l'agrégat /stripe-revenue (matchOrig sur facture d'origine, fallback
  // companyProfile) — sans ça, les remboursements de service apparaissaient
  // dans le drilldown achat (et inversement) et la somme du drilldown
  // divergeait du total de la barre.
  const matchOrigStmt = db.prepare(`
    SELECT subscription_id
    FROM factures
    WHERE company_id = ?
      AND sync_source = 'Factures Stripe'
      AND status = 'Payé'
      AND currency = ?
      AND ABS(COALESCE(CAST(montant_avant_taxes AS REAL), 0) - ?) < 0.5
      AND document_date <= ?
    ORDER BY document_date DESC
    LIMIT 1
  `);
  const companyProfileStmt = db.prepare(`
    SELECT
      SUM(CASE WHEN subscription_id IS NOT NULL THEN 1 ELSE 0 END) AS sub_count,
      SUM(CASE WHEN subscription_id IS NULL THEN 1 ELSE 0 END) AS order_count
    FROM factures
    WHERE company_id = ?
      AND sync_source = 'Factures Stripe'
      AND status = 'Payé'
  `);
  function classifyRefundForDrilldown(r) {
    if (r.subscription_id) return 'service';
    if (!r.company_id) return 'achat';
    const orig = matchOrigStmt.get(r.company_id, (r.currency || 'CAD').toUpperCase(), Math.abs(parseFloat(r.montant_avant_taxes) || 0), r.document_date);
    if (orig) return orig.subscription_id ? 'service' : 'achat';
    const prof = companyProfileStmt.get(r.company_id);
    if (prof && (prof.sub_count || 0) > 0 && (prof.order_count || 0) === 0) return 'service';
    return 'achat';
  }

  const filtered = rows.filter(r => {
    const isPaidSale = r.sync_source === 'Factures Stripe' && r.status === 'Payé';
    const isRefund = r.sync_source === 'Remboursements Stripe';
    if (!isPaidSale && !isRefund) return false;
    if (!type) return true;
    if (isPaidSale) {
      if (type === 'service') return !!r.subscription_id;
      if (type === 'achat') return !r.subscription_id;
    }
    if (isRefund) return classifyRefundForDrilldown(r) === type;
    return true;
  });

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

  // Payout lookups — distincts selon vente vs remboursement.
  // Pour les ventes : charge_id → invoice_id → payment_intent.
  // Pour les remboursements legacy : `invoice_id` du facture stocke le refund_id.
  const lookupPayoutByCharge = db.prepare(
    "SELECT payout_stripe_id FROM stripe_balance_transactions WHERE source_id=? AND type IN ('charge','payment')"
  );
  const lookupPayoutByInvoice = db.prepare(
    "SELECT payout_stripe_id FROM stripe_balance_transactions WHERE stripe_invoice_id=? AND type IN ('charge','payment') ORDER BY created_date DESC LIMIT 1"
  );
  // Map préchargée pour le lookup par payment_intent — voir l'agrégat
  // /stripe-revenue plus haut pour la justification (raw LIKE → 12s sur 2k ventes).
  const payoutByPI = new Map();
  for (const r of db.prepare(
    "SELECT payout_stripe_id, json_extract(raw, '$.source.payment_intent') AS pi FROM stripe_balance_transactions WHERE type IN ('charge','payment') AND payout_stripe_id IS NOT NULL"
  ).all()) {
    if (r.pi && !payoutByPI.has(r.pi)) payoutByPI.set(r.pi, r.payout_stripe_id);
  }
  const lookupPayoutByRefund = db.prepare(
    "SELECT payout_stripe_id FROM stripe_balance_transactions WHERE source_id=? AND type IN ('refund','payment_refund')"
  );
  const lookupPayout = db.prepare('SELECT arrival_date FROM stripe_payouts WHERE stripe_id=?');

  const result = [];
  for (const r of filtered) {
    const currency = (r.currency || 'CAD').toUpperCase();
    // `montant_avant_taxes` (string) = subtotal HT en monnaie native, fiable
    // pour toutes les sources de sync. Pour les remboursements, on retourne
    // un montant négatif pour que la somme du drilldown reproduise directement
    // le net agrégé affiché dans le chart (sans flip de signe côté client).
    const rawNative = parseFloat(r.montant_avant_taxes) || 0;
    const native = r.sync_source === 'Remboursements Stripe' ? -Math.abs(rawNative) : rawNative;

    let payoutId = null;
    if (r.sync_source === 'Remboursements Stripe') {
      if (r.invoice_id) {
        payoutId = lookupPayoutByRefund.get(r.invoice_id)?.payout_stripe_id || null;
      }
    } else {
      if (r.paid_charge_id) {
        payoutId = lookupPayoutByCharge.get(r.paid_charge_id)?.payout_stripe_id || null;
      }
      if (!payoutId && r.invoice_id) {
        payoutId = lookupPayoutByInvoice.get(r.invoice_id)?.payout_stripe_id || null;
      }
      if (!payoutId && r.paid_payment_intent) {
        payoutId = payoutByPI.get(r.paid_payment_intent) || null;
      }
    }

    let payoutArrivalDate = null;
    if (payoutId) {
      payoutArrivalDate = lookupPayout.get(payoutId)?.arrival_date || null;
    }

    // Préférer le taux BoC à la date d'arrivée du payout (cohérent avec le push
    // QB Deposit, cf. services/quickbooks.js:buildDepositFromPayout). Fallback
    // sur le document_date si pas de payout lié — taux historique au moment de
    // la facturation, comportement antérieur préservé.
    let cad = native;
    if (currency === 'USD') {
      const rateDate = payoutArrivalDate || r.document_date;
      const rate = await rateFor(rateDate);
      cad = native * rate;
    }

    // Date de constatation = moment où la ligne est portée au compte de revenu
    // dans QB. Pour les abonnements (Cr 41000 au payout) et les remboursements
    // (réversion sur le Deposit du payout) : arrival_date du payout. Pour les
    // ventes (Cr 40000) : `revenue_recognized_at` si posé (JE à l'expédition,
    // après deferred), sinon arrival_date du payout (vente expédiée avant
    // payout — Cr 40000 directement dans le Deposit).
    const isRefundRow = r.sync_source === 'Remboursements Stripe';
    const isSubscription = !!r.subscription_id;
    let recognitionDate;
    if (isRefundRow || isSubscription) {
      recognitionDate = payoutArrivalDate;
    } else {
      recognitionDate = r.revenue_recognized_at || payoutArrivalDate;
    }

    result.push({
      id: r.id,
      document_number: r.document_number,
      document_date: r.document_date,
      status: r.status,
      company_id: r.company_id,
      company_name: r.company_name,
      currency,
      amount_native: Math.round(native * 100) / 100,
      amount_cad: Math.round(cad * 100) / 100,
      payout_arrival_date: payoutArrivalDate,
      payout_stripe_id: payoutId,
      recognition_date: recognitionDate,
      sync_source: r.sync_source,
      subscription_id: r.subscription_id,
      interval_type: r.interval_type || null,
    });
  }

  // Remboursements modernes (table `payments` avec stripe_refund_id) — bucketés
  // par received_at. Le widget les soustrait de la barre du mois ; on doit les
  // refléter ici pour rester aligné avec le total agrégé. Marqués
  // sync_source='Remboursements Stripe' pour réutiliser la convention de signe.
  const refundPayments = db.prepare(`
    SELECT p.id, p.received_at, p.amount, p.currency, p.amount_cad,
           p.stripe_refund_id, p.facture_id,
           f.subscription_id, f.company_id,
           c.name AS company_name,
           s.interval_type
    FROM payments p
    JOIN factures f ON f.id = p.facture_id
    LEFT JOIN companies c ON f.company_id = c.id
    LEFT JOIN subscriptions s
      ON f.subscription_id IS NOT NULL
      AND (s.id = f.subscription_id OR s.stripe_id = f.subscription_id)
    WHERE p.stripe_refund_id IS NOT NULL
      AND substr(p.received_at, 1, 7) = ?
  `).all(month);

  const filteredRefundPayments = refundPayments.filter(r => {
    if (type === 'service' && !r.subscription_id) return false;
    if (type === 'achat' && r.subscription_id) return false;
    return true;
  });

  for (const r of filteredRefundPayments) {
    const currency = (r.currency || 'CAD').toUpperCase();
    // Convention de signe : remboursements négatifs pour que la somme du
    // drilldown reproduise directement le net agrégé du chart.
    const nativeAbs = Math.abs(Number(r.amount) || 0);

    let payoutId = null;
    if (r.stripe_refund_id) {
      payoutId = lookupPayoutByRefund.get(r.stripe_refund_id)?.payout_stripe_id || null;
    }
    let payoutArrivalDate = null;
    if (payoutId) {
      payoutArrivalDate = lookupPayout.get(payoutId)?.arrival_date || null;
    }

    // Préférer le taux BoC à la date d'arrivée du payout — même règle que la
    // boucle factures ci-dessus. Sans payout lié, on reprend la valeur stockée
    // sur le payment (`amount_cad`, calculée au moment du push QB) si elle
    // existe, sinon fallback sur le received_at.
    let cadAbs;
    if (payoutArrivalDate) {
      cadAbs = nativeAbs;
      if (currency === 'USD') {
        const rate = await rateFor(payoutArrivalDate);
        cadAbs = nativeAbs * rate;
      }
    } else {
      cadAbs = Number(r.amount_cad);
      if (cadAbs) {
        cadAbs = Math.abs(cadAbs);
      } else {
        cadAbs = nativeAbs;
        if (currency === 'USD') {
          const rate = await rateFor(r.received_at);
          cadAbs = nativeAbs * rate;
        }
      }
    }

    // Remboursement : constatation = arrival_date du payout (réversion sur le
    // Deposit du payout, comme les refunds legacy ci-dessus).
    const recognitionDate = payoutArrivalDate;

    result.push({
      // id pointe sur la facture parent pour que le lien /factures/:id
      // fonctionne (le payment.id ne correspond à aucune route).
      id: r.facture_id,
      document_number: r.stripe_refund_id || '—',
      document_date: r.received_at,
      status: 'Remboursement',
      company_id: r.company_id,
      company_name: r.company_name,
      currency,
      amount_native: -Math.round(nativeAbs * 100) / 100,
      amount_cad: -Math.round(cadAbs * 100) / 100,
      payout_arrival_date: payoutArrivalDate,
      payout_stripe_id: payoutId,
      recognition_date: recognitionDate,
      sync_source: 'Remboursements Stripe',
      subscription_id: r.subscription_id,
      interval_type: r.interval_type || null,
    });
  }

  // Tri final : par date desc, puis numéro desc.
  result.sort((a, b) => {
    const d = (b.document_date || '').localeCompare(a.document_date || '');
    if (d !== 0) return d;
    return (b.document_number || '').localeCompare(a.document_number || '');
  });

  res.json({ data: result });
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

// GET /api/dashboard/aging-receivables
// Balance âgée des comptes clients (accounts receivable aging) — le rapport
// comptable standard qui ventile l'encours client par tranche d'ancienneté.
// Calcul du retard sur due_date (fallback document_date), buckets demandés :
//   0–30 / 31–60 / 61–90 / 90+ jours.
// « Facture ouverte » = balance_due > 0 ET statut hors payé / annulé / brouillon
// / avoir / remboursement / irrécouvrable (Uncollectible = créance radiée, pas
// un compte à recevoir). Montants convertis en CAD au taux BoC USD→CAD à la
// date de référence (cohérent avec le reste du dashboard). balance_due est en
// devise native de la facture.
//
// Réponse :
//   { as_of, currency:'CAD',
//     buckets:[{ key, label, total }], total,
//     companies:[{ company_id, company_name, b0_30, b31_60, b61_90, b90, total,
//                  invoices:[{ id, document_number, document_date, due_date,
//                              status, currency, balance_due, balance_due_cad,
//                              days_overdue, bucket }] }] }
router.get('/aging-receivables', async (req, res) => {
  // Statuts exclus de l'encours client (paiement soldé, annulation, brouillon,
  // avoir, remboursement, créance irrécouvrable). On garde les variantes
  // accentuées/non-accentuées rencontrées en DB (sync Airtable + Stripe + ERP).
  const EXCLUDED_STATUSES = [
    'Payé', 'Payée', 'Void', 'Annulée', 'Annulé', 'Draft', 'Brouillon',
    'Note de crédit', 'Remboursement', 'Remboursé', 'Uncollectible',
  ];
  const placeholders = EXCLUDED_STATUSES.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT f.id, f.document_number, f.document_date, f.due_date, f.status,
           f.currency, f.balance_due, f.company_id, c.name AS company_name
    FROM factures f
    LEFT JOIN companies c ON c.id = f.company_id
    WHERE f.balance_due > 0
      AND COALESCE(f.status, '') NOT IN (${placeholders})
    ORDER BY f.due_date ASC, f.document_date ASC
  `).all(...EXCLUDED_STATUSES);

  // Date de référence (aujourd'hui, UTC date-only) pour le calcul du retard.
  const now = new Date();
  const asOfMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const asOfStr = new Date(asOfMs).toISOString().slice(0, 10);

  // Cache des taux USD→CAD par date (mêmes conventions que /stripe-revenue).
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

  function bucketOf(days) {
    if (days <= 30) return 'b0_30';   // inclut les factures non encore échues
    if (days <= 60) return 'b31_60';
    if (days <= 90) return 'b61_90';
    return 'b90';
  }

  const companiesMap = new Map();
  const bucketTotals = { b0_30: 0, b31_60: 0, b61_90: 0, b90: 0 };

  for (const r of rows) {
    const refDate = (r.due_date && r.due_date.slice(0, 10))
      || (r.document_date && r.document_date.slice(0, 10))
      || asOfStr;
    const refMs = Date.parse(refDate + 'T00:00:00Z');
    const daysOverdue = Number.isFinite(refMs) ? Math.floor((asOfMs - refMs) / 86400000) : 0;
    const bucket = bucketOf(daysOverdue);

    const currency = (r.currency || 'CAD').toUpperCase();
    let cad = Number(r.balance_due) || 0;
    if (currency === 'USD') {
      const rate = await rateFor(refDate);
      cad = cad * rate;
    }
    cad = Math.round(cad * 100) / 100;

    bucketTotals[bucket] += cad;

    const cid = r.company_id || '__none__';
    if (!companiesMap.has(cid)) {
      companiesMap.set(cid, {
        company_id: r.company_id || null,
        company_name: r.company_name || '(Sans entreprise)',
        b0_30: 0, b31_60: 0, b61_90: 0, b90: 0, total: 0,
        invoices: [],
      });
    }
    const co = companiesMap.get(cid);
    co[bucket] += cad;
    co.total += cad;
    co.invoices.push({
      id: r.id,
      document_number: r.document_number,
      document_date: r.document_date,
      due_date: r.due_date,
      status: r.status,
      currency,
      balance_due: Math.round((Number(r.balance_due) || 0) * 100) / 100,
      balance_due_cad: cad,
      days_overdue: daysOverdue,
      bucket,
    });
  }

  const round2 = (n) => Math.round(n * 100) / 100;
  const companies = [...companiesMap.values()].map(co => ({
    ...co,
    b0_30: round2(co.b0_30),
    b31_60: round2(co.b31_60),
    b61_90: round2(co.b61_90),
    b90: round2(co.b90),
    total: round2(co.total),
    invoices: co.invoices.sort((a, b) => b.days_overdue - a.days_overdue),
  })).sort((a, b) => b.total - a.total);

  const total = round2(Object.values(bucketTotals).reduce((s, v) => s + v, 0));

  res.json({
    as_of: asOfStr,
    currency: 'CAD',
    buckets: [
      { key: 'b0_30', label: '0–30 jours', total: round2(bucketTotals.b0_30) },
      { key: 'b31_60', label: '31–60 jours', total: round2(bucketTotals.b31_60) },
      { key: 'b61_90', label: '61–90 jours', total: round2(bucketTotals.b61_90) },
      { key: 'b90', label: '90+ jours', total: round2(bucketTotals.b90) },
    ],
    total,
    companies,
  });
});

// GET /api/dashboard/subscription-events
// Retourne les événements d'abonnement classifiés par mois et catégorie pour
// le panel "Mouvements d'abonnements". Catégories :
//   creation  — nouveaux abonnements (inclut les réactivations)
//   upgrade   — augmentation du MRR sur un abonnement existant
//   downgrade — diminution du MRR sur un abonnement existant
//   churn     — annulations
//
// Le Net MRR par mois est inclus comme `net_mrr_delta_cad`.
//
// Réponse : { months: [{ month: 'YYYY-MM', categories: {...}, net_mrr_delta_cad }] }
//   où categories[cat] = { count, total_amount_cad, items: [{ event_id, company_id, company_name, sub_id, amount_cad_delta, event_date }] }
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

  // 1. Tous les events depuis cutoff, joints aux noms d'entreprise et stripe_id du sub.
  // company_id est résolu via COALESCE(e.company_id, s.company_id) : certains events
  // legacy ont e.company_id NULL alors que l'abonnement parent est bien rattaché.
  const events = db.prepare(`
    SELECT
      e.id, e.subscription_id, e.event_date, e.event_type,
      e.category, e.amount_cad_delta, e.previous_amount_cad, e.new_amount_cad,
      e.currency,
      COALESCE(e.company_id, s.company_id) AS company_id,
      s.stripe_id, s.amount_monthly, s.interval_type, s.interval_count,
      co.name AS company_name,
      e.rachat_status, e.rachat_order_id,
      e.items_before_json, e.items_after_json,
      o.order_number AS rachat_order_number
    FROM subscription_events e
    LEFT JOIN subscriptions s ON e.subscription_id = s.id
    LEFT JOIN companies co ON co.id = COALESCE(e.company_id, s.company_id)
    LEFT JOIN orders o ON o.id = e.rachat_order_id
    WHERE e.event_date >= ?
      AND e.category IN ('creation', 'churn', 'reactivation', 'upgrade', 'downgrade')
    ORDER BY e.event_date ASC
  `).all(cutoff)

  // 3. Bucket par mois et catégorie
  const monthsMap = new Map()  // month → { categories: {cat: {count, total, items}}, net }
  function bucketFor(month) {
    if (!monthsMap.has(month)) {
      monthsMap.set(month, {
        month,
        categories: {
          creation:  { count: 0, total_amount_cad: 0, items: [] },
          upgrade:   { count: 0, total_amount_cad: 0, items: [] },
          downgrade: { count: 0, total_amount_cad: 0, items: [] },
          churn:     { count: 0, total_amount_cad: 0, items: [] },
        },
        net_mrr_delta_cad: 0,
      })
    }
    return monthsMap.get(month)
  }

  // 3b. Timeline de factures par abonnement → utilisée à la fois pour
  //     (a) creation/churn          : produits de la dernière facture (état courant)
  //     (b) upgrade/downgrade       : diff entre facture juste avant et facture juste
  //         après le `event_date` — ne montre que les produits ajoutés / dont le
  //         montant a augmenté (upgrade), retirés / dont le montant a baissé (downgrade).
  // Note : factures.subscription_id contient soit l'UUID ERP soit le Stripe ID
  // (`sub_xxx`), selon la source de la facture. On joint via subscriptions
  // pour couvrir les deux cas. On filtre `proration=0` pour ne garder que les
  // lignes de l'état récurrent (sans les crédits/charges de proration générés
  // au moment du changement, qui pollueraient le diff).
  const subIds = [...new Set(events.map(e => e.subscription_id).filter(Boolean))]
  const timelineBySubId = {}     // sub_id → [{ dateKey, factureId, items: [...] }] sorted asc
  const productsBySubId = {}     // sub_id → produits de la dernière facture (creation / churn)
  if (subIds.length > 0) {
    const placeholders = subIds.map(() => '?').join(',')
    const invoiceItems = db.prepare(`
      SELECT
        s.id AS erp_sub_id,
        f.id AS facture_id,
        f.document_date,
        f.created_at AS facture_created_at,
        COALESCE(p.name_fr, sii.description) AS product_name,
        p.id AS product_id,
        sii.quantity,
        sii.unit_amount,
        sii.amount,
        sii.rowid AS sii_rowid
      FROM subscriptions s
      JOIN factures f
        ON f.subscription_id = s.id
        OR (s.stripe_id IS NOT NULL AND f.subscription_id = s.stripe_id)
      JOIN stripe_invoice_items sii ON sii.facture_id = f.id
      LEFT JOIN products p ON p.id = sii.product_id
      WHERE s.id IN (${placeholders})
        AND sii.proration = 0
      ORDER BY s.id, COALESCE(f.document_date, f.created_at, '') ASC, sii.rowid
    `).all(...subIds)

    // Construit la timeline : chaque facture devient un bucket d'items.
    for (const row of invoiceItems) {
      const k = row.erp_sub_id
      const dateKey = row.document_date || (row.facture_created_at ? String(row.facture_created_at).slice(0, 10) : '')
      if (!timelineBySubId[k]) timelineBySubId[k] = []
      let bucket = timelineBySubId[k][timelineBySubId[k].length - 1]
      if (!bucket || bucket.factureId !== row.facture_id) {
        bucket = { dateKey, factureId: row.facture_id, items: [] }
        timelineBySubId[k].push(bucket)
      }
      if (row.product_name) {
        bucket.items.push({
          product_id: row.product_id || null,
          product_name: row.product_name,
          quantity: row.quantity ?? 1,
          unit_amount: row.unit_amount,
          amount: row.amount,
        })
      }
    }

    // Produits de la dernière facture par sub (pour creation / churn).
    for (const subId of Object.keys(timelineBySubId)) {
      const tl = timelineBySubId[subId]
      const last = tl[tl.length - 1]
      if (!last) continue
      productsBySubId[subId] = last.items.map(it => ({
        product_id: it.product_id, product_name: it.product_name, quantity: it.quantity,
      }))
    }
  }

  // Match key pour comparer un produit d'une facture à l'autre. On préfère
  // l'id (résiste aux renommages), avec fallback sur le nom.
  function productMatchKey(it) {
    return it.product_id ? `id:${it.product_id}` : `name:${it.product_name || ''}`
  }

  // Calcule la liste des produits affectés par un upgrade ou downgrade en
  // diffant la facture juste avant l'event_date avec celle juste après.
  // Retourne null si pas de timeline pour ce sub (= aucune facture connue).
  function diffProductsForEvent(subId, eventDate, direction) {
    const tl = timelineBySubId[subId]
    if (!tl || tl.length === 0) return null
    const evKey = String(eventDate).slice(0, 10)
    let beforeBucket = null
    let afterBucket = null
    for (const b of tl) {
      if ((b.dateKey || '') < evKey) beforeBucket = b
      else if (afterBucket == null) afterBucket = b
    }
    // Si on n'a aucune facture après l'event (ex. event = dernière action sur
    // un sub annulé), fallback sur la dernière facture connue avant — sans
    // ça on n'a rien à comparer.
    if (!afterBucket) afterBucket = beforeBucket
    if (!afterBucket) return []
    const before = beforeBucket?.items || []
    const after = afterBucket.items || []
    const beforeMap = new Map(before.map(it => [productMatchKey(it), it]))
    const afterMap = new Map(after.map(it => [productMatchKey(it), it]))
    const out = []
    function lineAmount(it) {
      // unit_amount × quantity tel que stocké en cents — comparaison relative
      // suffisante (jamais retourné au client, sert juste au sign).
      return (Number(it.unit_amount) || 0) * (Number(it.quantity) || 1)
    }
    if (direction === 'upgrade') {
      // Produits ajoutés (présents dans after, absents dans before) ou dont
      // le montant a augmenté.
      for (const [k, it] of afterMap) {
        const prev = beforeMap.get(k)
        if (!prev || lineAmount(it) > lineAmount(prev) + 0.5) {
          out.push({ product_id: it.product_id, product_name: it.product_name, quantity: it.quantity })
        }
      }
    } else {
      // Downgrade : produits retirés (présents dans before, absents dans
      // after) ou dont le montant a baissé.
      for (const [k, prev] of beforeMap) {
        const it = afterMap.get(k)
        if (!it) {
          out.push({ product_id: prev.product_id, product_name: prev.product_name, quantity: prev.quantity })
        } else if (lineAmount(it) < lineAmount(prev) - 0.5) {
          out.push({ product_id: it.product_id, product_name: it.product_name, quantity: it.quantity })
        }
      }
    }
    return out
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
      interval_type: e.interval_type || null,
      interval_count: e.interval_count || null,
      products: productsBySubId[e.subscription_id] || [],
      // Rachat info — pertinent pour churn uniquement, mais on l'inclut
      // toujours pour homogénéité client. NULL = non vérifié.
      rachat_status: e.rachat_status || null,
      rachat_order_id: e.rachat_order_id || null,
      rachat_order_number: e.rachat_order_number || null,
    }
    // Net MRR : tous les events de mouvement contribuent
    if (e.amount_cad_delta != null) bucket.net_mrr_delta_cad += e.amount_cad_delta

    if (e.category === 'creation' || e.category === 'reactivation') {
      // Toute création (initiale ou réactivation) tombe dans 'creation'.
      bucket.categories.creation.count++
      bucket.categories.creation.total_amount_cad += (e.amount_cad_delta || 0)
      bucket.categories.creation.items.push(item)
    } else if (e.category === 'churn') {
      bucket.categories.churn.count++
      bucket.categories.churn.total_amount_cad += (e.amount_cad_delta || 0)
      bucket.categories.churn.items.push(item)
    } else if (e.category === 'upgrade' || e.category === 'downgrade') {
      // Préférence : diff entre snapshots items_before_json/items_after_json
      // (capturés au moment du webhook → reflète l'état immédiatement après
      // le changement, sans dépendre du cycle de facturation suivant).
      // Fallback : diff entre facture avant/après l'event_date (legacy events
      // sans snapshot).
      let diff = null
      let parsedBefore = null
      let parsedAfter = null
      try {
        if (e.items_before_json) parsedBefore = JSON.parse(e.items_before_json)
        if (e.items_after_json) parsedAfter = JSON.parse(e.items_after_json)
      } catch {}
      if (parsedBefore || parsedAfter) {
        const snapDiff = diffSnapshots(parsedBefore || [], parsedAfter || [], e.category)
        const enriched = enrichItemsWithErpProductId(snapDiff)
        diff = enriched.map(it => ({
          product_id: it.product_id || null,
          product_name: it.name || null,
          quantity: it.quantity ?? 1,
        }))
      } else {
        diff = diffProductsForEvent(e.subscription_id, e.event_date, e.category)
      }
      if (diff != null) item.products = diff
      bucket.categories[e.category].count++
      bucket.categories[e.category].total_amount_cad += (e.amount_cad_delta || 0)
      bucket.categories[e.category].items.push(item)
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

// GET /api/dashboard/balance-sheet
// Récupère le rapport BalanceSheet QuickBooks (à la date du jour, méthode Accrual)
// et renvoie une structure aplatie prête à afficher en arborescence côté client.
//
// QB Reports renvoie un arbre Rows.Row[] où chaque Row a :
//   - type: 'Section' (groupe avec sous-rows + Summary) ou 'Data' (compte feuille)
//   - Header.ColData[]   (libellé du groupe)
//   - Rows.Row[]         (sous-rangs)
//   - Summary.ColData[]  (totaux de groupe)
//   - ColData[]          (ligne de données : [{value:libellé,id:acctId},{value:montant}])
// Permanent cache keyed by as_of. Invalidated on any QB write via onQbMutation
// below, and on `?refresh=1` (manual refresh button). Humans editing QB
// directly in the QB UI won't trigger invalidation — use ?refresh=1 then.
const balanceSheetCache = new Map()
onQbMutation(() => balanceSheetCache.clear())

router.get('/balance-sheet', async (req, res) => {
  try {
    const params = new URLSearchParams({ accounting_method: 'Accrual' })
    if (req.query.as_of) params.set('end_date', String(req.query.as_of))
    const cacheKey = params.toString()
    if (!req.query.refresh) {
      const hit = balanceSheetCache.get(cacheKey)
      if (hit) return res.json(hit)
    }
    const data = await qbGet(`/reports/BalanceSheet?${params}`)
    const report = data?.Report || data

    let nodeIdSeq = 0
    function walkRows(rows, depth) {
      const out = []
      for (const row of (rows?.Row || [])) {
        if (row.type === 'Section') {
          const label = row.Header?.ColData?.[0]?.value || ''
          const total = row.Summary?.ColData?.[1]?.value ?? null
          const node = {
            id: `n${nodeIdSeq++}`,
            kind: 'section',
            label,
            total: total !== null && total !== '' ? Number(total) : null,
            depth,
            children: walkRows(row.Rows, depth + 1),
          }
          out.push(node)
        } else {
          const cols = row.ColData || []
          out.push({
            id: `n${nodeIdSeq++}`,
            kind: 'data',
            label: cols[0]?.value || '',
            account_id: cols[0]?.id || null,
            total: cols[1]?.value !== undefined && cols[1]?.value !== '' ? Number(cols[1].value) : null,
            depth,
          })
        }
      }
      return out
    }

    const rows = walkRows(report?.Rows, 0)
    const payload = {
      currency: report?.Header?.Currency || 'CAD',
      as_of: report?.Header?.EndPeriod || null,
      generated_at: report?.Header?.Time || new Date().toISOString(),
      rows,
    }
    balanceSheetCache.set(cacheKey, payload)
    res.json(payload)
  } catch (e) {
    console.error('[dashboard/balance-sheet]', e)
    res.status(502).json({ error: e.message || 'Erreur QuickBooks' })
  }
})

// GET /api/dashboard/deferred-revenue
// Revenus perçus d'avance (compte 23900) : factures de commande encaissées
// (paid_at) dont le revenu n'a pas encore été constaté à l'expédition
// (revenue_recognized_at NULL). Remplace la table manuelle « Revenus perçus
// d'avance » du fichier CTB - Suivi. Abonnements exclus (kind='order' —
// politique : constat à la création du premier envoi, ventes unitaires only).
router.get('/deferred-revenue', (req, res) => {
  const rows = db.prepare(`
    SELECT f.id, f.document_number, f.paid_at, f.document_date,
           f.paid_amount, f.total_amount, f.currency,
           f.deferred_revenue_at, f.deferred_revenue_amount_cad,
           f.company_id, c.name AS company_name, f.order_id
    FROM factures f
    LEFT JOIN companies c ON c.id = f.company_id
    WHERE f.kind = 'order'
      AND f.paid_at IS NOT NULL
      AND f.revenue_recognized_at IS NULL
      AND COALESCE(f.status, '') = 'Payé'
    ORDER BY f.paid_at DESC
  `).all()

  const items = rows.map(r => {
    const native = (Number(r.paid_amount) || 0) > 0 ? Number(r.paid_amount) : (Number(r.total_amount) || 0)
    // CAD : montant de l'écriture 23900 si posée, sinon le montant encaissé
    // (déjà en CAD quand currency=CAD ; pour l'USD sans écriture, inconnu → null).
    const amountCad = r.deferred_revenue_amount_cad != null
      ? Number(r.deferred_revenue_amount_cad)
      : (r.currency === 'CAD' ? native : null)
    return {
      id: r.id,
      document_number: r.document_number,
      paid_at: r.paid_at,
      company_id: r.company_id,
      company_name: r.company_name,
      order_id: r.order_id,
      amount_native: Math.round(native * 100) / 100,
      currency: r.currency || 'CAD',
      amount_cad: amountCad != null ? Math.round(amountCad * 100) / 100 : null,
      deferred_posted: r.deferred_revenue_at != null, // écriture Cr 23900 posée au dépôt du payout
    }
  })

  const total_cad = Math.round(items.reduce((s, i) => s + (i.amount_cad || 0), 0) * 100) / 100
  const unconverted = items.filter(i => i.amount_cad == null).length
  res.json({ generated_at: new Date().toISOString(), items, total_cad, unconverted })
})

// GET /api/dashboard/bank-accounts
// Soldes du jour des comptes bancaires et cartes de crédit depuis QuickBooks.
// QB expose le solde courant de chaque compte via le champ CurrentBalance.
// Les cartes de crédit (passif) ont typiquement un CurrentBalance négatif.
//
// Cache permanent invalidé sur toute écriture QB via onQbMutation ci-dessous,
// et sur `?refresh=1` (bouton de rafraîchissement manuel). Une édition humaine
// directe dans l'UI QuickBooks ne déclenche pas l'invalidation — utiliser
// ?refresh=1 dans ce cas.
const bankAccountsCache = new Map()
onQbMutation(() => bankAccountsCache.clear())

// Limite de la marge de crédit (Desjardins + BNC confondues) — plancher de la
// trésorerie affichée sur le dashboard. Valeur métier fournie par Orisha.
const CREDIT_LINE_LIMIT = 360000

// Comptes qui composent la trésorerie : banques + cartes/marges de crédit.
// Même définition pour le solde du jour et pour l'historique mensuel, sinon les
// deux chiffres ne parleraient pas du même périmètre.
const QB_CASH_ACCOUNTS_QUERY = "SELECT * FROM Account WHERE AccountType IN ('Bank', 'Credit Card') AND Active = true MAXRESULTS 300"

router.get('/bank-accounts', async (req, res) => {
  try {
    if (!req.query.refresh) {
      const hit = bankAccountsCache.get('default')
      if (hit) return res.json(hit)
    }
    const q = new URLSearchParams({ query: QB_CASH_ACCOUNTS_QUERY })
    const data = await qbGet(`/query?${q}`)
    const rawAccounts = data.QueryResponse?.Account || []

    const accounts = rawAccounts.map(a => ({
      id: a.Id,
      name: a.Name,
      type: a.AccountType, // 'Bank' | 'Credit Card'
      sub_type: a.AccountSubType || null,
      balance: a.CurrentBalance != null ? Number(a.CurrentBalance) : 0,
      currency: a.CurrencyRef?.value || 'CAD',
    }))

    // Taux de change QB pour convertir les comptes en devise étrangère (USD…)
    // vers la devise maison (CAD). Sans conversion, les totaux mélangeraient
    // des USD et des CAD. En cas d'échec du fetch, repli sur 1:1.
    const foreignCurrencies = [...new Set(accounts.map(a => a.currency).filter(c => c && c !== 'CAD'))]
    const exchangeRates = {}
    for (const cur of foreignCurrencies) {
      try {
        const xr = await qbGet(`/exchangerate?sourcecurrencycode=${encodeURIComponent(cur)}`)
        const rate = Number(xr?.ExchangeRate?.Rate)
        if (Number.isFinite(rate) && rate > 0) exchangeRates[cur] = rate
      } catch (e) {
        console.error(`[dashboard/bank-accounts] taux de change ${cur} introuvable:`, e.message)
      }
    }
    for (const a of accounts) {
      const rate = a.currency === 'CAD' ? 1 : (exchangeRates[a.currency] || 1)
      a.balance_cad = Math.round(a.balance * rate * 100) / 100
    }

    // Tri : comptes bancaires d'abord, puis cartes de crédit, alpha par nom.
    accounts.sort((x, y) => {
      if (x.type !== y.type) return x.type === 'Bank' ? -1 : 1
      return x.name.localeCompare(y.name)
    })

    const bankTotal = accounts.filter(a => a.type === 'Bank').reduce((s, a) => s + a.balance_cad, 0)
    const creditCardTotal = accounts.filter(a => a.type === 'Credit Card').reduce((s, a) => s + a.balance_cad, 0)
    // Les passifs (cartes, marges) ont un CurrentBalance négatif quand dus,
    // donc l'addition donne bien banques − dettes.
    const treasury = Math.round((bankTotal + creditCardTotal) * 100) / 100

    const payload = {
      currency: 'CAD',
      generated_at: new Date().toISOString(),
      accounts,
      exchange_rates: exchangeRates,
      totals: {
        bank: Math.round(bankTotal * 100) / 100,
        credit_card: Math.round(creditCardTotal * 100) / 100,
        net: treasury,
      },
      treasury,
      credit_limit: CREDIT_LINE_LIMIT,
    }
    bankAccountsCache.set('default', payload)
    res.json(payload)
  } catch (e) {
    console.error('[dashboard/bank-accounts]', e)
    res.status(502).json({ error: e.message || 'Erreur QuickBooks' })
  }
})

// GET /api/dashboard/bank-accounts/history?months=12
// Évolution mensuelle de la trésorerie (banques − cartes & marges de crédit).
//
// Source : rapport BalanceSheet QuickBooks en colonnes mensuelles
// (`summarize_column_by=Month`) — chaque colonne donne le solde de FIN de mois
// de chaque compte. Les comptes retenus sont exactement ceux du panneau du jour
// (AccountType Bank / Credit Card), appariés par Id de compte plutôt que par
// nom de section : les libellés du rapport sont localisés (« Cartes de crédit »),
// donc non fiables comme clé.
//
// Convention de signe : dans le BalanceSheet, un passif dû est POSITIF, alors
// que `Account.CurrentBalance` est négatif pour ce même solde. La trésorerie est
// donc `banques − cartes` ici, là où le panneau du jour fait une addition.
//
// Note FX : le rapport exprime les comptes en devise étrangère à leur valeur
// aux livres (taux des transactions), pas au taux spot du jour — l'historique
// peut donc s'écarter légèrement du solde instantané affiché au-dessus.
const bankHistoryCache = new Map()
onQbMutation(() => bankHistoryCache.clear())

router.get('/bank-accounts/history', async (req, res) => {
  try {
    const months = Math.min(Math.max(parseInt(req.query.months, 10) || 12, 2), 36)
    const cacheKey = `m${months}`
    if (!req.query.refresh) {
      const hit = bankHistoryCache.get(cacheKey)
      if (hit) return res.json(hit)
    }

    const accQ = new URLSearchParams({ query: QB_CASH_ACCOUNTS_QUERY })
    const accData = await qbGet(`/query?${accQ}`)
    const typeById = new Map()
    for (const a of (accData.QueryResponse?.Account || [])) typeById.set(String(a.Id), a.AccountType)

    // Fenêtre glissante : `months` mois finissant par le mois courant (partiel).
    const now = new Date()
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1))
    const params = new URLSearchParams({
      accounting_method: 'Accrual',
      summarize_column_by: 'Month',
      start_date: start.toISOString().slice(0, 10),
      end_date: new Date().toISOString().slice(0, 10),
    })
    const data = await qbGet(`/reports/BalanceSheet?${params}`)
    const report = data?.Report || data

    // Colonnes : la première est le libellé de compte, les suivantes les mois.
    const cols = (report?.Columns?.Column || []).map(c => {
      const meta = {}
      for (const m of (c.MetaData || [])) meta[m.Name] = m.Value
      return { type: c.ColType, title: c.ColTitle, start: meta.StartDate || null, end: meta.EndDate || null }
    })
    const monthCols = cols
      .map((c, idx) => ({ ...c, idx }))
      .filter(c => c.type === 'Money' && c.start)
      .map(c => ({ ...c, month: c.start.slice(0, 7) }))

    const bank = new Array(monthCols.length).fill(0)
    const creditCard = new Array(monthCols.length).fill(0)

    // Seules les lignes de données portent un Id de compte exploitable ; les
    // en-têtes/summary de Section sont ignorés pour ne pas double-compter les
    // comptes parents multidevises.
    const walk = rows => {
      for (const row of (rows?.Row || [])) {
        if (row.type === 'Section') { walk(row.Rows); continue }
        const cd = row.ColData || []
        const type = typeById.get(String(cd[0]?.id || ''))
        if (!type) continue
        monthCols.forEach((c, i) => {
          const raw = cd[c.idx]?.value
          const v = raw === '' || raw == null ? 0 : Number(raw)
          if (!Number.isFinite(v)) return
          if (type === 'Bank') bank[i] += v
          else creditCard[i] += v
        })
      }
    }
    walk(report?.Rows)

    const round = v => Math.round(v * 100) / 100
    const currentMonth = new Date().toISOString().slice(0, 7)
    const series = monthCols.map((c, i) => ({
      month: c.month,
      period_end: c.end,
      bank: round(bank[i]),
      credit_card: round(creditCard[i]),
      treasury: round(bank[i] - creditCard[i]),
      is_current_month: c.month === currentMonth,
    }))

    const payload = {
      currency: report?.Header?.Currency || 'CAD',
      generated_at: new Date().toISOString(),
      months: series,
      credit_limit: CREDIT_LINE_LIMIT,
    }
    bankHistoryCache.set(cacheKey, payload)
    res.json(payload)
  } catch (e) {
    console.error('[dashboard/bank-accounts/history]', e)
    res.status(502).json({ error: e.message || 'Erreur QuickBooks' })
  }
})

export default router;
