// Vérifie que la colonne "Mois de début" est ajoutée à la table Abonnements :
// - le serveur renvoie start_month (YYYY-MM) calculé à partir de start_date
// - le header est visible dans le DataTable
// - les valeurs sont rendues comme "Mois Année" en français (ex. "Avril 2026")

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

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

describe('Abonnements — colonne Mois de début', () => {
  let token, browser, ctx, page

  before(async () => {
    token = await login()
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
  })

  after(async () => { await browser?.close() })

  test('API /api/projets/abonnements renvoie start_month au format YYYY-MM', async () => {
    const r = await fetch(`${URL}/api/projets/abonnements?limit=all`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(r.status, 200)
    const { data } = await r.json()
    assert.ok(data.length > 0, 'au moins un abonnement attendu')
    const withDate = data.filter(a => a.start_date)
    assert.ok(withDate.length > 0, 'au moins un abonnement avec start_date')
    for (const a of withDate.slice(0, 20)) {
      assert.ok(/^\d{4}-\d{2}$/.test(a.start_month || ''),
        `start_month doit être YYYY-MM (got "${a.start_month}" pour start_date=${a.start_date})`)
      assert.equal(a.start_month, a.start_date.slice(0, 7),
        'start_month doit correspondre aux 7 premiers chars de start_date')
    }
  })

  test('UI Abonnements affiche la colonne "Mois de début" avec valeurs formatées', async () => {
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    await page.goto(`${URL}/abonnements`, { waitUntil: 'networkidle' })
    await page.waitForSelector('text=/\\d+\\s+lignes?/', { timeout: 10000 })

    const header = page.locator('text=/^Mois de début$/').first()
    await header.waitFor({ state: 'visible', timeout: 5000 })

    // Au moins une cellule doit afficher un mois en français (ex. "Avril 2026")
    const monthCell = page.locator('text=/^(Janvier|Février|Mars|Avril|Mai|Juin|Juillet|Août|Septembre|Octobre|Novembre|Décembre)\\s+\\d{4}$/').first()
    await monthCell.waitFor({ state: 'visible', timeout: 5000 })
    const txt = await monthCell.textContent()
    assert.match(txt, /^[A-ZÀ-Ý][a-zà-ÿ]+\s+\d{4}$/, `cellule mois mal formatée: "${txt}"`)
  })
})
