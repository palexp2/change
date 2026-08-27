const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Une description d'entrée RSDE saisie sur plusieurs lignes ne doit pas casser
// le tableau du rapport RSDE ni le collage (TSV) : tout le texte reste dans une
// seule cellule, les sauts de ligne deviennent des espaces.
describe('FeuilleDeTemps — RSDE : description multi-lignes reste dans une seule cellule', () => {
  let browser, ctx, page
  const createdCodeIds = []
  const createdDayIds = []
  let setup = null

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
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => {
    if (page) {
      await page.evaluate(async ({ codes, days }) => {
        const token = localStorage.getItem('erp_token')
        for (const id of days) {
          await fetch(`/erp/api/timesheets/day/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {})
        }
        for (const id of codes) {
          await fetch(`/erp/api/activity-codes/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {})
        }
      }, { codes: createdCodeIds, days: createdDayIds }).catch(() => {})
    }
    await browser?.close()
  })

  test('la cellule Description ne contient aucun saut de ligne et garde tout le texte', async () => {
    setup = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const codeName = `RsdeML-${Date.now()}`
      const code = await fetch('/erp/api/activity-codes', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: codeName }),
      }).then(r => r.json())
      // On n'écrase aucune journée réelle : on cherche une date libre du mois courant.
      const now = new Date()
      const y = now.getFullYear()
      const m = now.getMonth() + 1
      const daysInMonth = new Date(y, m, 0).getDate()
      let target = null
      for (let d = daysInMonth; d >= 1; d--) {
        const date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
        const existing = await fetch(`/erp/api/timesheets/day?date=${date}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
        if (!existing?.id) { target = date; break }
      }
      if (!target) throw new Error('aucune date libre dans le mois courant pour le test')
      const day = await fetch('/erp/api/timesheets/day', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: target, mode: 'detailed' }),
      }).then(r => r.json())
      // Description saisie sur 3 lignes (le cas signalé) + une tabulation parasite
      const multiline = "Réunion d'équipe\nSuivi documents comptable\r\nSuivi\tfacture CÉGEP Lévis"
      await fetch(`/erp/api/timesheets/day/${day.id}/entries`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ activity_code_id: code.id, duration: '1:00', description: multiline, rsde: 1 }),
      })
      return { codeId: code.id, dayId: day.id, codeName, date: target, multiline }
    })
    createdCodeIds.push(setup.codeId)
    createdDayIds.push(setup.dayId)

    await page.goto(`${URL}/feuille-de-temps`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/Total payable du jour/', { timeout: 15000 })

    const table = page.locator('[data-testid="rsde-report"] [data-testid="rsde-table"]')
    await table.waitFor({ timeout: 10000 })

    const dataRows = table.locator('tbody tr')
    const todayRow = dataRows.nth(parseInt(setup.date.slice(8, 10), 10) - 1)
    // Le texte brut du noeud DOM (pas le rendu) : c'est lui qui part au presse-papiers
    // lors d'une sélection manuelle du tableau.
    const rawDesc = await todayRow.locator('td').nth(2).evaluate(el => el.textContent)

    assert.ok(!/[\n\r\t]/.test(rawDesc), `la cellule Description ne doit contenir ni saut de ligne ni tabulation, reçue ${JSON.stringify(rawDesc)}`)
    const expected = `${setup.codeName} — Réunion d'équipe Suivi documents comptable Suivi facture CÉGEP Lévis`
    assert.equal(rawDesc, expected, `Description attendue "${expected}", reçue "${rawDesc}"`)
  })

  test('le bouton Copier produit une seule ligne TSV par journée, texte complet', async () => {
    const report = page.locator('[data-testid="rsde-report"]')
    await report.locator('[data-testid="rsde-copy"]').click()
    const text = await page.evaluate(() => navigator.clipboard.readText())

    const [y, m] = setup.date.split('-').map(Number)
    const daysInMonth = new Date(y, m, 0).getDate()
    const lines = text.split('\n')
    assert.equal(lines.length, daysInMonth, `le TSV doit contenir exactement ${daysInMonth} lignes (une par jour), reçu ${lines.length} — un saut de ligne de description a créé des rangées`)

    for (const line of lines) {
      assert.equal(line.split('\t').length, 3, `chaque ligne TSV doit avoir 3 colonnes, reçue ${JSON.stringify(line)}`)
    }

    const todayLine = lines.find(l => l.startsWith(setup.date))
    assert.ok(todayLine, `une ligne pour ${setup.date} doit exister dans le TSV`)
    const parts = todayLine.split('\t')
    assert.equal(parts[2], `${setup.codeName} — Réunion d'équipe Suivi documents comptable Suivi facture CÉGEP Lévis`, `la description complète doit tenir dans la 3e colonne, reçue "${parts[2]}"`)
  })
})
