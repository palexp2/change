// Serveur de paiement (pm2 « erp-pay », port 3008) : ne sert QUE les pages vues
// par les clients au moment de payer — bloc d'acceptation des pages hébergées
// et pages de paiement. Boréal occupé ou en redémarrage ne les ralentit plus
// (Charles, 2026-10-13). nginx l'interroge d'abord, Boréal (erp_backend) en
// secours. Aucune tâche de fond ici : ce process ne fait que répondre.
import express from 'express'
import helmet from 'helmet'
import { loadEnv } from './config/loadEnv.js'

loadEnv()
const { default: customerPayRouter } = await import('./routes/customer-pay.js')
const { default: pagesPublicRouter } = await import('./routes/pages-public.js')

const PORT = Number(process.env.PAY_PORT) || 3008
const app = express()
app.set('trust proxy', 1)
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false, crossOriginResourcePolicy: { policy: 'same-site' } }))
app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: true }))

app.get('/api/health', (_req, res) => res.json({ ok: true, role: 'pay', pid: process.pid }))
app.use('/erp/pay', customerPayRouter)
app.use('/erp/api/public/pages', pagesPublicRouter)

app.use((err, _req, res, _next) => {
  console.error('[erp-pay]', err.message)
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' })
})

app.listen(PORT, '127.0.0.1', () => console.log(`erp-pay en écoute sur ${PORT}`))
