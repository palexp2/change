// Le mapping utilisateurs ERP ↔ owners HubSpot se fait désormais dans le
// tableau des utilisateurs (/admin/utilisateurs, colonne « Owner HubSpot ») et
// non plus dans la carte HubSpot de /admin/connecteurs.
//
// Le test crée un utilisateur jetable, lui assigne un owner depuis la colonne,
// vérifie l'autosave côté API, puis remet le mapping à zéro et supprime le
// compte (after) — aucun utilisateur réel n'est modifié.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const ERP = process.env.ERP_URL || 'http://localhost:3004/erp'
const ADMIN_EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
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
  await page.waitForURL(/\/dashboard/, { timeout: 15000 })
}

describe('Admin utilisateurs — colonne Owner HubSpot', () => {
  const ts = Date.now()
  const email = `e2e-hubspot-owner-${ts}@example.com`

  let browser, token, hsInfo, userId, targetOwner

  before(async () => {
    token = await loginToken(ADMIN_EMAIL, ADMIN_PASS)
    const info = await apiCall(token, 'GET', '/connectors/hubspot')
    hsInfo = info.body || {}
    browser = await chromium.launch()
  })

  after(async () => {
    if (browser) await browser.close()
    if (userId) {
      // Libérer l'owner (l'index unique le garderait sinon lié au compte
      // supprimé) puis supprimer le compte jetable.
      await apiCall(token, 'PUT', '/connectors/hubspot/mapping', { user_id: userId, hubspot_owner_id: null })
      await apiCall(token, 'DELETE', `/admin/users/${userId}`)
    }
  })

  test('la colonne permet d\'assigner un owner, avec sauvegarde automatique', async (t) => {
    if (!hsInfo.configured || hsInfo.error) {
      t.skip('connecteur HubSpot non configuré sur cet environnement')
      return
    }
    // Owner libre : ni déduit par email, ni déjà forcé manuellement pour un
    // autre utilisateur — assigner un owner déjà pris le retirerait à son
    // titulaire (unicité imposée côté serveur).
    const taken = new Set()
    for (const u of hsInfo.users || []) {
      if (u.auto_owner_id) taken.add(String(u.auto_owner_id))
      if (u.override_owner_id) taken.add(String(u.override_owner_id))
    }
    targetOwner = (hsInfo.owners || []).find(o => !taken.has(String(o.id)))
    assert.ok(targetOwner, 'il faut au moins un owner HubSpot libre pour ce test')

    const created = await apiCall(token, 'POST', '/admin/users', {
      email, name: `E2E HubSpot Owner ${ts}`, password: 'testpassword123', role: 'ops',
    })
    assert.equal(created.status, 201, `create failed: ${JSON.stringify(created.body)}`)
    userId = created.body.id

    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } })
    const page = await ctx.newPage()
    try {
      await uiLogin(page, ADMIN_EMAIL, ADMIN_PASS)
      await page.goto(ERP + '/admin/utilisateurs', { waitUntil: 'domcontentloaded' })
      await page.waitForSelector('h2:has-text("Utilisateurs")', { timeout: 15000 })

      // En-tête de colonne + résumé de couverture
      await page.waitForSelector('text=Owner HubSpot', { timeout: 15000 })
      const summary = page.locator('[data-testid="hubspot-mapping-summary"]')
      await summary.waitFor({ timeout: 10000 })
      assert.match(await summary.innerText(), /mappés/)

      // La ligne du compte jetable porte son propre sélecteur d'owner
      const select = page.locator(`[data-testid="hubspot-owner-select-${userId}"]`)
      await select.scrollIntoViewIfNeeded()
      await select.waitFor({ timeout: 10000 })
      assert.match(await select.innerText(), /—/, 'sans mapping, la cellule doit afficher un tiret')

      await select.click()
      const menu = page.locator(`[data-testid="hubspot-owner-select-${userId}-menu"]`)
      await menu.waitFor({ timeout: 5000 })
      await menu.locator('input').fill(targetOwner.name)
      await menu.locator('button', { hasText: targetOwner.name }).first().click()

      // Autosave : la valeur doit être persistée sans bouton « Enregistrer »
      let persisted = null
      for (let i = 0; i < 20; i++) {
        const r = await apiCall(token, 'GET', '/connectors/hubspot')
        persisted = (r.body?.users || []).find(u => u.id === userId)
        if (persisted?.override_owner_id === String(targetOwner.id)) break
        await new Promise(res => setTimeout(res, 500))
      }
      assert.equal(persisted?.override_owner_id, String(targetOwner.id), 'le mapping doit être sauvegardé automatiquement')

      // La cellule reflète le choix et la source « manuel »
      await page.waitForFunction(
        (id) => (document.querySelector(`[data-testid="hubspot-owner-select-${id}"]`)?.innerText || '').trim() !== '—',
        userId, { timeout: 10000 }
      )
      assert.match(await select.innerText(), new RegExp(targetOwner.name.split(' ')[0]))
      const cell = page.locator(`[data-testid="hubspot-owner-cell-${userId}"]`)
      assert.match(await cell.innerText(), /manuel/i) // le badge est en majuscules via CSS

      // Le clic dans la cellule ne doit pas avoir ouvert la modale d'édition
      assert.equal(await page.locator('text=Modifier l\'utilisateur').count(), 0)
    } finally {
      await ctx.close()
    }
  })

  test('la carte HubSpot des connecteurs renvoie vers le tableau des utilisateurs', async (t) => {
    if (!hsInfo.configured || hsInfo.error) {
      t.skip('connecteur HubSpot non configuré sur cet environnement')
      return
    }
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } })
    const page = await ctx.newPage()
    try {
      await uiLogin(page, ADMIN_EMAIL, ADMIN_PASS)
      await page.goto(ERP + '/admin/connecteurs', { waitUntil: 'domcontentloaded' })
      const card = page.locator('text=HubSpot').first()
      await card.waitFor({ timeout: 15000 })
      const link = page.locator('[data-testid="hubspot-mapping-users-link"]')
      // Le dépliage de la carte peut manquer un clic si React n'est pas encore
      // attaché — on réessaie plutôt que d'échouer sur une course de rendu.
      for (let i = 0; i < 3 && await link.count() === 0; i++) {
        await card.click()
        await page.waitForTimeout(1500)
      }
      await link.waitFor({ timeout: 10000 })
      // Le décompte dépend d'un aller-retour vers l'API HubSpot : plus lent.
      await page.locator('[data-testid="hubspot-mapping-count"]').waitFor({ timeout: 30000 })

      // Plus aucun sélecteur d'owner par utilisateur sur la page connecteurs
      assert.equal(await page.locator('[data-testid^="hubspot-owner-select-"]').count(), 0)

      await link.click()
      await page.waitForURL(/\/admin\/utilisateurs/, { timeout: 10000 })
    } finally {
      await ctx.close()
    }
  })
})
