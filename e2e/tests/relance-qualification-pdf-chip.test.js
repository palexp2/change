const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie l'éditeur de Règles générales avec chips PDF inline :
//   1. Insérer une chip via le bouton "+ PDF" → la chip est visible
//   2. La règle sauvegardée contient le marker {{pdf:<token>|<nom>}}
//   3. Après reload, la chip se réaffiche
//   4. Supprimer la chip (backspace) retire le marker
//
// Sauvegarde la valeur initiale des règles générales et la restaure en cleanup
// (les tests E2E partagent la DB de prod — CLAUDE.md).
describe('RelanceQualification — éditeur de règles avec chips PDF', () => {
  let browser, ctx, page
  let token, originalRules, pickedPdf

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

    // Snapshot des règles existantes (à restaurer en after)
    const settings = await page.evaluate(async (tk) => {
      const r = await fetch('/erp/api/email-relance/settings', { headers: { Authorization: 'Bearer ' + tk } })
      return r.json()
    }, token)
    originalRules = settings.general || ''

    // Trouver un PDF public disponible
    const files = await page.evaluate(async (tk) => {
      const r = await fetch('/erp/api/public-files?limit=all', { headers: { Authorization: 'Bearer ' + tk } })
      return r.json()
    }, token)
    pickedPdf = (files.data || []).find(f => (f.mime_type || '').toLowerCase().includes('pdf'))
    if (!pickedPdf) throw new Error('Aucun PDF public disponible pour le test')
  })

  after(async () => {
    // Restaurer la valeur originale des règles, même si le test a échoué
    if (token && originalRules !== undefined) {
      try {
        await page.evaluate(async ({ tk, value }) => {
          await fetch('/erp/api/email-relance/settings/global', {
            method: 'PUT',
            headers: { Authorization: 'Bearer ' + tk, 'Content-Type': 'application/json' },
            body: JSON.stringify({ instructions: value }),
          })
        }, { tk: token, value: originalRules })
      } catch {}
    }
    await browser?.close()
  })

  test('insertion de chip → sauvegarde → reload → persiste', async () => {
    // Reset des règles à une valeur de test connue pour ne pas dépendre du contenu réel
    const testBase = `E2E ${Date.now()} — base`
    await page.evaluate(async ({ tk, value }) => {
      await fetch('/erp/api/email-relance/settings/global', {
        method: 'PUT',
        headers: { Authorization: 'Bearer ' + tk, 'Content-Type': 'application/json' },
        body: JSON.stringify({ instructions: value }),
      })
    }, { tk: token, value: testBase })

    await page.goto(`${URL}/relance-qualification`, { waitUntil: 'networkidle' })

    // Locate l'éditeur (contenteditable dans la sidebar Règles générales)
    const editor = page.locator('aside [contenteditable="true"]').first()
    await editor.waitFor({ timeout: 8000 })

    // Cliquer dans l'éditeur (place le curseur à la fin), puis cliquer le bouton +
    await editor.click()
    await page.keyboard.press('End')
    await page.locator('aside button:has-text("PDF")').first().click()

    // Le picker s'ouvre, sélectionner notre PDF
    const pickerOption = page.locator(`aside button:has-text("${pickedPdf.original_name}")`).first()
    await pickerOption.waitFor({ timeout: 5000 })
    await pickerOption.click()

    // La chip doit apparaître dans l'éditeur
    const chip = editor.locator(`[data-pdf-token="${pickedPdf.token}"]`)
    await chip.waitFor({ timeout: 5000 })
    const chipText = await chip.textContent()
    assert.ok(chipText.includes(pickedPdf.original_name),
      `La chip doit contenir le nom du PDF (${pickedPdf.original_name}), got: ${chipText}`)

    // Blur pour déclencher l'autosave
    await page.locator('h2:has-text("Règles générales")').click()
    await page.locator('aside').getByText('enregistré').first().waitFor({ timeout: 5000 })

    // Vérifier en API que les règles contiennent le marker
    const savedRules = await page.evaluate(async (tk) => {
      const r = await fetch('/erp/api/email-relance/settings', { headers: { Authorization: 'Bearer ' + tk } })
      return (await r.json()).general || ''
    }, token)
    const expectedMarker = `{{pdf:${pickedPdf.token}|${pickedPdf.original_name}}}`
    assert.ok(savedRules.includes(expectedMarker),
      `Les règles sauvegardées doivent contenir ${expectedMarker}, got: ${savedRules}`)

    // Reload → la chip se réaffiche
    await page.reload({ waitUntil: 'networkidle' })
    const editorAfter = page.locator('aside [contenteditable="true"]').first()
    await editorAfter.waitFor({ timeout: 8000 })
    const chipAfter = editorAfter.locator(`[data-pdf-token="${pickedPdf.token}"]`)
    await chipAfter.waitFor({ timeout: 5000 })
    const chipTextAfter = await chipAfter.textContent()
    assert.ok(chipTextAfter.includes(pickedPdf.original_name),
      'La chip doit se réafficher après reload')
  })
})
