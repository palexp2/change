// Vérifie que la suppression d'un utilisateur (DELETE /admin/users/:id) le
// retire réellement de la liste /admin/utilisateurs (soft delete deleted_at),
// que son email redevient réutilisable, et qu'aucun compte de test E2E
// résiduel (e2e-*@…) n'apparaît dans la page.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const ERP = process.env.ERP_URL || 'http://localhost:3004/erp'
const ADMIN_EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const ADMIN_PASS = process.env.ERP_PASS
if (!ADMIN_PASS) throw new Error('ERP_PASS env var required')

async function apiCall(token, method, path, body) {
  const res = await fetch(`${ERP}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  let json = null
  try { json = await res.json() } catch {}
  return { status: res.status, body: json }
}

async function loginToken(email, password) {
  const r = await apiCall(null, 'POST', '/auth/login', { email, password })
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`)
  return r.body.token
}

async function uiLogin(page, email, password) {
  await page.goto(ERP + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', email)
  await page.fill('input[type="password"]', password)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(/\/dashboard/, { timeout: 10000 })
}

describe('Admin utilisateurs — suppression réelle des comptes E2E', () => {
  const ts = Date.now()
  const email = `e2e-user-delete-${ts}@example.com`
  const password = 'testpassword123'

  let browser, adminToken
  const createdIds = []

  before(async () => {
    adminToken = await loginToken(ADMIN_EMAIL, ADMIN_PASS)
    browser = await chromium.launch()
  })

  after(async () => {
    if (browser) await browser.close()
    // Nettoyage : supprimer tout compte jetable créé par ce test encore présent
    for (const id of createdIds) {
      await apiCall(adminToken, 'DELETE', `/admin/users/${id}`)
    }
  })

  test('DELETE retire l\'utilisateur de la liste et libère son email', async () => {
    const created = await apiCall(adminToken, 'POST', '/admin/users', { email, name: 'E2E Delete Me', password, role: 'ops' })
    assert.equal(created.status, 201, `create failed: ${JSON.stringify(created.body)}`)
    createdIds.push(created.body.id)

    const del = await apiCall(adminToken, 'DELETE', `/admin/users/${created.body.id}`)
    assert.equal(del.status, 200, `delete failed: ${JSON.stringify(del.body)}`)

    const list = await apiCall(adminToken, 'GET', '/admin/users')
    assert.equal(list.status, 200)
    assert.ok(!list.body.some(u => u.id === created.body.id), 'l\'utilisateur supprimé ne doit plus être listé')

    // L'email doit être réutilisable malgré UNIQUE(email) (tombstone à la suppression)
    const recreated = await apiCall(adminToken, 'POST', '/admin/users', { email, name: 'E2E Delete Me 2', password, role: 'ops' })
    assert.equal(recreated.status, 201, `re-create with same email failed: ${JSON.stringify(recreated.body)}`)
    createdIds.push(recreated.body.id)

    const del2 = await apiCall(adminToken, 'DELETE', `/admin/users/${recreated.body.id}`)
    assert.equal(del2.status, 200)
  })

  test('un utilisateur supprimé ne peut plus se connecter', async () => {
    const r = await apiCall(null, 'POST', '/auth/login', { email, password })
    assert.equal(r.status, 401, 'le login d\'un compte supprimé doit échouer')
  })

  test('la page /admin/utilisateurs ne montre aucun compte e2e-*', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    const page = await ctx.newPage()
    await uiLogin(page, ADMIN_EMAIL, ADMIN_PASS)
    await page.goto(ERP + '/admin/utilisateurs', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('h2:has-text("Utilisateurs")', { timeout: 10000 })
    // Attendre le rendu des lignes (DataTable = grille de divs, pas de <table>) :
    // les vrais comptes @orisha.io doivent apparaître
    await page.waitForSelector('text=@orisha.io', { timeout: 10000 })
    const bodyText = await page.locator('main, body').first().innerText()
    assert.ok(!/e2e-/i.test(bodyText), 'aucun compte e2e-* ne doit apparaître dans la liste. Contenu: ' + bodyText.slice(0, 500))
    await ctx.close()
  })
})
