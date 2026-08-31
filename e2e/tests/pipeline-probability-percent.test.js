// Pipeline — la probabilité importée d'Airtable est en points de pourcentage.
//
// Le champ « Probabilité » est un champ POURCENTAGE côté Airtable : l'API renvoie
// une fraction (0.85 pour une cellule affichée « 85 % »). L'import stockait la
// fraction telle quelle, si bien que /pipeline et la fiche projet affichaient
// « 0.85 % » au lieu de « 85 % » (et le pipeline pondéré du dashboard, qui
// calcule value_cad * probability / 100, sortait 100× trop petit).
//
// Ce test vérifie, sans rien créer ni modifier :
//   1. aucun projet n'a de probabilité fractionnaire dans ]0,1[ (signature du bug) ;
//   2. des projets ont bien une probabilité en points (≥ 10) ;
//   3. la fiche projet affiche la valeur sous forme « NN% » (entier 0-100).

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
}

function apiGet(page, p) {
  return page.evaluate(async (path) => {
    const tok = localStorage.getItem('erp_token')
    const r = await fetch('/erp/api' + path, { headers: { Authorization: `Bearer ${tok}` } })
    return r.json()
  }, p)
}

describe('Pipeline — probabilité en points de pourcentage', () => {
  let browser, ctx, page
  let projects = []

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await login(page)
    const res = await apiGet(page, '/projects?limit=2000')
    projects = (res.data || res || []).filter(p => p && p.probability != null)
    assert.ok(projects.length > 20, `attendu des projets avec probabilité, reçu ${projects.length}`)
  })

  // Test en lecture seule : aucun record créé/modifié, aucune vue touchée
  // (on ne déplie ni ne replie de groupe — cela autosauvegarderait la vue partagée).
  after(async () => { await browser?.close() })

  test('aucune probabilité fractionnaire (fraction Airtable brute)', () => {
    const fractional = projects.filter(p => Number(p.probability) > 0 && Number(p.probability) < 1)
    assert.deepStrictEqual(
      fractional.slice(0, 5).map(p => `${p.name}=${p.probability}`), [],
      'des projets portent encore la fraction Airtable au lieu du pourcentage'
    )
  })

  test('probabilités dans 0-100 et exprimées en points', () => {
    for (const p of projects) {
      const v = Number(p.probability)
      assert.ok(v >= 0 && v <= 100, `${p.name}: probabilité hors bornes (${v})`)
    }
    const enPoints = projects.filter(p => Number(p.probability) >= 10)
    assert.ok(enPoints.length > 0, 'aucune probabilité ≥ 10 — l’import est probablement encore en fractions')
  })

  test('la fiche projet affiche « NN% »', async () => {
    const sample = projects.find(p => Number(p.probability) >= 10)
    await page.goto(`${URL}/projects/${sample.id}`, { waitUntil: 'domcontentloaded' })
    const dd = page.locator('dt:has-text("Probabilité")').first().locator('xpath=following-sibling::dd[1]')
    await dd.waitFor({ timeout: 15000 })
    const txt = (await dd.innerText()).trim()
    assert.match(txt, /^(100|\d{1,2})%$/, `affichage inattendu de la probabilité : "${txt}"`)
    assert.strictEqual(txt, `${sample.probability}%`)
  })

  test('/pipeline — la colonne Probabilité affiche des pourcentages entiers', async () => {
    await page.goto(URL + '/pipeline', { waitUntil: 'domcontentloaded' })
    // `state: 'attached'` — la colonne peut être hors du viewport horizontal
    // (grille virtualisée), donc rendue mais pas « visible » au sens Playwright.
    await page.waitForSelector('[data-grid-cell$="|probability"]', { state: 'attached', timeout: 60000 })
    assert.strictEqual(await page.locator('[data-testid="col-header-probability"]').count(), 1,
      'colonne Probabilité absente de la vue /pipeline')

    const cells = await page.locator('[data-grid-cell$="|probability"]').allTextContents()
    const values = cells.map(c => c.trim()).filter(Boolean)
    assert.ok(values.length >= 5, `trop peu de cellules probabilité rendues (${values.length})`)
    for (const v of values) {
      if (v === '—') continue
      assert.match(v, /^(100|\d{1,2})%$/, `cellule probabilité inattendue : "${v}"`)
    }
    // Au moins une valeur en points (≥ 10 %) : avec le bug, tout était « 0.x% ».
    assert.ok(values.some(v => /^(100|[1-9]\d)%$/.test(v)),
      `aucune probabilité ≥ 10 % affichée : ${values.slice(0, 10).join(', ')}`)
  })
})
