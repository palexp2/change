const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie que la page Codes d'activité utilise désormais le composant DataTable :
//   - barre d'outils (compteur de lignes + champ de recherche)
//   - la recherche filtre les lignes
//   - l'édition inline (case RSDE) autosauvegarde via PATCH
describe("Codes d'activité — migration DataTable", () => {
  let browser, ctx, page, token
  let codeId = null
  const tag = 'E2E-DT-' + Date.now().toString(36).toUpperCase()

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
    token = await page.evaluate(() => localStorage.getItem('erp_token'))

    const created = await page.evaluate(async ({ tk, name }) => {
      const r = await fetch('/erp/api/activity-codes', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tk}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, payable: true, rsde_default: false }),
      })
      return r.json()
    }, { tk: token, name: tag })
    codeId = created.id
    assert.ok(codeId, 'création du code de test échouée')
  })

  after(async () => {
    // Cleanup : supprime le code créé même si un test a échoué.
    if (codeId && token) {
      await page.evaluate(async ({ id, tk }) => {
        await fetch(`/erp/api/activity-codes/${id}`, {
          method: 'DELETE', headers: { Authorization: `Bearer ${tk}` },
        }).catch(() => {})
      }, { id: codeId, tk: token })
    }
    await browser?.close()
  })

  test('la page affiche la barre d\'outils DataTable (compteur + recherche)', async () => {
    await page.goto(`${URL}/codes-activite`, { waitUntil: 'networkidle' })
    await page.waitForSelector('text=/\\d+\\s+lignes?/', { timeout: 10000 })
    const counterTxt = await page.locator('text=/\\d+\\s+lignes?/').first().textContent()
    const n = parseInt(counterTxt.match(/(\d+)/)[1], 10)
    assert.ok(n >= 1, `DataTable doit afficher au moins une ligne (got ${n})`)
    assert.ok(await page.locator('input[placeholder="Rechercher..."]').first().isVisible(),
      'DataTable doit afficher le champ de recherche')
    // La ligne créée doit être présente (rendue comme input éditable autosave)
    await page.locator(`input[value="${tag}"]`).first().waitFor({ timeout: 5000 })
  })

  test('la recherche DataTable filtre les lignes', async () => {
    const counterBefore = await page.locator('text=/\\d+\\s+lignes?/').first().textContent()
    const before = parseInt(counterBefore.match(/(\d+)/)[1], 10)

    await page.fill('input[placeholder="Rechercher..."]', tag)
    await page.waitForFunction((t) => {
      const el = [...document.querySelectorAll('*')].find(e => /\d+\s+lignes?/.test(e.textContent) && e.children.length === 0)
      return el && parseInt(el.textContent.match(/(\d+)/)[1], 10) === 1
    }, tag, { timeout: 5000 })

    const counterAfter = await page.locator('text=/\\d+\\s+lignes?/').first().textContent()
    const after = parseInt(counterAfter.match(/(\d+)/)[1], 10)
    assert.equal(after, 1, `la recherche doit filtrer à 1 ligne (avant=${before} après=${after})`)
    assert.ok(after < before || before === 1, 'la recherche doit réduire le nombre de lignes')

    await page.fill('input[placeholder="Rechercher..."]', '')
  })

  test('édition inline : cocher RSDE autosauvegarde via PATCH', async () => {
    // Re-filtrer pour cibler la ligne créée de façon déterministe
    await page.fill('input[placeholder="Rechercher..."]', tag)
    const cb = page.locator(`[data-testid="code-rsde-${codeId}"]`)
    await cb.waitFor({ timeout: 5000 })
    assert.equal(await cb.isChecked(), false, 'RSDE doit partir non coché')
    // .click() (pas .check()) : la case est contrôlée par React et reverte
    // visuellement le temps que le PATCH async + setCodes s'appliquent ; on
    // valide la persistance via l'API plutôt que l'état immédiat du DOM.
    await cb.click()

    // Attendre la persistance serveur
    await page.waitForFunction(async ({ id, tk }) => {
      const r = await fetch(`/erp/api/activity-codes/${id}`, { headers: { Authorization: `Bearer ${tk}` } })
      if (!r.ok) return false
      const c = await r.json()
      return c.rsde_default === 1
    }, { id: codeId, tk: token }, { timeout: 5000 })

    const fresh = await page.evaluate(async ({ id, tk }) => {
      const r = await fetch(`/erp/api/activity-codes/${id}`, { headers: { Authorization: `Bearer ${tk}` } })
      return r.json()
    }, { id: codeId, tk: token })
    assert.equal(fresh.rsde_default, 1, 'rsde_default doit être persisté à 1 après le clic UI')

    await page.fill('input[placeholder="Rechercher..."]', '')
  })
})
