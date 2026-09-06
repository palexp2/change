// Suggestions de Claude (/travaux, onglet « Suggestions de Claude ») : elles sont
// maintenant rangées en sous-sections par domaine métier (ventes, logistique,
// comptabilité, RH, marketing, technique, support) au lieu d'une seule liste plate.
// Vérifie que deux suggestions de domaines différents apparaissent chacune sous
// le bon en-tête de section.
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

describe('Travaux — suggestions rangées par domaine', () => {
  let browser, ctx, page
  const stamp = Date.now()
  let ventesId = null, comptaId = null

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

    const ventes = await createSuggestion(`E2E domaine ventes ${stamp}`, 'ventes')
    const compta = await createSuggestion(`E2E domaine comptabilite ${stamp}`, 'comptabilité') // texte libre volontaire : doit être normalisé
    ventesId = ventes.id
    comptaId = compta.id
    if (!ventesId || !comptaId) throw new Error('création des suggestions de test impossible')
  })

  after(async () => {
    if (page) {
      for (const id of [ventesId, comptaId]) {
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

  test('la suggestion "comptabilité" (texte libre) est normalisée sur l\'enum fermé', async () => {
    const area = await api(async (id) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/travaux/suggestions?status=new', { headers: { Authorization: `Bearer ${token}` } })
      const { suggestions } = await r.json()
      return suggestions.find(s => s.id === id)?.area
    }, comptaId)
    assert.equal(area, 'comptabilite', 'la valeur libre doit retomber sur le slug canonique')
  })

  test('les deux suggestions apparaissent chacune sous la bonne sous-section', async () => {
    await page.goto(URL + '/travaux?onglet=suggestions', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector(`text=E2E domaine ventes ${stamp}`, { timeout: 20000 })

    const ventesSection = page.getByTestId('suggestion-area-ventes')
    const comptaSection = page.getByTestId('suggestion-area-comptabilite')
    await ventesSection.waitFor({ timeout: 10000 })
    await comptaSection.waitFor({ timeout: 10000 })

    // La classe `uppercase` sur l'en-tête transforme le rendu (donc innerText),
    // sans changer le texte source : comparaison insensible à la casse.
    const ventesText = (await ventesSection.innerText()).toLowerCase()
    const comptaText = (await comptaSection.innerText()).toLowerCase()

    assert.ok(ventesText.includes('ventes'), 'en-tête de section « Ventes »')
    assert.ok(ventesText.includes(`e2e domaine ventes ${stamp}`.toLowerCase()),
      'la suggestion ventes doit être dans la section Ventes')
    assert.ok(!ventesText.includes(`e2e domaine comptabilite ${stamp}`.toLowerCase()),
      'la suggestion comptabilité ne doit pas être dans la section Ventes')

    assert.ok(comptaText.includes('comptabilité') || comptaText.includes('comptabilite'), 'en-tête de section « Comptabilité »')
    assert.ok(comptaText.includes(`e2e domaine comptabilite ${stamp}`.toLowerCase()),
      'la suggestion comptabilité doit être dans la section Comptabilité')
  })
})
