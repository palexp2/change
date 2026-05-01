import { Router } from 'express';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/database.js';
import { requireAdmin } from '../middleware/auth.js';
import { readFileSync, statSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import os from 'os';
import Stripe from 'stripe';
import { postInvoicePaidJE, stripeInvoiceNetHtCents } from '../services/quickbooks.js';

const router = Router();
router.use(requireAdmin);

// POST /api/admin/factures/backfill-paid-at  body: { limit?: number = 100 }
// Récupère depuis Stripe le paid_at / amount_paid / charge pour les factures
// Stripe payées dont les champs paid_* sont NULL. Utile une fois après l'ajout
// des colonnes paid_at — ensuite le webhook invoice.paid les pose en live.
router.post('/factures/backfill-paid-at', async (req, res) => {
  const stripeKey = getStripeKey()
  if (!stripeKey) return res.status(400).json({ error: 'Stripe non configuré' })
  const limit = Math.max(1, Math.min(parseInt(req.body?.limit) || 100, 500))
  const stripe = new Stripe(stripeKey)

  const candidates = db.prepare(`
    SELECT id, invoice_id, status, balance_due
    FROM factures
    WHERE invoice_id IS NOT NULL
      AND paid_at IS NULL
      AND (status = 'Payé' OR status = 'Payée')
    ORDER BY COALESCE(document_date, created_at) DESC
    LIMIT ?
  `).all(limit)

  const results = { updated: 0, skipped: 0, errors: [] }
  const upd = db.prepare(
    'UPDATE factures SET paid_at=?, paid_amount=?, paid_charge_id=?, paid_payment_intent=?, updated_at=strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\') WHERE id=?'
  )

  for (const f of candidates) {
    try {
      const inv = await stripe.invoices.retrieve(f.invoice_id, { expand: ['payments'] })
      if (inv.status !== 'paid') { results.skipped++; continue }
      const paidTs = inv.status_transitions?.paid_at
      const paidAt = paidTs ? new Date(paidTs * 1000).toISOString() : null
      const paidAmount = (inv.amount_paid ?? inv.total ?? 0) / 100
      const chargeId = typeof inv.charge === 'string' ? inv.charge : (inv.charge?.id || null)
      // Stripe ≥ 2024 : payment_intent migré sous inv.payments.data[0].payment.payment_intent
      const paymentIntent = inv.payment_intent
        || inv.payments?.data?.[0]?.payment?.payment_intent
        || null
      if (!paidAt) { results.skipped++; continue }
      upd.run(paidAt, paidAmount, chargeId, paymentIntent, f.id)
      results.updated++
    } catch (e) {
      results.errors.push({ facture_id: f.id, invoice_id: f.invoice_id, error: e.message })
    }
  }
  res.json({ scanned: candidates.length, ...results })
})

// POST /api/admin/factures/:id/clear-deferred-revenue
// Nettoie les champs deferred_revenue_* d'une facture quand la transaction QB
// correspondante n'existe pas réellement (orphelin DB). Ne touche pas aux
// champs revenue_recognized_* — c'est un concept séparé.
// Use case : un sync incomplet ou une suppression manuelle d'un payment a
// laissé des champs deferred sans contrepartie en QB → on remet à zéro pour
// que la fiche cesse d'afficher le badge "Revenu perçu d'avance" et le bouton
// "Constater la vente".
router.post('/factures/:id/clear-deferred-revenue', (req, res) => {
  const f = db.prepare('SELECT id, deferred_revenue_at FROM factures WHERE id=?').get(req.params.id)
  if (!f) return res.status(404).json({ error: 'Facture introuvable' })
  if (!f.deferred_revenue_at) return res.json({ ok: true, already_clean: true })
  db.prepare(`
    UPDATE factures
    SET deferred_revenue_at = NULL,
        deferred_revenue_amount_native = NULL,
        deferred_revenue_amount_cad = NULL,
        deferred_revenue_currency = NULL,
        deferred_revenue_qb_ref = NULL,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(req.params.id)
  res.json({ ok: true })
})

// GET /api/admin/users
router.get('/users', (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.email, u.name, u.role, u.active, u.created_at, u.employee_id,
           TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) as employee_name
    FROM users u
    LEFT JOIN employees e ON u.employee_id = e.id
    ORDER BY u.name
  `).all();
  res.json(users);
});

// POST /api/admin/users
router.post('/users', async (req, res) => {
  const { email, name, password, role } = req.body;
  if (!email || !name || !password || !role) {
    return res.status(400).json({ error: 'email, name, password, role are required' });
  }
  const validRoles = ['admin', 'sales', 'support', 'ops'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (existing) {
    return res.status(409).json({ error: 'Email already in use' });
  }

  const id = uuidv4();
  const passwordHash = await bcrypt.hash(password, 10);
  db.prepare(
    'INSERT INTO users (id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?)'
  ).run(id, email.toLowerCase().trim(), passwordHash, name, role);

  res.status(201).json(db.prepare('SELECT id, email, name, role, active, created_at FROM users WHERE id = ?').get(id));
});

// PUT /api/admin/users/:id
router.put('/users/:id', async (req, res) => {
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { name, email, role, active, password, employee_id } = req.body;
  const validRoles = ['admin', 'sales', 'support', 'ops'];
  if (role && !validRoles.includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  if (email) {
    const conflict = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email.toLowerCase().trim(), req.params.id);
    if (conflict) return res.status(409).json({ error: 'Ce courriel est déjà utilisé' });
  }

  if (employee_id) {
    const exists = db.prepare('SELECT id FROM employees WHERE id = ?').get(employee_id);
    if (!exists) return res.status(400).json({ error: 'Employé introuvable' });
    const claimed = db.prepare('SELECT id FROM users WHERE employee_id = ? AND id != ?').get(employee_id, req.params.id);
    if (claimed) return res.status(409).json({ error: 'Cet employé est déjà lié à un autre utilisateur' });
  }

  if (password) {
    const hash = await bcrypt.hash(password, 10);
    db.prepare('UPDATE users SET password_hash=? WHERE id = ?').run(hash, req.params.id);
  }

  const current = db.prepare('SELECT name, email, role, employee_id FROM users WHERE id = ?').get(req.params.id);
  db.prepare('UPDATE users SET name=?, email=?, role=?, active=?, employee_id=? WHERE id = ?')
    .run(
      name ?? current.name,
      email ? email.toLowerCase().trim() : current.email,
      role ?? current.role,
      active !== undefined ? (active ? 1 : 0) : 1,
      employee_id !== undefined ? (employee_id || null) : current.employee_id,
      req.params.id,
    );

  res.json(db.prepare('SELECT id, email, name, role, active, employee_id, created_at FROM users WHERE id = ?').get(req.params.id));
});

// POST /api/admin/users/:id/reset-password
router.post('/users/:id/reset-password', async (req, res) => {
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { password } = req.body;
  if (!password || password.length < 8) return res.status(400).json({ error: 'Minimum 8 caractères' });
  const hash = await bcrypt.hash(password, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.params.id);
  res.json({ ok: true });
});

// DELETE /api/admin/users/:id
router.delete('/users/:id', (req, res) => {
  // Can't delete yourself
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  db.prepare('UPDATE users SET active=0 WHERE id = ?').run(req.params.id);
  res.json({ message: 'User deactivated' });
});

// GET /api/admin/health
router.get('/health', (req, res) => {
  // ── Disque ────────────────────────────────────────────────────────────────
  let disk = null
  try {
    const out = execSync("df -k / | tail -1").toString().trim().split(/\s+/)
    disk = { total: parseInt(out[1]) * 1024, used: parseInt(out[2]) * 1024, available: parseInt(out[3]) * 1024 }
  } catch {}

  // ── RAM ───────────────────────────────────────────────────────────────────
  const totalMem = os.totalmem()
  const freeMem  = os.freemem()
  const ram = { total: totalMem, used: totalMem - freeMem, free: freeMem }

  // ── CPU ───────────────────────────────────────────────────────────────────
  const load = os.loadavg()
  const cpu = { load1: load[0], load5: load[1], load15: load[2], cores: os.cpus().length }

  // ── Uptime ────────────────────────────────────────────────────────────────
  const uptime = os.uptime()

  // ── PM2 processes ─────────────────────────────────────────────────────────
  let processes = []
  try {
    const raw = execSync('pm2 jlist 2>/dev/null').toString()
    const list = JSON.parse(raw)
    processes = list.map(p => ({
      name: p.name,
      status: p.pm2_env.status,
      uptime: p.pm2_env.pm_uptime,
      restarts: p.pm2_env.restart_time,
      memory: p.monit?.memory || 0,
      cpu: p.monit?.cpu || 0,
      pid: p.pid,
    }))
  } catch {}

  // ── SQLite DB size ────────────────────────────────────────────────────────
  let dbSize = null
  try {
    const dbPath = process.env.DATABASE_PATH || './data/erp.db'
    dbSize = statSync(dbPath).size
  } catch {}

  // ── Répartition espace disque ─────────────────────────────────────────────
  function duBytes(p) {
    try {
      const out = execSync(`du -sb "${p}" 2>/dev/null`).toString().trim()
      return parseInt(out.split('\t')[0]) || 0
    } catch { return 0 }
  }
  const home = os.homedir()
  const diskBreakdown = [
    { label: 'Enregistrements d\'appels', bytes: duBytes(`${home}/erp/server/uploads/calls`) },
    { label: 'Photos produits',           bytes: duBytes(`${home}/erp/server/uploads/products`) },
    { label: 'Base de données',           bytes: duBytes(`${home}/erp/server/data`) },
    { label: 'Dépendances Node',          bytes: duBytes(`${home}/erp/server/node_modules`) },
    { label: 'Logs PM2',                  bytes: duBytes(`${home}/.pm2/logs`) },
    { label: 'FTP uploads',               bytes: duBytes(`${home}/ftp-server/uploads`) },
  ]
  if (disk) {
    const accounted = diskBreakdown.reduce((s, c) => s + c.bytes, 0)
    diskBreakdown.push({ label: 'Autres / Système', bytes: Math.max(0, disk.used - accounted) })
  }

  // ── Whisper queue ─────────────────────────────────────────────────────────
  const whisper = db.prepare(`
    SELECT transcription_status, COUNT(*) as total FROM calls GROUP BY transcription_status
  `).all().reduce((acc, r) => { acc[r.transcription_status] = r.total; return acc }, {})

  // ── Dernières erreurs ERP ─────────────────────────────────────────────────
  let recentErrors = []
  try {
    const logPath = process.env.PM2_ERROR_LOG || `${os.homedir()}/.pm2/logs/erp-server-error.log`
    if (existsSync(logPath)) {
      const lines = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean)
      recentErrors = lines.slice(-8).reverse()
    }
  } catch {}

  res.json({ disk, ram, cpu, uptime, processes, dbSize, whisper, recentErrors, diskBreakdown })
})



// GET /api/admin/trash — enregistrements supprimés de toutes les tables
router.get('/trash', (req, res) => {
  const trash = {}

  const tables = [
    { key: 'custom_fields', label: 'Champs personnalisés', sql: `SELECT id, (erp_table || ' / ' || name) as label, deleted_at FROM custom_fields WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC` },
    { key: 'companies',     label: 'Entreprises',     sql: `SELECT id, name as label, deleted_at FROM companies WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC` },
    { key: 'contacts',      label: 'Contacts',        sql: `SELECT id, (first_name || ' ' || last_name) as label, deleted_at FROM contacts WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC` },
    { key: 'orders',        label: 'Commandes',       sql: `SELECT id, ('Commande #' || order_number) as label, deleted_at FROM orders WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC` },
    { key: 'products',      label: 'Produits',        sql: `SELECT id, COALESCE(name_fr, name_en, sku) as label, deleted_at FROM products WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC` },
    { key: 'shipments',     label: 'Envois',          sql: `SELECT s.id, COALESCE('Envoi #' || o.order_number, s.tracking_number, s.id) as label, s.deleted_at FROM shipments s LEFT JOIN orders o ON s.order_id=o.id WHERE s.deleted_at IS NOT NULL ORDER BY s.deleted_at DESC` },
    { key: 'returns',       label: 'Retours',         sql: `SELECT id, COALESCE(return_number, id) as label, deleted_at FROM returns WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC` },
    { key: 'projects',      label: 'Projets',         sql: `SELECT id, name as label, deleted_at FROM projects WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC` },
    { key: 'assemblages',   label: 'Assemblages',     sql: `SELECT id, COALESCE(name, id) as label, deleted_at FROM assemblages WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC` },
    { key: 'tasks',         label: 'Tâches',          sql: `SELECT id, title as label, deleted_at FROM tasks WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC` },
    { key: 'interactions',  label: 'Interactions',    sql: `SELECT i.id, COALESCE(e.subject, i.type) as label, i.deleted_at FROM interactions i LEFT JOIN emails e ON e.interaction_id=i.id WHERE i.deleted_at IS NOT NULL ORDER BY i.deleted_at DESC` },
    { key: 'serial_numbers',label: 'Numéros de série',sql: `SELECT id, serial as label, deleted_at FROM serial_numbers WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC` },
  ]

  for (const t of tables) {
    try { trash[t.key] = { label: t.label, items: db.prepare(t.sql).all() } }
    catch { trash[t.key] = { label: t.label, items: [] } }
  }

  res.json(trash)
})

// POST /api/admin/trash/:table/:id/restore
router.post('/trash/:table/:id/restore', (req, res) => {
  const allowed = ['companies','contacts','orders','products','shipments','returns','projects','assemblages','tasks','interactions','serial_numbers','custom_fields']
  if (!allowed.includes(req.params.table)) return res.status(400).json({ error: 'Table invalide' })

  const result = db.prepare(`UPDATE ${req.params.table} SET deleted_at = NULL WHERE id = ?`).run(req.params.id)
  if (result.changes === 0) return res.status(404).json({ error: 'Enregistrement introuvable' })
  res.json({ ok: true })
})

// DELETE /api/admin/trash — purge définitive de tous les enregistrements supprimés
router.delete('/trash', (req, res) => {
  const tables = ['companies','contacts','orders','products','shipments','returns','projects','assemblages','tasks','interactions','serial_numbers','custom_fields']
  let total = 0
  for (const t of tables) {
    try { total += db.prepare(`DELETE FROM ${t} WHERE deleted_at IS NOT NULL`).run().changes } catch {}
  }
  res.json({ purged: total })
})

// ── Backfill factures Stripe post-cutoff (refonte avril 2026) ───────────────
//
// Pendant la transition vers le pivot 12900, les factures Stripe payées entre
// le cutoff (date du dernier rapprochement QB côté ancien code) et le déploiement
// du nouveau code n'ont ni JE invoice.paid (nouveau code pas encore déployé) ni
// crédit revenue_* dans un Deposit QB (payouts pas encore poussés). Cette route
// rattrape ces factures en posant rétroactivement la JE Dr 12900 / Cr revenu.
//
// GET preview, POST process. Idempotent — skip les factures avec déjà une ligne
// payments direction='in' method='stripe'.
function getStripeKey() {
  const row = db.prepare("SELECT value FROM connector_config WHERE connector='stripe' AND key='secret_key'").get()
  return row?.value || null
}

function listBackfillCandidates(cutoffDate) {
  return db.prepare(`
    SELECT f.id, f.invoice_id, f.document_number, f.document_date, f.kind,
           f.currency, f.amount_before_tax_cad, f.total_amount, f.status,
           f.deferred_revenue_at, f.revenue_recognized_at,
           (SELECT COUNT(*) FROM payments p WHERE p.facture_id = f.id AND p.direction = 'in' AND p.method = 'stripe' AND (p.qb_journal_entry_id IS NOT NULL OR p.qb_payment_id IS NOT NULL)) AS posted_payments
    FROM factures f
    WHERE f.invoice_id IS NOT NULL
      AND f.sync_source = 'Factures Stripe'
      AND f.status = 'Payé'
      AND f.document_date > ?
    ORDER BY f.document_date, f.document_number
  `).all(cutoffDate)
}

// GET /api/admin/stripe-backfill/preview?cutoff=YYYY-MM-DD
router.get('/stripe-backfill/preview', (req, res) => {
  const cutoff = String(req.query.cutoff || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) {
    return res.status(400).json({ error: 'cutoff doit être au format YYYY-MM-DD' })
  }
  const rows = listBackfillCandidates(cutoff)
  const pending = rows.filter(r => r.posted_payments === 0)
  const alreadyDone = rows.filter(r => r.posted_payments > 0)
  res.json({
    cutoff,
    total_candidates: rows.length,
    pending_count: pending.length,
    already_done_count: alreadyDone.length,
    pending: pending.map(r => ({
      id: r.id,
      invoice_id: r.invoice_id,
      document_number: r.document_number,
      document_date: r.document_date,
      kind: r.kind,
      currency: r.currency,
      amount_before_tax: r.amount_before_tax_cad,
      total: r.total_amount,
    })),
  })
})

// POST /api/admin/stripe-backfill/process — body: { cutoff, facture_ids?, dry_run? }
// Si facture_ids est fourni, n'agit que sur ces factures-là. Sinon, traite tous les pending.
router.post('/stripe-backfill/process', async (req, res) => {
  const { cutoff, facture_ids, dry_run } = req.body || {}
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(cutoff || ''))) {
    return res.status(400).json({ error: 'cutoff doit être au format YYYY-MM-DD' })
  }
  const stripeKey = getStripeKey()
  if (!stripeKey) return res.status(400).json({ error: 'Stripe non configuré' })
  const stripe = new Stripe(stripeKey)

  let candidates = listBackfillCandidates(cutoff).filter(r => r.posted_payments === 0)
  if (Array.isArray(facture_ids) && facture_ids.length) {
    const set = new Set(facture_ids)
    candidates = candidates.filter(r => set.has(r.id))
  }

  const results = []
  for (const f of candidates) {
    try {
      // Si une ligne payments orpheline existe déjà (sans qb_journal_entry_id, créée
      // par une tentative précédente qui a échoué côté QB), on la réutilise au lieu
      // de créer un doublon.
      const existing = db.prepare(
        "SELECT id FROM payments WHERE facture_id = ? AND direction = 'in' AND method = 'stripe' AND qb_journal_entry_id IS NULL AND qb_payment_id IS NULL LIMIT 1"
      ).get(f.id)

      let paymentId = existing?.id
      let chargeId, netHt, currency, receivedAt

      if (!paymentId) {
        // Récupérer les infos depuis Stripe et créer la ligne payments.
        const inv = await stripe.invoices.retrieve(f.invoice_id)
        chargeId = typeof inv.charge === 'string' ? inv.charge : inv.charge?.id || null
        netHt = stripeInvoiceNetHtCents(inv) / 100
        currency = (inv.currency || f.currency || 'CAD').toUpperCase()
        receivedAt = inv.status_transitions?.paid_at
          ? new Date(inv.status_transitions.paid_at * 1000).toISOString()
          : (inv.created ? new Date(inv.created * 1000).toISOString() : new Date().toISOString())

        if (dry_run) {
          results.push({ facture_id: f.id, document_number: f.document_number, would_create: { charge_id: chargeId, amount: netHt, currency, received_at: receivedAt } })
          continue
        }

        const { randomUUID } = await import('crypto')
        paymentId = randomUUID()
        db.prepare(`
          INSERT INTO payments (
            id, facture_id, direction, method, received_at, amount, currency,
            stripe_charge_id, notes
          ) VALUES (?, ?, 'in', 'stripe', ?, ?, ?, ?, ?)
        `).run(paymentId, f.id, receivedAt, Math.round(netHt * 100) / 100, currency, chargeId, `Backfill post-cutoff ${cutoff} — invoice ${f.invoice_id}`)
      } else if (dry_run) {
        results.push({ facture_id: f.id, document_number: f.document_number, would_retry_existing_payment: paymentId })
        continue
      }

      // Pose (ou re-tente) la JE QB. Si on n'a pas encore l'invoice (cas reuse),
      // on la fetch maintenant pour pouvoir résoudre le TaxCode.
      let invForJe = null
      if (existing) {
        try { invForJe = await stripe.invoices.retrieve(f.invoice_id) } catch {}
      } else {
        // Inv déjà fetchée plus haut pour créer la ligne ; on la passe directement.
        // Mais on l'a déjà perdue (variable locale au if). Re-fetch.
        try { invForJe = await stripe.invoices.retrieve(f.invoice_id) } catch {}
      }
      try {
        const r = await postInvoicePaidJE(paymentId, invForJe ? { invoice: invForJe } : {})
        results.push({ facture_id: f.id, document_number: f.document_number, payment_id: paymentId, qb_je: r.qb_journal_entry_id, qb_sales_receipt: r.qb_payment_id, credit: r.credit_account, reused: !!existing })
      } catch (qbErr) {
        results.push({ facture_id: f.id, document_number: f.document_number, payment_id: paymentId, qb_error: qbErr.message })
      }
    } catch (err) {
      results.push({ facture_id: f.id, document_number: f.document_number, error: err.message })
    }
  }

  res.json({
    cutoff,
    dry_run: !!dry_run,
    processed: results.length,
    success: results.filter(r => r.qb_je || r.qb_sales_receipt).length,
    qb_errors: results.filter(r => r.qb_error).length,
    other_errors: results.filter(r => r.error).length,
    results,
  })
})

export default router;
