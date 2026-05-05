const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie le rapport "Rapport RSDE mensuel" sous la zone d'édition.
// - N'affiche que les entrées dont rsde=1
// - Description = code d'activité + description, durée en heures décimales
// - Navigation par mois (chevrons)
// - Bouton "Copier" → TSV dans le presse-papiers
describe('FeuilleDeTemps — rapport RSDE mensuel', () => {
  let browser, ctx, page
  const createdCodeIds = []
  const createdDayIds = []
  let codeName = ''

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({
      viewport: { width: 1400, height: 900 },
      permissions: ['clipboard-read', 'clipboard-write'],
    })
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
    }, { codes: createdCodeIds, days: createdDayIds })
    await browser?.close()
  })

  test('affiche toutes les journées du mois (zéro inclus) et agrège les entrées RSDE par jour', async () => {
    const setup = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const codeName = `RsdeTest-${Date.now()}`
      const code = await fetch('/erp/api/activity-codes', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: codeName }),
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
      // 2 entrées RSDE le même jour : 90 + 30 = 120 min = 2,00 h
      await fetch(`/erp/api/timesheets/day/${day.id}/entries`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ activity_code_id: code.id, duration: '1:30', description: 'Prototype shaper', rsde: 1 }),
      })
      await fetch(`/erp/api/timesheets/day/${day.id}/entries`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ activity_code_id: code.id, duration: '0:30', description: 'Tests bench', rsde: 1 }),
      })
      // Entrée non-RSDE : 60 min — ne doit pas apparaître
      await fetch(`/erp/api/timesheets/day/${day.id}/entries`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ activity_code_id: code.id, duration: '1:00', description: 'Admin', rsde: 0 }),
      })
      return { codeId: code.id, dayId: day.id, codeName, today }
    })
    createdCodeIds.push(setup.codeId)
    createdDayIds.push(setup.dayId)
    codeName = setup.codeName

    await page.goto(`${URL}/feuille-de-temps`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/Total payable du jour/', { timeout: 10000 })

    const report = page.locator('[data-testid="rsde-report"]')
    await report.waitFor({ timeout: 5000 })

    const table = report.locator('[data-testid="rsde-table"]')
    await table.waitFor({ timeout: 5000 })

    // Une ligne par jour du mois courant (28 à 31 selon le mois)
    const [y, m] = setup.today.split('-').map(Number)
    const daysInMonth = new Date(y, m, 0).getDate()
    const dataRows = table.locator('tbody tr')
    assert.equal(await dataRows.count(), daysInMonth, `${daysInMonth} lignes attendues (une par jour du mois)`)

    // Ligne du jour courant : 2 entrées agrégées
    const todayRow = dataRows.nth(parseInt(setup.today.slice(8, 10), 10) - 1)
    const cells = await todayRow.locator('td').allTextContents()
    assert.equal(cells[0].trim(), setup.today, `Date attendue "${setup.today}", reçue "${cells[0]}"`)
    assert.equal(cells[1].trim(), '2,00', `Durée agrégée attendue "2,00" (1:30 + 0:30), reçue "${cells[1]}"`)
    const expectedDesc = `${setup.codeName} — Prototype shaper ; ${setup.codeName} — Tests bench`
    assert.equal(cells[2].trim(), expectedDesc, `Description agrégée attendue "${expectedDesc}", reçue "${cells[2]}"`)

    // Une ligne sans heures RSDE : durée "0,00" et description vide
    const otherDayIndex = parseInt(setup.today.slice(8, 10), 10) === 1 ? 1 : 0
    const otherRow = dataRows.nth(otherDayIndex)
    const otherCells = await otherRow.locator('td').allTextContents()
    assert.equal(otherCells[1].trim(), '0,00', `Durée pour journée sans RSDE attendue "0,00", reçue "${otherCells[1]}"`)
    assert.equal(otherCells[2].trim(), '', `Description pour journée sans RSDE doit être vide, reçue "${otherCells[2]}"`)

    // Total
    const totalCells = await table.locator('tfoot tr td').allTextContents()
    assert.equal(totalCells[1].trim(), '2,00', `Total attendu "2,00", reçu "${totalCells[1]}"`)
  })

  test('navigation : mois précédent → toujours toutes les journées, toutes à zéro', async () => {
    const report = page.locator('[data-testid="rsde-report"]')
    await report.locator('button[aria-label="Mois précédent"]').click()
    const table = report.locator('[data-testid="rsde-table"]')
    await table.waitFor({ timeout: 3000 })
    const dataRows = table.locator('tbody tr')
    const count = await dataRows.count()
    assert.ok(count >= 28 && count <= 31, `un mois précédent doit toujours afficher 28-31 lignes, reçu ${count}`)
    const totalCells = await table.locator('tfoot tr td').allTextContents()
    assert.equal(totalCells[1].trim(), '0,00', `Total mois sans RSDE attendu "0,00", reçu "${totalCells[1]}"`)
    // Retour au mois courant
    await report.locator('button[aria-label="Mois suivant"]').click()
  })

  test('bouton Copier → TSV sans en-tête, toutes les journées du mois', async () => {
    const report = page.locator('[data-testid="rsde-report"]')
    await report.locator('[data-testid="rsde-copy"]').click()
    const text = await page.evaluate(() => navigator.clipboard.readText())
    const lines = text.split('\n')
    const today = new Date().toISOString().slice(0, 10)
    const [y, m] = today.split('-').map(Number)
    const daysInMonth = new Date(y, m, 0).getDate()
    assert.equal(lines.length, daysInMonth, `doit contenir ${daysInMonth} lignes (une par jour du mois)`)
    // Aucune en-tête : la 1re ligne doit être une vraie date du mois
    assert.match(lines[0], /^\d{4}-\d{2}-01\t/, 'la 1re ligne TSV doit commencer par le 1er du mois (pas d\'en-tête)')
    // Ligne du jour courant
    const todayLine = lines.find(l => l.startsWith(today))
    assert.ok(todayLine, `une ligne pour ${today} doit exister dans le TSV`)
    const parts = todayLine.split('\t')
    assert.equal(parts.length, 3, 'la ligne TSV doit avoir 3 colonnes : date, durée, description')
    assert.equal(parts[1], '2,00', `Durée TSV pour aujourd'hui attendue "2,00", reçue "${parts[1]}"`)
    assert.equal(parts[2], `${codeName} — Prototype shaper ; ${codeName} — Tests bench`, `Description TSV agrégée`)
    // Une ligne d'un jour sans RSDE : "DATE\t0,00\t" (3 champs, le dernier vide)
    const emptyLine = lines.find(l => l !== todayLine && !l.startsWith(today))
    const emptyParts = emptyLine.split('\t')
    assert.equal(emptyParts.length, 3, 'une journée sans RSDE doit toujours avoir 3 colonnes')
    assert.equal(emptyParts[1], '0,00', `Durée d'un jour sans RSDE attendue "0,00", reçue "${emptyParts[1]}"`)
    assert.equal(emptyParts[2], '', `Description d'un jour sans RSDE doit être vide, reçue "${emptyParts[2]}"`)
  })
})
