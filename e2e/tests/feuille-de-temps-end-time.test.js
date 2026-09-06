const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Feuille de temps détaillée — saisie par heure de fin', () => {
  let browser, ctx, page
  // Date future isolée pour ne pas polluer la vraie data
  const testDate = '2030-02-10'
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

  test('UI — première entrée affiche un input heure début, les suivantes affichent l’heure début calculée', async () => {
    // Setup: jour détaillé + 2 entries de 0 minutes via API
    const dayId = await page.evaluate(async ({ date }) => {
      const token = localStorage.getItem('erp_token')
      // crée le jour
      const day = await fetch('/erp/api/timesheets/day', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, mode: 'detailed' }),
      }).then(r => r.json())
      // start_time + 1ère entrée
      await fetch(`/erp/api/timesheets/day/${day.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ start_time: '08:00' }),
      })
      await fetch(`/erp/api/timesheets/day/${day.id}/entries`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'Entrée A', duration_minutes: 90 }),
      })
      await fetch(`/erp/api/timesheets/day/${day.id}/entries`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'Entrée B', duration_minutes: 60 }),
      })
      return day.id
    }, { date: testDate })
    created.push(dayId)

    // Navigue vers la page sur la bonne date
    await page.goto(`${URL}/feuille-de-temps`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/Feuille de temps/', { timeout: 10000 })
    // Sélecteur de date — input type="date"
    await page.fill('input[type="date"]', testDate)
    // Wait for table rows (descriptions are in input[value=...], pas en text node)
    await page.waitForSelector('input[value="Entrée A"]', { timeout: 5000 })
    await page.waitForSelector('input[value="Entrée B"]', { timeout: 5000 })

    // 1ère ligne : input time éditable pour début (valeur 08:00)
    const rows = page.locator('table tbody tr').filter({ has: page.locator('input, span') })
    const firstRow = rows.first()
    const firstStart = firstRow.locator('input[inputmode="numeric"]').first()
    assert.strictEqual(await firstStart.inputValue(), '08:00', 'la 1ère ligne doit avoir un input heure de début à 08:00')

    // 2e ligne : pas d'input pour début, mais bien un span "09:30"
    const secondRow = rows.nth(1)
    const secondTimeInputs = secondRow.locator('input[inputmode="numeric"]')
    assert.strictEqual(await secondTimeInputs.count(), 1, 'la 2e ligne ne doit avoir qu’un seul input numérique (heure fin), pas heure début')
    const startCellText = await secondRow.locator('td').first().innerText()
    assert.ok(startCellText.includes('09:30'), `attendu "09:30" comme début calculé, reçu: "${startCellText}"`)
  })

  test('UI — modifier l’heure de fin met à jour duration_minutes via PATCH', async () => {
    // Édite la fin de la 1ère ligne : passe de 09:30 (90 min) à 10:00 (120 min)
    const rows = page.locator('table tbody tr').filter({ has: page.locator('input, span') })
    const firstRow = rows.first()
    const firstEndInput = firstRow.locator('input[inputmode="numeric"]').nth(1) // 0=début, 1=fin
    await firstEndInput.fill('10:00')
    await firstEndInput.blur()

    // Wait for autosave
    await page.waitForTimeout(800)

    // Vérifie côté API
    const day = await page.evaluate(async ({ date }) => {
      const token = localStorage.getItem('erp_token')
      return await fetch(`/erp/api/timesheets/day?date=${date}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
    }, { date: testDate })
    assert.strictEqual(day.entries[0].duration_minutes, 120, '1ère entrée doit faire 120 min après modification de l’heure de fin')

    // Recharge l’UI : 2e ligne devrait maintenant montrer début=10:00
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.fill('input[type="date"]', testDate)
    await page.waitForSelector('input[value="Entrée B"]', { timeout: 5000 })
    const rowsAfter = page.locator('table tbody tr').filter({ has: page.locator('input, span') })
    const secondRowAfter = rowsAfter.nth(1)
    const startCellText = await secondRowAfter.locator('td').first().innerText()
    assert.ok(startCellText.includes('10:00'), `attendu "10:00" comme nouveau début de la 2e ligne, reçu: "${startCellText}"`)
  })

  test('UI — modifier l’heure début du jour décale toutes les heures de fin', async () => {
    // Passe day.start_time de 08:00 à 09:00 → end times shift de +1h
    const rows = page.locator('table tbody tr').filter({ has: page.locator('input, span') })
    const firstRow = rows.first()
    const firstStartInput = firstRow.locator('input[inputmode="numeric"]').first()
    await firstStartInput.fill('09:00')
    await firstStartInput.blur()
    await page.waitForTimeout(800)

    const day = await page.evaluate(async ({ date }) => {
      const token = localStorage.getItem('erp_token')
      return await fetch(`/erp/api/timesheets/day?date=${date}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
    }, { date: testDate })
    assert.strictEqual(day.start_time, '09:00')
    // Les durées des entrées sont conservées (120 + 60)
    assert.strictEqual(day.entries[0].duration_minutes, 120)
    assert.strictEqual(day.entries[1].duration_minutes, 60)
  })

  test('UI — les champs heure n’ont pas de placeholder et filtrent les caractères non numériques', async () => {
    const rows = page.locator('table tbody tr').filter({ has: page.locator('input, span') })
    const firstRow = rows.first()
    const firstStart = firstRow.locator('input[inputmode="numeric"]').first()
    // Pas de placeholder
    const ph = await firstStart.getAttribute('placeholder')
    assert.ok(!ph, `attendu aucun placeholder, reçu: "${ph}"`)
    // Tape des caractères mixtes — seuls digits et ":" doivent rester
    await firstStart.fill('')
    await firstStart.type('a9b:0c0z')
    const value = await firstStart.inputValue()
    assert.strictEqual(value, '9:00', `attendu "9:00" après filtre, reçu: "${value}"`)
    // Blur normalise en "09:00"
    await firstStart.blur()
    await page.waitForTimeout(400)
    assert.strictEqual(await firstStart.inputValue(), '09:00')
  })

  test('UI — entrer une heure de fin antérieure au début est rejeté (revert)', async () => {
    const rows = page.locator('table tbody tr').filter({ has: page.locator('input, span') })
    const firstRow = rows.first()
    const firstEndInput = firstRow.locator('input[inputmode="numeric"]').nth(1)
    const before = await firstEndInput.inputValue()
    // Day start = 09:00 ; on tente une fin à 08:30
    await firstEndInput.fill('08:30')
    await firstEndInput.blur()
    await page.waitForTimeout(500)
    const after = await firstEndInput.inputValue()
    assert.strictEqual(after, before, 'l’input doit revenir à sa valeur précédente quand fin < début')
  })
})
