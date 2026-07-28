const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS || 'saluerlessoviets'

// Colonnes visibles par défaut de la pill "Payé" (fallback si absente).
const BASE_VISIBLE = ['document_number', 'company_name', 'status', 'document_date', 'amount_before_tax_cad', 'total_amount', 'balance_due']

// Régression : la colonne intégrée "Date de paiement" (payment_date) n'avait pas
// de render dans Factures.jsx → DataTable affichait la valeur ISO brute
// (2026-07-23T05:01:15.000Z) au lieu d'une date formatée YYYY-MM-DD. Ce test
// active la colonne sur la pill "Payé" (factures payées → payment_date rempli)
// et vérifie que les cellules affichent des dates formatées, jamais d'ISO brut.
describe('Factures — colonne "Date de paiement" affiche des dates formatées', () => {
  let browser, ctx, page
  let pillId, originalVisibleColumns

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    const setup = await page.evaluate(async (BASE_VISIBLE) => {
      const token = localStorage.getItem('erp_token')
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      const views = await fetch('/erp/api/views/factures', { headers }).then(r => r.json())
      const pill = views.pills.find(p => p.label === 'Payé') || views.pills[0]
      if (!pill) return { error: 'aucune pill factures' }
      const original = Array.isArray(pill.visible_columns) ? pill.visible_columns : []
      const base = original.length ? original : BASE_VISIBLE
      const next = base.includes('payment_date') ? base : [...base, 'payment_date']
      await fetch(`/erp/api/views/factures/pills/${pill.id}`, {
        method: 'PUT', headers, body: JSON.stringify({ visible_columns: next }),
      })
      return { pillId: pill.id, pillLabel: pill.label, originalVisibleColumns: original }
    }, BASE_VISIBLE)

    if (setup.error) throw new Error('Setup E2E impossible : ' + setup.error)
    pillId = setup.pillId
    originalVisibleColumns = setup.originalVisibleColumns
  })

  after(async () => {
    if (page && pillId) {
      await page.evaluate(async ({ pillId, originalVisibleColumns }) => {
        const token = localStorage.getItem('erp_token')
        const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
        await fetch(`/erp/api/views/factures/pills/${pillId}`, {
          method: 'PUT', headers: h, body: JSON.stringify({ visible_columns: originalVisibleColumns || [] }),
        }).catch(() => {})
      }, { pillId, originalVisibleColumns })
    }
    await browser?.close()
  })

  test('les cellules "Date de paiement" sont des dates YYYY-MM-DD, jamais de l\'ISO brut', async () => {
    await page.goto(URL + '/factures', { waitUntil: 'networkidle' })
    await page.waitForSelector('h1:has-text("Factures clients")', { timeout: 8000 })
    // Se placer sur la pill "Payé" (factures payées → payment_date rempli).
    await page.getByRole('button', { name: 'Payé', exact: true }).first().click()
    // Attendre le rendu des lignes.
    await page.waitForSelector('[data-row-id]', { timeout: 10000 })
    await page.waitForTimeout(500)

    const res = await page.evaluate(() => {
      // En-têtes de colonne = divs .uppercase.tracking-wide dans la ligne d'en-tête.
      const headerCells = [...document.querySelectorAll('div.uppercase.tracking-wide')]
      if (!headerCells.length) return { error: 'aucun en-tête de colonne trouvé' }
      const headers = headerCells.map(c => c.innerText.trim())
      const idxInCols = headerCells.findIndex(c => c.innerText.trim().toLowerCase().includes('date de paiement'))
      if (idxInCols < 0) return { error: 'en-tête "Date de paiement" absent', headers }

      // Décalage des cellules préfixes (poignée réordonnancement, case à cocher,
      // dépliage) : position du 1er en-tête de colonne parmi les enfants de la grille.
      const grid = headerCells[0].parentElement
      const prefix = [...grid.children].indexOf(headerCells[0])
      const cellIndex = prefix + idxInCols

      const rows = [...document.querySelectorAll('[data-row-id]')]
      const values = []
      for (const row of rows) {
        const cell = row.children[cellIndex]
        if (cell) values.push(cell.innerText.trim())
      }
      const isoRaw = values.filter(v => /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v))
      const formatted = values.filter(v => /^\d{4}-\d{2}-\d{2}$/.test(v))
      return { headers, sampleCount: values.length, isoRaw, formattedCount: formatted.length, sample: values.slice(0, 5) }
    })

    assert.ok(!res.error, res.error ? `${res.error} — en-têtes: ${JSON.stringify(res.headers)}` : '')
    assert.ok(res.sampleCount > 0, 'au moins une ligne de facture payée doit être rendue')
    assert.deepEqual(
      res.isoRaw, [],
      `aucune cellule "Date de paiement" ne doit afficher un timestamp ISO brut, reçu: ${JSON.stringify(res.isoRaw)}`,
    )
    assert.ok(
      res.formattedCount > 0,
      `au moins une cellule "Date de paiement" doit afficher une date YYYY-MM-DD (échantillon: ${JSON.stringify(res.sample)})`,
    )
  })
})
