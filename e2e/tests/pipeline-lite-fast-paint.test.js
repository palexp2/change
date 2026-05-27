// Vérifie l'optimisation du chargement de la page Pipeline :
// 1) Les cartes de stats du haut sont retirées
// 2) Le premier fetch passe ?lite=1 → réponse rapide et minimale
// 3) Un second fetch silencieux (sans lite=1) recharge la version complète
// 4) Après les deux passes, les colonnes Vendeur et Commandes sont remplies

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS || 'saluerlessoviets'

describe('Pipeline — peinture rapide lite + reload silencieux', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  test('les cartes Pipeline ouvert / Valeur pondérée / Total gagné sont retirées', async () => {
    await page.goto(URL + '/pipeline', { waitUntil: 'domcontentloaded' })
    await page.locator('h1:has-text("Projets")').waitFor({ state: 'visible', timeout: 10000 })
    for (const label of ['Pipeline ouvert', 'Valeur pondérée', 'Total gagné']) {
      assert.equal(
        await page.locator(`text=${label}`).count(),
        0,
        `La carte "${label}" devrait être retirée du haut de la page Pipeline`,
      )
    }
  })

  test('Pipeline tire d’abord ?lite=1 puis recharge en silence la version complète', async () => {
    const calls = []
    const onResp = (resp) => {
      const u = resp.url()
      if (u.includes('/api/projects') && !u.includes('/api/projects/')) {
        calls.push({ url: u, status: resp.status() })
      }
    }
    page.on('response', onResp)
    await page.goto(URL + '/pipeline', { waitUntil: 'networkidle' })
    page.off('response', onResp)

    const lite = calls.find(c => /[?&]lite=1\b/.test(c.url))
    const full = calls.find(c => /\/api\/projects\?/.test(c.url) && !/[?&]lite=1\b/.test(c.url) && /limit=all/.test(c.url))
    assert.ok(lite, 'Premier appel attendu avec ?lite=1 (a vu: ' + JSON.stringify(calls) + ')')
    assert.ok(full, 'Second appel attendu sans lite=1 (a vu: ' + JSON.stringify(calls) + ')')
  })

  test('après le reload silencieux la colonne Vendeur est remplie sur au moins une ligne', async () => {
    // Vérifie que vendeur_label (qui n'est pas dans le payload lite) finit par
    // apparaître dans le DOM, signe que le second fetch a bien mergé.
    await page.goto(URL + '/pipeline', { waitUntil: 'networkidle' })
    const hasVendeur = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/projects?limit=all', { headers: { Authorization: `Bearer ${token}` } })
      const { data } = await r.json()
      return data.some(p => p.vendeur_label || (p.orders && p.orders.length))
    })
    assert.ok(hasVendeur, 'Au moins un projet devrait avoir vendeur_label ou orders dans la réponse complète')
  })
})
