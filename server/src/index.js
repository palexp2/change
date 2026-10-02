import { shutdownScriptRuntime } from './services/scriptSandbox.js'
import express from 'express'
import { requireAuth } from './middleware/auth.js'
import cors from 'cors'
import helmet from 'helmet'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { loadEnv } from './config/loadEnv.js'

// Validate critical secrets early (throws if JWT_SECRET missing)
import './config/secrets.js'

import { initSchema, seedSellableProducts } from './db/schema.js'
import { runMigrations } from './db/migrate.js'
import { checkSchemaDrift } from './db/schemaDrift.js'
import { initChangeLog, purgeChangeLog } from './db/changeLog.js'
import { startFieldRuleWatcher } from './services/fieldRuleWatcher.js'
import { startRevenueRecognitionWatcher } from './services/revenueRecognitionWatcher.js'
import { startReturnItemCreatedWatcher } from './services/returnItemCreatedWatcher.js'
import { startShippedCostWatcher } from './services/shippedCostWatcher.js'
import { startFifoCostWatcher } from './services/fifoCostWatcher.js'
import { startReturnItemReceivedWatcher } from './services/returnItemReceivedWatcher.js'
import { startFacturePaidSlackWatcher } from './services/facturePaidSlackWatcher.js'
import { startAddressCheckWatcher } from './services/addressCheck.js'
import { startRecordRevisions } from './services/recordRevisions.js'
import { syncAllPrepaidAccountsFromQB } from './services/prepaid.js'
import bootstrapRouter from './routes/bootstrap.js'
import { seedSystemAutomations, logSystemRun, touchSystemRun, isSystemAutomationActive } from './services/systemAutomations.js'
import { runTrashAutoCleanupOnBoot } from './services/trash.js'
import authRouter from './routes/auth.js'
import companiesRouter from './routes/companies.js'
import contactsRouter from './routes/contacts.js'
import projectsRouter from './routes/projects.js'
import customFieldsRouter from './routes/custom-fields.js'
import customFieldFilesRouter from './routes/custom-field-files.js'
import fieldVisibilityRulesRouter from './routes/field-visibility-rules.js'
import formConfigsRouter from './routes/form-configs.js'
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
import marketingFormsRouter from './routes/marketing-forms.js'
import purchasesRouter from './routes/purchases.js'
import serialsRouter from './routes/serials.js'
import viewsRouter from './routes/views.js'
import { recordDeleteGuard } from './middleware/recordDeleteGuard.js'
import projetsRouter from './routes/projets.js'
import retoursRouter from './routes/retours.js'
import paymentsRouter from './routes/payments.js'
import catalogRouter from './routes/catalog.js'
import documentsRouter from './routes/documents.js'
import searchRouter from './routes/search.js'
import recordLinksRouter from './routes/record-links.js'
import shipmentsRouter from './routes/shipments.js'
import automationsRouter from './routes/automations.js'
import tasksRouter from './routes/tasks.js'
import agentRouter from './routes/agent.js'
import aiUsageRouter from './routes/aiUsage.js'
import travauxRouter from './routes/travaux.js'
import achatsFournisseursRouter from './routes/achats-fournisseurs.js'
import vendorSubscriptionsRouter from './routes/vendor-subscriptions.js'
import vendorProfilesRouter from './routes/vendor-profiles.js'
import paymentCardsRouter from './routes/payment-cards.js'
import treasuryRouter from './routes/treasury.js'
import bankRouter from './routes/bank.js'
import bankRulesRouter from './routes/bankRules.js'
import bankStatementsRouter from './routes/bankStatements.js'
import plaidRouter, { plaidWebhookRouter } from './routes/plaid.js'
import vennRouter from './routes/venn.js'
import qbWebhookRouter from './routes/quickbooks-webhook.js'
import prepaidRouter from './routes/prepaid.js'
import ltDebtsRouter from './routes/lt-debts.js'
import marketingBudgetRouter from './routes/marketing-budget.js'
import carmRouter from './routes/carm.js'
import scrapersRouter from './routes/scrapers.js'
import fxRouter from './routes/fx.js'
import monthEndRouter from './routes/month-end.js'
import deferredRevenueRouter from './routes/deferred-revenue.js'
import driveInventoryRouter from './routes/drive-inventory.js'
import mapaqRouter from './routes/mapaq.js'
import clientMapRouter from './routes/clientMap.js'
import employeesRouter from './routes/employees.js'
import vacationsRouter from './routes/vacations.js'
import qualificationCallsRouter from './routes/qualification-calls.js'
import emailRelanceRouter from './routes/email-relance.js'
import placesRouter from './routes/places.js'
import weatherRouter from './routes/weather.js'
import paiesRouter from './routes/paies.js'
import timesheetsRouter from './routes/timesheets.js'
import activityCodesRouter from './routes/activity-codes.js'
import opsIssuesRouter from './routes/ops-issues.js'
import saleReceiptsRouter from './routes/sale-receipts.js'
import anomaliesRouter from './routes/anomalies.js'
import auditRouter from './routes/audit.js'
import changelogRouter from './routes/changelog.js'
import { runAnomalyScan, runQbLinkVerification } from './services/transactionAnomalies.js'
import attachmentsRouter from './routes/attachments.js'
import journalEntriesRouter from './routes/journal-entries.js'
import stockMovementsRouter from './routes/stock-movements.js'
import fournituresRouter from './routes/fournitures.js'
import stripeWebhooksRouter from './routes/stripe-webhooks.js'
import hooksRouter from './routes/hooks.js'
import instagramRouter from './routes/instagram.js'
import stripeInvoicesRouter from './routes/stripe-invoices.js'
import stripeSubscriptionsRouter from './routes/stripe-subscriptions.js'
import customerPayRouter from './routes/customer-pay.js'
import { SOUMISSION_ASSETS_DIR } from './services/soumissionPdf.js'
import customerPostPaymentRouter from './routes/customer-post-payment.js'
import discoveryFormsRouter from './routes/discovery-forms.js'
import { retryPendingDiscoveryOrders } from './services/discoveryOrderAirtable.js'
import discoveryFormSchemaRouter from './routes/discovery-form-schema.js'
import emailTrackingRouter from './routes/email-tracking.js'
import stripeQueueRouter from './routes/stripe-queue.js'
import stripePayoutsRouter from './routes/stripe-payouts.js'
import stripeInvoiceItemsRouter from './routes/stripe-invoice-items.js'
import novoxpressRouter from './routes/novoxpress.js'
import digikeyRouter from './routes/digikey.js'
import upsRouter from './routes/ups.js'
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
import { getAutomationFrom } from './services/postmarkConfig.js'
import { createRealtimeServer } from './services/realtime.js'
import { initTaskRunner, shutdownTaskRunner } from './services/taskRunner.js'
import { initScheduler } from './services/automationScheduler.js'
import { syncAllMailboxes } from './services/gmail.js'
import { syncCompanies, syncContacts, syncProjets, syncPieces, syncOrders, syncOrderItems, syncAchats, syncBillets, syncSerials, syncEnvois, syncSoumissions, syncRetours, syncRetourItems, syncAdresses, syncBomItems, syncSerialStateChanges, syncAssemblages, syncStockMovements, syncEmployees, syncPaies, syncPaieItems } from './services/airtable.js'
import { tracked } from './services/syncState.js'
import { routeSync, ENGINE_ONLY_SYNCS } from './services/airtableMirrorEngine.js'
import { syncStripeSubscriptions, isStripeConfigured } from './services/stripe.js'
import { syncAndPushStripePayouts, getStripePayoutPushConfig, importFromQB } from './services/quickbooks.js'
import cron from 'node-cron'
import { initAirtableWebhooks } from './services/airtableWebhooks.js'
import { getAccessToken as getAirtableToken } from './connectors/airtable.js'
import { logSync, purgeSyncLogs } from './services/syncLog.js'
import { pullDelta as hsPullDelta, retryFailedPushes as hsRetryFailedPushes } from './services/hubspotSync.js'
import { drainRachatRetryQueue } from './services/subscriptionEvents.js'
import { isHubSpotConfigured } from './connectors/hubspot.js'
import { syncHubSpotForms, syncScriptedForms } from './services/hubspotForms.js'
import { importHubSpotHistory, pendingHistoryTypes as hsPendingHistoryTypes, HISTORY_SYNC_KEY as HS_HISTORY_SYNC_KEY } from './services/hubspotHistoryImport.js'
import db from './db/database.js'
import { installAiFetchMeter } from './services/aiCostMeter.js'

loadEnv()
// Chaque appel texte à OpenAI / Gemini laisse ses jetons (Paramètres → Coûts IA).
installAiFetchMeter()

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

// Requêtes en cours : à l'arrêt on cesse d'accepter (nginx bascule alors sur
// l'autre exemplaire) et on laisse finir celles déjà reçues avant de sortir.
let inFlight = 0
app.use((req, res, next) => {
  inFlight++
  let done = false
  const end = () => { if (!done) { done = true; inFlight-- } }
  res.on('finish', end)
  res.on('close', end)
  next()
})


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
      // Module Chrome « pont de session » (browser-extension/) : il envoie les
      // cookies d'un portail fournisseur depuis le navigateur de l'utilisateur.
      // Son origine est chrome-extension://<id>, imprévisible et impossible à
      // whitelister ; l'accès reste gardé par le jeton d'authentification, et
      // la permission ne vaut QUE pour ces routes-là.
      if (o.startsWith('chrome-extension://') && req.url.includes('/scrapers/session-bridge/')) {
        return cb(null, true)
      }
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

// Plaid signe le webhook en JWT ES256 sur le corps brut (voir
// connectors/plaid.js:verifyWebhook) — même contrainte de corps brut.
app.use('/api/plaid/webhook', express.raw({ type: 'application/json' }), (req, res, next) => {
  req.rawBody = req.body
  try { req.body = JSON.parse(req.body) } catch { req.body = {} }
  next()
}, plaidWebhookRouter)

// Avis instantanés de QuickBooks : `intuit-signature` = HMAC-SHA256 du corps
// BRUT, même contrainte que Stripe et Plaid.
//
// `type: () => true` et NON `'application/json'` : Intuit envoie parfois un
// Content-Type avec charset, ou vide. express.raw laisserait alors `req.body`
// à `{}`, le corps brut serait vide et la signature échouerait EN SILENCE —
// c'est le mode d'échec le plus probable de ce montage.
app.use('/api/quickbooks/webhook', express.raw({ type: () => true }), (req, res, next) => {
  req.rawBody = req.body
  try { req.body = JSON.parse(req.body) } catch { req.body = {} }
  next()
}, qbWebhookRouter)

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
app.use('/api/recordings', requireAuth, express.static(uploadsPath('calls')))
// Serve bons de livraison
app.use('/api/bons-livraison', requireAuth, express.static(uploadsPath('bons-livraison')))
// Serve product images
app.use('/api/product-images', express.static(uploadsPath('products')))
// Images et polices du gabarit PDF des soumissions (aperçu en direct).
app.use('/api/soumission-assets', express.static(SOUMISSION_ASSETS_DIR, { maxAge: '7d' }))
// Serve product installation/replacement PDFs (cached copies of lien_pdf_*)
app.use('/api/product-docs', express.static(uploadsPath('products', 'docs')))
// Airtable image mirror requires a session; other private attachments use download routers.
app.use('/api/attachments/airtable', requireAuth, express.static(uploadsPath('attachments', 'airtable')))

import { ensureNativeFieldDefs } from './services/airtableAutoSync.js'
import { regenerateAllViews } from './services/customFieldsView.js'
import { seedNativeFieldConversions } from './services/nativeFieldConversions.js'
import {
  retireEnvoisCoreFieldMap, retireOrdersCoreFieldMap, retireAssemblagesCoreFieldMap,
  retirePiecesCoreFieldMap, retirePaiesCoreFieldMap, retireContactsCoreFieldMap,
  retireCompaniesCoreFieldMap, retireProjetsCoreFieldMap,
  retireRetourItemsCoreFieldMap, retireSerialsCoreFieldMap, retireBomCoreFieldMap,
} from './services/airtableUiFieldMap.js'
import { seedBankAccounts } from './services/bankReconciliation.js'
import { seedMonthEndProvisions } from './services/monthEndSeed.js'
import { seedRecurringWork } from './services/recurringWork.js'
import { seedLtDebts } from './services/ltDebtSeed.js'
import { seedCardCeilings } from './services/cardCeiling.js'
import { seedCancelUrls } from './services/subscriptionCancelUrls.js'
import { initPromptQueue } from './services/promptQueue.js'
import { startQuotaGuard } from './services/quotaGuard.js'
import { uploadsPath } from './config/uploads.js'

initSchema()
// Migrations numérotées (db/migrate.js) — ce que le pattern additif de
// schema.js ne sait pas faire : supprimer, renommer, et savoir ce qui a déjà
// été appliqué. Placées APRÈS initSchema (une migration peut dépendre d'une
// table qu'il vient de créer) et AVANT tout ce qui lit des données. Une
// migration qui échoue laisse remonter l'exception et arrête le démarrage :
// un serveur qui refuse de partir est préférable à une base à moitié migrée.
await runMigrations()
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
// Corbeille : rattrapage au démarrage (le serveur a pu rester éteint plusieurs
// jours), puis passage quotidien via le cron plus bas.
runTrashAutoCleanupOnBoot()
// Conversion des colonnes natives calculées en vrais champs custom (lookup/
// rollup) — DOIT précéder regenerateAllViews() : les routes converties lisent
// la vue <table>_v et comptent sur ces colonnes.
seedNativeFieldConversions()
// Envois : reprise du field_map « cœur » vers les mappings de /champs/shipments,
// puis effacement du field_map. Une seule fois (elle ne fait rien dès que le
// field_map est vide) — voir services/airtableUiFieldMap.js.
retireEnvoisCoreFieldMap()
// Commandes : même bascule (7 clés cœur reprises dans /champs/orders, doublon
// « Abonnement » mis à la corbeille). Idempotente elle aussi.
retireOrdersCoreFieldMap()
// Assemblages : « Produit », « Quantités fabriqués » et « Date » quittent le
// code pour /champs/assemblages. Idempotente elle aussi.
retireAssemblagesCoreFieldMap()
// Produits : les 17 clés cœur du module « pieces » (nom, SKU, coût, image,
// champs de la priorité d'assemblage…) quittent le code pour /champs/products.
// Idempotente elle aussi.
retirePiecesCoreFieldMap()
// Paies : les 15 clés cœur (numéro, période, statut, totaux, « Inclut … »)
// quittent le code pour /champs/paies, avec les sens de write-back semés en
// 'both' pour les colonnes que l'ERP modifie. Idempotente elle aussi.
retirePaiesCoreFieldMap()
// Contacts : les 6 clés cœur du CRM (Prénom, Nom, Email, Phone number,
// Entreprise, Langue) quittent le code pour /champs/contacts. Idempotente elle
// aussi — le field_map vit dans airtable_sync_config, pas dans
// airtable_module_config.
retireContactsCoreFieldMap()
// Entreprises : les 2 clés cœur qui restaient (« Entreprise » → le nom,
// « Phase du cycle de vie ») quittent le code pour /champs/companies — les
// trois autres ont été droppées avec leurs colonnes (migration 045).
// Idempotente elle aussi, même singleton que les contacts.
retireCompaniesCoreFieldMap()
// Projets : les 2 dernières clés cœur (« ID » → le numéro de projet,
// « Client final » → l'entreprise liée) quittent le code pour /champs/projects.
// Idempotente elle aussi, dans le singleton airtable_projets_config.
retireProjetsCoreFieldMap()
// Articles de retour : les 13 clés cœur (retour, n° de série, entreprise, les
// deux produits, raison, précision, catégorie, action, réception, analyse)
// quittent le code pour /champs/return_items. Idempotente elle aussi.
retireRetourItemsCoreFieldMap()
// Numéros de série : les 10 clés cœur (n° de série, produit, entreprise, item de
// commande, adresse, dates, valeur de fabrication, statut, notes) quittent le
// code pour /champs/serial_numbers, avec les sens de write-back semés en 'both'
// pour les colonnes que l'ERP modifie. Idempotente elle aussi.
retireSerialsCoreFieldMap()
// Nomenclature (BOM) : les 3 clés cœur (« Produit », « Pièces »,
// « QTY nécessaires ») quittent le code pour /champs/bom_items, où la table
// gagne du même coup sa colonne « Champ Airtable ». Idempotente elle aussi.
retireBomCoreFieldMap()
regenerateAllViews()

// Register native fields in airtable_field_mappings so they appear in the
// field-rule template whitelist alongside dynamic Airtable fields
ensureNativeFieldDefs([
  // Produits : les colonnes natives ne sont plus déclarées ici. Elles sont
  // ADOPTÉES en champs (custom_fields, cf. nativeFieldConversions.js), qui porte
  // désormais leur libellé et leur type — les répéter en dur les aurait figés
  // dans le dos de l'utilisateur, alors qu'il peut maintenant les renommer et
  // les re-typer. Leur ligne de mapping existe déjà (reprise du field_map cœur
  // par retirePiecesCoreFieldMap), donc la whitelist des règles de champ ne perd
  // rien. Seule « Emplacement » reste : sa colonne n'est ni dans le tableau, ni
  // dans le mapping cœur — sans cette def, elle n'aurait aucun type déclaré.
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
  { module: 'projets', erp_table: 'projects', column_name: 'notes',          label: 'Notes',           field_type: 'long_text',     sort_order: -988 },
  { module: 'projets', erp_table: 'projects', column_name: 'creation',       label: 'Créé le',         field_type: 'date',          sort_order: -987 },
])

// API Routes
// « Suppression permise » décochée sur une fiche ⇒ son DELETE est refusé, quel
// que soit l'appelant (voir middleware/recordDeleteGuard.js).
app.use('/api', recordDeleteGuard)
app.use('/api/auth', authRouter)
app.use('/api/bootstrap', bootstrapRouter)
app.use('/api/companies', companiesRouter)
app.use('/api/contacts', contactsRouter)
app.use('/api/projects', projectsRouter)
app.use('/api/custom-fields', customFieldsRouter)
// Fichiers déposés dans un champ perso de type « Attachement ».
app.use('/api/custom-field-files', customFieldFilesRouter)
app.use('/api/field-visibility-rules', fieldVisibilityRulesRouter)
app.use('/api/form-configs', formConfigsRouter)
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
app.use('/api/marketing-forms', marketingFormsRouter)
app.use('/api/purchases', purchasesRouter)
app.use('/api/serials', serialsRouter)
app.use('/api/views', viewsRouter)
app.use('/api/projets', projetsRouter)
app.use('/api/retours', retoursRouter)
app.use('/api/payments', paymentsRouter)
app.use('/api/catalog', catalogRouter)
app.use('/api/documents', documentsRouter)
app.use('/api/search', searchRouter)
app.use('/api/record-links', recordLinksRouter)
app.use('/api/shipments', shipmentsRouter)
app.use('/api/automations', automationsRouter)
// Webhooks entrants PUBLICS (token = secret, pas de requireAuth) — voir routes/hooks.js
app.use('/api/hooks', hooksRouter)
// Prospects Instagram : POST /manychat est public (secret partagé), /prospects authentifié.
app.use('/api/instagram', instagramRouter)
app.use('/api/tasks', tasksRouter)
app.use('/api/agent', agentRouter)
app.use('/api/ai-usage', aiUsageRouter)
app.use('/api/travaux', travauxRouter)
app.use('/api/achats-fournisseurs', achatsFournisseursRouter)
app.use('/api/vendor-subscriptions', vendorSubscriptionsRouter)
app.use('/api/vendor-profiles', vendorProfilesRouter)
app.use('/api/payment-cards', paymentCardsRouter)
app.use('/api/treasury', treasuryRouter)
// Les règles bancaires et le dépôt de relevés avant le routeur général :
// /api/bank/rules et /api/bank/statements leur sont propres.
app.use('/api/bank/rules', bankRulesRouter)
app.use('/api/bank/statements', bankStatementsRouter)
app.use('/api/bank', bankRouter)
app.use('/api/plaid', plaidRouter)
app.use('/api/venn', vennRouter)
app.use('/api/prepaid', prepaidRouter)
app.use('/api/lt-debts', ltDebtsRouter)
app.use('/api/marketing-budget', marketingBudgetRouter)
app.use('/api/carm', carmRouter)
app.use('/api/scrapers', scrapersRouter)
app.use('/api/fx', fxRouter)
app.use('/api/month-end', monthEndRouter)
app.use('/api/deferred-revenue', deferredRevenueRouter)
app.use('/api/drive-inventory', driveInventoryRouter)
app.use('/api/mapaq', mapaqRouter)
app.use('/api/client-map', clientMapRouter)
app.use('/api/sale-receipts', saleReceiptsRouter)
app.use('/api/anomalies', anomaliesRouter)
app.use('/api/audit', auditRouter)
app.use('/api/changelog', changelogRouter)
// Pièces jointes polymorphes (toute entité). Le static '/api/attachments'
// (ligne ~189) sert les fichiers bruts ; ce router gère list/upload/download/delete.
app.use('/api/attachments', attachmentsRouter)
app.use('/api/journal-entries', journalEntriesRouter)
app.use('/api/stock-movements', stockMovementsRouter)
app.use('/api/fournitures', fournituresRouter)
app.use('/api/stripe-queue', stripeQueueRouter)
app.use('/api/stripe-invoices', stripeInvoicesRouter)
app.use('/api/stripe-subscriptions', stripeSubscriptionsRouter)
app.use('/api/stripe-payouts', stripePayoutsRouter)
app.use('/api/stripe-invoice-items', stripeInvoiceItemsRouter)
app.use('/api/email-tracking', emailTrackingRouter)
app.use('/api/customer/post-payment', customerPostPaymentRouter)
app.use('/api/discovery-forms', discoveryFormsRouter)
app.use('/api/discovery-form-schema', discoveryFormSchemaRouter)
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
app.use('/api/ops-issues', opsIssuesRouter)
// API de mutation générique (phase 1) — pilotée par db/recordRegistry.js
app.use('/api/records', recordsRouter)
app.use('/api/activity', activityRouter)
app.use('/api/side-effects', sideEffectsRouter)
app.use('/api/notifications', notificationsRouter)
app.use('/api/comments', commentsRouter)
app.use('/api/receipt-files', express.static(uploadsPath('receipts')))
app.use('/api/novoxpress/labels', express.static(uploadsPath('labels')))
// Étiquette absente du disque : sans ce 404, la requête retombait sur le
// routeur Novoxpress (protégé) et repartait en 401 — un « non authentifié »
// trompeur pour un simple fichier manquant.
app.use('/api/novoxpress/labels', (req, res) => res.status(404).json({ error: 'Étiquette introuvable' }))
app.use('/api/novoxpress', novoxpressRouter)
// Étiquettes servies sous un chemin neutre (elles ne sont plus toutes
// Novoxpress depuis l'ajout du connecteur UPS) — même dossier uploads/labels.
app.use('/api/labels', express.static(uploadsPath('labels')))
app.use('/api/ups', upsRouter)
app.use('/api/digikey', digikeyRouter)
app.use('/api/track', trackRouter)
app.use('/api/public/installation-feedback', installationFeedbackRouter)
app.use('/api/public/ticket-survey', ticketSurveysPublicRouter)
app.use('/api/interaction-files', express.static(uploadsPath('interactions')))
app.use('/api/public-files', publicFilesRouter)
// Fichiers publics — URL non auth /erp/p/<token>/<filename>. Doit être monté
// avant le static client (/erp) sinon l'index.html SPA est servi à la place.
app.use('/erp/p', publicFileServeRouter)

// Serve client build
const clientBuild = path.join(__dirname, '../../client/dist')
// Les fichiers d'/assets portent un hash de contenu dans leur nom (Vite) : leur
// contenu ne changera jamais, un nouveau build produit un nouveau nom. On les
// met en cache un an sans revalidation — avant, `max-age=0` imposait un
// aller-retour 304 sur ~3 Mo de JS à chaque ouverture de l'app.
// index.html, lui, doit rester non caché : c'est lui qui pointe vers les
// nouveaux noms de fichiers après un déploiement.
const IMMUTABLE = 'public, max-age=31536000, immutable'
// Métadonnées lisibles sans JavaScript par les aperçus SMS.
app.get('/erp/s/:token', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache')
  res.sendFile(path.join(clientBuild, 'survey.html'))
})
app.use('/erp', express.static(clientBuild, {
  setHeaders(res, filePath) {
    res.setHeader('Cache-Control', /[/\\]assets[/\\]/.test(filePath) ? IMMUTABLE : 'no-cache')
  },
}))
app.get('/erp/*path', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache')
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

// Relais de redémarrage (scripts/restart.sh) : un second exemplaire, sur un
// autre port, que nginx sert en « backup » pendant que le principal redémarre.
// Il ne sert QUE le HTTP et le temps réel : aucun planificateur, watcher, cron
// ni file de l'agent — sinon tout tournerait en double le temps de la bascule.
const IS_STANDBY = process.env.ERP_ROLE === 'standby'

const server = app.listen(PORT, () => {
  console.log(`ERP Server running on http://localhost:${PORT}${IS_STANDBY ? ' (relais de redémarrage)' : ''}`)
  createRealtimeServer(server)
  if (IS_STANDBY) return
  initTaskRunner()
  // File de travaux : réconcilie un item fauché par le redémarrage et relance la
  // file. Après initTaskRunner, qui a déjà repris ou clos l'exécution en cours.
  initPromptQueue()
  // Garde-fou de quota : sous le seuil réglé dans le bandeau (30 % par défaut), toute
  // la file s'arrête d'elle-même et repart quand le quota remonte (quotaGuard.js).
  startQuotaGuard()
  initScheduler()

  // Contrôle de dérive du schéma (db/schemaDrift.js) — journal uniquement,
  // jamais bloquant, et différé pour rester hors du chemin de démarrage : il
  // lit les sources pour repérer les tables présentes en base que plus aucun
  // CREATE TABLE ne déclare. C'est ce contrôle qui manquait quand 22 tables
  // mortes se sont accumulées sans que rien ne le signale.
  setTimeout(() => {
    try { checkSchemaDrift() }
    catch (e) { console.warn('Contrôle de dérive du schéma indisponible:', e.message) }
  }, 5_000)

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

  // Gel du « coût total au moment de l'envoi » d'une ligne de commande — tail
  // change_log(order_items). Un envoi se crée dans Boréal comme dans Airtable :
  // le seul point commun est l'écriture sur la ligne (cf. shippedCostWatcher).
  startShippedCostWatcher()

  // Coût unitaire FIFO des pièces — tail change_log(purchases, products) +
  // passe complète horaire (prix d'achat relus dans Airtable).
  startFifoCostWatcher()

  // « Une facture a été payée » sur Slack — tail change_log(factures), toutes
  // origines confondues (Stripe, paiement saisi, sync QB/Airtable).
  startFacturePaidSlackWatcher()

  // Historique des révisions des fiches — tail change_log, diff champ par champ
  // contre le dernier instantané (services/recordRevisions.js).
  startRecordRevisions().catch(e => console.error('[revisions] démarrage', e.message))

  // Gmail sync — toutes les 3 minutes
  function scheduleGmailSync() {
    const t0 = Date.now()
    tracked('gmail', () => syncAllMailboxes('scheduled'))
      .then((summary = {}) => {
        const { accounts = 0, emailsImported = 0, invoicesImported = 0, errors = [] } = summary
        const base = `${accounts} boîte(s) — ${emailsImported} courriel(s) + ${invoicesImported} facture(s) importé(s).`
        // Passage à vide (le cas courant à 3 min) : on avance la date de dernière
        // exécution sans écrire de journal — voir touchSystemRun.
        if (!errors.length && !emailsImported && !invoicesImported) {
          touchSystemRun('sys_gmail_sync', 'success')
          return
        }
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
  }

  // Rematch des appels orphelins — resté horaire. Il roulait dans la passe Gmail,
  // mais c'est un balayage SQL des appels sans contact (les orphelins définitifs
  // sont rescannés chaque fois) : à 3 minutes ce serait 20× le travail pour rien,
  // et ça n'a aucun lien avec l'arrivée d'un courriel.
  function scheduleCallRematch() {
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
      ['companies', syncCompanies], ['contacts', syncContacts],
      ['projets', syncProjets], ['pieces', syncPieces],
      ['orders', syncOrders], ['order_items', syncOrderItems],
      ['achats', syncAchats], ['billets', syncBillets],
      ['serials', syncSerials], ['envois', syncEnvois], ['soumissions', syncSoumissions],
      ['retours', syncRetours], ['retour_items', syncRetourItems], ['adresses', syncAdresses],
      ['bom', syncBomItems], ['serial_changes', syncSerialStateChanges],
      ['assemblages', syncAssemblages], ['stock_movements', syncStockMovements],
      // RH : la comptabilisation de la paie lit ces tables (« Remb. dépenses »
      // des items) — sans ce filet elles restaient périmées entre deux syncs
      // manuels, et des remboursements manquaient à la publication QB.
      ['employees', syncEmployees], ['paies', syncPaies], ['paie_items', syncPaieItems],
      ...Object.entries(ENGINE_ONLY_SYNCS),
    ]
    // Même aiguillage que le routeur de webhooks : un module basculé sur le
    // moteur unique y part aussi pour le sync de rattrapage quotidien, sinon les
    // deux chemins écriraient différemment la même table.
    for (const [name, fn] of modules) scheduledSync(name, (changes) => routeSync(name, changes, fn))
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

  // Gmail : démarrage après 30s, puis toutes les 3 minutes. Le sync est
  // incrémental (history.list par boîte, puis get des seuls messages inconnus) et
  // protégé par un verrou « passe en cours » côté service : une passe qui traîne
  // (extraction IA d'une facture) absorbe l'appel suivant au lieu de doubler.
  setTimeout(scheduleGmailSync, 30_000)
  setInterval(scheduleGmailSync, 3 * 60 * 1000)

  // Appels orphelins → contacts : toutes les heures (détaché du sync Gmail).
  setTimeout(scheduleCallRematch, 45_000)
  setInterval(scheduleCallRematch, 60 * 60 * 1000)

  // Commandes System Builder : le bouton crée la commande dans Boréal seulement,
  // l'envoi à Airtable suit en arrière-plan. Ce battement reprend ce qui manque
  // (commande ou articles sans jumeau Airtable), avec un délai croissant par commande.
  const scheduleDiscoveryOrderRetry = () => {
    retryPendingDiscoveryOrders().catch(e => console.error('System Builder retry:', e.message))
  }
  setTimeout(scheduleDiscoveryOrderRetry, 60_000)
  setInterval(scheduleDiscoveryOrderRetry, 5 * 60 * 1000)

  // Comptes prépayés : détection des transactions QB des fournisseurs suivis
  // (recharges/factures Twilio…) — toutes les 6 h. logSync interne au service.
  const schedulePrepaidSync = () => { syncAllPrepaidAccountsFromQB('scheduled').catch(() => {}) }
  setTimeout(schedulePrepaidSync, 90_000)
  setInterval(schedulePrepaidSync, 6 * 60 * 60 * 1000)

  // change_log : purge des entrées hors rétention (48 h). Elle ne tournait qu'au
  // démarrage, ce qui suffisait tant que deploy.sh redémarrait le serveur toutes
  // les heures — ce n'est plus le cas (il ne redémarre que si `server/src` a
  // changé), donc la purge a maintenant son propre battement. Une table qui
  // gonfle ralentit tout ce qui la lit : le delta et les watchers.
  setInterval(purgeChangeLog, 30 * 60 * 1000)

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
  // CDC incrémental toutes les 2 min (délai perçu avant apparition dans la
  // section « à payer » réduit au minimum raisonnable côté polling) ; import
  // complet (réconciliation des suppressions incluse) une fois par jour.
  // logSync module 'qb_import'.
  const scheduleQbImportIncremental = () => { importFromQB({ incremental: true, trigger: 'scheduled' }).catch(() => {}) }
  const scheduleQbImportFull = () => { importFromQB({ trigger: 'scheduled' }).catch(() => {}) }
  setTimeout(scheduleQbImportIncremental, 120_000)
  setInterval(scheduleQbImportIncremental, 2 * 60 * 1000)
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

  // Formulaires HubSpot + leurs soumissions (Marketing → Formulaires) — toutes les heures.
  function scheduleHubSpotFormsSync() {
    if (!isHubSpotConfigured()) return
    const t0 = Date.now()
    tracked('hubspot_forms', () => syncHubSpotForms()).then((out) => {
      logSync('hubspot_forms', 'scheduled', {
        status: out.errors.length ? 'error' : 'success',
        modified: out.newSubmissions,
        error: out.errors.join(' · ') || null,
        durationMs: Date.now() - t0,
      })
    }).catch(e => {
      logSync('hubspot_forms', 'scheduled', { status: 'error', error: e.message, durationMs: Date.now() - t0 })
      console.error('HubSpot forms sync error:', e.message)
    })
  }
  // Import de l'historique HubSpot interrompu par un redémarrage → reprise au curseur.
  setTimeout(() => {
    const types = isHubSpotConfigured() ? hsPendingHistoryTypes() : []
    if (!types.length) return
    tracked(HS_HISTORY_SYNC_KEY, () => importHubSpotHistory({ types }))
      .then(r => logSync(HS_HISTORY_SYNC_KEY, 'scheduled', { status: 'success', result: r }))
      .catch(e => { logSync(HS_HISTORY_SYNC_KEY, 'scheduled', { status: 'error', error: e.message }); console.error('HubSpot history:', e.message) })
  }, 90_000)
  setTimeout(scheduleHubSpotFormsSync, 3 * 60_000)
  setInterval(scheduleHubSpotFormsSync, 60 * 60 * 1000)
  // Formulaires dont le script à la soumission est actif — toutes les 2 min.
  let scriptedFormsBusy = false
  setInterval(() => {
    if (scriptedFormsBusy || !isHubSpotConfigured()) return
    scriptedFormsBusy = true
    tracked('hubspot_forms_scripted', () => syncScriptedForms())
      .catch(e => console.error('HubSpot scripted forms sync error:', e.message))
      .finally(() => { scriptedFormsBusy = false })
  }, 2 * 60 * 1000)

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

  // Rappel « retours avec échange immédiat » RETIRÉ : son éligibilité reposait
  // sur `returns.billed_at` et sur le contact du retour, colonnes détruites par
  // la migration 037 (« supprime tous les champs Airtable codés en dur »).

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
          const { postSlack } = await import('./services/slack.js')
          await postSlack(url, `❌ *Payouts Stripe → QuickBooks* — le passage automatique a échoué : ${e.message}\n→ Journal : page Automations de l'ERP.`)
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

  // Relevés de carte de crédit déposés dans le Drive : le solde imprimé donne le
  // montant exact du prélèvement à venir, sans avoir à le reconstituer.
  cron.schedule('20 6 * * *', () => {
    import('./services/cardStatementImport.js')
      .then(({ importCardStatements }) => importCardStatements())
      .catch(e => console.error('relevés de carte:', e.message))
  })

  // Relevés PDF du Drive → rapprochement préparé dans QuickBooks, compte par
  // compte, le jour où chaque relevé arrive (jamais « Terminer »).
  cron.schedule('40 6 * * *', () => {
    import('./services/bankStatementDriveWatch.js')
      .then(({ watchDriveStatements }) => watchDriveStatements())
      .catch(e => console.error('relevés du Drive:', e.message))
  })

  // Alerte trésorerie BNC : vérification quotidienne du solde projeté à 7h30
  // locale (le service court-circuite si sys_treasury_alert est inactive).
  cron.schedule('30 7 * * *', () => {
    import('./services/treasury.js')
      .then(({ checkTreasuryAlert }) => checkTreasuryAlert({ trigger: 'cron quotidien' }))
      .catch(e => console.error('treasury cron:', e.message))
  })

  // Le Sheet du solde BNC est désormais entretenu depuis la projection Boréal.
  const mirrorTreasurySheet = () => import('./services/treasurySheetMirror.js')
    .then(({ syncTreasuryMirror }) => syncTreasuryMirror())
    .catch(e => console.error('treasury sheet mirror:', e.message))
  cron.schedule('*/20 * * * *', mirrorTreasurySheet)
  setTimeout(mirrorTreasurySheet, 160_000)

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

  // Vérification QuickBooks du rapprochement — LE moteur unique depuis le
  // 2026-09-15 (services/bankQbVerify.js). Il remplace à lui seul la sync
  // entrante du fichier TRX_Orisha et l'audit des comptes Plaid, qui
  // reconstruisaient le MÊME index de grand livre à trente secondes
  // d'intervalle : ~72 rapports par heure, désormais 12. Filet horaire sur une
  // fenêtre glissante ; le passage profond (tout l'historique, effacement des
  // liens morts) tourne une fois par jour. La détection immédiate, elle, vient
  // des avis de QuickBooks (routes/quickbooks-webhook.js).
  // Interrogation rapprochée de QuickBooks : « qu'est-ce qui a changé depuis
  // 30 secondes ? ». Un seul appel, et le changement trouvé suit exactement le
  // même chemin qu'un avis reçu d'Intuit. Coupe-circuit : sys_qb_change_poll.
  const runQbChangePoll = () => {
    import('./services/qbChangePoll.js')
      .then(({ pollQbChanges }) => pollQbChanges())
      .catch(e => console.error('qb change poll:', e.message))
  }
  setTimeout(runQbChangePoll, 90_000)
  setInterval(runQbChangePoll, 30 * 1000)

  const runQbVerify = () => {
    import('./services/bankQbVerify.js')
      .then(({ scheduledQbVerify }) => scheduledQbVerify({ trigger: 'planifie' }))
      .catch(e => console.error('bank qb verify:', e.message))
  }
  setTimeout(runQbVerify, 240_000)
  setInterval(runQbVerify, 60 * 60 * 1000)

  // Factures « À payer » dont l'échéance est passée → « En retard ».
  const runOverdueFactures = () => {
    import('./services/factureBalance.js')
      .then(({ refreshOverdueFactures }) => refreshOverdueFactures())
      .catch(e => console.error('factures en retard:', e.message))
  }
  setTimeout(runOverdueFactures, 30_000)
  cron.schedule('5 0 * * *', runOverdueFactures)

  cron.schedule('0 6 * * *', () => {
    import('./services/bankQbVerify.js')
      .then(({ scheduledQbVerify }) => scheduledQbVerify({ deep: true, trigger: 'cron quotidien' }))
      .catch(e => console.error('bank qb verify (profond):', e.message))
    import('./routes/quickbooks-webhook.js')
      .then(({ purgeOldWebhookEvents }) => purgeOldWebhookEvents(30))
      .catch(e => console.error('purge avis quickbooks:', e.message))
  })

  // Le sens inverse : Boreal recopie le rapprochement dans un classeur Google,
  // couleurs comprises. Décalé de 5 min de la sync entrante pour que le miroir
  // reflète ce qui vient d'arriver. Coupe-circuit : sys_trx_sheet_mirror,
  // éteinte tant que Charles n'a pas demandé la création du classeur.
  const runTrxSheetMirror = () => {
    import('./services/trxSheetMirror.js')
      .then(({ syncMirror }) => syncMirror({ trigger: 'planifie' }))
      .catch(e => console.error('trx sheet mirror:', e.message))
  }
  setTimeout(runTrxSheetMirror, 540_000)
  setInterval(runTrxSheetMirror, 20 * 60 * 1000)
  // Et l'inverse : une modification faite au fichier (commentaire de Michel)
  // revient dans Boréal en moins d'une demi-minute.
  import('./services/trxSheetMirror.js')
    .then(({ watchFileEdits }) => watchFileEdits())
    .catch(e => console.error('trx sheet watch:', e.message))

  // Un solde qui ne se relit plus ne fait aucun bruit : le dernier montant
  // connu reste affiché comme s'il était d'aujourd'hui, et la projection de
  // trésorerie s'appuie dessus. Trois passages par jour. Coupe-circuit dans le
  // service.
  cron.schedule('0 11,17,23 * * *', () => {
    if (!isSystemAutomationActive('sys_plaid_silence_alert')) return
    import('./services/plaidBalanceAlert.js')
      .then(({ checkBalanceFreshness }) => checkBalanceFreshness({ trigger: 'cron' }))
      .catch(e => console.error('plaid balance alert:', e.message))
  })

  // Lecture Plaid planifiée — FILET derrière le webhook, qui était jusqu'ici le
  // seul déclencheur : une signature refusée ou un webhook perdu et plus rien
  // n'arrivait, en silence. Coupe-circuit si sys_plaid_sync est désactivée.
  const runPlaidSync = () => {
    if (!isSystemAutomationActive('sys_plaid_sync')) return
    import('./services/plaidSync.js')
      .then(({ scheduledPlaidSync }) => scheduledPlaidSync())
      .catch(e => console.error('plaid sync:', e.message))
  }
  setTimeout(runPlaidSync, 120_000)
  // 10 min (choix de Charles, 2026-09-19) : le solde du compte de projection ne
  // vient plus que de là et la lecture ne coûte rien de plus (aucun appel au
  // produit Balance, facturé à l'appel).
  setInterval(runPlaidSync, 10 * 60 * 1000)

  // Lecture Venn planifiée — une fois par jour (5 h UTC = 1 h à Montréal), sur
  // les comptes Venn CAD et Venn USD reliés depuis /connecteurs. Venn ne
  // prévient pas l'ERP : ce passage est le SEUL chemin automatique. Relire une
  // fenêtre large ne coûte rien, la dédup est portée par l'identifiant de
  // transaction de Venn. Coupe-circuit si sys_venn_sync est désactivée.
  cron.schedule('0 5 * * *', () => {
    if (!isSystemAutomationActive('sys_venn_sync')) return
    import('./services/vennSync.js')
      .then(({ scheduledVennSync }) => scheduledVennSync({ trigger: 'scheduled' }))
      .catch(e => console.error('venn sync:', e.message))
  })

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

  // Le moteur du rapprochement, en rattrapage nocturne : la plupart des
  // propositions naissent à l'arrivée des transactions, mais certaines changent
  // sans qu'une ligne bouge (une facture extraite après coup, une règle créée
  // hier, un paiement émis marqué depuis). Rien n'est comptabilisé ici — le
  // passage ne fait que préparer ce qu'un clic appliquera.
  cron.schedule('0 9 * * *', async () => {
    try {
      const { isSystemAutomationActive } = await import('./services/systemAutomations.js')
      if (!isSystemAutomationActive('sys_bank_engine')) return
      const { runBankEngine } = await import('./services/bankProposals/engine.js')
      const res = await runBankEngine({})
      if (res.produced) console.log('bankEngine:', res.summary)
    } catch (e) { console.error('bankEngine cron:', e.message) }
  })

  // Contrôles comptables : une passe par jour, à distance du passage profond de
  // 6 h et du moteur de 9 h pour ne pas lire le grand livre en même temps
  // qu'eux. Silencieux — les constatations attendent sur le tableau de bord.
  cron.schedule('0 14 * * *', async () => {
    try {
      const { scheduledAudit } = await import('./services/audit/index.js')
      const res = await scheduledAudit({ trigger: 'planifie' })
      if (res?.found) console.log('audit:', res.summary)
    } catch (e) { console.error('audit cron:', e.message) }
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

  // ManyChat : contacts et conversations, tous les matins. Deux heures UTC
  // pour couvrir l'été et l'hiver ; le service ne retient qu'un passage.
  cron.schedule('0 9,10 * * *', () => {
    import('./services/manychatSync.js')
      .then(({ runManychatSync }) => runManychatSync({ trigger: 'cron quotidien' }))
      .catch(e => console.error('manychat sync cron:', e.message))
  })

  // Instagram : tri par type de demande, juste avant l'écriture — un message
  // écrit sans savoir ce que la personne demande tombe à côté.
  cron.schedule('30 9,10 * * *', () => {
    import('./services/instagramSegments.js')
      .then(({ runSegmentation }) => runSegmentation({ trigger: 'cron quotidien' }))
      .catch(e => console.error('instagram segmentation cron:', e.message))
  })

  // Instagram : écriture des messages d'avance, tous les matins après la
  // lecture de ManyChat. Deux heures UTC pour couvrir l'été et l'hiver.
  cron.schedule('0 10,11 * * *', () => {
    import('./services/instagramDrafts.js')
      .then(({ runDraftWriting }) => runDraftWriting({ trigger: 'cron quotidien' }))
      .catch(e => console.error('instagram draft write cron:', e.message))
  })

  // Instagram : la file d'envoi. Chaque minute — le service décide seul s'il
  // est l'heure, si le plafond du jour est atteint, et si le message suivant
  // est dû ; hors de ces conditions le passage ne fait rien.
  cron.schedule('* * * * *', () => {
    import('./services/instagramDrafts.js')
      .then(({ runDraftQueue }) => runDraftQueue({ trigger: 'file' }))
      .catch(e => console.error('instagram draft queue cron:', e.message))
  })

  // Santé des sessions de connecteurs (Instagram aujourd'hui, ManyChat demain) :
  // un passage quotidien, indépendant des tournées. C'est ce qui fait qu'une
  // session morte se voit le lendemain et non trois semaines plus tard.
  cron.schedule('0 11 * * *', () => {
    import('./services/sessionHealth.js')
      .then(({ runSessionHealthCheck }) => runSessionHealthCheck({ trigger: 'cron quotidien' }))
      .catch(e => console.error('session health cron:', e.message))
  })

  // Prospects Instagram : la liste hebdo à Philippe n'a plus d'horaire. Elle
  // part seulement après la reconnexion Instagram du samedi, une fois la
  // lecture réussie (services/instagramRefresh.js) — jamais de liste partielle.

  // Suggestions de chantiers ET d'intégrations (page Travaux) : passage quotidien
  // à 7 h (Montréal). Gardé par l'automation système sys_work_suggestions —
  // désactivée, aucun appel au modèle n'est fait.
  cron.schedule('0 11 * * *', () => {
    if (!isSystemAutomationActive('sys_work_suggestions')) return
    import('./services/workSuggestions.js')
      .then(({ runSuggestionEngines }) => runSuggestionEngines())
      .catch(e => console.error('work suggestions cron:', e.message))
  })

  // Agents autonomes (/travaux, onglet « Agents ») : toutes les 10 minutes, les
  // agents dont l'heure de réveil est passée déposent leur passage dans la file.
  // Gardé par l'automation système sys_autonomous_agents.
  cron.schedule('*/10 * * * *', () => {
    if (!isSystemAutomationActive('sys_autonomous_agents')) return
    const t0 = Date.now()
    import('./services/autonomousAgents.js')
      .then(({ tickAutonomousAgents }) => {
        const result = tickAutonomousAgents()
        if (result.lances.length) logSystemRun('sys_autonomous_agents', { status: 'success', result, duration_ms: Date.now() - t0 })
      })
      .catch(e => {
        console.error('autonomous agents cron:', e.message)
        logSystemRun('sys_autonomous_agents', { status: 'error', error: e.message, duration_ms: Date.now() - t0 })
      })
  })

  // Projets ouverts depuis 30 jours (réglable) : fermés avec la raison
  // « Fermeture automatique ». 10h15 UTC = 6h15 à Montréal.
  cron.schedule('15 10 * * *', () => {
    import('./services/projectAutoClose.js')
      .then(({ scheduledProjectAutoClose }) => scheduledProjectAutoClose())
      .catch(e => console.error('project auto-close cron:', e.message))
  })

  // Corbeille : suppression définitive de ce qui y traîne depuis plus de
  // retention_days jours. 7h30 UTC = 3h30 à Montréal, personne dans l'ERP.
  cron.schedule('30 7 * * *', () => {
    if (!isSystemAutomationActive('sys_trash_auto_cleanup')) return
    import('./services/trash.js')
      .then(({ runTrashAutoCleanup }) => runTrashAutoCleanup({ trigger: 'cron quotidien' }))
      .catch(e => console.error('trash cleanup cron:', e.message))
  })
})

// Kill Claude process on shutdown so pm2 restart doesn't leave orphans
// Arrêt en douceur : plus de nouvelles connexions (nginx passe à l'autre
// exemplaire), puis sortie dès que les requêtes en cours sont finies. Plafond
// sous le kill_timeout de pm2 (1,6 s par défaut, 12 s pour le relais).
const DRAIN_MAX_MS = Number(process.env.DRAIN_MAX_MS) || 1400
let shuttingDown = false
function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  shutdownScriptRuntime(); shutdownTaskRunner()
  server.close()
  const t0 = Date.now()
  const check = () => {
    if (inFlight <= 0 || Date.now() - t0 >= DRAIN_MAX_MS) process.exit(0)
    setTimeout(check, 50)
  }
  check()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

export default app
