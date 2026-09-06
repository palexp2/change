// Indicateur live « modifié par un autre utilisateur » dans DataTable.
//
// Scénario : la page /orders est ouverte par l'utilisateur courant (claude).
// Un AUTRE utilisateur (un compte E2E dédié) édite une commande via l'API HTTP.
// Le DataTable, abonné au canal WS `orders:list`, reçoit `order:updated` avec
// un actorUserId différent → il doit :
//   1. surligner la cellule changée (halo vert, classe .dt-cell-flash)
//   2. afficher un badge avec le nom de l'éditeur ([data-editor-badge])
// puis estomper le tout après ~3.6s.
//
// Nettoyage (hook after, exécuté même en cas d'échec) :
//   - hard-delete de la commande jetable créée pour le test
//   - désactivation du compte éditeur E2E (réutilisé d'un run à l'autre, donc
//     pas d'accumulation : un seul row e2e-flash-editor existe en base)

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const API = URL.replace(/\/$/, '') + '/api'
const EDITOR_EMAIL = 'e2e-flash-editor@example.com'
const EDITOR_NAME = 'E2E Flash Editor'
const EDITOR_PASS = 'e2e-flash-pass-' + 'fixed9421' // stable → row réutilisé

async function apiLogin(email, password) {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!r.ok) throw new Error(`login failed for ${email}: HTTP ${r.status}`)
  return (await r.json()).token
}

async function apiReq(token, method, path, body) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body == null ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  let json
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  if (!r.ok) throw new Error(`${method} ${path} → HTTP ${r.status}: ${text}`)
  return json
}

// Crée le compte éditeur E2E s'il n'existe pas, sinon le réactive + reset son
// mot de passe. Réutilise le même row à chaque run (email stable).
async function ensureEditor(adminToken) {
  const users = await apiReq(adminToken, 'GET', '/admin/users')
  const existing = Array.isArray(users) ? users.find(u => u.email === EDITOR_EMAIL) : null
  if (existing) {
    await apiReq(adminToken, 'PUT', `/admin/users/${existing.id}`, {
      name: EDITOR_NAME, email: EDITOR_EMAIL, role: 'support', active: 1, password: EDITOR_PASS,
    })
    return existing.id
  }
  const created = await apiReq(adminToken, 'POST', '/admin/users', {
    email: EDITOR_EMAIL, name: EDITOR_NAME, password: EDITOR_PASS, role: 'support',
  })
  return created.id
}

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
}

describe('DataTable — indicateur live des modifs d\'un autre utilisateur', () => {
  let browser, ctxA, pageA
  let adminToken, editorToken, editorId
  let orderId = null, orderNumber = null

  before(async () => {
    // Tokens / compte éditeur — créés AVANT le bootstrap du navigateur pour que
    // la commande jetable et le user éditeur soient présents dans le store de A.
    adminToken = await apiLogin(EMAIL, PASS)
    editorId = await ensureEditor(adminToken)
    editorToken = await apiLogin(EDITOR_EMAIL, EDITOR_PASS)

    const order = await apiReq(adminToken, 'POST', '/orders', {
      status: 'Commande vide', notes: 'e2e-flash-' + Date.now(),
    })
    assert.ok(order?.id, 'order creation failed: ' + JSON.stringify(order))
    orderId = order.id
    orderNumber = order.order_number

    browser = await chromium.launch()
    ctxA = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    pageA = await ctxA.newPage()
    await login(pageA) // bootstrap inclut désormais l'ordre + le user éditeur
  })

  after(async () => {
    // Toujours nettoyer, même si le test a échoué.
    if (orderId) {
      try { await apiReq(adminToken, 'DELETE', `/orders/${orderId}?hard=true`) } catch {}
    }
    if (editorId) {
      // DELETE = désactivation (active=0). Le row reste, réutilisé au prochain run.
      try { await apiReq(adminToken, 'DELETE', `/admin/users/${editorId}`) } catch {}
    }
    await browser?.close()
  })

  test('édition par un autre user → halo vert + badge éditeur sur la ligne', async () => {
    await pageA.goto(URL + '/orders', { waitUntil: 'networkidle' })
    // Laisse le WS s'authentifier + s'abonner à orders:list.
    await pageA.waitForTimeout(700)

    // La vue par défaut filtre par statut (pills) → bascule sur « Toutes les
    // commandes » (filtre vide) pour que la commande jetable soit dans le jeu.
    await pageA.click('button:has-text("Toutes les commandes")')
    await pageA.waitForTimeout(400)

    // Isole la commande jetable via la recherche pour garantir qu'elle est
    // rendue (la virtualisation peut sinon la sortir de la fenêtre visible).
    await pageA.locator('input[placeholder="Rechercher..."]:visible').first().fill(String(orderNumber))
    await pageA.locator(`text="#${orderNumber}"`).first().waitFor({ state: 'visible', timeout: 8000 })

    // L'éditeur change le statut via l'API (actorUserId ≠ utilisateur courant).
    // Le statut est une colonne visible dans la vue « Toutes les commandes ».
    await apiReq(editorToken, 'PUT', `/orders/${orderId}`, { status: 'En attente' })

    // Halo vert sur la cellule changée.
    await pageA.waitForSelector('.dt-cell-flash', { state: 'visible', timeout: 4000 })

    // Badge éditeur avec le nom résolu depuis actorUserId.
    const badge = pageA.locator('[data-editor-badge]').first()
    await badge.waitFor({ state: 'visible', timeout: 4000 })
    const badgeName = await badge.getAttribute('data-editor-badge')
    assert.equal(badgeName, EDITOR_NAME, `badge devrait nommer l'éditeur, reçu: ${badgeName}`)
    assert.match(await badge.innerText(), new RegExp(EDITOR_NAME))

    // La nouvelle valeur est affichée immédiatement (overlay realtime).
    await pageA.waitForFunction(() => document.body.innerText.includes('En attente'), null, { timeout: 4000 })

    // Le halo s'estompe : après ~4s la classe a disparu (animation forwards →
    // l'élément reste mais on vérifie surtout que le flash est temporaire en
    // re-déclenchant le state cleanup). On attend que le badge disparaisse.
    await pageA.waitForSelector('[data-editor-badge]', { state: 'detached', timeout: 6000 })
  })
})
