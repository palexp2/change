// Dashboard comptabilité → « Projection du solde BNC » réduite à l'essentiel.
//
// La projection portait une pile d'annexes (contrôle prévu/réel, vue calendrier,
// passé réel du relevé, rentrées estimées, bandeaux d'écart et de paiements émis).
// Tout ça vit maintenant dans les pages dédiées — Rapprochement bancaire et
// Paiements émis. Ce test verrouille les deux sens : l'essentiel est là, les
// annexes ne reviennent pas.
//
// Lecture seule — aucun record créé, aucune configuration modifiée.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Comptabilité — projection du solde minimale', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
    await page.goto(URL + '/comptabilite', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="treasury-section"]', { timeout: 20000 })
  })

  after(async () => { await browser?.close() })

  test('l\'essentiel est toujours là : solde, seuil, mouvements à venir, récurrentes', async () => {
    // Saisie du solde (la seule action de la carte) et projection chiffrée.
    await page.waitForSelector('[data-testid="treasury-balance-input"]', { timeout: 20000 })
    assert.equal(await page.locator('[data-testid="treasury-balance-save"]').count(), 1)
    await page.waitForSelector('[data-testid="treasury-min-balance"]', { timeout: 20000 })
    const section = page.locator('[data-testid="treasury-section"]')
    const txt = (await section.innerText()).replace(/\s+/g, ' ')
    // Les titres de section sont rendus en majuscules par le CSS → comparaisons
    // insensibles à la casse.
    assert.match(txt, /Projection du solde BNC/i)
    assert.match(txt, /Mouvements à venir/i)
    assert.match(txt, /Solde BNC noté/i)
    // Les récurrentes restent configurables depuis la projection.
    assert.equal(await page.locator('[data-testid="treasury-recurring-toggle"]').count(), 1)
    assert.equal(await page.locator('[data-testid="recurring-add"]').count(), 1)
  })

  test('les annexes ont bien disparu de la projection', async () => {
    for (const id of [
      'treasury-history',            // carte « Contrôle prévu / réel »
      'treasury-history-toggle',
      'treasury-variance',           // bandeau d'écart de réconciliation
      'treasury-pending-payments',   // bandeau des paiements émis
      'treasury-toggle-estimates',   // rentrées estimées
      'treasury-view-list',          // bascule liste / calendrier
      'treasury-view-calendar',
      'treasury-calendar',
      'treasury-past-range',         // menu du passé réel
      'treasury-past-header',
    ]) {
      assert.equal(await page.locator(`[data-testid="${id}"]`).count(), 0, `annexe encore présente : ${id}`)
    }
    const txt = (await page.locator('[data-testid="treasury-section"]').innerText()).replace(/\s+/g, ' ')
    assert.doesNotMatch(txt, /Contrôle prévu/i)
    assert.doesNotMatch(txt, /Rentrées estimées/i)
    assert.doesNotMatch(txt, /Déjà passé au compte/i)
  })

  test('la projection reste alimentée par l\'API (rien cassé côté données)', async () => {
    const r = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const res = await fetch('/erp/api/treasury/projection', { headers: { Authorization: `Bearer ${tok}` } })
      return { status: res.status, body: await res.json().catch(() => null) }
    })
    assert.equal(r.status, 200)
    assert.ok(Array.isArray(r.body.days) && r.body.days.length > 0, 'série quotidienne manquante')
    assert.equal(typeof r.body.threshold, 'number')
  })
})
