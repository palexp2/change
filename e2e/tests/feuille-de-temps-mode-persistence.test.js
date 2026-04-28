const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Feuille de temps — persistance du mode par utilisateur', () => {
  let browser, ctx, page
  // Dates isolées pour ne pas polluer les vraies données
  const FAR_DATE_1 = '2030-03-10'
  const FAR_DATE_2 = '2030-03-11'
  const createdIds = []

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'fr-CA' })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => {
    // Cleanup des jours créés
    await page.evaluate(async ({ ids }) => {
      const token = localStorage.getItem('erp_token')
      const h = { Authorization: `Bearer ${token}` }
      for (const id of ids) {
        try { await fetch(`/erp/api/timesheets/day/${id}`, { method: 'DELETE', headers: h }) } catch {}
      }
    }, { ids: createdIds })
    // Reset la pref à 'simple' pour ne pas polluer le compte de test
    await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      await fetch('/erp/api/timesheets/preferences', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ default_mode: 'simple' }),
      })
    })
    await browser?.close()
  })

  test('GET /preferences retourne un default_mode valide', async () => {
    const out = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/timesheets/preferences', { headers: { Authorization: `Bearer ${token}` } })
      return { status: r.status, body: await r.json() }
    })
    assert.strictEqual(out.status, 200)
    assert.ok(['simple', 'detailed'].includes(out.body.default_mode), `default_mode invalide: ${out.body.default_mode}`)
  })

  test('PATCH mode=detailed sur sa propre journée → pref passe à "detailed"', async () => {
    const out = await page.evaluate(async ({ date }) => {
      const token = localStorage.getItem('erp_token')
      const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      // S'assure que la pref est initialement 'simple'
      await fetch('/erp/api/timesheets/preferences', { method: 'PATCH', headers: h, body: JSON.stringify({ default_mode: 'simple' }) })
      // Crée le jour en mode simple
      const day = await fetch('/erp/api/timesheets/day', { method: 'POST', headers: h, body: JSON.stringify({ date, mode: 'simple' }) }).then(r => r.json())
      // Bascule en detailed via PATCH
      await fetch(`/erp/api/timesheets/day/${day.id}`, { method: 'PATCH', headers: h, body: JSON.stringify({ mode: 'detailed' }) })
      const pref = await fetch('/erp/api/timesheets/preferences', { headers: h }).then(r => r.json())
      return { dayId: day.id, pref }
    }, { date: FAR_DATE_1 })
    createdIds.push(out.dayId)
    assert.strictEqual(out.pref.default_mode, 'detailed', 'La préférence doit refléter le dernier mode choisi')
  })

  test('POST /day sans mode → utilise la pref utilisateur (detailed ici)', async () => {
    const out = await page.evaluate(async ({ date }) => {
      const token = localStorage.getItem('erp_token')
      const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      // pref = detailed suite au test précédent
      const r = await fetch('/erp/api/timesheets/day', { method: 'POST', headers: h, body: JSON.stringify({ date }) })
      return { status: r.status, body: await r.json() }
    }, { date: FAR_DATE_2 })
    createdIds.push(out.body.id)
    assert.strictEqual(out.status, 201)
    assert.strictEqual(out.body.mode, 'detailed', 'Le mode doit venir de la pref quand non fourni')
  })

  test('UI — la pref "detailed" est préchargée sur une nouvelle date (pas de journée)', async () => {
    // Force la pref à detailed
    await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      await fetch('/erp/api/timesheets/preferences', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ default_mode: 'detailed' }),
      })
    })
    // Navigue vers /feuille-de-temps — l'app charge aujourd'hui par défaut
    await page.goto(`${URL}/feuille-de-temps`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('h1:has-text("Feuille de temps")', { timeout: 10000 })
    // On s'assure que la journée du jour n'existe pas pour tester le comportement "jour non créé"
    await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const h = { Authorization: `Bearer ${token}` }
      const today = new Date().toISOString().slice(0, 10)
      const d = await fetch(`/erp/api/timesheets/day?date=${today}`, { headers: h }).then(r => r.json())
      if (d?.id) await fetch(`/erp/api/timesheets/day/${d.id}`, { method: 'DELETE', headers: h })
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('h1:has-text("Feuille de temps")', { timeout: 10000 })
    // Le bouton "Détaillé" doit être pressé (actif) même si pas de day
    const detailedPressed = await page.locator('button:has-text("Détaillé")').first().getAttribute('aria-pressed')
    assert.strictEqual(detailedPressed, 'true', 'Le mode "Détaillé" doit être actif par défaut selon la pref')
    // Le tableau du mode détaillé doit être rendu (header "Description" visible)
    await page.waitForSelector('text=/Ajouter une activité/', { timeout: 3000 })
  })

  test('UI — basculer vers "Simplifié" met à jour la pref immédiatement', async () => {
    // Déjà sur la page, pref=detailed, aucun day en base pour aujourd'hui
    await page.click('button:has-text("Simplifié")')
    // Attendre un aller-retour (patchDay → ensureDay POST + PATCH)
    await page.waitForFunction(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/timesheets/preferences', { headers: { Authorization: `Bearer ${token}` } })
      const j = await r.json()
      return j.default_mode === 'simple'
    }, null, { timeout: 5000 })

    // Cleanup : supprime le day "aujourd'hui" créé par la bascule
    await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const h = { Authorization: `Bearer ${token}` }
      const today = new Date().toISOString().slice(0, 10)
      const d = await fetch(`/erp/api/timesheets/day?date=${today}`, { headers: h }).then(r => r.json())
      if (d?.id) await fetch(`/erp/api/timesheets/day/${d.id}`, { method: 'DELETE', headers: h })
    })
  })
})
