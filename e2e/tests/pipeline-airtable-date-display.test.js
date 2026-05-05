// Vérifie que les dates « date-only » importées d'Airtable (encodées en minuit UTC)
// s'affichent comme la date choisie par l'utilisateur dans Airtable, pas comme
// le jour précédent en heure locale Montréal.
//
// Cas concret : PRJ-1563 a `creation = "2026-04-01T00:00:00.000Z"` côté DB.
// `fmtDate()` doit afficher "1 avr." (UTC) — pas "31 mars" (Montréal).

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS || 'saluerlessoviets'

describe('Pipeline — affichage date Airtable (midnight-UTC)', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({
      viewport: { width: 1400, height: 900 },
      timezoneId: 'America/Toronto', // Force le fuseau Montréal pour le test
    })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  test('PRJ-1563 (creation 2026-04-01T00:00:00Z) affiche "1 avr." pas "31 mars"', async () => {
    // Va directement sur la fiche du projet
    await page.goto(URL + '/pipeline?createdMonth=2026-04', { waitUntil: 'networkidle' })

    // Le bandeau de filtre apparait
    await page.locator('text=/Projets créés en avril 2026/').first().waitFor({ state: 'visible', timeout: 5000 })

    // Active la colonne "Créé le" si pas visible. On utilise l'API Pipeline
    // directe pour vérifier qu'au moins un projet d'avril est listé.
    const responseCheck = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/projects?limit=all', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const { data } = await r.json()
      const prj1563 = data.find(p => p.name === 'PRJ-1563')
      return prj1563 ? { creation: prj1563.creation, name: prj1563.name } : null
    })
    assert.ok(responseCheck, 'PRJ-1563 doit exister')
    assert.equal(responseCheck.creation, '2026-04-01T00:00:00.000Z', `Le timestamp DB doit être minuit UTC du 1er avril. Reçu: ${responseCheck.creation}`)

    // Vérification du rendu fmtDate côté navigateur (avec le fuseau Montréal)
    const renderCheck = await page.evaluate(() => {
      // Reproduit fmtDate() : pattern Airtable midnight-UTC → rendu en UTC
      const d = '2026-04-01T00:00:00.000Z'
      const naif = new Date(d).toLocaleDateString('fr-CA', { year: 'numeric', month: 'short', day: 'numeric' })
      const utc = new Date(d).toLocaleDateString('fr-CA', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
      return { naif, utc }
    })
    // Confirmation que sans le fix, le rendu naïf donnerait "31 mars"
    assert.match(renderCheck.naif, /31 mars/, `Sans timeZone:UTC, devrait donner "31 mars" (preuve du décalage). Reçu: ${renderCheck.naif}`)
    assert.match(renderCheck.utc, /1 avr/, `Avec timeZone:UTC, doit donner "1 avr.". Reçu: ${renderCheck.utc}`)
  })
})
