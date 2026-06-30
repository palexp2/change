const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

// Helper API dans le contexte de la page (token en localStorage)
async function apiArchivedAt(page, ids) {
  return page.evaluate(async (ids) => {
    const token = localStorage.getItem('erp_token')
    const r = await fetch('/erp/api/sale-receipts?limit=all', { headers: { Authorization: `Bearer ${token}` } })
    const list = (await r.json()).data || []
    return ids.map(id => {
      const row = list.find(t => t.id === id)
      return row ? row.archived_at : 'MISSING'
    })
  }, ids)
}

describe('Extraction de données — archivage des reçus + onglet Archivés', () => {
  let browser, ctx, page
  let createdIds = []
  const PREFIX = `__e2e_archive_${Date.now()}_`

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    // 2 reçus jetables non publiés → ils tombent dans l'onglet « À publier ».
    createdIds = await page.evaluate(async ({ b64, prefix }) => {
      const token = localStorage.getItem('erp_token')
      const bin = atob(b64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const created = []
      for (let i = 0; i < 2; i++) {
        const fd = new FormData()
        fd.append('file', new Blob([bytes], { type: 'image/png' }), `${prefix}${i}.png`)
        const r = await fetch('/erp/api/sale-receipts/upload', {
          method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
        })
        const t = await r.json()
        if (t.id) created.push(t.id)
      }
      return created
    }, { b64: PNG_1x1, prefix: PREFIX })
    assert.equal(createdIds.length, 2, 'devrait avoir créé 2 reçus de test')
  })

  after(async () => {
    if (page) {
      await page.evaluate(async (ids) => {
        const token = localStorage.getItem('erp_token')
        for (const id of ids) {
          await fetch(`/erp/api/sale-receipts/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
        }
      }, createdIds)
    }
    await browser?.close()
  })

  test('archiver depuis « À publier » : les reçus quittent l\'onglet', async () => {
    await page.goto(`${URL}/sale-receipts`, { waitUntil: 'networkidle' })
    await page.waitForSelector('input[placeholder="Rechercher..."]', { timeout: 10000 })
    // Onglet par défaut = « À publier » (premier pill). On filtre sur nos reçus.
    await page.fill('input[placeholder="Rechercher..."]', PREFIX)
    await page.waitForTimeout(500)

    let counter = await page.locator('text=/\\d+\\s+lignes?/').first().textContent()
    assert.equal(parseInt(counter.match(/(\d+)/)[1], 10), 2, 'attendu 2 reçus dans À publier')

    await page.click('input[aria-label="Tout sélectionner"]')
    await page.locator('text=/2 sélectionné/').waitFor({ state: 'visible', timeout: 3000 })

    // Bouton « Archiver » (exact pour ne pas matcher « Désarchiver »)
    await page.getByRole('button', { name: 'Archiver', exact: true }).click()

    // Les reçus quittent « À publier » → compteur à 0
    await page.waitForFunction(() => {
      const m = document.body.innerText.match(/(\d+)\s+lignes?/)
      return m && parseInt(m[1], 10) === 0
    }, { timeout: 5000 })

    // Vérif API : archived_at renseigné pour les deux
    const archived = await apiArchivedAt(page, createdIds)
    assert.ok(archived.every(a => a && a !== 'MISSING'), `archived_at doit être posé (got ${JSON.stringify(archived)})`)
  })

  test('onglet « Archivés » affiche les reçus puis « Désarchiver » les retire', async () => {
    // Aller dans l'onglet Archivés
    await page.getByRole('button', { name: 'Archivés', exact: true }).click()
    await page.waitForTimeout(400)
    await page.fill('input[placeholder="Rechercher..."]', PREFIX)
    await page.waitForTimeout(500)

    const counter = await page.locator('text=/\\d+\\s+lignes?/').first().textContent()
    assert.equal(parseInt(counter.match(/(\d+)/)[1], 10), 2, 'attendu 2 reçus dans Archivés')

    await page.click('input[aria-label="Tout sélectionner"]')
    await page.locator('text=/2 sélectionné/').waitFor({ state: 'visible', timeout: 3000 })

    // Bouton « Désarchiver » visible car toutes les lignes sont archivées
    await page.getByRole('button', { name: 'Désarchiver', exact: true }).click()

    // Les reçus quittent « Archivés » → compteur à 0
    await page.waitForFunction(() => {
      const m = document.body.innerText.match(/(\d+)\s+lignes?/)
      return m && parseInt(m[1], 10) === 0
    }, { timeout: 5000 })

    // Vérif API : archived_at remis à null
    const archived = await apiArchivedAt(page, createdIds)
    assert.ok(archived.every(a => a === null), `archived_at doit être null après désarchivage (got ${JSON.stringify(archived)})`)
  })
})
