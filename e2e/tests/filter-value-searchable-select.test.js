const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie que le picker de valeur d'un filtre user/single_select (ValueSelect)
// est recherchable : bouton -> portail #value-select-portal avec input de recherche
// qui filtre les options en live, et sélection qui applique la valeur.
describe('Filtre — picker de valeur recherchable (single_select/user)', () => {
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
    await page.goto(URL + '/tasks', { waitUntil: 'networkidle' })
    await page.waitForSelector('h1:has-text("Tâches")', { timeout: 10000 })
    const tousBtn = page.locator('button:has-text("Toutes les tâches")').first()
    if (await tousBtn.isVisible().catch(() => false)) {
      await tousBtn.click()
      await page.waitForTimeout(500)
    }
  })

  after(async () => { await browser?.close() })

  // Test non destructif : ouvre uniquement le panneau de filtre (état local, non persisté
  // tant qu'aucune vue n'est sauvegardée). Aucune config en DB n'est modifiée.
  test('le picker de valeur ouvre un portail recherchable et applique la sélection', async () => {
    // Ouvre le panneau de filtre et ajoute une ligne
    await page.click('button:has-text("Filtrer")')
    await page.waitForSelector('text=Ajouter un filtre', { timeout: 3000 })
    await page.click('button:has-text("Ajouter un filtre")')
    await page.waitForTimeout(300)

    // Choisir le champ "Responsable" (type user)
    const fieldBtn = page.locator('button.select').first()
    await fieldBtn.click()
    await page.waitForSelector('#field-select-portal', { timeout: 2000 })
    await page.locator('#field-select-portal button', { hasText: 'Responsable' }).first().click()
    await page.waitForTimeout(300)

    // Régler l'opérateur sur "Est" (equals) pour faire apparaître le picker de valeur
    const selects = await page.locator('select').all()
    let opSelect = null
    for (const s of selects) {
      const texts = await s.locator('option').allTextContents()
      if (texts.some(t => t.trim() === 'Est moi')) { opSelect = s; break }
    }
    assert.ok(opSelect, 'select opérateur introuvable')
    await opSelect.selectOption({ label: 'Est' })
    await page.waitForTimeout(300)

    // Le picker de valeur (ValueSelect) est le frère immédiat (div.relative > button)
    // qui suit le <select> opérateur dans la ligne de filtre.
    const valueBtn = opSelect.locator('xpath=following-sibling::div[1]//button')
    await valueBtn.waitFor({ state: 'visible', timeout: 2000 })

    // Ouvre le portail recherchable
    await valueBtn.click()
    await page.waitForSelector('#value-select-portal', { timeout: 2000 })

    // L'input de recherche existe
    const searchInput = page.locator('#value-select-portal input')
    await searchInput.waitFor({ state: 'visible', timeout: 2000 })

    // Options disponibles (hors l'entrée "—")
    const allOptions = await page.locator('#value-select-portal button').allTextContents()
    const realOptions = allOptions.map(t => t.trim()).filter(t => t && t !== '—')
    assert.ok(realOptions.length > 0, 'aucune option de valeur disponible')

    // La recherche filtre en live : tape les 1ers caractères de la 1re option
    const target = realOptions[0]
    const frag = target.slice(0, Math.min(3, target.length))
    await searchInput.fill(frag)
    await page.waitForTimeout(300)
    const afterSearch = (await page.locator('#value-select-portal button').allTextContents())
      .map(t => t.trim()).filter(t => t && t !== '—')
    assert.ok(
      afterSearch.every(o => o.toLowerCase().includes(frag.toLowerCase())),
      `la recherche ne filtre pas correctement : "${frag}" -> [${afterSearch.join('|')}]`
    )
    assert.ok(afterSearch.length > 0, `la recherche "${frag}" ne renvoie aucun résultat`)

    // Sélectionne la première option filtrée
    const chosen = afterSearch[0]
    await page.locator('#value-select-portal button', { hasText: chosen }).first().click()
    await page.waitForTimeout(300)

    // Le portail se ferme et le bouton affiche la valeur choisie
    assert.equal(await page.locator('#value-select-portal').count(), 0, 'le portail ne se ferme pas après sélection')
    const finalLabel = (await valueBtn.textContent()).trim()
    assert.ok(finalLabel.includes(chosen), `le bouton n'affiche pas la valeur choisie : "${finalLabel}" vs "${chosen}"`)
  })
})
