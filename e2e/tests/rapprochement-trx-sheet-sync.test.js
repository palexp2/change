// Rapprochement bancaire — bandeau de sync automatique du fichier TRX_Orisha.
// Lecture seule : on vérifie le bandeau, le statut de l'automation et la
// présence des anomalies — on ne déclenche PAS de sync (import réel + Slack).
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Rapprochement bancaire — sync TRX_Orisha', () => {
  let browser, ctx, page

  const apiFetch = (path, opts = {}) => page.evaluate(async ({ path, opts }) => {
    const tok = localStorage.getItem('erp_token')
    const r = await fetch(`/erp/api${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}`, ...(opts.headers || {}) },
    })
    return { status: r.status, body: await r.json().catch(() => null) }
  }, { path, opts })

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => {
    await browser?.close()
  })

  test('l\'endpoint de statut expose l\'automation et son dernier passage', async () => {
    await page.goto(URL + '/rapprochement', { waitUntil: 'domcontentloaded' })
    const r = await apiFetch('/bank/trx-sheet/status')
    assert.equal(r.status, 200)
    assert.equal(typeof r.body.active, 'boolean')
    // La sync a déjà tourné au moins une fois (activée au déploiement) : le
    // dernier passage porte un résumé et la liste d'anomalies.
    if (r.body.last_run) {
      assert.ok(r.body.last_run.executed_at, 'executed_at manquant')
      assert.ok(Array.isArray(r.body.last_run.anomalies), 'anomalies absentes du résultat')
    }
  })

  test('le bandeau TRX_Orisha s\'affiche sur /rapprochement', async () => {
    await page.goto(URL + '/rapprochement', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('h1:has-text("Rapprochement bancaire")', { timeout: 15000 })
    const banner = page.locator('[data-testid="trx-sheet-banner"]')
    await banner.waitFor({ state: 'visible', timeout: 15000 })
    const text = await banner.innerText()
    assert.match(text, /TRX_Orisha/)
    assert.match(text, /Synchroniser maintenant/)
    // Badge d'état de l'automation (active ou non, mais présent).
    assert.match(text, /sync auto aux 20 min|automation désactivée/)
  })

  test('la cadence annoncée est de 20 minutes (bandeau + fiche automation)', async () => {
    const r = await apiFetch('/automations/sys_bank_trx_sheet')
    assert.equal(r.status, 200)
    const trigger = JSON.parse(r.body.trigger_config || '{}')
    assert.match(trigger.source, /setInterval 20 min/)
    assert.match(trigger.summary, /20 minutes/)
    assert.match(r.body.description, /Toutes les 20 minutes/)
    // Le bandeau de la page dit la même chose quand l'automation est active.
    await page.goto(URL + '/rapprochement', { waitUntil: 'domcontentloaded' })
    const banner = page.locator('[data-testid="trx-sheet-banner"]')
    await banner.waitFor({ state: 'visible', timeout: 15000 })
    const status = await apiFetch('/bank/trx-sheet/status')
    if (status.body?.active) {
      assert.match(await banner.innerText(), /sync auto aux 20 min/)
    }
  })

  test('les anomalies du dernier passage se déplient avec leur explication', async () => {
    const r = await apiFetch('/bank/trx-sheet/status')
    const anomalies = r.body.last_run?.anomalies || []
    const banner = page.locator('[data-testid="trx-sheet-banner"]')
    if (!anomalies.length) {
      // Pas d'anomalie au dernier passage : le bandeau ne montre pas le compteur.
      assert.equal(await banner.locator('button:has-text("anomalie")').count(), 0)
      return
    }
    await banner.locator(`button:has-text("${anomalies.length} anomalie")`).click()
    // Chaque anomalie affichée porte son explication (préfixe « ↳ »).
    const first = banner.locator('text=↳').first()
    await first.waitFor({ state: 'visible', timeout: 5000 })
    // Le clic sur une anomalie sélectionne le compte concerné (onglet actif).
    const label = anomalies[0].account_name
    await banner.locator(`button:has-text("${label}")`).first().click()
    await page.waitForSelector(`button.bg-brand-600:has-text("${label}")`, { timeout: 5000 })
  })
})
