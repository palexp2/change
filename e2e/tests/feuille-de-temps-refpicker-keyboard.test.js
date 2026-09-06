const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Feuille de temps — RefPicker (code activité) navigation clavier', () => {
  let browser, ctx, page
  const testDate = '2030-03-15'
  const created = []

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    // Setup : journée détaillée avec 1 entrée
    const dayId = await page.evaluate(async ({ date }) => {
      const token = localStorage.getItem('erp_token')
      const day = await fetch('/erp/api/timesheets/day', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, mode: 'detailed' }),
      }).then(r => r.json())
      await fetch(`/erp/api/timesheets/day/${day.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ start_time: '08:00' }),
      })
      await fetch(`/erp/api/timesheets/day/${day.id}/entries`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'Entrée test', duration_minutes: 60 }),
      })
      return day.id
    }, { date: testDate })
    created.push(dayId)
  })

  after(async () => {
    for (const id of created) {
      await page.evaluate(async ({ id }) => {
        const token = localStorage.getItem('erp_token')
        await fetch(`/erp/api/timesheets/day/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
      }, { id })
    }
    await browser?.close()
  })

  test('UI — focus + frappe ouvre le picker, filtre et permet sélection avec arrow + enter', async () => {
    await page.goto(`${URL}/feuille-de-temps`, { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="date"]', testDate)
    await page.waitForSelector('input[value="Entrée test"]', { timeout: 5000 })

    // Récupère les codes existants pour choisir un nom à filtrer
    const codes = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/activity-codes?limit=all', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      return r.data || r
    })
    if (!codes.length) {
      console.warn('Aucun code activité — test skip')
      return
    }
    // Cible le 1er code dont le nom commence par une lettre alphanumérique
    const target = codes.find(c => /^[a-zA-Z0-9]/.test(c.name))
    if (!target) { console.warn('Aucun code activité avec nom alphanumérique'); return }
    const firstChar = target.name[0].toLowerCase()

    // Ouvre la page, focus le bouton du RefPicker (4e cellule de la 1ère ligne tbody)
    // — colonnes : Début, Description, Code activité, Fin, Durée, RSDE, ×
    const row = page.locator('table tbody tr').filter({ has: page.locator('input, span') }).first()
    const codeBtn = row.locator('button[type="button"]').first() // c'est le bouton du RefPicker (le 1er bouton dans la ligne)
    await codeBtn.focus()

    // Frappe un caractère → doit ouvrir le popup et démarrer le filtrage
    await page.keyboard.type(firstChar)
    // Le popup s'affiche (input "Rechercher…" devient visible)
    const searchInput = page.locator('input[placeholder="Rechercher…"]')
    await searchInput.waitFor({ state: 'visible', timeout: 2000 })
    assert.strictEqual(await searchInput.inputValue(), firstChar, 'la frappe doit pré-remplir la recherche')

    // Vérifie que la liste filtrée contient le target
    const items = page.locator('div[style*="z-index: 9999"] button').filter({ hasText: target.name })
    assert.ok(await items.count() >= 1, `liste filtrée doit contenir "${target.name}"`)

    // ArrowDown : descend dans la liste
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowUp')
    // Enter : sélectionne l'item courant
    await page.keyboard.press('Enter')

    // Le popup se ferme
    await searchInput.waitFor({ state: 'hidden', timeout: 2000 })

    // Une activité a été assignée à l'entrée — vérifions via API
    await page.waitForTimeout(400)
    const day = await page.evaluate(async ({ date }) => {
      const token = localStorage.getItem('erp_token')
      return await fetch(`/erp/api/timesheets/day?date=${date}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
    }, { date: testDate })
    assert.ok(day.entries[0].activity_code_id, 'un activity_code_id doit être enregistré sur l’entrée')
  })

  test('UI — Escape ferme le popup sans sélectionner', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.fill('input[type="date"]', testDate)
    await page.waitForSelector('input[value="Entrée test"]', { timeout: 5000 })

    // Récupère l'état actuel
    const before = await page.evaluate(async ({ date }) => {
      const token = localStorage.getItem('erp_token')
      const day = await fetch(`/erp/api/timesheets/day?date=${date}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      return day.entries[0].activity_code_id
    }, { date: testDate })

    const row = page.locator('table tbody tr').filter({ has: page.locator('input, span') }).first()
    const codeBtn = row.locator('button[type="button"]').first()
    await codeBtn.focus()
    await page.keyboard.press('ArrowDown') // ouvre
    const searchInput = page.locator('input[placeholder="Rechercher…"]')
    await searchInput.waitFor({ state: 'visible', timeout: 2000 })
    await page.keyboard.press('Escape')
    await searchInput.waitFor({ state: 'hidden', timeout: 2000 })

    // Pas de PATCH → activity_code_id inchangé
    const after = await page.evaluate(async ({ date }) => {
      const token = localStorage.getItem('erp_token')
      const day = await fetch(`/erp/api/timesheets/day?date=${date}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      return day.entries[0].activity_code_id
    }, { date: testDate })
    assert.strictEqual(after, before, 'Escape ne doit pas changer la sélection')
  })
})
