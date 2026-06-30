// Vérifie l'uniformisation de l'affichage des dates (backlog f56aa65e).
//
// Les helpers lib/formatDate.js ont été basculés vers un format numérique :
//   fmtDate     → YYYY-MM-DD
//   fmtDateTime → YYYY-MM-DD HH:MM
//
// Ce test prouve les deux bout-à-bout dans le navigateur :
//   1. fmtDate     : page détail d'une commande ("Créée le <date>")
//   2. fmtDateTime : tableau de bord système (/admin) ("Mis à jour <datetime>")
//
// La commande créée pour le test est hard-supprimée dans after() (DB prod = DB test).

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const FR_MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']

// Même logique que localISODate() côté client : date locale, pas l'UTC.
function localISODate(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
}

describe('Affichage dates — fmtDate / fmtDateTime uniformisés (YYYY-MM-DD)', () => {
  let browser, ctx, page
  /** @type {string|null} */ let createdId = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)
  })

  after(async () => {
    if (createdId) {
      try {
        await page.evaluate(async (id) => {
          const tok = localStorage.getItem('erp_token')
          await fetch(`/erp/api/orders/${id}?hard=true`, { method: 'DELETE', headers: { Authorization: `Bearer ${tok}` } })
        }, createdId)
      } catch {}
    }
    await browser?.close()
  })

  test('fmtDate : "Créée le" affiche YYYY-MM-DD (pas "18 juin 2026")', async () => {
    const order = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify({ status: 'Commande vide', notes: 'e2e-datefmt' }),
      })
      return r.json()
    })
    assert.ok(order?.id, 'création commande échouée: ' + JSON.stringify(order))
    createdId = order.id

    await page.goto(`${URL}/orders/${order.id}`, { waitUntil: 'networkidle' })

    // La fiche affiche "Créée le {fmtDate(order.created_at)}".
    const locator = page.locator('text=/Créée le/').first()
    await locator.waitFor({ state: 'visible', timeout: 10000 })
    const txt = (await locator.textContent()).trim()

    const m = txt.match(/Créée le\s+(\d{4}-\d{2}-\d{2})\b/)
    assert.ok(m, `format attendu YYYY-MM-DD, obtenu: "${txt}"`)
    // La commande vient d'être créée → date du jour (heure locale).
    assert.equal(m[1], localISODate(), `date du jour attendue, obtenu "${m[1]}"`)
    // Aucun nom de mois français résiduel (ancien format "18 juin 2026").
    for (const month of FR_MONTHS) {
      assert.ok(!txt.toLowerCase().includes(month), `nom de mois résiduel ("${month}") dans: "${txt}"`)
    }
  })

  test('fmtDateTime : "Mis à jour" affiche YYYY-MM-DD HH:MM', async () => {
    await page.goto(`${URL}/admin`, { waitUntil: 'networkidle' })

    const locator = page.locator('text=/Mis à jour/').first()
    await locator.waitFor({ state: 'visible', timeout: 15000 })
    const txt = (await locator.textContent()).trim()

    const m = txt.match(/Mis à jour\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\b/)
    assert.ok(m, `format attendu "YYYY-MM-DD HH:MM", obtenu: "${txt}"`)
    assert.equal(m[1], localISODate(), `date du jour attendue, obtenu "${m[1]}"`)
    for (const month of FR_MONTHS) {
      assert.ok(!txt.toLowerCase().includes(month), `nom de mois résiduel ("${month}") dans: "${txt}"`)
    }
  })
})
