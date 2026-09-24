// Vérifie les trois façons de faire entrer un relevé dans la fenêtre de dépôt
// de /rapprochement : cliquer, GLISSER un fichier, et COLLER une capture
// (Ctrl+V). Demande de Charles : « je veux pouvoir aussi glisser un fichier…
// pas juste la sélection dans les fichiers ».
//
// Les deux derniers gestes n'existent que dans le navigateur — aucun test
// unitaire ne peut les voir. On simule un vrai DataTransfer (drop) puis un vrai
// ClipboardEvent (paste), et on vérifie que le fichier part bien à l'API.
//
// Aucune écriture dans bank_transactions : on s'arrête à l'aperçu, et on
// supprime les dépôts créés en fin de test.

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
    // Le dépôt de relevé vit dans le menu « ⋯ » de la barre d'outils depuis
    // que la page n'a plus d'en-tête.
    await page.click('[data-testid="rapprochement-more"]')
    await page.click('[data-testid="statement-drop"]')
    await page.waitForSelector('text=Glissez vos fichiers')
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

  test('glisser un fichier dans la fenêtre le dépose', async () => {
    await page.evaluate((csv) => {
      const dt = new DataTransfer()
      dt.items.add(new File([csv], 'Desjardins CAD - glisse.csv', { type: 'text/csv' }))
      const zone = document.querySelector('[data-testid="statement-drop-zone"]')
      zone.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }))
      zone.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }))
    }, CSV)
    await page.waitForSelector('text=Desjardins CAD - glisse.csv', { timeout: 20000 })
    assert.ok(created.length >= 1, 'le fichier glissé est parti à l’API')
  })

  test('glisser met la zone en évidence, sinon rien ne dit que le geste est permis', async () => {
    await page.evaluate(() => {
      const dt = new DataTransfer()
      dt.items.add(new File(['x'], 'survol.csv', { type: 'text/csv' }))
      document.querySelector('[data-testid="statement-drop-zone"]')
        .dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }))
    })
    await page.waitForSelector('text=Lâchez ici', { timeout: 5000 })
    // On relâche le survol pour ne pas laisser la zone allumée.
    await page.evaluate(() => {
      document.querySelector('[data-testid="statement-drop-zone"]')
        .dispatchEvent(new DragEvent('dragleave', { bubbles: true }))
    })
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
    await page.waitForFunction((n) => document.body.innerText.includes('capture-'), null, { timeout: 20000 })
      .catch(() => {})
    assert.ok(created.length > before, 'la capture collée est partie à l’API')
  })
})
