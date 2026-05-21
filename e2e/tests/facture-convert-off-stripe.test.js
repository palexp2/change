const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

// Vérifie le workflow "convertir un paiement Stripe paid-out-of-band en
// paiement hors Stripe" : callout admin → modale de confirmation → reset
// local de paid_at / status. La saisie du paiement Interac proprement dite
// n'est PAS faite ici pour éviter de poster une vraie JE en QuickBooks.
describe('FactureDetail — convertir paiement Stripe → hors Stripe', () => {
  let browser, ctx, page, db
  let factureId
  let originalState = null

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })

    // Sélectionne une facture order, CAD, déjà en revenue_recognized_at (cas
    // typique du paid-out-of-band : la vente est constatée à l'expédition,
    // l'argent entre ensuite par Interac). On évite les subscriptions.
    const fac = db.prepare(`
      SELECT id FROM factures
      WHERE kind = 'order'
        AND currency = 'CAD'
        AND revenue_recognized_at IS NOT NULL
        AND total_amount > 0
      LIMIT 1
    `).get()
    if (!fac) throw new Error('Aucune facture order CAD constatée — impossible de tester ce flow')
    factureId = fac.id

    originalState = db.prepare(`
      SELECT status, balance_due, paid_at, paid_amount, paid_charge_id, paid_payment_intent
      FROM factures WHERE id = ?
    `).get(factureId)

    // Force l'état "marquée payée mais sans détails Stripe", avec balance_due
    // remis au total comme dans le scénario réel (facture 8b800f2d…) :
    // Stripe pousse paid_amount = total même pour les invoices marquées
    // paid-out-of-band, donc on reproduit ce comportement plutôt que d'utiliser
    // amount=0 (qui était une hypothèse erronée).
    db.prepare(`
      UPDATE factures
      SET status = 'Payé',
          paid_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          paid_amount = total_amount,
          paid_charge_id = NULL,
          paid_payment_intent = NULL,
          balance_due = total_amount
      WHERE id = ?
    `).run(factureId)

    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => {
    if (factureId && originalState) {
      // Restauration intégrale de l'état initial — pas de DB de test isolée.
      db.prepare(`
        UPDATE factures SET
          status = ?,
          balance_due = ?,
          paid_at = ?,
          paid_amount = ?,
          paid_charge_id = ?,
          paid_payment_intent = ?
        WHERE id = ?
      `).run(
        originalState.status,
        originalState.balance_due,
        originalState.paid_at,
        originalState.paid_amount,
        originalState.paid_charge_id,
        originalState.paid_payment_intent,
        factureId,
      )
    }
    db?.close()
    await browser?.close()
  })

  test('le callout admin de conversion est visible quand paid_at posé sans détails Stripe', async () => {
    await page.goto(`${URL}/factures/${factureId}`, { waitUntil: 'networkidle' })
    const btn = page.locator('[data-testid="convert-to-off-stripe-btn"]')
    await btn.waitFor({ timeout: 5000 })
    assert.equal(await btn.isVisible(), true)
  })

  test('la modale de confirmation s\'ouvre puis confirme le reset local', async () => {
    await page.goto(`${URL}/factures/${factureId}`, { waitUntil: 'networkidle' })
    await page.locator('[data-testid="convert-to-off-stripe-btn"]').click()

    const confirmBtn = page.locator('[data-testid="convert-to-off-stripe-confirm"]')
    await confirmBtn.waitFor({ timeout: 3000 })
    await confirmBtn.click()

    // Après conversion : paid_at doit être NULL, status doit avoir bougé hors de Payé.
    await page.waitForTimeout(800) // laisse l'appel API se terminer + reload du facture
    const after = db.prepare('SELECT status, paid_at, paid_amount FROM factures WHERE id=?').get(factureId)
    assert.equal(after.paid_at, null, 'paid_at doit être NULL après conversion')
    assert.equal(after.paid_amount, null, 'paid_amount doit être NULL après conversion')
    assert.ok(after.status !== 'Payé' && after.status !== 'Payée', `status doit avoir bougé hors de Payé, vu: ${after.status}`)

    // Le formulaire de paiement est ouvert avec la devise CAD préremplie,
    // et la case "Écriture déjà postée dans QuickBooks" est cochée par défaut
    // (l'argent étant typiquement déjà comptabilisé manuellement quand l'invoice
    // Stripe est marquée paid-out-of-band).
    const amountInput = page.locator('[data-testid="payment-amount"]')
    await amountInput.waitFor({ timeout: 3000 })
    assert.equal(await amountInput.isVisible(), true)
    const skipQbCheckbox = page.locator('[data-testid="payment-skip-qb"]')
    await skipQbCheckbox.waitFor({ timeout: 3000 })
    assert.equal(await skipQbCheckbox.isChecked(), true, 'skip_qb doit être coché par défaut après conversion')
  })

  test('le callout disparaît une fois paid_at remis à NULL', async () => {
    // La conversion du test précédent a déjà laissé paid_at à NULL.
    await page.goto(`${URL}/factures/${factureId}`, { waitUntil: 'networkidle' })
    assert.equal(await page.locator('[data-testid="convert-to-off-stripe-btn"]').count(), 0)
    // Et le bouton normal "Paiement (hors Stripe)" doit maintenant être visible.
    const addBtn = page.locator('[data-testid="add-payment-in"]')
    await addBtn.waitFor({ timeout: 3000 })
    assert.equal(await addBtn.isVisible(), true)
  })
})
