// Harnais de tests d'intégration au niveau routes.
//
// Monte l'app Express (routers réels) sur une DB SQLite jetable créée à partir
// de schema.js — aucun accès à la prod erp.db, aucune dépendance aux connecteurs
// tiers (Stripe/QuickBooks/Airtable). Permet de tester les routes argent/compta
// (sale-receipts, payments) de bout en bout via de vraies requêtes HTTP.
//
// IMPORTANT : ./testEnv.js est importé EN PREMIER. Il pose DATABASE_PATH avant
// que db/database.js ne soit évalué (voir l'en-tête de testEnv.js). Ne pas
// réordonner cet import.
import './testEnv.js'

import express from 'express'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'node:crypto'
import { existsSync, unlinkSync } from 'node:fs'
import { JWT_SECRET } from '../config/secrets.js'
import { initSchema } from '../db/schema.js'
import db from '../db/database.js'

import saleReceiptsRouter from '../routes/sale-receipts.js'
import paymentsRouter from '../routes/payments.js'

// Routers montés par défaut. Map mountPath → router. Étendre ici au fur et à
// mesure que d'autres routes argent/compta entrent dans le harnais.
const DEFAULT_ROUTERS = {
  '/api/sale-receipts': saleReceiptsRouter,
  '/api/payments': paymentsRouter,
}

let schemaReady = false
let cleanupRegistered = false

// Nettoyage au niveau PROCESS (et non par fichier de test). Crucial sous Node 18
// où `node --test fichierA fichierB` exécute TOUS les fichiers dans le MÊME
// process : le module db/database.js (singleton) est partagé. Fermer la DB dans
// le hook after() d'un fichier casserait les fichiers suivants. On enregistre
// donc la fermeture + suppression du fichier temp une seule fois, sur 'exit'.
function registerProcessCleanup() {
  if (cleanupRegistered) return
  cleanupRegistered = true
  process.once('exit', () => {
    try { db.close() } catch {}
    const p = process.env.__TEST_DB_PATH
    if (!p) return
    for (const f of [p, `${p}-wal`, `${p}-shm`, `${p}-journal`]) {
      try { if (existsSync(f)) unlinkSync(f) } catch {}
    }
  })
}

// Crée le schéma (idempotent) sur la DB temp. Réutilisable entre fichiers de
// test du même process.
export function initTestDb() {
  registerProcessCleanup()
  if (!schemaReady) {
    initSchema()
    schemaReady = true
  }
  return db
}

export { db }

// Construit une app Express minimale reproduisant la chaîne de middlewares
// pertinente de server/src/index.js (express.json + handler d'erreur uniforme),
// sans app.listen ni les schedulers/syncs du démarrage prod.
export function buildTestApp(routers = DEFAULT_ROUTERS) {
  initTestDb()
  const app = express()
  app.use(express.json({ limit: '10mb' }))
  app.use(express.urlencoded({ extended: true }))
  for (const [mount, router] of Object.entries(routers)) {
    app.use(mount, router)
  }
  // 404 JSON pour /api/* — miroir d'index.js
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' })
    next()
  })
  // Handler d'erreur uniforme — miroir d'index.js (sans le console.error bruyant)
  app.use((err, req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' })
  })
  return app
}

// Démarre l'app sur un port éphémère (127.0.0.1:0) et renvoie { server, base }.
// `base` est l'URL racine pour les requêtes fetch.
export function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ server, base: `http://127.0.0.1:${port}` })
    })
    // unref : un hook after() déclaré au TOP LEVEL d'un fichier node:test n'est
    // jamais exécuté (il faut un describe() englobant) — le serveur n'était donc
    // jamais fermé et le fichier de test ne rendait jamais la main. C'est ce qui
    // faisait « hanger » npm test, donc le hook pre-push, indéfiniment. Un
    // serveur unref'd n'empêche plus le processus de sortir ; les requêtes en
    // cours gardent leurs propres handles actifs le temps du test.
    server.unref()
  })
}

// Forge un JWT valide signé avec le même secret que requireAuth vérifie.
export function makeToken({ id, role = 'admin', name = 'E2E Route Test' } = {}) {
  const uid = id || randomUUID()
  return { id: uid, token: jwt.sign({ id: uid, role, name }, JWT_SECRET, { algorithm: 'HS256' }) }
}

// Insère un vrai user en DB (pour les routes qui font un JOIN sur users) et
// renvoie son id + un token. Préfixe e2e-route- pour repérage si cleanup raté.
export function createTestUser({ role = 'admin', name = 'E2E Route User' } = {}) {
  const id = randomUUID()
  db.prepare('INSERT INTO users (id, email, password_hash, name, role) VALUES (?,?,?,?,?)')
    .run(id, `e2e-route-${id}@example.com`, 'x', name, role)
  return { id, token: makeToken({ id, role, name }).token }
}

// Petit client fetch authentifié. Renvoie { status, body } (body = JSON parsé,
// ou texte brut si non-JSON).
export async function apiFetch(base, token, method, path, body) {
  const headers = {}
  if (token) headers['Authorization'] = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(base + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let parsed
  try { parsed = text ? JSON.parse(text) : null } catch { parsed = text }
  return { status: res.status, body: parsed }
}

// Ferme le serveur http créé par listen(). À appeler dans le after() de chaque
// fichier de test (chaque fichier a son propre serveur). NE PAS fermer la DB
// ici — voir registerProcessCleanup() : la fermeture est gérée au niveau process
// pour ne pas casser les autres fichiers de test partageant le même singleton.
export function closeServer(server) {
  return new Promise((resolve) => {
    if (!server) return resolve()
    server.close(() => resolve())
    // fetch() (undici) garde ses sockets en keep-alive : sans fermeture forcée,
    // server.close() n'appelle jamais son callback et le fichier de test ne rend
    // jamais la main — c'est ce qui faisait « hanger » npm test (donc le hook
    // pre-push) indéfiniment.
    server.closeAllConnections?.()
  })
}

// Avertit explicitement si jamais on pointe sur autre chose qu'un fichier temp —
// garde-fou contre une régression qui ferait taper la prod erp.db.
if (!/erp-test-/.test(process.env.__TEST_DB_PATH || '')) {
  throw new Error(`[testApp] DATABASE_PATH inattendu (${process.env.__TEST_DB_PATH}) — le harnais doit cibler une DB temp. Abandon pour ne pas toucher la prod.`)
}
