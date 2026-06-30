import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import dotenv from 'dotenv'

// Validate critical secrets early (throws if JWT_SECRET missing)
import './config/secrets.js'

import { initSchema, seedSellableProducts } from './db/schema.js'
import { initChangeLog } from './db/changeLog.js'
import { startFieldRuleWatcher } from './services/fieldRuleWatcher.js'
import { startRevenueRecognitionWatcher } from './services/revenueRecognitionWatcher.js'
import bootstrapRouter from './routes/bootstrap.js'
import { seedSystemAutomations, logSystemRun, isSystemAutomationActive } from './services/systemAutomations.js'
import { runPurge } from './services/purge.js'
import authRouter from './routes/auth.js'
import companiesRouter from './routes/companies.js'
import contactsRouter from './routes/contacts.js'
import projectsRouter from './routes/projects.js'
import customFieldsRouter from './routes/custom-fields.js'
import airtableFieldsRouter from './routes/airtable-fields.js'
import fieldVisibilityRulesRouter from './routes/field-visibility-rules.js'
import productsRouter from './routes/products.js'
import ordersRouter from './routes/orders.js'
import ticketsRouter from './routes/tickets.js'
import dashboardRouter from './routes/dashboard.js'
import adminRouter from './routes/admin.js'
import telemetryRouter from './routes/telemetry.js'
import undoRouter from './routes/undo.js'
import interactionsRouter from './routes/interactions.js'
import callsRouter, { rematchCalls } from './routes/calls.js'
import connectorsRouter from './routes/connectors.js'
import hubspotRouter from './routes/hubspot.js'
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
import qualificationCallsRouter from './routes/qualification-calls.js'
import emailRelanceRouter from './routes/email-relance.js'
import placesRouter from './routes/places.js'
import paiesRouter from './routes/paies.js'
import timesheetsRouter from './routes/timesheets.js'
import activityCodesRouter from './routes/activity-codes.js'
import hourBankRouter from './routes/hour-bank.js'
import saleReceiptsRouter from './routes/sale-receipts.js'
import attachmentsRouter from './routes/attachments.js'
import journalEntriesRouter from './routes/journal-entries.js'
import stockMovementsRouter from './routes/stock-movements.js'
import stripeWebhooksRouter from './routes/stripe-webhooks.js'
import hooksRouter from './routes/hooks.js'
import stripeInvoicesRouter from './routes/stripe-invoices.js'
import customerPayRouter from './routes/customer-pay.js'
import customerPostPaymentRouter from './routes/customer-post-payment.js'
import discoveryFormsRouter from './routes/discovery-forms.js'
import emailTrackingRouter from './routes/email-tracking.js'
import stripeQueueRouter from './routes/stripe-queue.js'
import stripePayoutsRouter from './routes/stripe-payouts.js'
import stripeInvoiceItemsRouter from './routes/stripe-invoice-items.js'
import novoxpressRouter from './routes/novoxpress.js'
import trackRouter from './routes/track.js'
import installationFeedbackRouter from './routes/installation-feedback.js'
import { publicFilesRouter, publicFileServeRouter } from './routes/public-files.js'
import recordsRouter from './routes/records.js'
import activityRouter from './routes/activity.js'
import sideEffectsRouter from './routes/sideEffects.js'
import notificationsRouter from './routes/notifications.js'
import commentsRouter from './routes/comments.js'
import reportsTaxesRouter from './routes/reports-taxes.js'
import { sendInstallationFollowups } from './services/installationFollowup.js'
import { resolveFromAddress, getAutomationFrom } from './services/postmarkConfig.js'
import { createRealtimeServer } from './services/realtime.js'
import { initTaskRunner, shutdownTaskRunner } from './services/taskRunner.js'
import { initScheduler } from './services/automationScheduler.js'
import { syncAllMailboxes } from './services/gmail.js'
import { syncAirtable, syncProjets, syncPieces, syncOrders, syncAchats, syncBillets, syncSerials, syncEnvois, syncSoumissions, syncRetours, syncRetourItems, syncAdresses, syncBomItems, syncSerialStateChanges, syncAssemblages, syncStockMovements } from './services/airtable.js'
import { tracked } from './services/syncState.js'
import { syncStripeSubscriptions, isStripeConfigured } from './services/stripe.js'
import { syncAndPushStripePayouts } from './services/quickbooks.js'
import cron from 'node-cron'
import { initAirtableWebhooks } from './services/airtableWebhooks.js'
import { getAccessToken as getAirtableToken } from './connectors/airtable.js'
import { logSync, purgeSyncLogs } from './services/syncLog.js'
import { pullDelta as hsPullDelta, retryFailedPushes as hsRetryFailedPushes } from './services/hubspotSync.js'
import { drainRachatRetryQueue } from './services/subscriptionEvents.js'
import { isHubSpotConfigured } from './connectors/hubspot.js'
import db from './db/database.js'

dotenv.config()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 3004

// Identifiant unique du process — permet au client de distinguer un blip réseau
// d'un vrai redémarrage du serveur (pm2 restart, déploiement). Exposé via le
// header X-Boot-Id sur chaque réponse API + l'endpoint /api/health.
const BOOT_ID = crypto.randomUUID()
const STARTED_AT = new Date().toISOString()

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

// Expose BOOT_ID sur toutes les réponses /api/* pour que le client puisse
// détecter un redémarrage du serveur (changement d'UUID entre deux requêtes).
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    res.setHeader('X-Boot-Id', BOOT_ID)
    res.setHeader('Access-Control-Expose-Headers', 'X-Boot-Id')
  }
  next()
})

// Healthcheck léger — pas d'auth, pas de DB. Sert au ServerOfflineOverlay côté
// client pour pinger pendant un offline et comparer le boot_id.
app.get('/api/health', (req, res) => {
  res.json({ boot_id: BOOT_ID, started_at: STARTED_AT, uptime_s: Math.round(process.uptime()) })
})

// Serve call recordings
app.use('/api/recordings', express.static(path.join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'calls')))
// Serve bons de livraison
app.use('/api/bons-livraison', express.static(path.join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'bons-livraison')))
// Serve product images
app.use('/api/product-images', express.static(path.join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'products')))
// Serve product installation/replacement PDFs (cached copies of lien_pdf_*)
app.use('/api/product-docs', express.static(path.join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'products', 'docs')))
// Serve record attachments
app.use('/api/attachments', express.static(path.join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'attachments')))

import { ensureNativeFieldDefs } from './services/airtableAutoSync.js'
import { regenerateAllViews } from './services/customFieldsView.js'

initSchema()
initChangeLog()
seedSellableProducts()
seedSystemAutomations()
runPurge()
regenerateAllViews()

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

  // Projects natives — enregistrés pour que le mapping Airtable→ERP puisse
  // valider la compatibilité de type côté serveur (sans cette info, les
  // natives ne sont connues que dans TABLE_COLUMN_META côté client).
  { module: 'projets', erp_table: 'projects', column_name: 'name',           label: 'Projet',          field_type: 'text',          sort_order: -1000 },
  { module: 'projets', erp_table: 'projects', column_name: 'type',           label: 'Type',            field_type: 'single_select', sort_order: -999 },
  { module: 'projets', erp_table: 'projects', column_name: 'status',         label: 'Statut',          field_type: 'single_select', sort_order: -998 },
  { module: 'projets', erp_table: 'projects', column_name: 'probability',    label: 'Probabilité',     field_type: 'number',        sort_order: -997 },
  { module: 'projets', erp_table: 'projects', column_name: 'value_cad',      label: 'Valeur (CAD)',    field_type: 'number',        sort_order: -996 },
  { module: 'projets', erp_table: 'projects', column_name: 'monthly_cad',    label: 'Mensuel (CAD)',   field_type: 'number',        sort_order: -995 },
  { module: 'projets', erp_table: 'projects', column_name: 'nb_greenhouses', label: 'Nb serres',       field_type: 'number',        sort_order: -994 },
  { module: 'projets', erp_table: 'projects', column_name: 'company_id',     label: 'Entreprise',      field_type: 'link',          sort_order: -993, options: { target_table: 'companies' } },
  { module: 'projets', erp_table: 'projects', column_name: 'vendeur_id',     label: 'Vendeur',         field_type: 'link',          sort_order: -992, options: { target_table: 'users' } },
  { module: 'projets', erp_table: 'projects', column_name: 'nom_du_vendeur', label: 'Vendeur AT',      field_type: 'text',          sort_order: -991 },
  { module: 'projets', erp_table: 'projects', column_name: 'close_date',     label: 'Date de clôture', field_type: 'date',          sort_order: -990 },
  { module: 'projets', erp_table: 'projects', column_name: 'refusal_reason', label: 'Raison du refus', field_type: 'text',          sort_order: -989 },
  { module: 'projets', erp_table: 'projects', column_name: 'notes',          label: 'Notes',           field_type: 'long_text',     sort_order: -988 },
  { module: 'projets', erp_table: 'projects', column_name: 'creation',       label: 'Créé le',         field_type: 'date',          sort_order: -987 },
])

// API Routes
app.use('/api/auth', authRouter)
app.use('/api/bootstrap', bootstrapRouter)
app.use('/api/companies', companiesRouter)
app.use('/api/contacts', contactsRouter)
app.use('/api/projects', projectsRouter)
app.use('/api/custom-fields', customFieldsRouter)
app.use('/api/airtable-fields', airtableFieldsRouter)
app.use('/api/field-visibility-rules', fieldVisibilityRulesRouter)
app.use('/api/products', productsRouter)
app.use('/api/orders', ordersRouter)
app.use('/api/tickets', ticketsRouter)
app.use('/api/dashboard', dashboardRouter)
app.use('/api/reports', reportsTaxesRouter)
app.use('/api/admin', adminRouter)
app.use('/api/telemetry', telemetryRouter)
app.use('/api/undo', undoRouter)
app.use('/api/interactions', interactionsRouter)
app.use('/api/calls', callsRouter)
app.use('/api/connectors', connectorsRouter)
app.use('/api/hubspot', hubspotRouter)
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
// Webhooks entrants PUBLICS (token = secret, pas de requireAuth) — voir routes/hooks.js
app.use('/api/hooks', hooksRouter)
app.use('/api/tasks', tasksRouter)
app.use('/api/agent', agentRouter)
app.use('/api/achats-fournisseurs', achatsFournisseursRouter)
app.use('/api/sale-receipts', saleReceiptsRouter)
// Pièces jointes polymorphes (toute entité). Le static '/api/attachments'
// (ligne ~189) sert les fichiers bruts ; ce router gère list/upload/download/delete.
app.use('/api/attachments', attachmentsRouter)
app.use('/api/journal-entries', journalEntriesRouter)
app.use('/api/stock-movements', stockMovementsRouter)
app.use('/api/stripe-queue', stripeQueueRouter)
app.use('/api/stripe-invoices', stripeInvoicesRouter)
app.use('/api/stripe-payouts', stripePayoutsRouter)
app.use('/api/stripe-invoice-items', stripeInvoiceItemsRouter)
app.use('/api/email-tracking', emailTrackingRouter)
app.use('/api/customer/post-payment', customerPostPaymentRouter)
app.use('/api/discovery-forms', discoveryFormsRouter)
// Permanent customer-facing payment link — must be registered before the SPA
// fallback below so /erp/pay/:id is handled by the redirect, not the React app.
app.use('/erp/pay', customerPayRouter)
app.use('/api/employees', employeesRouter)
app.use('/api/vacations', vacationsRouter)
app.use('/api/qualification-calls', qualificationCallsRouter)
app.use('/api/email-relance', emailRelanceRouter)
app.use('/api/places', placesRouter)
app.use('/api/paies', paiesRouter)
app.use('/api/timesheets', timesheetsRouter)
app.use('/api/activity-codes', activityCodesRouter)
app.use('/api/hour-bank', hourBankRouter)
// API de mutation générique (phase 1) — pilotée par db/recordRegistry.js
app.use('/api/records', recordsRouter)
app.use('/api/activity', activityRouter)
app.use('/api/side-effects', sideEffectsRouter)
app.use('/api/notifications', notificationsRouter)
app.use('/api/comments', commentsRouter)
app.use('/api/receipt-files', express.static(path.join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'receipts')))
app.use('/api/novoxpress/labels', express.static(path.join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'labels')))
app.use('/api/novoxpress', novoxpressRouter)
app.use('/api/track', trackRouter)
app.use('/api/public/installation-feedback', installationFeedbackRouter)
app.use('/api/interaction-files', express.static(path.join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'interactions')))
app.use('/api/public-files', publicFilesRouter)
// Fichiers publics — URL non auth /erp/p/<token>/<filename>. Doit être monté
// avant le static client (/erp) sinon l'index.html SPA est servi à la place.
app.use('/erp/p', publicFileServeRouter)

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

  // Field-rule automations watcher — tails change_log to fire declarative
  // rules on direct ERP writes. Gated by the feature flag (off → never starts).
  if (process.env.FEATURE_FIELD_RULES === 'true') startFieldRuleWatcher()

  // Revenue recognition watcher — tails change_log on shipments→« Envoyé » to
  // post the sale-recognition JE, and retries persisted failures with backoff.
  // Démarré sans flag : intégrité comptable (remplace les fire-and-forget de route).
  startRevenueRecognitionWatcher()

  // Gmail sync — toutes les heures
  function scheduleGmailSync() {
    const t0 = Date.now()
    tracked('gmail', () => syncAllMailboxes('scheduled'))
      .then((summary = {}) => {
        const { accounts = 0, emailsImported = 0, invoicesImported = 0, errors = [] } = summary
        const base = `${accounts} boîte(s) — ${emailsImported} courriel(s) + ${invoicesImported} facture(s) importé(s).`
        logSystemRun('sys_gmail_sync', {
          status: errors.length ? 'error' : 'success',
          result: errors.length ? `${base} ${errors.length} boîte(s)/box en échec : ${errors.join(' ; ')}` : base,
          error: errors.length ? errors.join(' ; ') : undefined,
          duration_ms: Date.now() - t0,
          triggerData: summary,
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
      // e.message est déjà enrichi (curseur, fenêtre, nb traité) par pullDelta ;
      // e.hubspotSyncProgress porte les compteurs partiels appliqués avant l'échec.
      const p = e.hubspotSyncProgress || {}
      logSync('hubspot_tasks', 'scheduled', {
        status: 'error',
        error: e.message,
        modified: p.modified || 0,
        destroyed: p.destroyed || 0,
        durationMs: Date.now() - t0,
      })
      console.error('HubSpot pull error:', e.message)
    })
  }
  setTimeout(scheduleHubSpotPull, 45_000)
  setInterval(scheduleHubSpotPull, 2 * 60 * 1000)

  // Reprise des push HubSpot échoués (ERP → HubSpot) — toutes les 2 minutes.
  // Sans ça, un push fire-and-forget échoué restait une divergence silencieuse :
  // ici on rejoue ce qui est persisté dans hubspot_push_failures jusqu'à succès.
  function scheduleHubSpotPushRetry() {
    if (!isHubSpotConfigured()) return
    const t0 = Date.now()
    hsRetryFailedPushes().then((out) => {
      if (out.attempted > 0) {
        logSync('hubspot_task_push_retry', 'scheduled', {
          status: out.stillFailing > 0 ? 'error' : 'success',
          modified: out.recovered,
          error: out.stillFailing > 0 ? `${out.stillFailing} push toujours en échec sur ${out.attempted} rejoués` : null,
          durationMs: Date.now() - t0,
        })
      }
    }).catch(e => {
      logSync('hubspot_task_push_retry', 'scheduled', { status: 'error', error: e.message, durationMs: Date.now() - t0 })
      console.error('HubSpot push retry error:', e.message)
    })
  }
  setTimeout(scheduleHubSpotPushRetry, 75_000)
  setInterval(scheduleHubSpotPushRetry, 2 * 60 * 1000)

  // Reprise des détections de rachat (post-churn) échouées — toutes les 5 min.
  // detectRachatForChurn() tourne en fire-and-forget à l'ingestion du webhook
  // Stripe ; un échec y était avalé, laissant un client réabonné marqué churné
  // sans retry. On rejoue ici ce qui est persisté dans rachat_detect_failures
  // (backoff exponentiel par event) jusqu'à succès.
  function scheduleRachatRetry() {
    const t0 = Date.now()
    try {
      const out = drainRachatRetryQueue()
      if (out.attempted > 0) {
        logSync('rachat_detect_retry', 'scheduled', {
          status: out.stillFailing > 0 ? 'error' : 'success',
          modified: out.recovered,
          error: out.stillFailing > 0 ? `${out.stillFailing} détection(s) toujours en échec sur ${out.attempted} rejouée(s)` : null,
          durationMs: Date.now() - t0,
        })
      }
    } catch (e) {
      logSync('rachat_detect_retry', 'scheduled', { status: 'error', error: e.message, durationMs: Date.now() - t0 })
      console.error('Rachat detect retry error:', e.message)
    }
  }
  setTimeout(scheduleRachatRetry, 90_000)
  setInterval(scheduleRachatRetry, 5 * 60 * 1000)

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

  // Sync + push QB des Stripe payouts — tous les lundis à 12h00 (local). System
  // automation shipped disabled (default_active: 0) : aucun push QB tant qu'un
  // opérateur n'a pas activé `sys_stripe_weekly_payout_push` dans /automations.
  // La garde anti-erreur vit dans syncAndPushStripePayouts (skip des payouts à
  // warning). Voir services/quickbooks.js:syncAndPushStripePayouts.
  async function runStripeWeeklyPayoutPush() {
    if (!isSystemAutomationActive('sys_stripe_weekly_payout_push')) {
      logSystemRun('sys_stripe_weekly_payout_push', {
        status: 'skipped',
        result: 'Automatisation désactivée — aucun sync ni push.',
        duration_ms: 0,
      })
      return
    }
    if (!isStripeConfigured()) {
      logSystemRun('sys_stripe_weekly_payout_push', {
        status: 'skipped',
        result: 'Stripe non configuré — aucun sync ni push.',
        duration_ms: 0,
      })
      return
    }
    const t0 = Date.now()
    try {
      const out = await syncAndPushStripePayouts({})
      const pushedLines = out.pushed.map(p => `PUSH — ${p.payout_id} (${p.amount} ${p.currency}) → Deposit ${p.qb_deposit_id}`)
      const skippedLines = out.skipped.map(s => `SKIP (garde) — ${s.payout_id} : ${s.reason}`)
      const errorLines = out.errors.map(e => `ERREUR — ${e.payout_id} : ${e.error}`)
      logSystemRun('sys_stripe_weekly_payout_push', {
        status: out.errors.length ? 'partial' : 'success',
        result: [out.summary, '', ...pushedLines, ...skippedLines, ...errorLines].join('\n'),
        duration_ms: Date.now() - t0,
        triggerData: { pushed: out.pushed.length, skipped: out.skipped.length, errors: out.errors.length },
      })
    } catch (e) {
      console.error('Stripe weekly payout push error:', e.message)
      logSystemRun('sys_stripe_weekly_payout_push', {
        status: 'error',
        error: e.message,
        duration_ms: Date.now() - t0,
      })
    }
  }
  cron.schedule('0 12 * * 1', runStripeWeeklyPayoutPush)
})

// Kill Claude process on shutdown so pm2 restart doesn't leave orphans
process.on('SIGINT',  () => { shutdownTaskRunner(); process.exit(0) })
process.on('SIGTERM', () => { shutdownTaskRunner(); process.exit(0) })

export default app
