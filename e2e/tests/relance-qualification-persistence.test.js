const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie la persistance des drafts d'emails sur la page RelanceQualification :
//   1. Éditer un email → blur → reload → l'édition reste
//   2. Le badge "édité manuellement" reste visible après reload
//   3. "Restaurer le template" → reload → on retombe sur le template
//
// Cleanup : DELETE du draft pour ne pas polluer la DB. Le hook after() tourne
// même si le test échoue (convention CLAUDE.md).
describe('RelanceQualification — persistance des drafts', () => {
  let browser, ctx, page
  let token, targetQcId, templateSubject

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    token = await page.evaluate(() => localStorage.getItem('erp_token'))

    // Cible le premier QC de la liste pour le test
    const data = await page.evaluate(async (tk) => {
      const r = await fetch('/erp/api/email-relance/qualification-calls', { headers: { Authorization: 'Bearer ' + tk } })
      return r.json()
    }, token)
    const first = (data.data || [])[0]
    if (!first) throw new Error('Aucun QC à tester')
    targetQcId = first.qualification_call.id
    templateSubject = first.template.subject

    // Sécurité : on commence avec un état propre (pas de draft résiduel)
    await page.evaluate(async ({ tk, qcId }) => {
      await fetch(`/erp/api/email-relance/draft/${qcId}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + tk },
      })
    }, { tk: token, qcId: targetQcId })
  })

  after(async () => {
    // Cleanup : enlève le draft créé par les tests
    if (token && targetQcId) {
      try {
        await page.evaluate(async ({ tk, qcId }) => {
          await fetch(`/erp/api/email-relance/draft/${qcId}`, {
            method: 'DELETE',
            headers: { Authorization: 'Bearer ' + tk },
          })
        }, { tk: token, qcId: targetQcId })
      } catch {}
    }
    await browser?.close()
  })

  test('édition manuelle → reload → l\'édition persiste', async () => {
    await page.goto(`${URL}/relance-qualification`, { waitUntil: 'networkidle' })

    // Première carte
    const card = page.locator('article').first()
    await card.waitFor({ timeout: 8000 })

    const subjectInput = card.locator('input[type="text"]').first()
    const editedSubject = `E2E test ${Date.now()} — sujet édité`
    await subjectInput.fill(editedSubject)
    await subjectInput.blur()
    await card.locator('text=enregistré').first().waitFor({ timeout: 5000 })

    // Reload
    await page.reload({ waitUntil: 'networkidle' })
    const cardAfter = page.locator('article').first()
    await cardAfter.waitFor({ timeout: 8000 })
    const subjectAfter = cardAfter.locator('input[type="text"]').first()
    const valueAfter = await subjectAfter.inputValue()
    assert.equal(valueAfter, editedSubject, 'Le sujet édité doit persister après reload')

    // Le badge "édité manuellement" doit aussi être présent
    await cardAfter.locator('text=édité manuellement').first().waitFor({ timeout: 3000 })
  })

  test('Restaurer le template → reload → revient au template', async () => {
    // À ce stade un draft user existe (depuis le test précédent). Clique Restaurer.
    const card = page.locator('article').first()
    await card.locator('button:has-text("Restaurer le template")').first().click()

    // Le sujet redevient celui du template
    const subjectInput = card.locator('input[type="text"]').first()
    // Petit délai pour que l'état React soit reflété
    await page.waitForTimeout(200)
    assert.equal(await subjectInput.inputValue(), templateSubject,
      'Le sujet doit redevenir celui du template après Restaurer')

    // Reload et vérifier que c'est toujours le template
    await page.reload({ waitUntil: 'networkidle' })
    const cardAfter = page.locator('article').first()
    await cardAfter.waitFor({ timeout: 8000 })
    const subjectAfter = cardAfter.locator('input[type="text"]').first()
    assert.equal(await subjectAfter.inputValue(), templateSubject,
      'Après reload, le sujet doit être le template (draft supprimé en DB)')

    // Plus de badge "édité manuellement"
    const editedBadge = cardAfter.locator('text=édité manuellement')
    assert.equal(await editedBadge.count(), 0, 'Badge "édité manuellement" ne doit plus apparaître')
  })

  test('API renvoie aiBaseline=null et template pour un QC sans draft', async () => {
    const data = await page.evaluate(async (tk) => {
      const r = await fetch('/erp/api/email-relance/qualification-calls', { headers: { Authorization: 'Bearer ' + tk } })
      return r.json()
    }, token)
    const it = (data.data || []).find(x => x.qualification_call.id === targetQcId)
    assert.ok(it, 'QC ciblé absent')
    assert.equal(it.aiBaseline, null, 'aiBaseline doit être null sans régénération IA')
    assert.ok(it.template, 'template doit toujours être présent')
    assert.equal(it.email.subject, it.template.subject,
      'Sans draft, email.subject === template.subject')
  })
})
