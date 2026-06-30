const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie que le bouton « Envoyer » du PurchaseOrderModal n'envoie PAS le courriel
// immédiatement : il doit d'abord afficher une modale de confirmation listant le
// side effect (règle CLAUDE.md). Le test ANNULE la confirmation — aucun courriel
// n'est envoyé, donc aucun record créé ni config écrasée → pas de cleanup requis.
describe('Bon de commande — confirmation avant envoi par courriel', () => {
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

  test('« Envoyer » ouvre la modale de confirmation et « Annuler » n\'envoie rien', async () => {
    // Trouver un produit buy_via_po avec fournisseur (même critère que les autres tests PO)
    const productId = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const res = await fetch('/erp/api/products?limit=all', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      const list = data.data || data
      return (list.find(x => x.buy_via_po && x.supplier_company_id) || {}).id
    })
    assert.ok(productId, 'aucun produit buy_via_po avec fournisseur trouvé')

    await page.goto(`${URL}/products/${productId}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('button:has-text("Générer un PO")', { timeout: 10000 })
    await page.click('button:has-text("Générer un PO")')

    // Récupérer le n° PO affiché (input N° PO) pour vérifier le message de confirmation
    await page.waitForSelector('button:has-text("Envoyer au fournisseur")', { timeout: 10000 })
    const poNumber = await page.locator('label:has-text("N° PO") + input').inputValue()
    assert.ok(poNumber, 'n° PO non rempli')

    // Passer à l'écran d'envoi
    await page.click('button:has-text("Envoyer au fournisseur")')
    await page.waitForSelector('label:has-text("Envoyer depuis")', { timeout: 5000 })

    // Choisir un compte expéditeur (claude@orisha.io n'a pas de Gmail connecté → défaut vide)
    await page.click('[data-testid="po-from-account-select"]')
    await page.waitForSelector('[data-testid="po-from-account-select-menu"]', { timeout: 5000 })
    await page.locator('[data-testid="po-from-account-select-menu"] button').nth(1).click()

    // S'assurer qu'un destinataire est renseigné. Selon le fournisseur, le champ est
    // soit un input libre, soit un SearchableSelect (po-recipient-select).
    const customInput = page.locator('input[placeholder="fournisseur@exemple.com"]')
    const hasCustomInput = await customInput.count()
    if (hasCustomInput) {
      const current = await customInput.inputValue()
      if (!current) await customInput.fill('e2e-confirm-test@example.com')
    } else {
      // SearchableSelect : la valeur par défaut (contacts[0].email) est déjà sélectionnée.
      // On vérifie juste qu'elle n'est pas vide via l'état du bouton Envoyer plus bas.
    }

    const sendBtn = page.getByRole('button', { name: 'Envoyer', exact: true })
    await sendBtn.waitFor({ state: 'visible' })
    assert.ok(!(await sendBtn.isDisabled()), 'le bouton Envoyer doit être actif (compte + destinataire renseignés)')

    // Clic « Envoyer » → la modale de confirmation doit s'ouvrir, AUCUN envoi immédiat.
    await sendBtn.click()

    const confirmTitle = page.locator('text=Confirmer l\'envoi du bon de commande')
    await confirmTitle.waitFor({ state: 'visible', timeout: 5000 })

    // Le message liste explicitement le side effect : PDF en pièce jointe.
    const confirmBody = await page.locator('.whitespace-pre-line').first().innerText()
    assert.match(confirmBody, new RegExp(`${poNumber}\\.pdf`), 'le message doit nommer le PDF attaché')
    assert.match(confirmBody, /sera envoyé/, 'le message doit décrire l\'envoi du courriel')

    // On ne doit PAS être déjà passé en état « envoyé »
    assert.strictEqual(
      await page.locator('text=Bon de commande envoyé').count(), 0,
      'le courriel ne doit pas avoir été envoyé avant confirmation'
    )

    // Annuler → retour au formulaire, toujours aucun envoi.
    await page.click('button:has-text("Annuler")')
    await confirmTitle.waitFor({ state: 'hidden', timeout: 5000 })
    assert.strictEqual(
      await page.locator('text=Bon de commande envoyé').count(), 0,
      'après annulation, aucun envoi ne doit avoir eu lieu'
    )
    // Le formulaire d'envoi reste affiché (le bouton Envoyer est toujours là)
    await page.locator('button:has-text("Envoyer depuis")').first().waitFor({ state: 'hidden' }).catch(() => {})
    assert.ok(await page.locator('label:has-text("Envoyer depuis")').count() > 0, 'le formulaire d\'envoi doit rester ouvert')
  })
})
