// Vérifie que le toggle « Autoriser la suppression en lot » dans la modale
// de configuration (icône engrenage en haut des listes) n'apparaît que sur
// les pages dont le parent a câblé `onBulkDelete` sur le DataTable.
//
// Pages supportant bulk delete (prop `bulkDelete` passée à TableConfigModal) :
//   Contacts, Tasks, Companies, Products, Interactions, PublicFiles.
// Toutes les autres pages avec TableConfigModal ne doivent PAS afficher le toggle.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const TOGGLE_TEXT = 'Autoriser la suppression en lot'
const GEAR_SELECTOR = 'button[title="Gérer les vues de la table"]'

async function openGearModal(page) {
  await page.locator(GEAR_SELECTOR).first().click()
  // La modale a un titre commençant par "Vues — "
  await page.locator('h2, h3').filter({ hasText: /^Vues — / }).first().waitFor({ state: 'visible', timeout: 5000 })
}

async function closeModal(page) {
  await page.keyboard.press('Escape')
  await page.locator('h2, h3').filter({ hasText: /^Vues — / }).first().waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {})
}

describe('TableConfigModal — toggle bulk delete affiché seulement si la page le supporte', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  test('/tasks — toggle visible (page supporte bulk delete)', async () => {
    await page.goto(`${URL}/tasks`, { waitUntil: 'networkidle' })
    await page.locator(GEAR_SELECTOR).first().waitFor({ state: 'visible', timeout: 10000 })
    await openGearModal(page)
    const toggle = page.locator(`text=${TOGGLE_TEXT}`)
    await toggle.waitFor({ state: 'visible', timeout: 3000 })
    await closeModal(page)
  })

  test('/contacts — toggle visible (page supporte bulk delete)', async () => {
    await page.goto(`${URL}/contacts`, { waitUntil: 'networkidle' })
    await page.locator(GEAR_SELECTOR).first().waitFor({ state: 'visible', timeout: 10000 })
    await openGearModal(page)
    await page.locator(`text=${TOGGLE_TEXT}`).waitFor({ state: 'visible', timeout: 3000 })
    await closeModal(page)
  })

  test('/factures — toggle absent (page ne supporte pas bulk delete)', async () => {
    await page.goto(`${URL}/factures`, { waitUntil: 'networkidle' })
    await page.locator(GEAR_SELECTOR).first().waitFor({ state: 'visible', timeout: 10000 })
    await openGearModal(page)
    // Attendre un poil pour s'assurer que la modale est entièrement rendue
    await page.waitForTimeout(200)
    const count = await page.locator(`text=${TOGGLE_TEXT}`).count()
    assert.equal(count, 0, `toggle "${TOGGLE_TEXT}" ne doit PAS apparaître sur /factures (pas de onBulkDelete)`)
    await closeModal(page)
  })

  test('/orders — toggle absent (page ne supporte pas bulk delete)', async () => {
    await page.goto(`${URL}/orders`, { waitUntil: 'networkidle' })
    await page.locator(GEAR_SELECTOR).first().waitFor({ state: 'visible', timeout: 10000 })
    await openGearModal(page)
    await page.waitForTimeout(200)
    const count = await page.locator(`text=${TOGGLE_TEXT}`).count()
    assert.equal(count, 0, `toggle "${TOGGLE_TEXT}" ne doit PAS apparaître sur /orders (pas de onBulkDelete)`)
    await closeModal(page)
  })
})
