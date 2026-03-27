import express from 'express'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'
import dotenv from 'dotenv'

import { initSchema, seedSystemFields, seedCatalogProducts, seedSellableProducts } from './db/schema.js'
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
import inventaireRouter from './routes/inventaire.js'
import catalogRouter from './routes/catalog.js'
import documentsRouter from './routes/documents.js'
import searchRouter from './routes/search.js'
import shipmentsRouter from './routes/shipments.js'
import baseRouter from './routes/base.js'
import webhooksRouter from './routes/webhooks.js'
import notificationsRouter from './routes/notifications.js'
import automationsRouter from './routes/automations.js'
import interfacesRouter from './routes/interfaces.js'
import baseInteractionsRouter from './routes/base_interactions.js'
import agentRouter from './routes/agent.js'
import { createRealtimeServer } from './services/realtime.js'
import { initScheduler } from './services/automationScheduler.js'
import { initConnectorSync } from './services/connectorSync.js'
import { syncAllMailboxes } from './services/gmail.js'
import { syncDrive } from './services/drive.js'
import { syncAirtable, syncInventaire, syncPieces, syncOrders, syncAchats, syncBillets, syncSerials, syncEnvois, syncSoumissions, syncRetours, syncRetourItems, syncAdresses, syncBomItems, syncSerialStateChanges, syncAbonnements, syncAssemblages, syncFactures } from './services/airtable.js'
import { tracked } from './services/syncState.js'
import db from './db/database.js'

dotenv.config()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 3004

app.use(cors({ origin: true, credentials: true }))
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

// Rewrite /erp/api/* → /api/* so the built frontend works without a dev proxy
app.use((req, res, next) => {
  if (req.url.startsWith('/erp/api/')) req.url = req.url.slice('/erp'.length)
  next()
})

// Serve call recordings
app.use('/api/recordings', express.static(path.join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'calls')))
// Serve product images
app.use('/api/product-images', express.static(path.join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'products')))
// Serve record attachments
app.use('/api/attachments', express.static(path.join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'attachments')))

initSchema()
seedSystemFields()
seedCatalogProducts()
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
app.use('/api/inventaire', inventaireRouter)
app.use('/api/catalog', catalogRouter)
app.use('/api/documents', documentsRouter)
app.use('/api/search', searchRouter)
app.use('/api/shipments', shipmentsRouter)
app.use('/api/base', baseRouter)
app.use('/api/webhooks', webhooksRouter)
app.use('/api/notifications', notificationsRouter)
app.use('/api/automations', automationsRouter)
app.use('/api/interfaces', interfacesRouter)
app.use('/api/base/interactions', baseInteractionsRouter)
app.use('/api/agent', agentRouter)
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
  initScheduler()
  initConnectorSync(db)

  // Cron-style sync — run every hour
  function scheduleSyncs() {
    const tenants = db.prepare('SELECT id FROM tenants').all().map(t => t.id)
    for (const tenantId of tenants) {
      tracked(tenantId, 'gmail', () => syncAllMailboxes(tenantId)).catch(e => console.error('Gmail sync error:', e.message))
      // Drive sync désactivé — intégration appels migrée vers FTP (Cube ARC)
      // tracked(tenantId, 'drive', () => syncDrive(tenantId)).catch(e => console.error('Drive sync error:', e.message))
      tracked(tenantId, 'airtable', () => syncAirtable(tenantId)).catch(e => console.error('Airtable sync error:', e.message))
      tracked(tenantId, 'inventaire', () => syncInventaire(tenantId)).catch(e => console.error('Inventaire sync error:', e.message))
      tracked(tenantId, 'pieces', () => syncPieces(tenantId)).catch(e => console.error('Pièces sync error:', e.message))
      tracked(tenantId, 'orders', () => syncOrders(tenantId)).catch(e => console.error('Orders sync error:', e.message))
      tracked(tenantId, 'achats', () => syncAchats(tenantId)).catch(e => console.error('Achats sync error:', e.message))
      tracked(tenantId, 'billets', () => syncBillets(tenantId)).catch(e => console.error('Billets sync error:', e.message))
      tracked(tenantId, 'serials', () => syncSerials(tenantId)).catch(e => console.error('Serials sync error:', e.message))
      tracked(tenantId, 'envois', () => syncEnvois(tenantId)).catch(e => console.error('Envois sync error:', e.message))
      tracked(tenantId, 'soumissions', () => syncSoumissions(tenantId)).catch(e => console.error('Soumissions sync error:', e.message))
      tracked(tenantId, 'retours', () => syncRetours(tenantId)).catch(e => console.error('Retours sync error:', e.message))
      tracked(tenantId, 'retour_items', () => syncRetourItems(tenantId)).catch(e => console.error('Retour items sync error:', e.message))
      tracked(tenantId, 'adresses', () => syncAdresses(tenantId)).catch(e => console.error('Adresses sync error:', e.message))
      tracked(tenantId, 'bom', () => syncBomItems(tenantId)).catch(e => console.error('BOM sync error:', e.message))
      tracked(tenantId, 'serial_changes', () => syncSerialStateChanges(tenantId)).catch(e => console.error('Serial changes sync error:', e.message))
      tracked(tenantId, 'abonnements', () => syncAbonnements(tenantId)).catch(e => console.error('Abonnements sync error:', e.message))
      tracked(tenantId, 'assemblages', () => syncAssemblages(tenantId)).catch(e => console.error('Assemblages sync error:', e.message))
      tracked(tenantId, 'factures', () => syncFactures(tenantId)).catch(e => console.error('Factures sync error:', e.message))
      try { rematchCalls(tenantId) } catch(e) { console.error('Rematch error:', e.message) }
    }
  }

  // Initial sync after 30s, then every hour
  setTimeout(scheduleSyncs, 30_000)
  setInterval(scheduleSyncs, 60 * 60 * 1000)
})

export default app
