// Suggestions de Claude (/travaux, onglet « Suggestions de Claude ») : on peut
// maintenant filtrer la liste par domaine métier — une rangée de pastilles au-dessus
// de la liste, et le titre de chaque sous-section qui sert lui aussi de filtre.
//
// Sécurité : les deux suggestions créées sont jetables (titres horodatés) et
// supprimées dans le hook after().
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Travaux — filtre des suggestions par domaine', () => {
  let browser, ctx, page
  const stamp = Date.now()
  const VENTES_TITLE = `E2E filtre ventes ${stamp}`
  const LOGI_TITLE = `E2E filtre logistique ${stamp}`
  let ventesId = null, logiId = null

  const api = (fn, arg) => page.evaluate(fn, arg)

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    async function createSuggestion(title, area) {
      return api(async ({ title, area }) => {
        const token = localStorage.getItem('erp_token')
        const r = await fetch('/erp/api/travaux/suggestions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title, area, kind: 'chantier',
            rationale: 'Suggestion jetable créée par un test E2E.',
            prompt: 'Ne rien faire — suggestion de test E2E.',
          }),
        })
        return r.json()
      }, { title, area })
    }

    ventesId = (await createSuggestion(VENTES_TITLE, 'ventes')).id
    logiId = (await createSuggestion(LOGI_TITLE, 'logistique')).id
    if (!ventesId || !logiId) throw new Error('création des suggestions de test impossible')
  })

  after(async () => {
    if (page) {
      for (const id of [ventesId, logiId]) {
        if (!id) continue
        await api(async (id) => {
          const token = localStorage.getItem('erp_token')
          await fetch(`/erp/api/travaux/suggestions/${id}`, {
            method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
          }).catch(() => {})
        }, id)
      }
    }
    await browser?.close()
  })

  test('la pastille « Ventes » n\'affiche que les suggestions de ce domaine', async () => {
    await page.goto(URL + '/travaux?onglet=suggestions', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector(`text=${VENTES_TITLE}`, { timeout: 20000 })
    await page.waitForSelector(`text=${LOGI_TITLE}`, { timeout: 20000 })

    const chip = page.getByTestId('suggestion-area-chip-ventes')
    await chip.waitFor({ timeout: 10000 })
    await chip.click()

    await page.getByTestId('suggestion-area-logistique').waitFor({ state: 'detached', timeout: 10000 })
    await page.getByTestId('suggestion-area-ventes').waitFor({ timeout: 10000 })

    assert.equal(await page.locator(`text=${VENTES_TITLE}`).count(), 1,
      'la suggestion ventes reste visible')
    assert.equal(await page.locator(`text=${LOGI_TITLE}`).count(), 0,
      'la suggestion logistique est masquée par le filtre')
    assert.equal(await chip.getAttribute('aria-pressed'), 'true', 'la pastille Ventes est active')
  })

  test('« Tous les domaines » remet la liste complète', async () => {
    await page.getByTestId('suggestion-area-chip-all').click()
    await page.getByTestId('suggestion-area-logistique').waitFor({ timeout: 10000 })
    assert.equal(await page.locator(`text=${VENTES_TITLE}`).count(), 1)
    assert.equal(await page.locator(`text=${LOGI_TITLE}`).count(), 1)
  })

  test('le titre d\'une sous-section filtre, et un second clic annule le filtre', async () => {
    await page.getByTestId('suggestion-area-title-logistique').click()
    await page.getByTestId('suggestion-area-ventes').waitFor({ state: 'detached', timeout: 10000 })
    assert.equal(await page.locator(`text=${LOGI_TITLE}`).count(), 1)
    assert.equal(await page.locator(`text=${VENTES_TITLE}`).count(), 0)

    await page.getByTestId('suggestion-area-title-logistique').click()
    await page.getByTestId('suggestion-area-ventes').waitFor({ timeout: 10000 })
    assert.equal(await page.locator(`text=${VENTES_TITLE}`).count(), 1)
  })
})
