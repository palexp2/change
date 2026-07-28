// OrderDetail — tableau Articles : bouton "Champs" pour afficher/masquer des
// colonnes. On vérifie : (1) le bouton ouvre un panneau listant les colonnes,
// (2) décocher une colonne la retire du tableau (avec badge du nb masqué),
// (3) la préférence persiste après reload (localStorage), (4) "Tout voir"
// restaure toutes les colonnes.
// Test read-only côté DB : aucune commande créée ni modifiée.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
}

describe('OrderDetail — visibilité des colonnes du tableau Articles', () => {
  let browser, ctx, page, orderId

  before(async () => {
    browser = await chromium.launch()
    // Viewport large pour que toutes les colonnes responsive (sm/md/lg) soient rendues.
    ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } })
    page = await ctx.newPage()
    await login(page)
    // N'importe quelle commande existante — le test ne mute rien côté serveur.
    orderId = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const list = await fetch('/erp/api/orders?limit=1', {
        headers: { Authorization: `Bearer ${tok}` },
      }).then(r => r.json())
      return (list.data || [])[0]?.id || null
    })
    assert.ok(orderId, 'aucune commande disponible pour le test')
  })

  after(async () => {
    // Restaure la préférence de colonnes (contexte navigateur jetable, mais on
    // nettoie quand même par principe).
    try {
      await page.evaluate(() => localStorage.removeItem('erp_orderItems_cols'))
    } catch {}
    await browser?.close()
  })

  test('masquer une colonne, persistance après reload, puis tout restaurer', async () => {
    await page.goto(`${URL}/orders/${orderId}`, { waitUntil: 'networkidle' })

    const itemsCard = page.locator('div.card', { has: page.locator('h2:text-matches("^Articles \\\\(")') }).first()
    await itemsCard.waitFor({ state: 'visible', timeout: 10000 })

    const thEmplacement = itemsCard.locator('th', { hasText: 'Emplacement' })
    const thType = itemsCard.locator('th', { hasText: /^Type$/ })
    assert.equal(await thEmplacement.count(), 1, 'colonne Emplacement attendue visible au départ')
    assert.equal(await thType.count(), 1, 'colonne Type attendue visible au départ')

    // Ouvre le panneau "Champs" et décoche Emplacement.
    const fieldsBtn = page.getByTestId('items-fields-btn')
    await fieldsBtn.click()
    const panel = page.locator('div:has(> p:has-text("Colonnes visibles"))').last()
    await panel.waitFor({ state: 'visible', timeout: 5000 })
    const emplacementCheckbox = panel.locator('label', { hasText: 'Emplacement' }).locator('input[type="checkbox"]')
    assert.ok(await emplacementCheckbox.isChecked(), 'la case Emplacement devrait être cochée au départ')
    await emplacementCheckbox.click()

    // La colonne disparaît immédiatement + badge "1" sur le bouton.
    await thEmplacement.waitFor({ state: 'detached', timeout: 5000 })
    assert.equal(await thType.count(), 1, 'la colonne Type ne doit pas être affectée')
    assert.equal((await fieldsBtn.innerText()).includes('1'), true, 'badge "1 colonne masquée" attendu sur le bouton Champs')

    // Ferme le panneau (clic hors du panneau).
    await page.locator('h1').click()
    await panel.waitFor({ state: 'detached', timeout: 5000 })

    // Persistance : reload → la colonne reste masquée.
    await page.reload({ waitUntil: 'networkidle' })
    await itemsCard.waitFor({ state: 'visible', timeout: 10000 })
    assert.equal(await thEmplacement.count(), 0, 'la colonne Emplacement doit rester masquée après reload')
    assert.equal(await thType.count(), 1, 'la colonne Type doit rester visible après reload')

    // "Tout voir" restaure toutes les colonnes.
    await fieldsBtn.click()
    await panel.waitFor({ state: 'visible', timeout: 5000 })
    await panel.locator('button:has-text("Tout voir")').click()
    await thEmplacement.waitFor({ state: 'attached', timeout: 5000 })
    const visibleCols = ['Qté', 'Type', 'Emplacement', 'Prélèvement', 'Série remplacée', 'Disponibilité']
    for (const label of visibleCols) {
      assert.ok((await itemsCard.locator('th', { hasText: label }).count()) >= 1, `colonne ${label} attendue après "Tout voir"`)
    }
  })
})
