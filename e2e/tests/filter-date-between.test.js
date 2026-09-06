const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const TABLE = 'factures'
const PILL_LABEL = 'Toutes les factures'

async function readCount(page) {
  const txt = await page.locator('text=/\\d+\\s+lignes?/').first().textContent()
  return parseInt(txt.match(/(\d+)/)[1], 10)
}

// Le compteur de lignes part de 0 puis se met à jour quand les données chargent
// (et après chaque changement de filtre). On poll jusqu'à ce que `pred(count)`
// soit vrai pour éviter de lire une valeur transitoire.
async function waitForCount(page, pred, { timeout = 10000 } = {}) {
  const start = Date.now()
  let last = NaN
  while (Date.now() - start < timeout) {
    last = await readCount(page)
    if (pred(last)) return last
    await page.waitForTimeout(150)
  }
  return last
}

async function apiGet(page, token, path) {
  return page.evaluate(async ({ t, p }) => {
    const r = await fetch('/erp/api' + p, { headers: { Authorization: 'Bearer ' + t } })
    return r.json().catch(() => null)
  }, { t: token, p: path })
}
async function apiPut(page, token, path, body) {
  return page.evaluate(async ({ t, p, b }) => {
    const r = await fetch('/erp/api' + p, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
      body: JSON.stringify(b),
    })
    return { status: r.status, body: await r.json().catch(() => null) }
  }, { t: token, p: path, b: body })
}

// Vérifie le nouvel opérateur date « Est entre » (range) sur la page Factures,
// dont le champ "Date document" (document_date) est le cas d'usage cité (filtrer
// un trimestre sans empiler deux règles before/after) :
// 1. l'opérateur apparaît dans la liste pour un champ date,
// 2. il affiche DEUX sélecteurs de date dans la ligne de filtre,
// 3. il filtre réellement la grille (une plage large garde des lignes,
//    une plage future impossible les ramène à 0).
//
// ⚠ L'édition du panneau de filtre s'auto-sauvegarde dans la vue (pill) active
// (autosave ViewToolbar). On cible donc la pill « Toutes les factures », on
// capture ses filtres AVANT et on les RESTAURE dans after() — même si le test
// échoue — conformément à la règle CLAUDE.md (DB de test = DB de prod).
describe('Filtre date — opérateur « Est entre » (range)', () => {
  let browser, ctx, page, token
  let pillId, originalFilters

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
    token = await page.evaluate(() => localStorage.getItem('erp_token') || localStorage.getItem('token'))

    // Capture l'état AVANT de la pill ciblée pour pouvoir la restaurer.
    const views = await apiGet(page, token, `/views/${TABLE}`)
    const pill = (views?.pills || []).find(p => p.label === PILL_LABEL)
    assert.ok(pill, `pill « ${PILL_LABEL} » introuvable`)
    pillId = pill.id
    originalFilters = pill.filters

    await page.goto(URL + '/' + TABLE, { waitUntil: 'networkidle' })
    await page.waitForSelector('button:has-text("Filtrer")', { timeout: 10000 })
    // Active la vue « Toutes les factures » (baseline = toutes les lignes).
    await page.locator(`button:has-text("${PILL_LABEL}")`).first().click()
    await page.waitForTimeout(500)
  })

  after(async () => {
    // Restaure TOUJOURS les filtres d'origine de la pill, même si le test a
    // échoué — sinon la vue partagée reste polluée par les filtres de test.
    try {
      if (token && pillId && originalFilters !== undefined) {
        await apiPut(page, token, `/views/${TABLE}/pills/${pillId}`, { filters: originalFilters })
      }
    } finally {
      await browser?.close()
    }
  })

  test('« Est entre » affiche deux sélecteurs et filtre la grille', async () => {
    const total = await waitForCount(page, c => c > 0)
    assert.ok(total > 0, `pas de factures (count=${total})`)

    // Ouvre le panneau de filtre et ajoute une ligne
    await page.click('button:has-text("Filtrer")')
    await page.waitForSelector('text=Ajouter un filtre', { timeout: 3000 })
    await page.click('button:has-text("Ajouter un filtre")')
    await page.waitForTimeout(300)

    // Choisir le champ "Date document" (type date)
    const fieldBtn = page.locator('button.select').first()
    await fieldBtn.click()
    await page.waitForSelector('#field-select-portal', { timeout: 2000 })
    await page.locator('#field-select-portal button', { hasText: 'Date document' }).first().click()
    await page.waitForTimeout(300)

    // Trouver le select opérateur contenant « Est entre »
    const selects = await page.locator('select').all()
    let opSelect = null
    for (const s of selects) {
      const texts = await s.locator('option').allTextContents()
      if (texts.some(t => t.trim() === 'Est entre')) { opSelect = s; break }
    }
    assert.ok(opSelect, 'opérateur « Est entre » introuvable pour un champ date')

    await opSelect.selectOption({ label: 'Est entre' })
    await page.waitForTimeout(300)

    // Deux sélecteurs de date doivent apparaître DANS la ligne de filtre
    // (le <select> opérateur est un enfant direct du div FilterRow).
    const row = opSelect.locator('xpath=..')
    const dateInputs = row.locator('input[type="date"]')
    await page.waitForTimeout(200)
    assert.equal(await dateInputs.count(), 2, '« Est entre » doit afficher exactement deux sélecteurs de date')

    // Plage large → conserve des lignes
    await dateInputs.nth(0).fill('2000-01-01')
    await dateInputs.nth(1).fill('2100-12-31')
    const wide = await waitForCount(page, c => c > 0)
    assert.ok(wide > 0, `plage large devrait garder des lignes, reçu ${wide}`)
    assert.ok(wide <= total, `plage large (${wide}) ne devrait pas dépasser le total (${total})`)

    // Plage future impossible → 0 ligne
    await dateInputs.nth(0).fill('2099-01-01')
    await dateInputs.nth(1).fill('2099-12-31')
    const future = await waitForCount(page, c => c === 0)
    assert.equal(future, 0, `plage future 2099 devrait donner 0 ligne, reçu ${future}`)
    assert.ok(future < wide, `la plage future (${future}) doit filtrer plus que la plage large (${wide})`)
  })
})
