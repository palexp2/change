// Auth coverage test.
// Parses every route file, ensures each HTTP route is either behind
// requireAuth / requireAdmin, or behind a documented "public" middleware
// (webhook signature, OAuth callback, tracking pixel, etc.).
//
// Goal: catch regressions where a developer ships a route without auth.
// New public endpoints must be added to PUBLIC_ROUTES below with a reason.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROUTES_DIR = dirname(fileURLToPath(import.meta.url))

// Routes intentionally exposed without JWT auth, each with the reason they
// can exist. Keep the matcher STRICT (exact method + exact path). Anything
// new must land here with a justification, or a reviewer will push back.
const PUBLIC_ROUTES = new Map([
  ['POST /api/auth/login',                           'login endpoint (credentials)'],
  ['POST /api/auth/setup',                           'first-run setup (guarded by existing-user count check)'],
  ['POST /api/stripe-webhooks/',                     'Stripe webhook (verifies stripe-signature, fail-closed if secret missing)'],
  ['POST /api/stripe-webhooks/:legacy',              'Stripe webhook legacy path (same signature verification)'],
  ['POST /api/connectors/airtable/webhook-ping',     'Airtable webhook ping (no payload trusted, only triggers lookup by webhook id)'],
  ['GET /api/connectors/google/callback',            'OAuth callback — browser redirect from Google, validated via code exchange'],
  ['GET /api/connectors/airtable/callback',          'OAuth callback — browser redirect from Airtable'],
  ['GET /api/connectors/quickbooks/callback',        'OAuth callback — browser redirect from Intuit'],
  ['POST /api/calls/ftp-ingest',                     'FTP ingest (requireFtpSecret — X-FTP-Secret header)'],
  ['POST /api/agent/tasks/internal',                 'Agent sub-task creation (X-Agent-Secret via timingSafeEqual)'],
  ['GET /api/track/email/:emailId.gif',              'Email open-tracking pixel (incremented counter only)'],
  ['GET /api/public/installation-feedback/',         'Public customer feedback button from install follow-up email'],
  ['GET /erp/pay/:pendingId',                        'Permanent customer payment link — redirects to a fresh Stripe Checkout Session'],
  ['GET /api/email-tracking/:emailId.gif',           'Invoice email open-tracking pixel (counter only)'],
  ['GET /api/customer/post-payment/:sessionId',      'Customer onboarding wizard — auth via Stripe Checkout Session id (validated via Stripe API)'],
  ['POST /api/customer/post-payment/:sessionId/save',     'Customer onboarding autosave (Stripe session id auth)'],
  ['POST /api/customer/post-payment/:sessionId/submit',   'Customer onboarding final submit (Stripe session id auth)'],
  ['POST /api/customer/post-payment/:sessionId/extras',   'Customer onboarding extras → new pending invoice (Stripe session id auth)'],
])

// Middleware names that count as "this route is protected". If a route's
// first-positional-arg-after-path matches one of these tokens, it's OK.
const AUTH_TOKENS = new Set(['requireAuth', 'requireAdmin'])

// Mount paths, must stay in sync with index.js. Derived from routes/ filenames
// where trivial (e.g. companies.js → /api/companies), overridden for the rest.
const MOUNTS = {
  'achats-fournisseurs.js':     '/api/achats-fournisseurs',
  'activity-codes.js':          '/api/activity-codes',
  'admin.js':                   '/api/admin',
  'agent.js':                   '/api/agent',
  'auth.js':                    '/api/auth',
  'automations.js':             '/api/automations',
  'calls.js':                   '/api/calls',
  'catalog.js':                 '/api/catalog',
  'companies.js':               '/api/companies',
  'connectors.js':              '/api/connectors',
  'contacts.js':                '/api/contacts',
  'custom-fields.js':           '/api/custom-fields',
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
  'payments.js':                '/api/payments',
  'products.js':                '/api/products',
  'projects.js':                '/api/projects',
  'projets.js':                 '/api/projets',
  'purchases.js':               '/api/purchases',
  'sale-receipts.js':           '/api/sale-receipts',
  'search.js':                  '/api/search',
  'serials.js':                 '/api/serials',
  'shipments.js':               '/api/shipments',
  'stock-movements.js':         '/api/stock-movements',
  'customer-pay.js':            '/erp/pay',
  'customer-post-payment.js':   '/api/customer/post-payment',
  'email-tracking.js':          '/api/email-tracking',
  'stripe-invoice-items.js':    '/api/stripe-invoice-items',
  'stripe-invoices.js':         '/api/stripe-invoices',
  'stripe-payouts.js':          '/api/stripe-payouts',
  'stripe-queue.js':            '/api/stripe-queue',
  'stripe-webhooks.js':         '/api/stripe-webhooks',
  'undo.js':                    '/api/undo',
  'tasks.js':                   '/api/tasks',
  'tickets.js':                 '/api/tickets',
  'timesheets.js':              '/api/timesheets',
  'track.js':                   '/api/track',
  'vacations.js':               '/api/vacations',
  'views.js':                   '/api/views',
}

// Parse one route file. Returns:
// { routes: [{ method, path, firstArg, line, protected: bool }], blanket: 'requireAuth'|'requireAdmin'|null }
function parseFile(content) {
  const lines = content.split('\n')
  let blanket = null
  const routes = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Blanket middleware applied to all routes that follow in this router.
    // e.g. `router.use(requireAuth)` or `router.use(requireAdmin)`
    const blanketMatch = line.match(/router\.use\(\s*(requireAuth|requireAdmin)\s*\)/)
    if (blanketMatch) {
      blanket = blanketMatch[1]
      continue
    }

    // Route definition: router.<method>('<path>', <firstArg>, ...)
    // firstArg is either an auth middleware or the handler itself.
    const routeMatch = line.match(/^\s*router\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]\s*,\s*([A-Za-z_][\w]*)/)
    if (routeMatch) {
      const [, method, path, firstArg] = routeMatch
      const hasAuth = AUTH_TOKENS.has(firstArg) || blanket !== null
      routes.push({
        method: method.toUpperCase(),
        path,
        firstArg,
        line: i + 1,
        protected: hasAuth,
        blanket,
      })
      continue
    }

    // Route with inline handler on the same line: `router.post('/x', (req, res) => {`
    // Treated as unprotected unless blanket applies.
    const inlineHandlerMatch = line.match(/^\s*router\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]\s*,\s*(async\s*)?\(/)
    if (inlineHandlerMatch) {
      const [, method, path] = inlineHandlerMatch
      routes.push({
        method: method.toUpperCase(),
        path,
        firstArg: '(inline)',
        line: i + 1,
        protected: blanket !== null,
        blanket,
      })
    }
  }

  return { routes, blanket }
}

function normalizeKey(method, mount, path) {
  // Mount ends without trailing slash; path starts with '/'. Concatenating
  // gives e.g. '/api/orders/:id'. For '/', the full URL is mount + '/'.
  const full = (mount + path).replace(/\/+/g, '/')
  return `${method} ${full}`
}

test('chaque route HTTP est protégée par requireAuth/requireAdmin ou dans la whitelist publique', () => {
  const files = readdirSync(ROUTES_DIR)
    .filter(f => f.endsWith('.js') && !f.endsWith('.test.js') && f !== '_auth-audit.test.js')

  const offenders = []
  const allRoutes = []

  for (const file of files) {
    const mount = MOUNTS[file]
    if (!mount) {
      offenders.push(`${file}: pas de mount path dans MOUNTS — mettre à jour le test`)
      continue
    }
    const content = readFileSync(join(ROUTES_DIR, file), 'utf8')
    const { routes } = parseFile(content)

    for (const r of routes) {
      const key = normalizeKey(r.method, mount, r.path)
      allRoutes.push(key)
      if (r.protected) continue
      if (PUBLIC_ROUTES.has(key)) continue
      offenders.push(`${file}:${r.line}  ${key}  (firstArg=${r.firstArg})`)
    }
  }

  if (offenders.length > 0) {
    const msg =
      'Routes sans auth détectées. Ajouter requireAuth/requireAdmin, ' +
      'OU si la route doit rester publique, l\'ajouter à PUBLIC_ROUTES ' +
      'dans _auth-audit.test.js avec une justification.\n\n' +
      offenders.map(o => '  • ' + o).join('\n')
    assert.fail(msg)
  }

  // Sanity: on s'attend à un nombre raisonnable de routes. Si on tombe bien
  // en dessous, c'est probablement que le parser a raté des cas.
  assert.ok(allRoutes.length >= 150, `Seulement ${allRoutes.length} routes parsées — le parser a peut-être régressé`)
})

test('chaque entrée de PUBLIC_ROUTES correspond à une route existante', () => {
  const files = readdirSync(ROUTES_DIR)
    .filter(f => f.endsWith('.js') && !f.endsWith('.test.js') && f !== '_auth-audit.test.js')

  const existing = new Set()
  for (const file of files) {
    const mount = MOUNTS[file]
    if (!mount) continue
    const content = readFileSync(join(ROUTES_DIR, file), 'utf8')
    const { routes } = parseFile(content)
    for (const r of routes) existing.add(normalizeKey(r.method, mount, r.path))
  }

  const stale = []
  for (const key of PUBLIC_ROUTES.keys()) {
    if (!existing.has(key)) stale.push(key)
  }

  if (stale.length > 0) {
    assert.fail(
      'Entrées PUBLIC_ROUTES obsolètes (route supprimée/renommée ?). ' +
      'Retirer de la whitelist :\n\n' +
      stale.map(s => '  • ' + s).join('\n')
    )
  }
})
