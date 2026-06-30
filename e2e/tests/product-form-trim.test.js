const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie que la modale de création "Nouveau produit" (ProductForm) :
//  1. rejette un nom (FR) composé uniquement d'espaces (pas de record blanc),
//  2. trim le nom avant l'envoi (espaces de bordure supprimés en DB).
describe('ProductForm — trim des champs texte à la création', () => {
  let browser, ctx, page
  let createdId
  const stamp = Date.now()
  const rawName = `   E2E Trim Prod ${stamp}   `
  const trimmedName = `E2E Trim Prod ${stamp}`

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

  after(async () => {
    // Cleanup : supprimer le produit créé par le test, même en cas d'échec.
    if (createdId) {
      await page.evaluate(async (id) => {
        const token = localStorage.getItem('erp_token')
        await fetch(`/erp/api/products/${id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => {})
      }, createdId).catch(() => {})
    }
    await browser?.close()
  })

  async function openModal() {
    await page.goto(`${URL}/products`, { waitUntil: 'networkidle' })
    await page.click('button:has-text("Nouveau produit")')
    await page.waitForSelector('label:has-text("Nom (FR) *")', { timeout: 5000 })
  }

  test('un nom (FR) composé uniquement d\'espaces est rejeté', async () => {
    await openModal()
    const nameInput = page.locator('.input[required]').first()
    await nameInput.fill('     ')
    await page.click('button[type="submit"]:has-text("Enregistrer")')
    // Le message d'erreur s'affiche et la modale reste ouverte (pas de création).
    await page.waitForSelector('text=Le nom (FR) est requis.', { timeout: 4000 })
    assert.ok(await page.locator('label:has-text("Nom (FR) *")').isVisible(), 'la modale doit rester ouverte')
  })

  test('le nom (FR) est trim avant l\'envoi', async () => {
    // La modale est encore ouverte depuis le test précédent ; on remplit un nom valide.
    const nameInput = page.locator('.input[required]').first()
    await nameInput.fill(rawName)
    await page.click('button[type="submit"]:has-text("Enregistrer")')
    // La modale se ferme après création réussie.
    await page.waitForSelector('label:has-text("Nom (FR) *")', { state: 'detached', timeout: 6000 })

    // Vérifie en DB (via API) que le nom est trimmé.
    const product = await page.evaluate(async (name) => {
      const token = localStorage.getItem('erp_token')
      const list = await fetch('/erp/api/products?limit=all', {
        headers: { Authorization: `Bearer ${token}` },
      }).then(r => r.json())
      const rows = Array.isArray(list) ? list : (list.products || list.data || [])
      return rows.find(p => p.name_fr === name) || null
    }, trimmedName)

    assert.ok(product, `produit avec name_fr exactement "${trimmedName}" (trimmé) introuvable`)
    assert.equal(product.name_fr, trimmedName, 'le nom doit être stocké sans espaces de bordure')
    createdId = product.id
  })
})
