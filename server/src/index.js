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
import { startReturnItemCreatedWatcher } from './services/returnItemCreatedWatcher.js'
import { startReturnItemReceivedWatcher } from './services/returnItemReceivedWatcher.js'
import { sendReturnExchangeReminders } from './services/returnExchangeReminder.js'
import { startAddressCheckWatcher } from './services/addressCheck.js'
import { syncAllPrepaidAccountsFromQB } from './services/prepaid.js'
import bootstrapRouter from './routes/bootstrap.js'
import { seedSystemAutomations, logSystemRun, isSystemAutomationActive } from './services/systemAutomations.js'
import { runPurge } from './services/purge.js'
import authRouter from './routes/auth.js'
import companiesRouter from './routes/companies.js'
import contactsRouter from './routes/contacts.js'
import projectsRouter from './routes/projects.js'
import customFieldsRouter from './routes/custom-fields.js'
import fieldVisibilityRulesRouter from './routes/field-visibility-rules.js'
import productsRouter from './routes/products.js'
import ordersRouter from './routes/orders.js'
import ticketsRouter from './routes/tickets.js'
import dashboardRouter from './routes/dashboard.js'
import hubRouter from './routes/hub.js'
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
import retoursRouter from './routes/retours.js'
import paymentsRouter from './routes/payments.js'
import catalogRouter from './routes/catalog.js'
import documentsRouter from './routes/documents.js'
import searchRouter from './routes/search.js'
import shipmentsRouter from './routes/shipments.js'
import automationsRouter from './routes/automations.js'
import tasksRouter from './routes/tasks.js'
import agentRouter from './routes/agent.js'
import travauxRouter from './routes/travaux.js'
import achatsFournisseursRouter from './routes/achats-fournisseurs.js'
import vendorSubscriptionsRouter from './routes/vendor-subscriptions.js'
import vendorProfilesRouter from './routes/vendor-profiles.js'
import treasuryRouter from './routes/treasury.js'
import bankRouter from './routes/bank.js'
import prepaidRouter from './routes/prepaid.js'
import ltDebtsRouter from './routes/lt-debts.js'
import marketingBudgetRouter from './routes/marketing-budget.js'
import carmRouter from './routes/carm.js'
import scrapersRouter from './routes/scrapers.js'
import fxRouter from './routes/fx.js'
import monthEndRouter from './routes/month-end.js'
import driveInventoryRouter from './routes/drive-inventory.js'
import mapaqRouter from './routes/mapaq.js'
import reqRouter from './routes/req.js'
import employeesRouter from './routes/employees.js'
import vacationsRouter from './routes/vacations.js'
import qualificationCallsRouter from './routes/qualification-calls.js'
import emailRelanceRouter from './routes/email-relance.js'
import placesRouter from './routes/places.js'
import weatherRouter from './routes/weather.js'
import paiesRouter from './routes/paies.js'
import timesheetsRouter from './routes/timesheets.js'
import activityCodesRouter from './routes/activity-codes.js'
import hourBankRouter from './routes/hour-bank.js'
import saleReceiptsRouter from './routes/sale-receipts.js'
import anomaliesRouter from './routes/anomalies.js'
import changelogRouter from './routes/changelog.js'
import { runAnomalyScan, runQbLinkVerification } from './services/transactionAnomalies.js'
import attachmentsRouter from './routes/attachments.js'
import journalEntriesRouter from './routes/journal-entries.js'
import stockMovementsRouter from './routes/stock-movements.js'
import stripeWebhooksRouter from './routes/stripe-webhooks.js'
import hooksRouter from './routes/hooks.js'
import instagramRouter from './routes/instagram.js'
import stripeInvoicesRouter from './routes/stripe-invoices.js'
import customerPayRouter from './routes/customer-pay.js'
import customerPostPaymentRouter from './routes/customer-post-payment.js'
import discoveryFormsRouter from './routes/discovery-forms.js'
import emailTrackingRouter from './routes/email-tracking.js'
import stripeQueueRouter from './routes/stripe-queue.js'
import stripePayoutsRouter from './routes/stripe-payouts.js'
import stripeInvoiceItemsRouter from './routes/stripe-invoice-items.js'
import novoxpressRouter from './routes/novoxpress.js'
import digikeyRouter from './routes/digikey.js'
import upsRouter from './routes/ups.js'
import purolatorRouter from './routes/purolator.js'
import trackRouter from './routes/track.js'
import installationFeedbackRouter from './routes/installation-feedback.js'
import telnyxWebhooksRouter from './routes/telnyx-webhooks.js'
import ticketSurveysPublicRouter from './routes/ticket-surveys-public.js'
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
import { syncAirtable, syncProjets, syncPieces, syncOrders, syncAchats, syncBillets, syncSerials, syncEnvois, syncSoumissions, syncRetours, syncRetourItems, syncAdresses, syncBomItems, syncSerialStateChanges, syncAssemblages, syncStockMovements, syncEmployees, syncPaies, syncPaieItems } from './services/airtable.js'
import { tracked } from './services/syncState.js'
import { syncStripeSubscriptions, isStripeConfigured } from './services/stripe.js'
import { syncAndPushStripePayouts, getStripePayoutPushConfig, importFromQB } from './services/quickbooks.js'
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

// Telnyx signe `${timestamp}|${rawBody}` en Ed25519 — même contrainte de corps
// brut que Stripe, donc même montage avant express.json.
app.use('/api/hooks/telnyx', express.raw({ type: 'application/json' }), (req, res, next) => {
  req.rawBody = req.body
  try { req.body = JSON.parse(req.body) } catch { req.body = {} }
  next()
}, telnyxWebhooksRouter)

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
import { seedBankAccounts } from './services/bankReconciliation.js'
import { seedMonthEndProvisions } from './services/monthEndSeed.js'
import { seedRecurringWork } from './services/recurringWork.js'
import { seedLtDebts } from './services/ltDebtSeed.js'
import { seedCardCeilings } from './services/cardCeiling.js'
import { seedCancelUrls } from './services/subscriptionCancelUrls.js'
import { initPromptQueue } from './services/promptQueue.js'

initSchema()
initChangeLog()
seedSellableProducts()
seedSystemAutomations()
seedBankAccounts()
seedMonthEndProvisions()
seedRecurringWork()
seedLtDebts()
// Cartes dont on suit le plafond (MasterCard BNC) — n'écrase aucune config
// existante et ne ressuscite pas une carte retirée du suivi.
seedCardCeilings()
// Pages d'annulation des abonnements fournisseurs — ne remplit que les vides.
seedCancelUrls()
runPurge()
regenerateAllViews()

// Register native fields in airtable_field_mappings so they appear in the
// field-rule template whitelist alongside dynamic Airtable fields
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
app.use('/api/field-visibility-rules', fieldVisibilityRulesRouter)
app.use('/api/products', productsRouter)
app.use('/api/orders', ordersRouter)
app.use('/api/tickets', ticketsRouter)
app.use('/api/dashboard', dashboardRouter)
app.use('/api/hub', hubRouter)
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
app.use('/api/retours', retoursRouter)
app.use('/api/payments', paymentsRouter)
app.use('/api/catalog', catalogRouter)
app.use('/api/documents', documentsRouter)
app.use('/api/search', searchRouter)
app.use('/api/shipments', shipmentsRouter)
app.use('/api/automations', automationsRouter)
// Webhooks entrants PUBLICS (token = secret, pas de requireAuth) — voir routes/hooks.js
app.use('/api/hooks', hooksRouter)
// Prospects Instagram : POST /manychat est public (secret partagé), /prospects authentifié.
app.use('/api/instagram', instagramRouter)
app.use('/api/tasks', tasksRouter)
app.use('/api/agent', agentRouter)
app.use('/api/travaux', travauxRouter)
app.use('/api/achats-fournisseurs', achatsFournisseursRouter)
app.use('/api/vendor-subscriptions', vendorSubscriptionsRouter)
app.use('/api/vendor-profiles', vendorProfilesRouter)
app.use('/api/treasury', treasuryRouter)
app.use('/api/bank', bankRouter)
app.use('/api/prepaid', prepaidRouter)
app.use('/api/lt-debts', ltDebtsRouter)
app.use('/api/marketing-budget', marketingBudgetRouter)
app.use('/api/carm', carmRouter)
app.use('/api/scrapers', scrapersRouter)
app.use('/api/fx', fxRouter)
app.use('/api/month-end', monthEndRouter)
app.use('/api/drive-inventory', driveInventoryRouter)
app.use('/api/mapaq', mapaqRouter)
app.use('/api/req', reqRouter)
app.use('/api/sale-receipts', saleReceiptsRouter)
app.use('/api/anomalies', anomaliesRouter)
app.use('/api/changelog', changelogRouter)
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
app.use('/api/weather', weatherRouter)
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
// Étiquettes servies sous un chemin neutre (elles ne sont plus toutes
// Novoxpress depuis l'ajout du connecteur UPS) — même dossier uploads/labels.
app.use('/api/labels', express.static(path.join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'labels')))
app.use('/api/ups', upsRouter)
app.use('/api/purolator', purolatorRouter)
app.use('/api/digikey', digikeyRouter)
app.use('/api/track', trackRouter)
app.use('/api/public/installation-feedback', installationFeedbackRouter)
app.use('/api/public/ticket-survey', ticketSurveysPublicRouter)
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
  // File de travaux : réconcilie un item fauché par le redémarrage et relance la
  // file. Après initTaskRunner, qui a déjà repris ou clos l'exécution en cours.
  initPromptQueue()
  initScheduler()

  // Field-rule automations watcher — tails change_log to fire declarative
  // rules on direct ERP writes. Gated by the feature flag (off → never starts).
  if (process.env.FEATURE_FIELD_RULES === 'true') startFieldRuleWatcher()

  // Revenue recognition watcher — tails change_log on shipments→« Envoyé » to
  // post the sale-recognition JE, and retries persisted failures with backoff.
  // Démarré sans flag : intégrité comptable (remplace les fire-and-forget de route).
  startRevenueRecognitionWatcher()

  // Vérificateur d'adresses postales — tail change_log(adresses) : contrôle
  // chaque adresse écrite, quelle qu'en soit l'origine (UI, appel de
  // qualification, formulaire client, sync Airtable), et notifie les fautives.
  startAddressCheckWatcher()

  // Import des automatisations Airtable « Retours » (Phase 2) — voir
  // services/returnItemCreatedWatcher.js et returnItemReceivedWatcher.js.
  startReturnItemCreatedWatcher()
  startReturnItemReceivedWatcher()

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
      // RH : la comptabilisation de la paie lit ces tables (« Remb. dépenses »
      // des items) — sans ce filet elles restaient périmées entre deux syncs
      // manuels, et des remboursements manquaient à la publication QB.
      ['employees', syncEmployees], ['paies', syncPaies], ['paie_items', syncPaieItems],
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

  // Comptes prépayés : détection des transactions QB des fournisseurs suivis
  // (recharges/factures Twilio…) — toutes les 6 h. logSync interne au service.
  const schedulePrepaidSync = () => { syncAllPrepaidAccountsFromQB('scheduled').catch(() => {}) }
  setTimeout(schedulePrepaidSync, 90_000)
  setInterval(schedulePrepaidSync, 6 * 60 * 60 * 1000)

  // Anomalies transactionnelles : re-scan périodique des reçus récents (filet en plus
  // du scan à l'extraction/édition — attrape les doublons entre canaux et l'historique
  // modifié hors extraction). logSync module 'transaction_anomalies'.
  // Le scan est suivi d'une vérification des liens QuickBooks : un reçu peut se dire
  // publié sous un Id d'écriture supprimée depuis (nettoyage d'un doublon dans QB).
  const scheduleAnomalyScan = () => {
    try { runAnomalyScan('scheduled') } catch {}
    runQbLinkVerification('scheduled').catch(() => {})
  }
  setTimeout(scheduleAnomalyScan, 180_000)
  setInterval(scheduleAnomalyScan, 6 * 60 * 60 * 1000)

  // Achats fournisseurs : import QB continu — nouvelles factures/dépenses
  // comptabilisées dans QB ET suppressions, sans clic dans Connecteurs.
  // CDC incrémental toutes les 15 min ; import complet (réconciliation des
  // suppressions incluse) une fois par jour. logSync module 'qb_import'.
  const scheduleQbImportIncremental = () => { importFromQB({ incremental: true, trigger: 'scheduled' }).catch(() => {}) }
  const scheduleQbImportFull = () => { importFromQB({ trigger: 'scheduled' }).catch(() => {}) }
  setTimeout(scheduleQbImportIncremental, 120_000)
  setInterval(scheduleQbImportIncremental, 15 * 60 * 1000)
  setInterval(scheduleQbImportFull, 24 * 60 * 60 * 1000)

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

  // Rappel retours avec échange immédiat (import Airtable #4) — quotidien à
  // 09:00 local, tant que le retour n'est pas facturé (PAS one-shot, fidèle à
  // l'original). Désactivé par défaut (default_active: 0).
  async function runReturnExchangeReminder() {
    if (!isSystemAutomationActive('sys_return_exchange_reminder')) {
      logSystemRun('sys_return_exchange_reminder', { status: 'skipped', result: 'Automatisation désactivée — aucun envoi.', duration_ms: 0 })
      return
    }
    const t0 = Date.now()
    try {
      const out = await sendReturnExchangeReminders(db, { fromAddress: getAutomationFrom('sys_return_exchange_reminder') })
      logSystemRun('sys_return_exchange_reminder', {
        status: out.errors > 0 ? 'partial' : 'success',
        result: `${out.sent} envoyé(s) · ${out.errors} erreur(s) · ${out.skipped} skip · ${out.total} éligible(s).\n` +
          out.details.map(d => `${d.action.toUpperCase()} — retour ${d.return_id} → ${d.to || '—'}${d.error ? ` · ${d.error}` : ''}`).join('\n'),
        duration_ms: Date.now() - t0,
        triggerData: { total: out.total, sent: out.sent, errors: out.errors },
      })
    } catch (e) {
      console.error('Return exchange reminder error:', e.message)
      logSystemRun('sys_return_exchange_reminder', { status: 'error', error: e.message, duration_ms: Date.now() - t0 })
    }
  }

  function scheduleReturnExchangeReminder() {
    const now = new Date()
    const next = new Date(now)
    next.setHours(9, 5, 0, 0) // décalé de 5 min pour ne pas coïncider avec le followup d'installation
    if (next <= now) next.setDate(next.getDate() + 1)
    const delay = next.getTime() - now.getTime()
    setTimeout(() => {
      runReturnExchangeReminder()
      setInterval(runReturnExchangeReminder, 24 * 60 * 60 * 1000)
    }, delay)
  }
  scheduleReturnExchangeReminder()

  // Comptabilisation QB des Stripe payouts — deux passages par jour (12h et 22h UTC
  // = 8h et 18h à Montréal) : le passage du matin ramasse les payouts réglés la
  // veille, celui du soir ceux marqués « paid » par Stripe en cours de journée
  // (typiquement le lundi, jour d'arrivée des payouts BNC CAD et Venn USD).
  // Idempotent et borné (push_since / max_batch) : un passage sans rien à faire est
  // un no-op silencieux. La garde anti-erreur et l'alerte Slack vivent dans
  // syncAndPushStripePayouts. Voir services/quickbooks.js:syncAndPushStripePayouts.
  async function runStripePayoutPush() {
    // Désactivée → retour silencieux (pas de logSystemRun : en cadence quotidienne,
    // logger chaque skip noierait l'historique de l'automation sous du bruit).
    if (!isSystemAutomationActive('sys_stripe_weekly_payout_push')) return
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
      const staleLines = (out.stale || []).map(p => `EN SOUFFRANCE — ${p.stripe_id} (${p.amount} ${p.currency}, réglé le ${p.arrival_date})`)
      logSystemRun('sys_stripe_weekly_payout_push', {
        status: out.errors.length ? 'partial' : 'success',
        result: [out.summary + (out.slack ? ` · Slack: ${out.slack}` : ''), '', ...pushedLines, ...skippedLines, ...errorLines, ...staleLines].join('\n'),
        duration_ms: Date.now() - t0,
        triggerData: { pushed: out.pushed.length, skipped: out.skipped.length, errors: out.errors.length, stale: (out.stale || []).length },
      })
    } catch (e) {
      // Échec total (Stripe injoignable, token QB mort…) : journal + Slack — un
      // payout non comptabilisé ne doit jamais passer inaperçu.
      console.error('Stripe payout push error:', e.message)
      logSystemRun('sys_stripe_weekly_payout_push', {
        status: 'error',
        error: e.message,
        duration_ms: Date.now() - t0,
      })
      try {
        const { slack_webhook_env } = getStripePayoutPushConfig()
        const url = process.env[slack_webhook_env]
        if (url) {
          await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: `❌ *Payouts Stripe → QuickBooks* — le passage automatique a échoué : ${e.message}\n→ Journal : page Automations de l'ERP.` }),
          })
        }
      } catch (slackErr) {
        console.error('Stripe payout push Slack alert error:', slackErr.message)
      }
    }
  }
  cron.schedule('0 12,22 * * *', runStripePayoutPush)

  // Alerte solde du compte CARM (douanes ASFC) : vérification quotidienne à 8h
  // (le service court-circuite si sys_carm_balance_alert est inactive).
  cron.schedule('0 8 * * *', () => {
    import('./services/carmAccount.js')
      .then(({ checkCarmBalanceAlert }) => checkCarmBalanceAlert({ trigger: 'cron quotidien' }))
      .catch(e => console.error('carm alert cron:', e.message))
  })

  // Alerte trésorerie BNC : vérification quotidienne du solde projeté à 7h30
  // locale (le service court-circuite si sys_treasury_alert est inactive).
  cron.schedule('30 7 * * *', () => {
    import('./services/treasury.js')
      .then(({ checkTreasuryAlert }) => checkTreasuryAlert({ trigger: 'cron quotidien' }))
      .catch(e => console.error('treasury cron:', e.message))
  })

  // Sync du Google Sheet « Maintien du solde disponible BNC » vers la projection
  // de trésorerie (le fichier fait foi) : toutes les 60 min, à l'heure pile.
  // Cron plutôt que setInterval — l'intervalle repartait de zéro à chaque
  // redémarrage pm2, donc la cadence réelle dépendait des déploiements. Le
  // service court-circuite si l'automation sys_treasury_solde_sheet est
  // désactivée, et journalise lui-même chaque passage (sync_log +
  // automation_logs).
  cron.schedule('0 * * * *', () => {
    import('./services/treasurySoldeSheet.js')
      .then(({ scheduledSoldeSheetSync }) => scheduledSoldeSheetSync())
      .catch(e => console.error('solde sheet sync:', e.message))
  })
  // Rattrapage au démarrage, seulement si le dernier passage a plus d'une heure.
  setTimeout(() => {
    import('./services/treasurySoldeSheet.js')
      .then(({ catchUpSoldeSheetSync }) => catchUpSoldeSheetSync())
      .catch(e => console.error('solde sheet catch-up:', e.message))
  }, 150_000)

  // Suivi Purolator : rafraîchissement horaire des envois non livrés (le
  // service court-circuite si sys_purolator_tracking est désactivée ou si
  // Purolator n'est pas configuré) — cf. services/purolator.js.
  cron.schedule('0 * * * *', () => {
    import('./services/purolator.js')
      .then(({ refreshPurolatorTracking }) => refreshPurolatorTracking({ trigger: 'scheduled' }))
      .catch(e => console.error('purolator tracking cron:', e.message))
  })

  // Reprise automatique (30 min) de l'onglet « Pmt_Suivi » du fichier CTB -
  // Suivi : les paiements ajoutés à la main dans le fichier arrivent seuls dans
  // la page Paiements émis, et le passage au vert coche « passé à la banque ».
  // Coupe-circuit si sys_pmt_suivi_sheet est désactivée ; le service journalise
  // lui-même chaque passage (sync_log + automation_logs).
  const runPmtSuiviSync = () => {
    import('./services/pmtSuiviImport.js')
      .then(({ scheduledPmtSuiviImport }) => scheduledPmtSuiviImport())
      .catch(e => console.error('pmt suivi sync:', e.message))
  }
  setTimeout(runPmtSuiviSync, 180_000)
  setInterval(runPmtSuiviSync, 30 * 60 * 1000)

  // Détection horaire du « passé à la banque » dans le grand livre QuickBooks
  // (écritures compensées « C » / rapprochées « R ») → coche les paiements émis
  // dont l'appariement est sûr, laisse les autres à confirmer sur la page.
  // Coupe-circuit si sys_treasury_qb_clear est désactivée ; journalise
  // lui-même (sync_log + automation_logs).
  const runQbClearSync = () => {
    import('./services/treasuryQbClear.js')
      .then(({ scheduledQbClearSync }) => scheduledQbClearSync())
      .catch(e => console.error('qb clear sync:', e.message))
  }
  setTimeout(runQbClearSync, 210_000)
  setInterval(runQbClearSync, 60 * 60 * 1000)

  // Sync aux 20 minutes du fichier TRX_Orisha (relevés des 11 comptes bancaires)
  // vers le rapprochement bancaire : import des nouvelles transactions, matching
  // auto, liaison QuickBooks et audit d'anomalies (alerte Slack sur du neuf).
  // Coupe-circuit si l'automation sys_bank_trx_sheet est désactivée ;
  // journalise lui-même chaque passage (sync_log + automation_logs). Un passage
  // plus long que l'intervalle ne se chevauche pas : scheduledTrxSheetSync
  // ignore l'appel si la sync précédente tourne encore.
  const runTrxSheetSync = () => {
    import('./services/bankTrxSheet.js')
      .then(({ scheduledTrxSheetSync }) => scheduledTrxSheetSync())
      .catch(e => console.error('trx sheet sync:', e.message))
  }
  setTimeout(runTrxSheetSync, 240_000)
  setInterval(runTrxSheetSync, 20 * 60 * 1000)

  // Sync quotidienne de l'onglet « Fournisseurs_TPS_TVQ_Anomalies » (Sheet du
  // mentor comptable) vers les profils fournisseurs : chaque correction de
  // statut fiscal nouvelle devient le défaut du fournisseur pour ses prochaines
  // transactions. Coupe-circuit + journalisation dans le service.
  const runFiscalAnomaliesSync = () => {
    import('./services/fiscalAnomaliesSheet.js')
      .then(({ scheduledFiscalAnomaliesSync }) => scheduledFiscalAnomaliesSync())
      .catch(e => console.error('fiscal anomalies sync:', e.message))
  }
  setTimeout(runFiscalAnomaliesSync, 300_000)
  setInterval(runFiscalAnomaliesSync, 12 * 60 * 60 * 1000)

  // Préparation des écritures de fin de mois : le 1er de chaque mois à 13h UTC
  // = 9h à Montréal, sur le mois qui vient de se terminer. Importe les heures
  // R&D du Drive, recalcule les provisions et notifie — ne publie rien dans QB.
  cron.schedule('0 13 1 * *', () => {
    import('./services/monthEndAutomation.js')
      .then(({ prepareMonthEnd }) => prepareMonthEnd({ trigger: 'cron mensuel' }))
      .catch(e => console.error('month-end cron:', e.message))
  })

  // Déboursés mensuels en pièces : le 7 de chaque mois à 13h UTC = 9h à
  // Montréal, sur le mois qui vient de se terminer. Le 7 plutôt que le 1er —
  // les factures fournisseurs du mois écoulé doivent avoir eu le temps d'être
  // saisies dans QuickBooks, sinon « À payer à la fin » est sous-évalué.
  // Calcule, dépose le Google Sheet et notifie ; le message à Guillaume part
  // seulement après validation humaine sur la page de fin de mois.
  cron.schedule('0 13 7 * *', () => {
    import('./services/piecesDisbursements.js')
      .then(({ preparePiecesMonth }) => preparePiecesMonth({ trigger: 'cron mensuel' }))
      .catch(e => console.error('pieces disbursements cron:', e.message))
  })

  // Registre des entreprises du Québec : rafraîchissement mensuel du miroir
  // local, le 3 à 8h UTC = 4h à Montréal (le Registraire republie deux fois par
  // mois ; une passe mensuelle suffit à un usage de prospection). Import
  // additif : upsert par NEQ, jamais de suppression. Coupe-circuit si
  // sys_req_import est désactivée ; le service journalise lui-même
  // (sync_log + automation_logs).
  cron.schedule('0 8 3 * *', () => {
    import('./services/reqImport.js')
      .then(({ scheduledReqImport }) => scheduledReqImport())
      .catch(e => console.error('req import cron:', e.message))
  })

  // Collecte des factures sur les portails fournisseurs (Amazon, Wix) : une
  // tournée quotidienne à 9h UTC = 5h à Montréal, hors des heures où quelqu'un
  // pourrait travailler dans l'ERP — un Chromium headless par compte, en série.
  // Les comptes dont la 2FA n'est pas couverte par un secret TOTP peuvent finir
  // en attente d'un code : la page /collecte le signale.
  cron.schedule('0 9 * * *', async () => {
    try {
      const { isSystemAutomationActive } = await import('./services/systemAutomations.js')
      if (!isSystemAutomationActive('sys_invoice_collection')) return
      const { runAllScrapers } = await import('./services/scrapers/index.js')
      await runAllScrapers('scheduled')
    } catch (e) { console.error('scrapers cron:', e.message) }
  })

  // DigiKey : rapatriement des commandes et de leurs factures PDF, une fois par
  // jour à 10h UTC (6h à Montréal) — juste après la collecte de portails, pour
  // que la journée comptable commence avec les brouillons déjà là.
  cron.schedule('0 10 * * *', async () => {
    try {
      const { isSystemAutomationActive } = await import('./services/systemAutomations.js')
      if (!isSystemAutomationActive('sys_digikey_orders')) return
      const { isDigikeyConfigured } = await import('./connectors/digikey.js')
      if (!isDigikeyConfigured()) return
      const { syncDigikey } = await import('./services/digikey.js')
      await syncDigikey({ trigger: 'scheduled' })
    } catch (e) { console.error('digikey cron:', e.message) }
  })

  // Rappel mensuel de paiement des cartes (Visa CAD / USD) : scan quotidien à
  // 12h UTC = 8h à Montréal. Le service ne fait rien hors du jour de rappel.
  cron.schedule('0 12 * * *', () => {
    import('./services/cardPaymentReminder.js')
      .then(({ checkCardPaymentReminder }) => checkCardPaymentReminder({ trigger: 'cron quotidien' }))
      .catch(e => console.error('card reminder cron:', e.message))
  })

  // Plafond des cartes (MasterCard BNC) : même heure que le rappel ci-dessus,
  // 5 minutes après pour ne pas empiler deux lectures QuickBooks. Question
  // différente (la place qui reste, pas le paiement du mois) et automation
  // distincte : les deux peuvent être activées ou coupées séparément.
  cron.schedule('5 12 * * *', () => {
    import('./services/cardCeiling.js')
      .then(({ checkCardCeilings }) => checkCardCeilings({ trigger: 'cron quotidien' }))
      .catch(e => console.error('card ceiling cron:', e.message))
  })

  // Budget marketing (Émilie) : détection des nouvelles dépenses dans les
  // comptes QB marketing PLUSIEURS FOIS PAR JOUR — aux 3 heures de 10h30 à
  // 22h30 UTC (6h30 → 18h30 à Montréal en heure d'été, 5h30 → 17h30 en heure
  // d'hiver), soit 5 passages qui couvrent la journée de travail où les
  // factures sont saisies dans QuickBooks. Un seul passage matinal laissait la
  // file muette jusqu'au lendemain pour toute dépense saisie après 7h30.
  // La sync est idempotente (dédup par import_key) : re-balayer la même période
  // n'insère rien, donc multiplier les passages ne crée pas de doublon.
  // Le scan d'envoi du message Slack hebdo reste à 20h UTC = 16h (le service
  // n'envoie que le mardi, une fois par semaine). Les deux court-circuitent si
  // leur automation système est désactivée.
  cron.schedule('30 10,13,16,19,22 * * *', () => {
    import('./services/marketingBudget.js')
      .then(({ syncMarketingExpenses }) => syncMarketingExpenses({ trigger: 'cron aux 3 h' }))
      .catch(e => console.error('marketing budget sync cron:', e.message))
  })
  // 20h UTC = 16h à Montréal : l'utilisateur fait son tri du budget marketing le
  // mardi dans la journée, donc l'envoi doit venir APRÈS (à 9h, le message
  // partait vide et les dépenses validées attendaient le mardi suivant).
  cron.schedule('0 20 * * *', () => {
    import('./services/marketingBudget.js')
      .then(({ checkWeeklyMarketingSlack }) => checkWeeklyMarketingSlack({ trigger: 'cron quotidien' }))
      .catch(e => console.error('marketing weekly slack cron:', e.message))
  })

  // Prospects Instagram : lecture des commentaires à minuit dans la nuit de
  // dimanche à lundi (heure de Montréal), quand la semaine ISO vient de se
  // clore. Le serveur tourne en UTC et aucun cron du repo n'utilise l'option
  // timezone — on tire donc DEUX fois, 4h et 5h UTC le LUNDI (= lundi 0h à
  // Montréal en heure d'été puis en heure d'hiver), et le service ne retient
  // que le passage où l'heure locale vaut bien 0. Ne pas « simplifier » en un
  // seul passage : la moitié de l'année la tournée partirait une heure à côté,
  // donc potentiellement dans la mauvaise semaine ISO.
  cron.schedule('0 4,5 * * 1', () => {
    import('./services/instagramCommentScrape.js')
      .then(({ runCommentScrape }) => runCommentScrape({ trigger: 'cron nuit dimanche→lundi' }))
      .catch(e => console.error('instagram comment scrape cron:', e.message))
  })

  // Prospects Instagram : liste hebdo à Philippe, lundi 7h30 heure de Montréal
  // — soit après la lecture des commentaires ci-dessus, pour que la liste soit
  // complète. Même double passage : 11h30 et 12h30 UTC valent 7h30 à Montréal
  // en heure d'été puis en heure d'hiver. Les MINUTES viennent du cron seul :
  // send_hour ne porte que l'heure, et c'est elle que le service vérifie.
  cron.schedule('30 11,12 * * 1', () => {
    import('./services/instagramProspects.js')
      .then(({ runWeeklyProspectDigest }) => runWeeklyProspectDigest({ trigger: 'cron lundi matin' }))
      .catch(e => console.error('instagram prospects hebdo cron:', e.message))
  })

  // Suggestions de chantiers ET d'intégrations (page Travaux) : passage quotidien
  // à 7 h (Montréal). Gardé par l'automation système sys_work_suggestions —
  // désactivée, aucun appel au modèle n'est fait.
  cron.schedule('0 11 * * *', () => {
    if (!isSystemAutomationActive('sys_work_suggestions')) return
    import('./services/workSuggestions.js')
      .then(({ runSuggestionEngines }) => runSuggestionEngines())
      .catch(e => console.error('work suggestions cron:', e.message))
  })
})

// Kill Claude process on shutdown so pm2 restart doesn't leave orphans
process.on('SIGINT',  () => { shutdownTaskRunner(); process.exit(0) })
process.on('SIGTERM', () => { shutdownTaskRunner(); process.exit(0) })

export default app
