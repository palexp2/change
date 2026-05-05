// Vérifie que la vue virtuelle « Tous » a été retirée :
// - aucune table n'est sans pill (backfill schema.js)
// - le tab bar n'affiche plus d'onglet « Tous » sur les tables
// - le groupage / tri / filtres sont persistés sur la première pill auto-sélectionnée
// - la suppression de la dernière pill est refusée par l'API

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const TABLES = [
  'companies','contacts','projects','products','orders','tickets','purchases',
  'serial_numbers','interactions','shipments','abonnements','retours','factures',
  'assemblages','achats_fournisseurs','tasks','employees','paies','paie_items',
  'bom_items','company_serials',
]

async function login() {
  const r = await fetch(`${URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  })
  if (!r.ok) throw new Error(`Login failed: ${r.status}`)
  const { token } = await r.json()
  return token
}

describe('Vues — retrait de l\'onglet « Tous »', () => {
  let token, browser, ctx, page

  before(async () => {
    token = await login()
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
  })

  after(async () => { await browser?.close() })

  test('toutes les tables ont au moins une pill (backfill)', async () => {
    for (const t of TABLES) {
      const r = await fetch(`${URL}/api/views/${t}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      assert.equal(r.status, 200, `views ${t}: status=${r.status}`)
      const { pills } = await r.json()
      assert.ok(Array.isArray(pills) && pills.length > 0,
        `table "${t}" doit avoir au moins une pill (got ${pills?.length})`)
    }
  })

  test('API refuse de supprimer la dernière pill', async () => {
    // Trouver une table avec exactement 1 pill (parmi celles backfillées)
    const r = await fetch(`${URL}/api/views/serial_numbers`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const { pills } = await r.json()
    assert.equal(pills.length, 1, 'serial_numbers doit avoir exactement 1 pill pour ce test')
    const pillId = pills[0].id

    const del = await fetch(`${URL}/api/views/serial_numbers/pills/${pillId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(del.status, 400, 'la suppression de la dernière pill doit être refusée')
    const body = await del.json()
    assert.match(body.error, /derni/i, `message d'erreur attendu (got "${body.error}")`)
  })

  test('UI Abonnements : pas d\'onglet « Tous les abonnements », première pill active', async () => {
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    await page.goto(`${URL}/abonnements`, { waitUntil: 'networkidle' })
    await page.waitForSelector('text=/\\d+\\s+lignes?/', { timeout: 10000 })

    // L'onglet « Tous les abonnements » ne doit plus exister
    const tousTab = await page.locator('button', { hasText: /^Tous les abonnements$/ }).count()
    assert.equal(tousTab, 0, 'l\'onglet « Tous les abonnements » doit avoir été retiré')

    // Au moins une pill doit être active (visible et highlighted)
    const activeTab = page.locator('button.text-brand-600').first()
    await activeTab.waitFor({ state: 'visible', timeout: 5000 })
    const label = await activeTab.textContent()
    assert.ok(label && label.length > 0, 'une pill doit être active')
  })

  test('UI Abonnements : groupage par mois persiste sur la pill active', async () => {
    // Login + go to abonnements
    await page.goto(`${URL}/abonnements`, { waitUntil: 'networkidle' })
    await page.waitForSelector('text=/\\d+\\s+lignes?/', { timeout: 10000 })

    // Récupérer l'id de la pill active via le state du localStorage ou l'API
    const pillBefore = await page.evaluate(async () => {
      const lastView = localStorage.getItem('erp_lastView_abonnements')
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/views/abonnements', { headers: { Authorization: `Bearer ${token}` } })
      const { pills } = await r.json()
      const active = pills.find(p => p.id === lastView) || pills[0]
      return { id: active.id, group_by: active.group_by }
    })

    // Cliquer sur le bouton "Grouper" et choisir start_month
    await page.getByRole('button', { name: 'Grouper' }).click()
    // Le titre du panneau confirme l'ouverture
    await page.locator('text=/^Grouper par$/').waitFor({ state: 'visible', timeout: 5000 })
    // Cliquer sur l'entrée "Mois de début" du panneau (un seul bouton avec ce texte exact dans le panel)
    const clicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'))
      const target = btns.find(b => b.textContent?.trim() === 'Mois de début')
      if (target) { target.click(); return true }
      return false
    })
    if (!clicked) throw new Error('bouton "Mois de début" introuvable dans le panneau Grouper')
    // Attendre l'autosave (debounce 600ms)
    await page.waitForTimeout(1500)

    // Vérifier que group_by a été persisté côté serveur sur la pill active
    const pillAfter = await page.evaluate(async (id) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/views/abonnements', { headers: { Authorization: `Bearer ${token}` } })
      const { pills } = await r.json()
      return pills.find(p => p.id === id)
    }, pillBefore.id)

    assert.equal(pillAfter.group_by, 'start_month',
      `group_by attendu = "start_month" sur la pill active, got "${pillAfter.group_by}"`)

    // Cleanup : retirer le groupage
    await page.click('button:has-text("Grouper")')
    await page.waitForTimeout(300)
    const noneOption = page.locator('text=/^Aucun$/').last()
    if (await noneOption.isVisible().catch(() => false)) {
      await noneOption.click()
      await page.waitForTimeout(1200)
    }
  })
})
