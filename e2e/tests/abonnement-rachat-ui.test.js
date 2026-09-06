// Vérifie le rendu UI du rachat post-churn :
// - Page Mouvements d'abonnements : badge "Vérifier" sur ligne de churn,
//   menu déroulant qui change le statut, lien vers la commande lorsque
//   rachat_status='probable'/'confirmed'.
// - Panel Dashboard : affiche le badge rachat sous une annulation (lecture
//   seule, pas d'interaction).

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = '/home/ec2-user/erp/server/data/erp.db'

describe("Rachat post-churn — UI Mouvements + Dashboard", () => {
  let browser, ctx, page, db
  let companyId = null
  let subId = null
  let churnEventId = null
  let orderId = null
  const insertedEventIds = []
  const insertedSubIds = []
  const insertedOrderIds = []

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })

    const company = db.prepare("SELECT id FROM companies WHERE name IS NOT NULL ORDER BY created_at DESC LIMIT 1").get()
    if (!company) throw new Error('Aucune entreprise en base')
    companyId = company.id

    // Sub annulé + churn ce mois-ci pour qu'il apparaisse dans le panel dashboard.
    subId = `__rachat_ui_sub_${Date.now()}`
    db.prepare(`INSERT INTO subscriptions (id, company_id, status, amount_monthly, currency, interval_type, interval_count) VALUES (?,?,?,?,?,?,?)`)
      .run(subId, companyId, 'canceled', 100, 'CAD', 'month', 1)
    insertedSubIds.push(subId)

    // Churn 5 jours dans le passé pour qu'il soit dans le mois courant.
    const churnDate = new Date(Date.now() - 5 * 86400_000).toISOString()
    churnEventId = `__rachat_ui_evt_${Date.now()}`
    db.prepare(`
      INSERT INTO subscription_events (id, subscription_id, company_id, event_date, event_type, category, amount_cad_delta, previous_amount_cad, currency)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(churnEventId, subId, companyId, churnDate, 'churn', 'churn', -100, 100, 'CAD')
    insertedEventIds.push(churnEventId)

    // Commande postérieure 2 jours après le churn, total ≥ 1200 CAD pour
    // déclencher la détection.
    const orderDate = new Date(Date.now() - 3 * 86400_000)
    orderId = `__rachat_ui_order_${Date.now()}`
    const maxN = db.prepare('SELECT MAX(order_number) AS m FROM orders').get()
    const orderNumber = (maxN?.m || 0) + 1
    db.prepare(`
      INSERT INTO orders (id, order_number, company_id, status, date_commande, is_subscription, created_at)
      VALUES (?,?,?,?,?,0,?)
    `).run(orderId, orderNumber, companyId, 'Envoyé', orderDate.toISOString().slice(0, 10), orderDate.toISOString())
    insertedOrderIds.push(orderId)
    db.prepare(`
      INSERT INTO order_items (id, order_id, qty, unit_cost, item_type)
      VALUES (?,?,1,1500,'Facturable')
    `).run(`__rachat_ui_oi_${Date.now()}`, orderId)

    // Login + détection initiale via API
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    page.on('pageerror', err => console.error('PAGEERROR:', err.message))

    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    // Déclenche la détection auto sur l'event de test
    await page.evaluate(async (id) => {
      const tok = localStorage.getItem('erp_token')
      await fetch(`/erp/api/projets/abonnement-events/${id}/detect-rachat`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}` },
      })
    }, churnEventId)
  })

  after(async () => {
    if (db) {
      try {
        for (const id of insertedEventIds) db.prepare('DELETE FROM subscription_events WHERE id=?').run(id)
        for (const id of insertedSubIds) db.prepare('DELETE FROM subscriptions WHERE id=?').run(id)
        for (const id of insertedOrderIds) {
          db.prepare('DELETE FROM order_items WHERE order_id=?').run(id)
          db.prepare('DELETE FROM orders WHERE id=?').run(id)
        }
      } catch (e) { console.error('cleanup:', e.message) }
      db.close()
    }
    await browser?.close()
  })

  test("Page Mouvements d'abonnements affiche badge 'Rachat probable' + lien commande", async () => {
    await page.goto(URL + '/abonnements/mouvements', { waitUntil: 'networkidle' })
    // Attend que la table charge
    await page.waitForSelector(`[data-testid="rachat-picker-${churnEventId}"]`, { timeout: 10000 })

    const picker = page.locator(`[data-testid="rachat-picker-${churnEventId}"]`)
    const txt = await picker.innerText()
    assert.match(txt, /Rachat probable/i, `attendu 'Rachat probable', vu: ${txt}`)

    // Lien vers la commande candidate
    const orderLink = page.locator(`[data-testid="rachat-order-link-${churnEventId}"]`)
    await orderLink.waitFor({ state: 'visible', timeout: 3000 })
    assert.ok(await orderLink.count() > 0, 'lien vers la commande attendu')
  })

  test("Cliquer sur le picker ouvre le menu et permet de basculer le statut", async () => {
    await page.goto(URL + '/abonnements/mouvements', { waitUntil: 'networkidle' })
    await page.waitForSelector(`[data-testid="rachat-picker-${churnEventId}"]`, { timeout: 10000 })

    await page.locator(`[data-testid="rachat-picker-${churnEventId}"]`).click()
    const menu = page.locator(`[data-testid="rachat-picker-menu-${churnEventId}"]`)
    await menu.waitFor({ state: 'visible', timeout: 2000 })

    await page.locator(`[data-testid="rachat-option-${churnEventId}-confirmed"]`).click()
    // Attend la persistance (autosave)
    await page.waitForTimeout(800)

    const dbRow = db.prepare('SELECT rachat_status FROM subscription_events WHERE id=?').get(churnEventId)
    assert.equal(dbRow.rachat_status, 'confirmed', `attendu 'confirmed' en DB, vu ${dbRow.rachat_status}`)

    // Le badge doit refléter le nouveau statut
    const txt = await page.locator(`[data-testid="rachat-picker-${churnEventId}"]`).innerText()
    assert.match(txt, /Rachat confirmé/i, `attendu 'Rachat confirmé', vu: ${txt}`)
  })

  test("Bascule à 'none' → pas de lien commande", async () => {
    await page.locator(`[data-testid="rachat-picker-${churnEventId}"]`).click()
    await page.locator(`[data-testid="rachat-picker-menu-${churnEventId}"]`).waitFor({ state: 'visible', timeout: 2000 })
    await page.locator(`[data-testid="rachat-option-${churnEventId}-none"]`).click()
    await page.waitForTimeout(800)

    const dbRow = db.prepare('SELECT rachat_status FROM subscription_events WHERE id=?').get(churnEventId)
    assert.equal(dbRow.rachat_status, 'none')

    // Le lien commande ne doit plus être affiché
    const linkCount = await page.locator(`[data-testid="rachat-order-link-${churnEventId}"]`).count()
    assert.equal(linkCount, 0, "lien commande ne doit pas apparaître quand status='none'")
  })

  test("Dashboard panel mouvements affiche le badge sous l'annulation", async () => {
    // Remet à 'confirmed' pour le test d'affichage
    await page.evaluate(async (id) => {
      const tok = localStorage.getItem('erp_token')
      await fetch(`/erp/api/projets/abonnement-events/${id}/rachat`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'confirmed' }),
      })
    }, churnEventId)

    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })
    // Attend que le panel charge (DataTable rend les groupes mois niveau 0)
    await page.waitForSelector('[data-testid^="datatable-group-"][data-group-level="0"]', { timeout: 15000 })
    await page.waitForTimeout(500)

    // Le badge rachat doit apparaître (RachatPicker partagé avec la page Mouvements).
    // Les groupes mois sont dépliés par défaut, donc le badge devrait être directement visible.
    const badge = page.locator(`[data-testid="rachat-picker-${churnEventId}"]`)
    await badge.waitFor({ state: 'visible', timeout: 5000 })
    const txt = await badge.innerText()
    assert.match(txt, /Rachat confirmé/i, `attendu 'Rachat confirmé' dans le badge dashboard, vu: ${txt}`)

    // Lien commande visible (même testid que sur la page Mouvements)
    const link = page.locator(`[data-testid="rachat-order-link-${churnEventId}"]`)
    assert.ok(await link.count() > 0, 'lien commande attendu dans le panel dashboard')
  })
})
