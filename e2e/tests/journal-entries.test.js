const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Écritures de journal — vue liste standard', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
    await page.goto(URL + '/journal-entries', { waitUntil: 'networkidle' })
    await page.waitForSelector('text=Écritures de journal', { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  test('titre et sous-titre présents', async () => {
    assert.ok(await page.locator('h1:has-text("Écritures de journal")').isVisible())
    assert.ok(await page.locator('text=Écritures synchronisées avec QuickBooks').isVisible())
  })

  test('barre d\'outils standard (recherche, Champs, Filtrer, Trier, Grouper)', async () => {
    assert.ok(await page.locator('input[placeholder="Rechercher..."]').first().isVisible())
    for (const label of ['Champs', 'Filtrer', 'Trier', 'Grouper']) {
      assert.ok(await page.locator(`button:has-text("${label}")`).first().isVisible(), `bouton ${label} absent`)
    }
  })

  test('en-têtes de colonnes standards', async () => {
    for (const h of ['DATE', 'N°', 'MÉMO', 'LIGNES', 'TOTAL', 'QB']) {
      assert.ok(await page.locator(`text=${h}`).first().isVisible(), `en-tête ${h} absent`)
    }
  })

  test('compteur de lignes > 0', async () => {
    const txt = await page.locator('text=/\\d+\\s+lignes?/').first().textContent()
    const n = parseInt(txt.match(/(\d+)/)[1], 10)
    assert.ok(n > 0, `compteur de lignes: ${txt}`)
  })

  test('au moins un total formaté non nul', async () => {
    const totals = await page.locator('text=/^\\s*[0-9\\s]+,\\d{2}\\s*\\$\\s*$/').allTextContents()
    const nonZero = totals.filter(t => !/^\s*0,00\s*\$\s*$/.test(t))
    assert.ok(nonZero.length > 0, `aucun total non-zéro trouvé (trouvés: ${totals.slice(0, 5).join(' | ')})`)
  })

  test('la recherche filtre les lignes', async () => {
    const counterBefore = await page.locator('text=/\\d+\\s+lignes?/').first().textContent()
    const before = parseInt(counterBefore.match(/(\d+)/)[1], 10)

    await page.fill('input[placeholder="Rechercher..."]', 'zzzzzzzz_aucune_correspondance')
    await page.waitForTimeout(500)
    const counterAfter = await page.locator('text=/\\d+\\s+lignes?/').first().textContent()
    const after = parseInt(counterAfter.match(/(\d+)/)[1], 10)
    assert.ok(after < before, `la recherche n'a pas filtré: avant=${before} après=${after}`)

    await page.fill('input[placeholder="Rechercher..."]', '')
    await page.waitForTimeout(300)
  })

  test('le modal "Nouvelle écriture" s\'ouvre', async () => {
    await page.click('button:has-text("Nouvelle écriture")')
    await page.waitForSelector('text=Nouvelle écriture de journal', { timeout: 5000 })
    assert.ok(await page.locator('text=Nouvelle écriture de journal').isVisible())
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  })

  test('prépopulation : 3 tableaux avec colonnes Débit et Crédit', async () => {
    // Fresh reload to clear any lingering modal state from previous tests
    await page.goto(URL + '/journal-entries', { waitUntil: 'networkidle' })
    await page.waitForSelector('h1:has-text("Écritures de journal")', { timeout: 10000 })
    await page.click('button:has-text("Nouvelle écriture")')
    await page.waitForSelector('text=Nouvelle écriture de journal', { timeout: 5000 })

    await page.click('button:has-text("Prépopuler depuis les opérations ERP")')
    await page.waitForSelector('button:has-text("Analyser la période")', { timeout: 3000 })

    // Use a wide range to maximize chances of populated tables.
    // The modal has 3 date inputs: txn_date, prepFrom, prepTo.
    await page.fill('input[type="date"] >> nth=1', '2024-01-01')
    await page.fill('input[type="date"] >> nth=2', '2026-12-31')
    await page.click('button:has-text("Analyser la période")')

    // Wait for one of the three section labels (proof that prepData arrived)
    await page.waitForSelector('text=Changements d\'état des numéros de série', { timeout: 15000 })
    await page.waitForTimeout(500)

    // The three sections titles are always present once prepData is set
    for (const label of [
      'Changements d\'état des numéros de série',
      'Pièces envoyées sans numéro de série',
      'Mouvements d\'inventaire',
    ]) {
      assert.ok(await page.locator(`text=${label}`).first().isVisible(), `section ${label} absente`)
    }

    // In the "Nouvelle écriture" modal, the only tables with both Débit and
    // Crédit thead cells are the 3 prepop tables (the editable Lignes table
    // uses Type/Compte/Description/Montant).
    const tables = page.locator('table')
    const count = await tables.count()
    const prepTables = []
    for (let i = 0; i < count; i++) {
      const t = tables.nth(i)
      const hasDebit = await t.locator('thead th', { hasText: /^Débit$/ }).count() > 0
      const hasCredit = await t.locator('thead th', { hasText: /^Crédit$/ }).count() > 0
      if (hasDebit && hasCredit) prepTables.push(t)
    }
    assert.equal(prepTables.length, 8, `attendu 8 tableaux Débit/Crédit (3 opérations + 5 réconciliations), trouvé ${prepTables.length} (tables totales: ${count})`)

    // Columns must be aligned across the three tables: capture the x-coordinates
    // of Nb / Débit / Crédit / Montant thead cells for each table and verify
    // they match within 1px.
    const colRefs = ['Nb', 'Débit', 'Crédit', 'Montant']
    const xByCol = {}
    for (const t of prepTables) {
      for (const col of colRefs) {
        const box = await t.locator('thead th', { hasText: new RegExp(`^${col}$`) }).boundingBox()
        assert.ok(box, `en-tête ${col} introuvable`)
        if (!xByCol[col]) xByCol[col] = []
        xByCol[col].push({ x: Math.round(box.x), right: Math.round(box.x + box.width) })
      }
    }
    for (const col of colRefs) {
      const xs = xByCol[col].map(b => b.x)
      const rights = xByCol[col].map(b => b.right)
      const xSpread = Math.max(...xs) - Math.min(...xs)
      const rSpread = Math.max(...rights) - Math.min(...rights)
      assert.ok(xSpread <= 1, `colonne ${col} désalignée (x): ${JSON.stringify(xs)}`)
      assert.ok(rSpread <= 1, `colonne ${col} désalignée (right): ${JSON.stringify(rights)}`)
    }

    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  })

  test('prépopulation : réconciliations ERP ↔ QB (Pièces + Produits finis + reconditionnés)', async () => {
    await page.goto(URL + '/journal-entries', { waitUntil: 'networkidle' })
    await page.waitForSelector('h1:has-text("Écritures de journal")', { timeout: 10000 })
    await page.click('button:has-text("Nouvelle écriture")')
    await page.waitForSelector('text=Nouvelle écriture de journal', { timeout: 5000 })
    await page.click('button:has-text("Prépopuler depuis les opérations ERP")')
    await page.waitForSelector('button:has-text("Analyser la période")', { timeout: 3000 })
    await page.fill('input[type="date"] >> nth=1', '2024-01-01')
    await page.fill('input[type="date"] >> nth=2', '2026-12-31')
    await page.click('button:has-text("Analyser la période")')
    await page.waitForSelector('text=Réconciliation Stock de Pièces', { timeout: 15000 })
    await page.waitForSelector('text=Réconciliation Stock de Produits finis reconditionnés', { timeout: 5000 })
    await page.waitForSelector('text=Réconciliation Stock d\'équip. en transit', { timeout: 5000 })
    await page.waitForSelector('text=Réconciliation Équipements prêtés aux abonnés', { timeout: 5000 })

    const reconciliations = [
      { name: 'Stock de Pièces', erpRegex: /ERP.*pièces non sérialisées/ },
      { name: 'Stock de Produits finis', erpRegex: /ERP.*Disponible - Vente/ },
      { name: 'Stock de Produits finis reconditionnés', erpRegex: /ERP.*Disponible - Location/ },
      { name: 'Stock d\'équip. en transit', erpRegex: /ERP.*En retour.*À analyser.*À reconditionner/ },
      { name: 'Équipements prêtés aux abonnés', erpRegex: /ERP.*Opérationnel - Loué/ },
    ]

    for (const reco of reconciliations) {
      // Utilise un regex exact sur le label pour ne pas matcher plusieurs sections
      // (« Stock de Produits finis » est un préfixe de « ... reconditionnés »)
      const labelRe = new RegExp(`^Écriture d'ajustement — Réconciliation ${reco.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(ERP ↔ QB\\)$`)
      const section = page.locator('label', { hasText: labelRe }).locator('..')
      assert.equal(await section.count(), 1, `section ${reco.name} non trouvée ou dupliquée`)
      assert.ok(await section.getByText(reco.erpRegex).first().isVisible(), `ligne ERP absente pour ${reco.name}`)
      assert.ok(await section.getByText(/projeté après opérations/).first().isVisible(), `ligne projetée absente pour ${reco.name}`)
      const hasAdjustment = await section.getByText(/Ajustement requis/).first().isVisible()
      const hasBalanced = await section.getByText(/Soldes balancés/).first().isVisible()
      assert.ok(hasAdjustment || hasBalanced, `ni ajustement ni balancé pour ${reco.name}`)

      // Quand les soldes sont balancés, la case à cocher doit apparaître décochée
      // (et désactivée) — sinon l'utilisateur peut croire qu'une écriture va être
      // ajoutée alors qu'il n'y en a pas besoin.
      const checkbox = section.locator('input[type="checkbox"]').first()
      if (hasBalanced) {
        assert.equal(await checkbox.isChecked(), false, `case devrait être décochée quand balancé (${reco.name})`)
        assert.equal(await checkbox.isDisabled(), true, `case devrait être désactivée quand balancé (${reco.name})`)
      }
    }

    // 6 tables Débit/Crédit : 3 opérations + 3 réconciliations, toutes alignées
    const tables = page.locator('table')
    const count = await tables.count()
    const recoTables = []
    for (let i = 0; i < count; i++) {
      const t = tables.nth(i)
      const hasDebit = await t.locator('thead th', { hasText: /^Débit$/ }).count() > 0
      const hasCredit = await t.locator('thead th', { hasText: /^Crédit$/ }).count() > 0
      if (hasDebit && hasCredit) recoTables.push(t)
    }
    assert.equal(recoTables.length, 8, `attendu 8 tableaux Débit/Crédit (3 opérations + 5 réconciliations), trouvé ${recoTables.length}`)

    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  })
})
