const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Migration des onglets Soumissions et Factures de ProjectDetail vers DataTable.
// Lecture seule — aucun record créé ni configuration écrasée, donc pas de cleanup
// au-delà de la fermeture du navigateur.
describe('ProjectDetail — onglets Soumissions et Factures en DataTable', () => {
  let browser, ctx, page, soumissionProjectId, factureProjectId

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    // Trouver un projet ayant ≥1 soumission et un projet ayant ≥1 facture.
    const found = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const h = { Authorization: `Bearer ${token}` }
      const sRes = await fetch('/erp/api/documents/soumissions?limit=all', { headers: h })
      const sData = await sRes.json()
      const sProj = (sData.data || []).find(s => s.project_id)?.project_id || null
      const fRes = await fetch('/erp/api/projets/factures?limit=all', { headers: h })
      const fData = await fRes.json()
      const fProj = (fData.data || []).find(f => f.project_id)?.project_id || null
      return { sProj, fProj }
    })
    soumissionProjectId = found.sProj
    factureProjectId = found.fProj
    assert.ok(soumissionProjectId, 'aucun projet avec soumission trouvé')
    assert.ok(factureProjectId, 'aucun projet avec facture trouvé')
  })

  after(async () => { await browser?.close() })

  async function openTab(projectId, tabLabel) {
    await page.goto(`${URL}/projects/${projectId}`, { waitUntil: 'networkidle' })
    await page.click(`button:has-text("${tabLabel}")`)
    // Le compteur "N ligne(s)" de la ViewToolbar de DataTable apparaît quand prêt.
    await page.waitForSelector('text=/\\d+\\s+lignes?/', { timeout: 10000 })
  }

  test('onglet Soumissions affiche la barre d\'outils DataTable (compteur + recherche)', async () => {
    await openTab(soumissionProjectId, 'Soumissions')
    const counterTxt = await page.locator('text=/\\d+\\s+lignes?/').first().textContent()
    const n = parseInt(counterTxt.match(/(\d+)/)[1], 10)
    assert.ok(n > 0, `DataTable Soumissions doit afficher au moins une ligne (got ${n})`)
    assert.ok(await page.locator('input[placeholder="Rechercher..."]').first().isVisible(),
      'DataTable doit afficher le champ de recherche')
  })

  test('recherche DataTable filtre les soumissions', async () => {
    await openTab(soumissionProjectId, 'Soumissions')
    const before = parseInt((await page.locator('text=/\\d+\\s+lignes?/').first().textContent()).match(/(\d+)/)[1], 10)
    await page.fill('input[placeholder="Rechercher..."]', 'zzzzzzzz_aucune_correspondance')
    await page.waitForTimeout(500)
    const after = parseInt((await page.locator('text=/\\d+\\s+lignes?/').first().textContent()).match(/(\d+)/)[1], 10)
    assert.ok(after < before, `la recherche n'a pas filtré: avant=${before} après=${after}`)
    await page.fill('input[placeholder="Rechercher..."]', '')
  })

  test('clic sur une soumission non-legacy navigue vers la fiche', async () => {
    await openTab(soumissionProjectId, 'Soumissions')
    // Récupère l'id d'une soumission non-legacy de ce projet pour valider la nav.
    const sid = await page.evaluate(async (pid) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/documents/soumissions?project_id=${pid}&limit=all`, { headers: { Authorization: `Bearer ${token}` } })
      const d = await r.json()
      return (d.data || []).find(s => s.status !== 'legacy' && s.id)?.id || null
    }, soumissionProjectId)
    if (!sid) return // que des legacy — non cliquables, rien à vérifier
    const row = page.locator(`[data-row-id="${sid}"]`).first()
    await row.waitFor({ state: 'visible', timeout: 5000 })
    await row.click()
    await page.waitForURL(u => u.toString().includes(`/soumissions/${sid}`), { timeout: 8000 })
    assert.ok(page.url().includes(`/soumissions/${sid}`), 'le clic doit ouvrir la fiche soumission')
  })

  test('onglet Factures affiche la barre d\'outils DataTable (compteur + recherche)', async () => {
    await openTab(factureProjectId, 'Factures')
    const counterTxt = await page.locator('text=/\\d+\\s+lignes?/').first().textContent()
    const n = parseInt(counterTxt.match(/(\d+)/)[1], 10)
    assert.ok(n > 0, `DataTable Factures doit afficher au moins une ligne (got ${n})`)
    assert.ok(await page.locator('input[placeholder="Rechercher..."]').first().isVisible(),
      'DataTable doit afficher le champ de recherche')
  })

  test('clic sur une facture navigue vers la fiche', async () => {
    await openTab(factureProjectId, 'Factures')
    const fid = await page.evaluate(async (pid) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/projets/factures?project_id=${pid}&limit=all`, { headers: { Authorization: `Bearer ${token}` } })
      const d = await r.json()
      return (d.data || [])[0]?.id || null
    }, factureProjectId)
    assert.ok(fid, 'aucune facture id trouvée')
    const row = page.locator(`[data-row-id="${fid}"]`).first()
    await row.waitFor({ state: 'visible', timeout: 5000 })
    await row.click()
    await page.waitForURL(u => u.toString().includes(`/factures/${fid}`), { timeout: 8000 })
    assert.ok(page.url().includes(`/factures/${fid}`), 'le clic doit ouvrir la fiche facture')
  })
})
