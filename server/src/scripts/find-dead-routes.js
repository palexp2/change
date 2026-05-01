#!/usr/bin/env node
// Liste les routes serveur qui ne sont référencées nulle part dans client/src/
// et qui ne sont pas des endpoints "externes connus" (webhooks, OAuth, pixels…).
//
// Usage : node server/src/scripts/find-dead-routes.js
//
// Méthode :
//   1. Énumération statique des routes depuis server/src/routes/*.js
//   2. Pour chaque route, construction d'une regex tolérante aux template
//      literals JS (`${id}` remplace `:param`).
//   3. Grep récursif dans client/src/.
//   4. Les routes "externes" (appelées par Stripe, Airtable, FTP, email pixel,
//      OAuth callbacks, agent subprocess) sont marquées comme vivantes par
//      construction et listées séparément.
//
// Le script n'écrit rien : il imprime un rapport. À l'utilisateur d'arbitrer
// la suppression — faux positifs possibles pour des routes appelées via
// <a href> en dur, window.open(), ou iframe depuis un autre sous-process.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const ROUTES_DIR = join(REPO_ROOT, 'server', 'src', 'routes')
const CLIENT_DIR = join(REPO_ROOT, 'client', 'src')

// Routes appelées hors client (webhooks, callbacks, pixels, agent interne).
// Même clé que le test d'auth, pour rester cohérent.
const EXTERNAL_ROUTES = new Set([
  'POST /api/auth/login',
  'POST /api/auth/setup',
  'POST /api/stripe-webhooks/',
  'POST /api/stripe-webhooks/:legacy',
  'POST /api/connectors/airtable/webhook-ping',
  'GET /api/connectors/google/callback',
  'GET /api/connectors/airtable/callback',
  'GET /api/connectors/quickbooks/callback',
  'POST /api/calls/ftp-ingest',
  'POST /api/agent/tasks/internal',
  'GET /api/track/email/:emailId.gif',
  'GET /api/public/installation-feedback/',
  // Admin routes appelées via curl/scripts d'ops (pas depuis le client UI)
  'POST /api/admin/factures/backfill-paid-at',
  'POST /api/admin/factures/:id/clear-deferred-revenue',
  'GET /api/admin/stripe-backfill/preview',
  'POST /api/admin/stripe-backfill/process',
  // Pixel de tracking dans les emails (variante de /api/track/email)
  'GET /api/email-tracking/:emailId.gif',
  // Page de paiement client (lien permanent partagé hors-app)
  'GET /erp/pay/:pendingId',
  // Pending invoice consulté côté FactureDetail via api.factures.get
  'GET /api/stripe-invoices/pending/:pendingId',
])

// Même table que _auth-audit.test.js — garder synchro.
const MOUNTS = {
  'achats-fournisseurs.js':     '/api/achats-fournisseurs',
  'activity-codes.js':          '/api/activity-codes',
  'admin.js':                   '/api/admin',
  'agent.js':                   '/api/agent',
  'auth.js':                    '/api/auth',
  'automations.js':             '/api/automations',
  'custom-fields.js':           '/api/custom-fields',
  'customer-pay.js':            '/erp/pay',
  'customer-post-payment.js':   '/api/customer/post-payment',
  'email-tracking.js':          '/api/email-tracking',
  'payments.js':                '/api/payments',
  'stripe-invoice-items.js':    '/api/stripe-invoice-items',
  'stripe-invoices.js':         '/api/stripe-invoices',
  'undo.js':                    '/api/undo',
  'calls.js':                   '/api/calls',
  'catalog.js':                 '/api/catalog',
  'companies.js':               '/api/companies',
  'connectors.js':              '/api/connectors',
  'contacts.js':                '/api/contacts',
  'dashboard.js':               '/api/dashboard',
  'documents.js':               '/api/documents',
  'employees.js':               '/api/employees',
  'hour-bank.js':               '/api/hour-bank',
  'installation-feedback.js':   '/api/public/installation-feedback',
  'interactions.js':            '/api/interactions',
  'journal-entries.js':         '/api/journal-entries',
  'novoxpress.js':              '/api/novoxpress',
  'orders.js':                  '/api/orders',
  'paies.js':                   '/api/paies',
  'products.js':                '/api/products',
  'projects.js':                '/api/projects',
  'projets.js':                 '/api/projets',
  'purchases.js':               '/api/purchases',
  'sale-receipts.js':           '/api/sale-receipts',
  'search.js':                  '/api/search',
  'serials.js':                 '/api/serials',
  'shipments.js':               '/api/shipments',
  'stock-movements.js':         '/api/stock-movements',
  'stripe-payouts.js':          '/api/stripe-payouts',
  'stripe-queue.js':            '/api/stripe-queue',
  'stripe-webhooks.js':         '/api/stripe-webhooks',
  'tasks.js':                   '/api/tasks',
  'tickets.js':                 '/api/tickets',
  'timesheets.js':              '/api/timesheets',
  'track.js':                   '/api/track',
  'vacations.js':               '/api/vacations',
  'views.js':                   '/api/views',
}

function parseRoutes(content) {
  const lines = content.split('\n')
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*router\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/)
    if (m) out.push({ method: m[1].toUpperCase(), path: m[2], line: i + 1 })
  }
  return out
}

function normalizeKey(method, mount, path) {
  return `${method} ${(mount + path).replace(/\/+/g, '/')}`
}

// Construit les regex qui matchent le chemin côté client.
//
// Formes acceptées dans le code client (strings / template literals) :
//   · '/orders/${id}'             (via api.js, BASE='/erp/api' ajouté au runtime)
//   · '/erp/api/calls/upload'     (fetch direct — littéral complet)
//   · `${BASE}/foo/${id}/bar`     (fetch direct via BASE interpolé)
//   · '/connectors/sync/${module}'  (dispatch dynamique : accepte n'importe
//     quel sibling ayant le même préfixe)
//
// Les params :param déclarés côté serveur acceptent un littéral OU ${expr}.
// Trailing '/' optionnelle côté client.
function buildClientRegexes(serverPath) {
  const withoutApi = serverPath.startsWith('/api') ? serverPath.slice(4) : serverPath
  const stripped = withoutApi.replace(/\/+$/, '')
  if (stripped === '') return []

  const escapeSeg = (seg) => {
    if (seg === '') return ''
    if (seg.startsWith(':')) return `(?:[^/'"\`\\s]+|\\$\\{[^}]+\\})`
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  const segments = stripped.split('/').map(escapeSeg)
  const withApiSegments = ('/erp/api' + stripped).split('/').map(escapeSeg)
  const right = "/?(?=[?'\"`\\s${}]|$)"

  const regexes = [
    // 1. '/path/...'  (via api.js helper)
    new RegExp("['\"`]" + segments.join('/') + right),
    // 2. '/erp/api/path/...'  (fetch direct avec URL littérale complète)
    new RegExp("['\"`]" + withApiSegments.join('/') + right),
    // 3. `${BASE}/path/...`  (fetch direct avec BASE interpolé)
    new RegExp("\\$\\{BASE\\}" + segments.join('/') + right),
  ]

  // 4. Sibling dynamique : si le client fait `post('/prefix/${module}')`,
  //    on considère toutes les routes `/prefix/<n'importe quoi>` reachables.
  //    On génère le regex du parent + /${...}.
  const parent = stripped.replace(/\/[^/]+$/, '')
  if (parent && parent !== stripped) {
    const parentSegs = parent.split('/').map(escapeSeg)
    regexes.push(new RegExp("['\"`]" + parentSegs.join('/') + "/\\$\\{[^}]+\\}"))
  }

  return regexes
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.vite') continue
      walk(full, out)
    } else if (/\.(jsx?|tsx?)$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

function main() {
  // 1. Énumérer les routes
  const allRoutes = []
  const files = readdirSync(ROUTES_DIR).filter(f => f.endsWith('.js') && !f.endsWith('.test.js'))
  for (const file of files) {
    const mount = MOUNTS[file]
    if (!mount) {
      console.warn(`⚠ pas de mount path pour ${file} — mettre à jour MOUNTS`)
      continue
    }
    const content = readFileSync(join(ROUTES_DIR, file), 'utf8')
    for (const r of parseRoutes(content)) {
      allRoutes.push({
        key: normalizeKey(r.method, mount, r.path),
        method: r.method,
        fullPath: (mount + r.path).replace(/\/+/g, '/'),
        file,
        line: r.line,
      })
    }
  }

  // 2. Charger tout le code client en un seul blob pour limiter le coût.
  const clientFiles = walk(CLIENT_DIR)
  const clientBlob = clientFiles.map(f => readFileSync(f, 'utf8')).join('\n///FILE///\n')

  // 3. Pour chaque route, chercher une référence.
  const dead = []
  const external = []
  const live = []

  for (const r of allRoutes) {
    if (EXTERNAL_ROUTES.has(r.key)) {
      external.push(r)
      continue
    }
    const regexes = buildClientRegexes(r.fullPath)
    if (regexes.length === 0) { live.push(r); continue }
    if (regexes.some(re => re.test(clientBlob))) live.push(r)
    else dead.push(r)
  }

  // 4. Rapport.
  const hr = '─'.repeat(80)
  console.log(hr)
  console.log(`Énumération : ${allRoutes.length} routes serveur`)
  console.log(`  · référencées dans client/src/ : ${live.length}`)
  console.log(`  · externes connues (webhooks, OAuth, pixels) : ${external.length}`)
  console.log(`  · candidates mortes : ${dead.length}`)
  console.log(hr)

  if (dead.length > 0) {
    console.log('\nCANDIDATES MORTES (non trouvées dans client/src/) :')
    console.log('⚠ Faux positifs possibles : <a href> en dur, window.open(), iframe externe,')
    console.log('  appel depuis un autre PM2 process (ftp-arc, etc.).')
    console.log('  Vérifier avant de supprimer.\n')
    // Regrouper par mount pour lisibilité
    const byMount = new Map()
    for (const r of dead) {
      const mount = Object.values(MOUNTS).find(m => r.fullPath.startsWith(m + '/') || r.fullPath === m) || r.fullPath
      if (!byMount.has(mount)) byMount.set(mount, [])
      byMount.get(mount).push(r)
    }
    for (const [mount, rs] of [...byMount.entries()].sort()) {
      console.log(`  ${mount}`)
      for (const r of rs) {
        console.log(`    ${r.method.padEnd(6)} ${r.fullPath}   (${r.file}:${r.line})`)
      }
    }
    console.log()
  }
}

main()
