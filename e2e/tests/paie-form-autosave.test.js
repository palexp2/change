const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Édition d'une paie existante : autosave (PATCH on blur / on change), aucun
// bouton « Enregistrer ». La création garde son bouton (record sans id).
describe('PaieForm — autosave en mode édition', () => {
  let browser, ctx, page
  let paieId
  const uniqNumber = Number(String(Date.now()).slice(-6)) // identifiable, recherchable

  async function getPaie() {
    return page.evaluate(async (id) => {
      const token = localStorage.getItem('erp_token')
      return fetch(`/erp/api/paies/${id}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
    }, paieId)
  }

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    // Crée une paie existante à éditer (record jetable, supprimé en after).
    paieId = await page.evaluate(async (number) => {
      const token = localStorage.getItem('erp_token')
      const paie = await fetch('/erp/api/paies', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ period_end: '2031-03-14', number, status: 'Non débuté', nb_holiday_days: 0, includes_mileage: 0 }),
      }).then(r => r.json())
      return paie.id
    }, uniqNumber)
    assert.ok(paieId, 'paie de test créée')
  })

  after(async () => {
    if (paieId) {
      await page.evaluate(async (id) => {
        const token = localStorage.getItem('erp_token')
        await fetch(`/erp/api/paies/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {})
      }, paieId)
    }
    await browser?.close()
  })

  test('édition : pas de bouton « Enregistrer », autosave on blur / on change', async () => {
    await page.goto(URL + '/paies', { waitUntil: 'domcontentloaded' })

    // Filtrer sur le numéro unique puis ouvrir la fiche.
    const searchBox = page.getByPlaceholder('Rechercher...').first()
    await searchBox.waitFor({ timeout: 15000 })
    await searchBox.fill(String(uniqNumber))
    const row = page.locator('[data-row-id]', { hasText: String(uniqNumber) }).first()
    await row.waitFor({ state: 'visible', timeout: 10000 })
    await row.click()

    // PaieDetail → « Modifier » ouvre le formulaire en mode édition.
    const editBtn = page.getByRole('button', { name: 'Modifier' })
    await editBtn.waitFor({ timeout: 10000 })
    await editBtn.click()

    // Le formulaire d'édition est dans la modale ; on attend un champ connu.
    const dialog = page.getByRole('dialog')
    const deadline = dialog.locator('input[placeholder="ex. Mardi 11h AM"]')
    await deadline.waitFor({ timeout: 10000 })

    // RÈGLE : aucun bouton « Enregistrer » en édition (autosave), mais un « Fermer ».
    await assert.rejects(
      dialog.getByRole('button', { name: /Enregistrer/ }).waitFor({ timeout: 1500 }),
      'aucun bouton Enregistrer ne doit exister en mode édition',
    )
    assert.ok(await dialog.getByRole('button', { name: 'Fermer' }).count() > 0, 'un bouton Fermer doit exister')

    // 1) Champ texte → persistance au blur.
    const newDeadline = `E2E ${uniqNumber}`
    await deadline.fill(newDeadline)
    await deadline.blur()

    // 2) Select statut → persistance immédiate.
    await dialog.locator('select').first().selectOption('En cours')

    // 3) Checkbox Kilométrage (includes_mileage) → persistance immédiate.
    const mileage = dialog.locator('label', { hasText: 'Kilométrage' }).locator('input[type="checkbox"]')
    await mileage.check()

    // Vérifie la persistance côté serveur (poll API, pas l'état DOM immédiat).
    await assert.doesNotReject(async () => {
      for (let i = 0; i < 20; i++) {
        const p = await getPaie()
        if (p.timesheets_deadline === newDeadline && p.status === 'En cours' && p.includes_mileage === 1) return
        await new Promise(r => setTimeout(r, 400))
      }
      throw new Error('les modifications ne se sont pas autosauvegardées')
    })

    // Indicateur de sauvegarde visible à un moment (idle/saved acceptés après coup).
    const final = await getPaie()
    assert.strictEqual(final.timesheets_deadline, newDeadline)
    assert.strictEqual(final.status, 'En cours')
    assert.strictEqual(final.includes_mileage, 1)
  })
})
