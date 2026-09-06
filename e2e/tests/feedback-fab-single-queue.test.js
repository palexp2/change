// FeedbackFab — destination unique : la file de la section Travaux.
//
// Le choix « Tout de suite » / « Ma file Travaux » a été retiré (les deux
// menaient au même exécuteur). Envoyer le prompt dépose désormais TOUJOURS un
// item dans la file de la section Travaux : il part tout de suite si rien ne
// tourne, sinon il attend son tour en fin de file.
//
// Vérifie :
//   1. Le formulaire n'offre plus aucun bouton de destination.
//   2. FAB → « Cibler un élément » → clic sur le h1 → chip ; soumission →
//      confirmation « file Travaux » + lien vers /travaux.
//   3. Côté API : un prompt existe dans /travaux/prompts (space finance) avec la
//      demande, la route et le descriptif de l'élément dans son texte ; il est
//      « queued » (rien ne s'exécute, agent OFF), et rien n'est parti au backlog
//      agent.
//
// L'agent est forcé OFF (capturé/restauré en after()). Cleanup : prompt supprimé.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const MARKER = `E2E file unique ${Date.now()}`

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
}

async function api(page, method, p, body) {
  return page.evaluate(async ({ method, path, body }) => {
    const tok = localStorage.getItem('erp_token')
    const r = await fetch('/erp/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      body: body ? JSON.stringify(body) : undefined,
    })
    return r.json()
  }, { method, path: p, body })
}

describe('FeedbackFab — file Travaux comme destination unique', () => {
  let browser, ctx, page
  let originalEnabled = false

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await login(page)
    const s = await api(page, 'GET', '/agent/settings')
    originalEnabled = !!s.enabled
    await api(page, 'PUT', '/agent/settings', { enabled: false })
  })

  after(async () => {
    try {
      const { prompts } = await api(page, 'GET', '/travaux/prompts')
      for (const p of (prompts || []).filter(p => (p.prompt || '').includes(MARKER))) {
        try { await api(page, 'DELETE', `/travaux/prompts/${p.id}`) } catch {}
      }
    } catch {}
    try { await api(page, 'PUT', '/agent/settings', { enabled: originalEnabled }) } catch {}
    await browser?.close()
  })

  test('plus de choix de destination → le prompt part dans la file Travaux', async () => {
    await page.goto(URL + '/factures', { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="feedback-fab"]', { timeout: 15000 })

    // FAB → formulaire → ciblage → clic sur le h1 de la page → chip élément.
    await page.click('[data-testid="feedback-fab"]')
    await page.waitForSelector('[data-testid="feedback-pick-element"]', { timeout: 5000 })

    // Les deux boutons de destination ont disparu du formulaire.
    assert.equal(await page.locator('[data-testid="feedback-dest-now"]').count(), 0,
      'le bouton « Tout de suite » ne doit plus exister')
    assert.equal(await page.locator('[data-testid="feedback-dest-travaux"]').count(), 0,
      'le bouton « Ma file Travaux » ne doit plus exister')

    await page.click('[data-testid="feedback-pick-element"]')
    await page.waitForSelector('[data-testid="feedback-pick-banner"]', { timeout: 5000 })
    await page.locator('h1').first().click({ position: { x: 10, y: 10 } })
    await page.waitForSelector('[data-testid="feedback-element-chip"]', { timeout: 5000 })

    const text = `${MARKER} — corps de la demande, ne pas exécuter.`
    await page.fill('[data-testid="feedback-fab-text"]', text)
    await page.click('[data-testid="feedback-fab-submit"]')
    // Aucun écran de confirmation : la modale se referme dès le dépôt.
    await page.waitForSelector('[data-testid="feedback-fab-text"]', { state: 'detached', timeout: 10000 })
    assert.equal(await page.locator('[data-testid="feedback-approved"]').count(), 0,
      'l\'étape de confirmation a été retirée')

    // Côté API : le prompt est dans la file finance, queued, avec le contexte.
    const { prompts } = await api(page, 'GET', '/travaux/prompts')
    const item = (prompts || []).find(p => (p.prompt || '').includes(MARKER))
    assert.ok(item, 'le prompt doit exister dans la file Travaux')
    assert.equal(item.space, 'finance', 'file de la section Travaux (/travaux)')
    assert.equal(item.status, 'queued', 'agent OFF → l\'item reste en file, rien ne démarre')
    assert.ok(item.prompt.includes('/factures'), 'la page courante doit être dans le prompt')
    assert.ok(item.prompt.includes('élément ciblé par l\'utilisateur'), 'le marqueur élément doit être dans le prompt')
    assert.ok(item.prompt.includes('<h1'), 'le descriptif de l\'élément cliqué doit être dans le prompt')

    // Rien ne s'est lancé : la demande ne doit PAS être partie au backlog agent.
    const backlog = await api(page, 'GET', '/agent/backlog')
    assert.ok(!backlog.some(i => (i.text || '').includes(MARKER)),
      'la demande ne doit pas avoir été envoyée au backlog agent')
  })
})
