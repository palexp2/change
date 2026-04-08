import express from 'express'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'
import dotenv from 'dotenv'

import { initSchema, seedSellableProducts } from './db/schema.js'
import { runPurge } from './services/purge.js'
import { seedBaseTables } from './services/baseSeed.js'
import authRouter from './routes/auth.js'
import companiesRouter from './routes/companies.js'
import contactsRouter from './routes/contacts.js'
import projectsRouter from './routes/projects.js'
import productsRouter from './routes/products.js'
import ordersRouter from './routes/orders.js'
import ticketsRouter from './routes/tickets.js'
import dashboardRouter from './routes/dashboard.js'
import adminRouter from './routes/admin.js'
import interactionsRouter from './routes/interactions.js'
import callsRouter, { rematchCalls } from './routes/calls.js'
import connectorsRouter from './routes/connectors.js'
import purchasesRouter from './routes/purchases.js'
import serialsRouter from './routes/serials.js'
import viewsRouter from './routes/views.js'
import projetsRouter from './routes/projets.js'
import catalogRouter from './routes/catalog.js'
import documentsRouter from './routes/documents.js'
import searchRouter from './routes/search.js'
import shipmentsRouter from './routes/shipments.js'
// import baseRouter from './routes/base.js' // Dynamic tables — disabled
import automationsRouter from './routes/automations.js'
import tasksRouter from './routes/tasks.js'
import agentRouter from './routes/agent.js'
import depensesRouter from './routes/depenses.js'
import facturesFournisseursRouter from './routes/factures-fournisseurs.js'
import employeesRouter from './routes/employees.js'
import saleReceiptsRouter from './routes/sale-receipts.js'
import stripeWebhooksRouter from './routes/stripe-webhooks.js'
import stripeQueueRouter from './routes/stripe-queue.js'
import novoxpressRouter from './routes/novoxpress.js'
import trackRouter from './routes/track.js'
import { createRealtimeServer } from './services/realtime.js'
import { initTaskRunner, shutdownTaskRunner } from './services/taskRunner.js'
import { initScheduler } from './services/automationScheduler.js'
import { syncAllMailboxes } from './services/gmail.js'
import { syncDrive } from './services/drive.js'
import { syncAirtable, syncProjets, syncPieces, syncOrders, syncAchats, syncBillets, syncSerials, syncEnvois, syncSoumissions, syncRetours, syncRetourItems, syncAdresses, syncBomItems, syncSerialStateChanges, syncAssemblages, syncFactures } from './services/airtable.js'
import { tracked } from './services/syncState.js'
import { syncStripeSubscriptions, isStripeConfigured } from './services/stripe.js'
import { initAirtableWebhooks } from './services/airtableWebhooks.js'
import { getAccessToken as getAirtableToken } from './connectors/airtable.js'
import { logSync, purgeSyncLogs } from './services/syncLog.js'
import db from './db/database.js'

dotenv.config()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 3004

app.use(cors({ origin: true, credentials: true }))

// Stripe webhooks need raw body for signature verification — mount before express.json
app.use('/api/stripe-webhooks', express.raw({ type: 'application/json' }), (req, res, next) => {
  req.rawBody = req.body
  req.body = JSON.parse(req.body)
  next()
}, stripeWebhooksRouter)

app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

// Rewrite /erp/api/* → /api/* so the built frontend works without a dev proxy
app.use((req, res, next) => {
  if (req.url.startsWith('/erp/api/')) req.url = req.url.slice('/erp'.length)
  next()
})

// Serve call recordings
app.use('/api/recordings', express.static(path.join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'calls')))
// Serve bons de livraison
app.use('/api/bons-livraison', express.static(path.join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'bons-livraison')))
// Serve product images
app.use('/api/product-images', express.static(path.join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'products')))
// Serve record attachments
app.use('/api/attachments', express.static(path.join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'attachments')))

initSchema()
seedSellableProducts()
seedBaseTables()
runPurge()

// API Routes
app.use('/api/auth', authRouter)
app.use('/api/companies', companiesRouter)
app.use('/api/contacts', contactsRouter)
app.use('/api/projects', projectsRouter)
app.use('/api/products', productsRouter)
app.use('/api/orders', ordersRouter)
app.use('/api/tickets', ticketsRouter)
app.use('/api/dashboard', dashboardRouter)
app.use('/api/admin', adminRouter)
app.use('/api/interactions', interactionsRouter)
app.use('/api/calls', callsRouter)
app.use('/api/connectors', connectorsRouter)
app.use('/api/purchases', purchasesRouter)
app.use('/api/serials', serialsRouter)
app.use('/api/views', viewsRouter)
app.use('/api/projets', projetsRouter)
app.use('/api/catalog', catalogRouter)
app.use('/api/documents', documentsRouter)
app.use('/api/search', searchRouter)
app.use('/api/shipments', shipmentsRouter)
// app.use('/api/base', baseRouter) // Dynamic tables — disabled
app.use('/api/automations', automationsRouter)
app.use('/api/tasks', tasksRouter)
app.use('/api/agent', agentRouter)
app.use('/api/depenses', depensesRouter)
app.use('/api/factures-fournisseurs', facturesFournisseursRouter)
app.use('/api/sale-receipts', saleReceiptsRouter)
app.use('/api/stripe-queue', stripeQueueRouter)
app.use('/api/employees', employeesRouter)
app.use('/api/receipt-files', express.static(path.join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'receipts')))
app.use('/api/novoxpress/labels', express.static(path.join(__dirname, '../../uploads/labels')))
app.use('/api/novoxpress', novoxpressRouter)
app.use('/api/track', trackRouter)
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
app.use((err, req, res, next) => {
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
    tracked('gmail', () => syncAllMailboxes()).catch(e => console.error('Gmail sync error:', e.message))
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
    purgeSyncLogs() // purge logs > 7 days
    scheduledSync('airtable', syncAirtable)
    scheduledSync('projets', syncProjets)
    scheduledSync('pieces', syncPieces)
    scheduledSync('orders', syncOrders)
    scheduledSync('achats', syncAchats)
    scheduledSync('billets', syncBillets)
    scheduledSync('serials', syncSerials)
    scheduledSync('envois', syncEnvois)
    scheduledSync('soumissions', syncSoumissions)
    scheduledSync('retours', syncRetours)
    scheduledSync('retour_items', syncRetourItems)
    scheduledSync('adresses', syncAdresses)
    scheduledSync('bom', syncBomItems)
    scheduledSync('serial_changes', syncSerialStateChanges)
    if (isStripeConfigured()) {
      tracked('stripe', () => syncStripeSubscriptions()).catch(e => console.error('Stripe sync error:', e.message))
    }
    scheduledSync('assemblages', syncAssemblages)
    scheduledSync('factures', syncFactures)
  }

  // Gmail : démarrage après 30s, puis toutes les heures
  setTimeout(scheduleGmailSync, 30_000)
  setInterval(scheduleGmailSync, 60 * 60 * 1000)

  // Airtable webhooks : enregistrement au démarrage
  setTimeout(() => initAirtableWebhooks().catch(e => console.error('Webhook init error:', e.message)), 5_000)

  // Airtable fallback : sync complet une fois par jour
  setInterval(scheduleAirtableFallback, 24 * 60 * 60 * 1000)

  // Airtable token proactive refresh — évite que le token expire entre deux webhooks
  // Refresh tout token qui expire dans les 15 prochaines minutes
  async function refreshExpiringAirtableTokens() {
    const soon = Date.now() + 15 * 60 * 1000
    const row = db.prepare(`
      SELECT id FROM connector_oauth
      WHERE connector='airtable' AND (expiry_date IS NULL OR expiry_date <= ?)
      LIMIT 1
    `).get(soon)
    if (row) {
      try {
        await getAirtableToken()
        console.log('✅ Airtable token rafraîchi proactivement')
      } catch (e) {
        console.error('⚠️ Airtable proactive refresh échoué:', e.message)
      }
    }
  }
  setTimeout(refreshExpiringAirtableTokens, 60_000)
  setInterval(refreshExpiringAirtableTokens, 10 * 60 * 1000)
})

// Kill Claude process on shutdown so pm2 restart doesn't leave orphans
process.on('SIGINT',  () => { shutdownTaskRunner(); process.exit(0) })
process.on('SIGTERM', () => { shutdownTaskRunner(); process.exit(0) })

export default app
