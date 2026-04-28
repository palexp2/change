const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie le panneau "Cumul mensuel par code" sous la zone d'édition.
// - Sélection multi-codes (chip + ×, picker pour ajouter)
// - Persistance localStorage
// - Calcul correct des totaux par mois
describe('FeuilleDeTemps — cumul mensuel par code', () => {
  let browser, ctx, page
  const createdCodeIds = []
  const createdDayIds = []
  let ajoutCodeId = null

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
    await page.evaluate(async ({ codes, days }) => {
      const token = localStorage.getItem('erp_token')
      for (const id of days) {
        await fetch(`/erp/api/timesheets/day/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {})
      }
      for (const id of codes) {
        await fetch(`/erp/api/activity-codes/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {})
      }
      localStorage.removeItem('fdt:cumul-codes')
    }, { codes: createdCodeIds, days: createdDayIds })
    await browser?.close()
  })

  test('ligne Total : avec 2 codes, somme correcte par mois et grand total', async () => {
    // Setup : 2 codes + 1 jour aujourd'hui avec 90 min sur code A et 30 min sur code B
    const setup = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const codeA = await fetch('/erp/api/activity-codes', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `CumulSumA-${Date.now()}` }),
      }).then(r => r.json())
      const codeB = await fetch('/erp/api/activity-codes', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `CumulSumB-${Date.now()}` }),
      }).then(r => r.json())
      const today = new Date().toISOString().slice(0, 10)
      const existing = await fetch(`/erp/api/timesheets/day?date=${today}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      if (existing?.id) {
        await fetch(`/erp/api/timesheets/day/${existing.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
      }
      const day = await fetch('/erp/api/timesheets/day', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: today, mode: 'detailed' }),
      }).then(r => r.json())
      await fetch(`/erp/api/timesheets/day/${day.id}/entries`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ activity_code_id: codeA.id, duration: '1:30' }),
      })
      await fetch(`/erp/api/timesheets/day/${day.id}/entries`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ activity_code_id: codeB.id, duration: '0:30' }),
      })
      // Pré-sélection des deux codes via localStorage avant d'ouvrir la page
      localStorage.setItem('fdt:cumul-codes', JSON.stringify([codeA.id, codeB.id]))
      return { codeAId: codeA.id, codeBId: codeB.id, dayId: day.id }
    })
    createdCodeIds.push(setup.codeAId, setup.codeBId)
    createdDayIds.push(setup.dayId)

    await page.goto(`${URL}/feuille-de-temps`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/Total payable du jour/', { timeout: 10000 })

    const cumul = page.locator('[data-testid="monthly-cumul"]')
    await cumul.waitFor({ timeout: 5000 })

    const totalRow = cumul.locator('[data-testid="cumul-total-row"]')
    await totalRow.waitFor({ timeout: 5000 })

    const cells = await totalRow.locator('td').allTextContents()
    const grandTotal = cells[cells.length - 1].trim()
    assert.equal(grandTotal, '2:00', `Grand total attendu "2:00" (1:30 + 0:30), reçu "${grandTotal}"`)

    const currentMonthCell = cells[cells.length - 2].trim()
    assert.equal(currentMonthCell, '2:00', `Total mois courant attendu "2:00", reçu "${currentMonthCell}"`)

    // Cleanup pour ne pas polluer le test suivant
    await page.evaluate(() => localStorage.removeItem('fdt:cumul-codes'))
  })

  test('ajout d\'un code → ligne avec total mensuel correct', async () => {
    // Setup: un code, un jour aujourd'hui avec une entrée de 90 minutes sur ce code
    const setup = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const code = await fetch('/erp/api/activity-codes', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `CumulTest-${Date.now()}` }),
      }).then(r => r.json())
      const today = new Date().toISOString().slice(0, 10)
      const existing = await fetch(`/erp/api/timesheets/day?date=${today}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      if (existing?.id) {
        await fetch(`/erp/api/timesheets/day/${existing.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
      }
      const day = await fetch('/erp/api/timesheets/day', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: today, mode: 'detailed' }),
      }).then(r => r.json())
      await fetch(`/erp/api/timesheets/day/${day.id}/entries`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ activity_code_id: code.id, duration: '1:30' }),
      })
      // Reset selection localStorage to ensure clean state
      localStorage.removeItem('fdt:cumul-codes')
      const currentMonthLabel = new Date().toLocaleDateString('fr-CA', { month: 'short', year: '2-digit' }).replace('.', '')
      return { codeId: code.id, dayId: day.id, codeName: code.name, currentMonthLabel }
    })
    createdCodeIds.push(setup.codeId)
    createdDayIds.push(setup.dayId)
    ajoutCodeId = setup.codeId

    await page.goto(`${URL}/feuille-de-temps`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/Total payable du jour/', { timeout: 10000 })

    const cumul = page.locator('[data-testid="monthly-cumul"]')
    await cumul.waitFor({ timeout: 5000 })

    // État initial : pas de code sélectionné
    await cumul.locator('text=Sélectionne un ou plusieurs codes').waitFor({ timeout: 2000 })

    // Ajouter le code via le picker
    const picker = cumul.locator('button:has-text("+ Ajouter un code")')
    await picker.click()
    const popup = page.locator('div[style*="z-index: 9999"]').last()
    await popup.locator('input[placeholder="Rechercher…"]').fill(setup.codeName)
    await popup.locator(`button:has-text("${setup.codeName}")`).click()

    // La ligne du code apparaît
    const row = cumul.locator(`[data-testid="cumul-row-${setup.codeId}"]`)
    await row.waitFor({ timeout: 5000 })

    // Le total (dernière colonne) doit être 1:30
    const cells = await row.locator('td').allTextContents()
    const total = cells[cells.length - 1].trim()
    assert.equal(total, '1:30', `Total attendu "1:30", reçu "${total}"`)

    // La cellule du mois courant doit afficher 1:30
    // (les en-têtes de mois sont thématiquement la dernière à droite avant Total)
    const monthCell = cells[cells.length - 2].trim()
    assert.equal(monthCell, '1:30', `Mois courant: attendu "1:30", reçu "${monthCell}"`)
  })

  test('persistance — la sélection survit au reload', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/Total payable du jour/', { timeout: 10000 })
    const row = page.locator(`[data-testid="cumul-row-${ajoutCodeId}"]`)
    await row.waitFor({ timeout: 5000 })
    assert.ok(await row.isVisible(), 'la ligne du code doit toujours être affichée après reload')
  })

  test('clic sur × retire le code', async () => {
    const cumul = page.locator('[data-testid="monthly-cumul"]')
    await cumul.locator(`[data-testid="cumul-remove-${ajoutCodeId}"]`).click()
    await page.waitForFunction(
      id => !document.querySelector(`[data-testid="cumul-row-${id}"]`),
      ajoutCodeId,
      { timeout: 3000 }
    )
    await cumul.locator('text=Sélectionne un ou plusieurs codes').waitFor({ timeout: 2000 })
  })
})
