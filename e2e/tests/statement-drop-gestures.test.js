// Vérifie les façons de déposer un relevé sur /rapprochement, sans fenêtre
// (maquette A2, 2026-10-13) : GLISSER un fichier n'importe où, et COLLER une
// capture (Ctrl+V). Demande de Charles : « je veux pouvoir aussi glisser un fichier…
// pas juste la sélection dans les fichiers ».
//
// Les deux derniers gestes n'existent que dans le navigateur — aucun test
// unitaire ne peut les voir. On simule un vrai DataTransfer (drop) puis un vrai
// ClipboardEvent (paste), et on vérifie que le fichier part bien à l'API.
//
// Aucune écriture dans bank_transactions : l'import automatique est coupé
// (route commit interceptée), et on supprime les dépôts créés en fin de test.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const TOKEN = process.env.ERP_TOKEN
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!TOKEN && !PASS) throw new Error('ERP_TOKEN ou ERP_PASS requis')

const CSV = [
  'Date;Description;Débit;Crédit;Solde',
  '2026-09-08;GESTE DE TEST A;10,00;;1000,00',
  '2026-09-09;GESTE DE TEST B;;25,00;1025,00',
].join('\n')

describe('Dépôt de relevés — glisser et coller', () => {
  let browser, ctx, page
  const created = []

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext()
    if (TOKEN) await ctx.addInitScript((t) => localStorage.setItem('erp_token', t), TOKEN)
    page = await ctx.newPage()
    // Ce qui est sûr s'importe tout seul : jamais pendant un test.
    await page.route('**/bank/statements/*/commit', (r) => r.abort())
    // Toute création de dépôt est notée pour être supprimée à la fin.
    page.on('response', async (r) => {
      if (r.url().includes('/bank/statements/upload') && r.ok()) {
        const body = await r.json().catch(() => null)
        for (const id of body?.ids || []) created.push(id)
      }
    })
    await page.goto(`${URL}/rapprochement`)
    if (!TOKEN) {
      await page.fill('input[type="email"]', EMAIL)
      await page.fill('input[type="password"]', PASS)
      await page.click('button[type="submit"]')
      await page.waitForURL('**/rapprochement**')
    }
    await page.waitForSelector('[data-testid="rapprochement-more"]')
  })

  after(async () => {
    for (const id of created) {
      await page.evaluate(async ([base, uid]) => {
        await fetch(`${base}/api/bank/statements/${uid}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${localStorage.getItem('erp_token')}` },
        })
      }, [URL, id])
    }
    await browser?.close()
  })

  test('glisser un fichier sur la page le dépose', async () => {
    const before = created.length
    await page.evaluate((csv) => {
      const dt = new DataTransfer()
      dt.items.add(new File([csv], 'Desjardins CAD - glisse.csv', { type: 'text/csv' }))
      window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }))
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }))
    }, CSV)
    for (let i = 0; i < 40 && created.length === before; i++) await page.waitForTimeout(250)
    assert.ok(created.length > before, 'le fichier glissé est parti à l’API')
  })

  test('glisser voile la page, sinon rien ne dit que le geste est permis', async () => {
    await page.evaluate(() => {
      const dt = new DataTransfer()
      dt.items.add(new File(['x'], 'survol.csv', { type: 'text/csv' }))
      window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }))
    })
    await page.waitForSelector('text=Lâcher', { timeout: 5000 })
    // On relâche le survol pour ne pas laisser la page voilée.
    await page.evaluate(() => window.dispatchEvent(new DragEvent('dragleave', { bubbles: true })))
  })

  test('coller une capture (Ctrl+V) la dépose sans passer par un fichier', async () => {
    const before = created.length
    await page.evaluate(() => {
      // Un PNG minuscule mais valide, nommé comme le fait Chrome sur un collage.
      const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
      const bin = atob(b64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const dt = new DataTransfer()
      dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }))
      window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }))
    })
    for (let i = 0; i < 40 && created.length === before; i++) await page.waitForTimeout(250)
    assert.ok(created.length > before, 'la capture collée est partie à l’API')
  })
})
