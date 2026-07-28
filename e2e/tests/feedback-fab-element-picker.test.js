// FeedbackFab — ciblage d'élément déclenché depuis le formulaire.
//
// Signalement /factures : le clic sur la bulle « Modifier le système » ouvre
// directement le formulaire en demande générale (concernant la page courante,
// aucun élément ciblé). L'utilisateur peut ensuite, au besoin, cliquer sur
// « Cibler un élément sur la page » pour passer en mode ciblage ; l'élément
// cliqué est décrit et joint en contexte de la suggestion (il n'a plus à
// décrire OÙ, seulement QUOI changer).
//
// Vérifie :
//   1. FAB → formulaire directement (aucun bandeau, aucun chip) ; soumission →
//      contexte = route seule.
//   2. FAB → « Cibler un élément » → bandeau de ciblage ; clic sur le h1 de la
//      page → retour au formulaire avec le chip « Élément ciblé » ; le clic
//      intercepté ne déclenche PAS l'action de l'élément ; soumission → le
//      contexte du backlog contient la route + le descriptif de l'élément.
//   3. Le chip est retirable (×) et Échap pendant le ciblage revient au
//      formulaire sans chip.
//
// L'agent est forcé OFF (capturé/restauré en after()) : les suggestions créées
// sont liées à des tâches `approved` mais AUCUNE exécution n'est spawnée.
// Cleanup : tâches + suggestions supprimées via l'API, réglage restauré.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const MARKER = `E2E element picker ${Date.now()}`

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

describe('FeedbackFab — ciblage d\'élément avant le formulaire', () => {
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
    // Cleanup même en cas d'échec : toutes les suggestions du test (et leurs
    // tâches liées), puis le toggle agent restauré.
    try {
      const backlog = await api(page, 'GET', '/agent/backlog')
      for (const item of backlog.filter(i => (i.text || '').includes(MARKER))) {
        try { if (item.task_id) await api(page, 'DELETE', `/agent/tasks/${item.task_id}`) } catch {}
        try { await api(page, 'DELETE', `/agent/backlog/${item.id}`) } catch {}
      }
    } catch {}
    try { await api(page, 'PUT', '/agent/settings', { enabled: originalEnabled }) } catch {}
    await browser?.close()
  })

  test('FAB → formulaire direct (demande générale), contexte = route seule', async () => {
    await page.goto(URL + '/factures', { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="feedback-fab"]', { timeout: 15000 })

    // FAB → formulaire directement, aucun bandeau de ciblage, aucun chip.
    await page.click('[data-testid="feedback-fab"]')
    await page.waitForSelector('[data-testid="feedback-fab-text"]', { timeout: 5000 })
    assert.equal(await page.locator('[data-testid="feedback-pick-banner"]').count(), 0,
      'le FAB ne doit pas lancer le ciblage directement')
    assert.equal(await page.locator('[data-testid="feedback-element-chip"]').count(), 0,
      'aucun chip élément par défaut')
    // Le bouton « Cibler un élément » est disponible dans le formulaire.
    await page.waitForSelector('[data-testid="feedback-pick-element"]', { timeout: 3000 })

    const text = `${MARKER} — demande générale`
    await page.fill('[data-testid="feedback-fab-text"]', text)
    await page.click('[data-testid="feedback-fab-submit"]')
    await page.waitForSelector('[data-testid="feedback-approved"]', { timeout: 10000 })
    await page.click('[role="dialog"] button:has-text("Fermer")')

    const backlog = await api(page, 'GET', '/agent/backlog')
    const item = backlog.find(i => i.text === text)
    assert.ok(item, 'la suggestion doit exister côté API')
    assert.ok(item.context.includes('/factures'), 'la route doit être jointe en contexte')
    assert.ok(!item.context.includes('élément ciblé'), 'pas de descriptif élément pour une demande générale')
  })

  test('« Cibler un élément » → clic sur un élément → descriptif joint en contexte', async () => {
    // FAB → formulaire, puis lancer le ciblage depuis le formulaire.
    await page.click('[data-testid="feedback-fab"]')
    await page.waitForSelector('[data-testid="feedback-pick-element"]', { timeout: 5000 })
    await page.click('[data-testid="feedback-pick-element"]')
    await page.waitForSelector('[data-testid="feedback-pick-banner"]', { timeout: 5000 })
    assert.equal(await page.locator('[data-testid="feedback-fab-text"]').count(), 0,
      'la modale doit être masquée pendant le ciblage')

    // Cliquer sur le titre de la page → retour au formulaire avec le chip élément.
    const h1 = page.locator('h1').first()
    const h1Text = (await h1.innerText()).trim()
    // position : éviter tout chevauchement avec le bandeau fixé en haut-centre.
    await h1.click({ position: { x: 10, y: 10 } })
    await page.waitForSelector('[data-testid="feedback-element-chip"]', { timeout: 5000 })
    const chipText = await page.locator('[data-testid="feedback-element-chip"]').innerText()
    assert.ok(chipText.includes('<h1'), 'le chip doit décrire l\'élément cliqué (balise h1)')
    assert.ok(chipText.includes(h1Text.slice(0, 20)), 'le chip doit inclure le texte de l\'élément')

    // Le clic intercepté ne doit pas avoir navigué ailleurs.
    assert.ok(page.url().includes('/factures'), 'le clic de ciblage ne doit pas déclencher de navigation')

    // Soumettre → le contexte du backlog contient route + descriptif d'élément.
    const text = `${MARKER} — élément ciblé`
    await page.fill('[data-testid="feedback-fab-text"]', text)
    await page.click('[data-testid="feedback-fab-submit"]')
    await page.waitForSelector('[data-testid="feedback-approved"]', { timeout: 10000 })
    await page.click('[role="dialog"] button:has-text("Fermer")')

    const backlog = await api(page, 'GET', '/agent/backlog')
    const item = backlog.find(i => i.text === text)
    assert.ok(item, 'la suggestion doit exister côté API')
    assert.ok(item.context.includes('/factures'), 'la route doit être jointe en contexte')
    assert.ok(item.context.includes('élément ciblé par l\'utilisateur'), 'le contexte doit contenir le marqueur élément')
    assert.ok(item.context.includes('<h1'), 'le contexte doit contenir le descriptif de l\'élément cliqué')
  })

  test('chip retirable + Échap revient au formulaire', async () => {
    // FAB → formulaire → ciblage → h1, puis retirer le chip.
    await page.click('[data-testid="feedback-fab"]')
    await page.waitForSelector('[data-testid="feedback-pick-element"]', { timeout: 5000 })
    await page.click('[data-testid="feedback-pick-element"]')
    await page.waitForSelector('[data-testid="feedback-pick-banner"]', { timeout: 5000 })
    await page.locator('h1').first().click({ position: { x: 10, y: 10 } })
    await page.waitForSelector('[data-testid="feedback-element-chip"]', { timeout: 5000 })
    await page.click('[data-testid="feedback-element-remove"]')
    assert.equal(await page.locator('[data-testid="feedback-element-chip"]').count(), 0, 'le chip doit être retirable')
    // Le bouton « Cibler un élément » réapparaît dans le formulaire.
    await page.waitForSelector('[data-testid="feedback-pick-element"]', { timeout: 3000 })
    await page.click('[role="dialog"] button:has-text("Annuler")')
    await page.locator('[data-testid="feedback-fab-text"]').waitFor({ state: 'detached', timeout: 5000 })

    // Échap pendant le ciblage (lancé depuis le formulaire) → retour au formulaire.
    await page.click('[data-testid="feedback-fab"]')
    await page.waitForSelector('[data-testid="feedback-pick-element"]', { timeout: 5000 })
    await page.click('[data-testid="feedback-pick-element"]')
    await page.waitForSelector('[data-testid="feedback-pick-banner"]', { timeout: 5000 })
    await page.keyboard.press('Escape')
    await page.locator('[data-testid="feedback-pick-banner"]').waitFor({ state: 'detached', timeout: 3000 })
    await page.waitForSelector('[data-testid="feedback-fab-text"]', { timeout: 5000 })
    assert.equal(await page.locator('[data-testid="feedback-element-chip"]').count(), 0,
      'Échap pendant le ciblage revient au formulaire sans chip')
    await page.click('[role="dialog"] button:has-text("Annuler")')
  })
})
