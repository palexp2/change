import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import path from 'path'
import { fileURLToPath } from 'url'
import dotenv from 'dotenv'

// Validate critical secrets early (throws if JWT_SECRET missing)
import './config/secrets.js'

import { initSchema, seedSellableProducts } from './db/schema.js'
import { seedSystemAutomations, logSystemRun, isSystemAutomationActive } from './services/systemAutomations.js'
import { runPurge } from './services/purge.js'
import authRouter from './routes/auth.js'
import companiesRouter from './routes/companies.js'
import contactsRouter from './routes/contacts.js'
import projectsRouter from './routes/projects.js'
import customFieldsRouter from './routes/custom-fields.js'
import productsRouter from './routes/products.js'
import ordersRouter from './routes/orders.js'
import ticketsRouter from './routes/tickets.js'
import dashboardRouter from './routes/dashboard.js'
import adminRouter from './routes/admin.js'
import undoRouter from './routes/undo.js'
import interactionsRouter from './routes/interactions.js'
import callsRouter, { rematchCalls } from './routes/calls.js'
import connectorsRouter from './routes/connectors.js'
import purchasesRouter from './routes/purchases.js'
import serialsRouter from './routes/serials.js'
import viewsRouter from './routes/views.js'
import projetsRouter from './routes/projets.js'
import paymentsRouter from './routes/payments.js'
import catalogRouter from './routes/catalog.js'
import documentsRouter from './routes/documents.js'
import searchRouter from './routes/search.js'
import shipmentsRouter from './routes/shipments.js'
import automationsRouter from './routes/automations.js'
import tasksRouter from './routes/tasks.js'
import agentRouter from './routes/agent.js'
import achatsFournisseursRouter from './routes/achats-fournisseurs.js'
import employeesRouter from './routes/employees.js'
import vacationsRouter from './routes/vacations.js'
import paiesRouter from './routes/paies.js'
import timesheetsRouter from './routes/timesheets.js'
import activityCodesRouter from './routes/activity-codes.js'
import hourBankRouter from './routes/hour-bank.js'
import saleReceiptsRouter from './routes/sale-receipts.js'
import journalEntriesRouter from './routes/journal-entries.js'
import stockMovementsRouter from './routes/stock-movements.js'
import stripeWebhooksRouter from './routes/stripe-webhooks.js'
import stripeInvoicesRouter from './routes/stripe-invoices.js'
import customerPayRouter from './routes/customer-pay.js'
import customerPostPaymentRouter from './routes/customer-post-payment.js'
import emailTrackingRouter from './routes/email-tracking.js'
import stripeQueueRouter from './routes/stripe-queue.js'
import stripePayoutsRouter from './routes/stripe-payouts.js'
import stripeInvoiceItemsRouter from './routes/stripe-invoice-items.js'
import novoxpressRouter from './routes/novoxpress.js'
import trackRouter from './routes/track.js'
import installationFeedbackRouter from './routes/installation-feedback.js'
import { sendInstallationFollowups } from './services/installationFollowup.js'
import { resolveFromAddress, getAutomationFrom } from './services/postmarkConfig.js'
import { createRealtimeServer } from './services/realtime.js'
import { initTaskRunner, shutdownTaskRunner } from './services/taskRunner.js'
import { initScheduler } from './services/automationScheduler.js'
import { syncAllMailboxes } from './services/gmail.js'
import { syncAirtable, syncProjets, syncPieces, syncOrders, syncAchats, syncBillets, syncSerials, syncEnvois, syncSoumissions, syncRetours, syncRetourItems, syncAdresses, syncBomItems, syncSerialStateChanges, syncAssemblages, syncStockMovements } from './services/airtable.js'
import { tracked } from './services/syncState.js'
import { syncStripeSubscriptions, isStripeConfigured } from './services/stripe.js'
import { initAirtableWebhooks } from './services/airtableWebhooks.js'
import { getAccessToken as getAirtableToken } from './connectors/airtable.js'
import { logSync, purgeSyncLogs } from './services/syncLog.js'
import { pullDelta as hsPullDelta } from './services/hubspotSync.js'
import { isHubSpotConfigured } from './connectors/hubspot.js'
import db from './db/database.js'

dotenv.config()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 3004

app.disable('x-powered-by')
app.set('trust proxy', 1) // behind nginx — needed for correct req.ip

app.use(helmet({
  // CSP désactivé pour l'instant : à activer après audit des sources externes
  // (Stripe iframe, Google Maps, fontes, etc.) pour éviter de tout casser.
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'same-site' },
}))

// CORS : autorise same-origin + whitelist explicite (env CORS_ORIGINS).
// `<script crossorigin>` dans index.html déclenche un Origin header même same-host,
// d'où la comparaison Origin↔Host pour ne pas casser les assets statiques.
const allowedOrigins = (process.env.CORS_ORIGINS || 'https://customer.orisha.io')
  .split(',').map(s => s.trim()).filter(Boolean)
app.use((req, res, next) => {
  const corsMw = cors({
    origin: (o, cb) => {
      if (!o) return cb(null, true) // same-origin direct / curl / server-to-server
      if (allowedOrigins.includes(o)) return cb(null, true)
      // Same-host (origin host matches request Host header) — accept.
      try {
        const u = new URL(o)
        if (u.host === req.headers.host) return cb(null, true)
      } catch {}
      return cb(new Error(`CORS: origin ${o} not allowed`))
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Agent-Secret'],
  })
  return corsMw(req, res, next)
})

// Rewrite /erp/api/* → /api/* so the built frontend works without a dev proxy
// Must be before all route mounts so external URLs like Stripe webhooks resolve correctly
app.use((req, res, next) => {
  if (req.url.startsWith('/erp/api/')) req.url = req.url.slice('/erp'.length)
  next()
})

// Stripe webhooks need raw body for signature verification — mount before express.json
app.use('/api/stripe-webhooks', express.raw({ type: 'application/json' }), (req, res, next) => {
  req.rawBody = req.body
  req.body = JSON.parse(req.body)
  next()
}, stripeWebhooksRouter)

app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

// Serve call recordings
app.use('/api/recordings', express.static(path.join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'calls')))
// Serve bons de livraison
app.use('/api/bons-livraison', express.static(path.join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'bons-livraison')))
// Serve product images
app.use('/api/product-images', express.static(path.join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'products')))
// Serve record attachments
app.use('/api/attachments', express.static(path.join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'attachments')))

import { ensureNativeFieldDefs } from './services/airtableAutoSync.js'

initSchema()
seedSellableProducts()
seedSystemAutomations()
runPurge()

// Register native fields in airtable_field_defs so they appear in views/filters
ensureNativeFieldDefs([
  { module: 'pieces', erp_table: 'products', column_name: 'name_fr',    label: 'Nom',                      field_type: 'text',   sort_order: -1000 },
  { module: 'pieces', erp_table: 'products', column_name: 'name_en',    label: 'Nom (EN)',                  field_type: 'text',   sort_order: -999 },
  { module: 'pieces', erp_table: 'products', column_name: 'sku',        label: 'SKU',                       field_type: 'text',   sort_order: -998 },
  { module: 'pieces', erp_table: 'products', column_name: 'type',       label: 'Type',                      field_type: 'single_select', sort_order: -997 },
  { module: 'pieces', erp_table: 'products', column_name: 'unit_cost',  label: 'Coût unitaire',             field_type: 'number', sort_order: -996 },
  { module: 'pieces', erp_table: 'products', column_name: 'price_cad',  label: 'Prix (CAD)',                field_type: 'number', sort_order: -995 },
  { module: 'pieces', erp_table: 'products', column_name: 'stock_qty',  label: 'Quantité en inventaire',    field_type: 'number', sort_order: -994 },
  { module: 'pieces', erp_table: 'products', column_name: 'min_stock',  label: 'Stock minimum',             field_type: 'number', sort_order: -993 },
  { module: 'pieces', erp_table: 'products', column_name: 'order_qty',  label: 'Quantité à commander',      field_type: 'number', sort_order: -992 },
  { module: 'pieces', erp_table: 'products', column_name: 'supplier',   label: 'Fournisseur',               field_type: 'text',   sort_order: -991 },
  { module: 'pieces', erp_table: 'products', column_name: 'image_url',  label: 'Image',                     field_type: 'text',   sort_order: -990, options: { format: 'url' } },
  { module: 'pieces', erp_table: 'products', column_name: 'location',   label: 'Emplacement',               field_type: 'text',   sort_order: -989 },
])

// API Routes
app.use('/api/auth', authRouter)
app.use('/api/companies', companiesRouter)
app.use('/api/contacts', contactsRouter)
app.use('/api/projects', projectsRouter)
app.use('/api/custom-fields', customFieldsRouter)
app.use('/api/products', productsRouter)
app.use('/api/orders', ordersRouter)
app.use('/api/tickets', ticketsRouter)
app.use('/api/dashboard', dashboardRouter)
app.use('/api/admin', adminRouter)
app.use('/api/undo', undoRouter)
app.use('/api/interactions', interactionsRouter)
app.use('/api/calls', callsRouter)
app.use('/api/connectors', connectorsRouter)
app.use('/api/purchases', purchasesRouter)
app.use('/api/serials', serialsRouter)
app.use('/api/views', viewsRouter)
app.use('/api/projets', projetsRouter)
app.use('/api/payments', paymentsRouter)
app.use('/api/catalog', catalogRouter)
app.use('/api/documents', documentsRouter)
app.use('/api/search', searchRouter)
app.use('/api/shipments', shipmentsRouter)
app.use('/api/automations', automationsRouter)
app.use('/api/tasks', tasksRouter)
app.use('/api/agent', agentRouter)
app.use('/api/achats-fournisseurs', achatsFournisseursRouter)
app.use('/api/sale-receipts', saleReceiptsRouter)
app.use('/api/journal-entries', journalEntriesRouter)
app.use('/api/stock-movements', stockMovementsRouter)
app.use('/api/stripe-queue', stripeQueueRouter)
app.use('/api/stripe-invoices', stripeInvoicesRouter)
app.use('/api/stripe-payouts', stripePayoutsRouter)
app.use('/api/stripe-invoice-items', stripeInvoiceItemsRouter)
app.use('/api/email-tracking', emailTrackingRouter)
app.use('/api/customer/post-payment', customerPostPaymentRouter)
// Permanent customer-facing payment link — must be registered before the SPA
// fallback below so /erp/pay/:id is handled by the redirect, not the React app.
app.use('/erp/pay', customerPayRouter)
app.use('/api/employees', employeesRouter)
app.use('/api/vacations', vacationsRouter)
app.use('/api/paies', paiesRouter)
app.use('/api/timesheets', timesheetsRouter)
app.use('/api/activity-codes', activityCodesRouter)
app.use('/api/hour-bank', hourBankRouter)
app.use('/api/receipt-files', express.static(path.join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'receipts')))
app.use('/api/novoxpress/labels', express.static(path.join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'labels')))
app.use('/api/novoxpress', novoxpressRouter)
app.use('/api/track', trackRouter)
app.use('/api/public/installation-feedback', installationFeedbackRouter)
app.use('/api/interaction-files', express.static(path.join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'interactions')))

// Serve client build
const clientBuild = path.join(__dirname, '../../client/dist')
app.use('/erp', express.static(clientBuild))
app.get('/erp/*path', (req, res) => {
  res.sendFile(path.join(clientBuild, 'index.html'))
})
app.get('/', (req, res) => res.redirect('/erp/'))

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' })
  next()
})
app.use((err, req, res, _next) => {
  console.error('Error:', err)
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' })
})

const server = app.listen(PORT, () => {
  console.log(`ERP Server running on http://localhost:${PORT}`)
  createRealtimeServer(server)
  initTaskRunner()
  initScheduler()

  // Gmail sync — toutes les heures
  function scheduleGmailSync() {
    const t0 = Date.now()
    tracked('gmail', () => syncAllMailboxes())
      .then(() => {
        logSystemRun('sys_gmail_sync', {
          status: 'success',
          result: 'Sync Gmail complétée pour toutes les boîtes connectées.',
          duration_ms: Date.now() - t0,
        })
      })
      .catch(e => {
        console.error('Gmail sync error:', e.message)
        logSystemRun('sys_gmail_sync', {
          status: 'error',
          error: e.message,
          duration_ms: Date.now() - t0,
        })
      })
    try { rematchCalls() } catch(e) { console.error('Rematch error:', e.message) }
  }

  // Airtable fallback sync — une fois par jour (au cas où des webhooks auraient manqué des événements)
  function scheduledSync(module, fn) {
    const t0 = Date.now()
    tracked(module, () => fn()).then(() => {
      logSync(module, 'scheduled', { status: 'success', durationMs: Date.now() - t0 })
    }).catch(e => {
      logSync(module, 'scheduled', { status: 'error', error: e.message, durationMs: Date.now() - t0 })
      console.error(`${module} sync error:`, e.message)
    })
  }

  function scheduleAirtableFallback() {
    const t0 = Date.now()
    purgeSyncLogs() // purge logs > 7 days
    const modules = [
      ['airtable', syncAirtable], ['projets', syncProjets], ['pieces', syncPieces],
      ['orders', syncOrders], ['achats', syncAchats], ['billets', syncBillets],
      ['serials', syncSerials], ['envois', syncEnvois], ['soumissions', syncSoumissions],
      ['retours', syncRetours], ['retour_items', syncRetourItems], ['adresses', syncAdresses],
      ['bom', syncBomItems], ['serial_changes', syncSerialStateChanges],
      ['assemblages', syncAssemblages], ['stock_movements', syncStockMovements],
    ]
    for (const [name, fn] of modules) scheduledSync(name, fn)
    if (isStripeConfigured()) {
      tracked('stripe', () => syncStripeSubscriptions()).catch(e => console.error('Stripe sync error:', e.message))
    }
    // Macro-level log — individual module outcomes are already in sync_logs
    logSystemRun('sys_airtable_fallback_sync', {
      status: 'success',
      result: `Fallback sync déclenché pour ${modules.length} modules (chaque sync tourne en parallèle, voir sync_logs pour le détail).`,
      duration_ms: Date.now() - t0,
      triggerData: { modules: modules.map(([n]) => n) },
    })
  }

  // Gmail : démarrage après 30s, puis toutes les heures
  setTimeout(scheduleGmailSync, 30_000)
  setInterval(scheduleGmailSync, 60 * 60 * 1000)

  // Airtable webhooks : enregistrement au démarrage
  setTimeout(() => {
    const t0 = Date.now()
    initAirtableWebhooks()
      .then((info) => {
        logSystemRun('sys_airtable_webhooks_init', {
          status: 'success',
          result: typeof info === 'string' ? info : 'Webhooks Airtable initialisés au boot.',
          duration_ms: Date.now() - t0,
        })
      })
      .catch(e => {
        console.error('Webhook init error:', e.message)
        logSystemRun('sys_airtable_webhooks_init', {
          status: 'error',
          error: e.message,
          duration_ms: Date.now() - t0,
        })
      })
  }, 5_000)

  // Airtable fallback : sync complet une fois par jour
  setInterval(scheduleAirtableFallback, 24 * 60 * 60 * 1000)

  // Airtable token proactive refresh — évite que le token expire entre deux webhooks
  // Refresh tout token qui expire dans les 15 prochaines minutes
  async function refreshExpiringAirtableTokens() {
    const t0 = Date.now()
    const soon = Date.now() + 15 * 60 * 1000
    const row = db.prepare(`
      SELECT id FROM connector_oauth
      WHERE connector='airtable' AND (expiry_date IS NULL OR expiry_date <= ?)
      LIMIT 1
    `).get(soon)
    if (!row) {
      logSystemRun('sys_airtable_token_refresh', {
        status: 'skipped',
        result: 'Aucun token Airtable proche de l\'expiration.',
        duration_ms: Date.now() - t0,
      })
      return
    }
    try {
      await getAirtableToken()
      console.log('✅ Airtable token rafraîchi proactivement')
      logSystemRun('sys_airtable_token_refresh', {
        status: 'success',
        result: 'Token Airtable rafraîchi proactivement avant expiration.',
        duration_ms: Date.now() - t0,
      })
    } catch (e) {
      console.error('⚠️ Airtable proactive refresh échoué:', e.message)
      logSystemRun('sys_airtable_token_refresh', {
        status: 'error',
        error: e.message,
        duration_ms: Date.now() - t0,
      })
    }
  }
  setTimeout(refreshExpiringAirtableTokens, 60_000)
  setInterval(refreshExpiringAirtableTokens, 10 * 60 * 1000)

  // HubSpot tasks delta pull — toutes les 2 minutes
  function scheduleHubSpotPull() {
    if (!isHubSpotConfigured()) return
    const t0 = Date.now()
    tracked('hubspot_tasks', () => hsPullDelta()).then((out) => {
      logSync('hubspot_tasks', 'scheduled', {
        status: 'success',
        modified: out?.modified || 0,
        destroyed: out?.destroyed || 0,
        durationMs: Date.now() - t0,
      })
    }).catch(e => {
      logSync('hubspot_tasks', 'scheduled', { status: 'error', error: e.message, durationMs: Date.now() - t0 })
      console.error('HubSpot pull error:', e.message)
    })
  }
  setTimeout(scheduleHubSpotPull, 45_000)
  setInterval(scheduleHubSpotPull, 2 * 60 * 1000)

  // Installation follow-up — runs daily at 09:00 local. System automation is
  // shipped disabled (default_active: 0); no emails go out until an operator
  // enables `sys_installation_followup` in /automations.
  async function runInstallationFollowup() {
    if (!isSystemAutomationActive('sys_installation_followup')) {
      logSystemRun('sys_installation_followup', {
        status: 'skipped',
        result: 'Automatisation désactivée — aucun envoi.',
        duration_ms: 0,
      })
      return
    }
    const t0 = Date.now()
    try {
      const out = await sendInstallationFollowups(db, { fromAddress: getAutomationFrom('sys_installation_followup') })
      logSystemRun('sys_installation_followup', {
        status: out.errors > 0 ? 'partial' : 'success',
        result: `${out.sent} envoyé(s) · ${out.errors} erreur(s) · ${out.skipped} skip · ${out.total} éligible(s).\n` +
          out.details.map(d => `${d.action.toUpperCase()} — ${d.company_name || d.company_id} → ${d.to || '—'}${d.error ? ` · ${d.error}` : ''}`).join('\n'),
        duration_ms: Date.now() - t0,
        triggerData: { total: out.total, sent: out.sent, errors: out.errors },
      })
    } catch (e) {
      console.error('Installation follow-up error:', e.message)
      logSystemRun('sys_installation_followup', {
        status: 'error',
        error: e.message,
        duration_ms: Date.now() - t0,
      })
    }
  }

  function scheduleInstallationFollowup() {
    const now = new Date()
    const next = new Date(now)
    next.setHours(9, 0, 0, 0)
    if (next <= now) next.setDate(next.getDate() + 1)
    const delay = next.getTime() - now.getTime()
    setTimeout(() => {
      runInstallationFollowup()
      setInterval(runInstallationFollowup, 24 * 60 * 60 * 1000)
    }, delay)
  }
  scheduleInstallationFollowup()
})

// Kill Claude process on shutdown so pm2 restart doesn't leave orphans
process.on('SIGINT',  () => { shutdownTaskRunner(); process.exit(0) })
process.on('SIGTERM', () => { shutdownTaskRunner(); process.exit(0) })

export default app
