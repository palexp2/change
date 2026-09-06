// Vérifie que pour les events upgrade/downgrade du panel "Mouvements
// d'abonnements", products[] ne contient QUE les produits affectés par
// le changement (ajoutés / retirés / dont le montant a changé), et non
// la totalité des produits de la dernière facture.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')
const { randomUUID } = require('crypto')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = '/home/ec2-user/erp/server/data/erp.db'

describe('Dashboard — diff produits sur upgrade/downgrade', () => {
  let browser, ctx, page, db, companyId
  const cleanup = { events: [], subs: [], factures: [], items: [] }

  function fmtMonth(d) {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
  }

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })
    const company = db.prepare("SELECT id FROM companies WHERE name IS NOT NULL ORDER BY created_at DESC LIMIT 1").get()
    if (!company) throw new Error('Aucune entreprise en base')
    companyId = company.id

    const now = new Date()
    const thisMonth = fmtMonth(now)
    const eventDateUp = `${thisMonth}-12T12:00:00.000Z`
    const eventDateDown = `${thisMonth}-13T12:00:00.000Z`
    const beforeDate = `${thisMonth}-01`
    const afterDate = `${thisMonth}-15`

    function insertSub(suffix, amountMonthly) {
      const id = `__test_diff_sub_${suffix}_${Date.now()}`
      db.prepare(
        `INSERT INTO subscriptions (id, company_id, stripe_id, status, amount_monthly, currency, interval_type, interval_count)
         VALUES (?,?,?,?,?,?,?,?)`
      ).run(id, companyId, `__test_diff_${suffix}__`, 'active', amountMonthly, 'CAD', 'month', 1)
      cleanup.subs.push(id)
      return id
    }

    function insertFacture(subId, docDate) {
      const id = randomUUID()
      db.prepare(
        `INSERT INTO factures (id, invoice_id, company_id, document_number, document_date,
            status, currency, amount_before_tax_cad, total_amount, balance_due, subscription_id, kind, sync_source)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        id, `__test_diff_inv_${id}__`, companyId, `TEST-${id.slice(0, 8)}`, docDate,
        'Payé', 'CAD', 0, 0, 0, subId, 'subscription', 'Factures Stripe'
      )
      cleanup.factures.push(id)
      return id
    }

    function insertItem(factureId, productName, qty, unitAmountCents) {
      const id = randomUUID()
      db.prepare(
        `INSERT INTO stripe_invoice_items (id, facture_id, stripe_invoice_id, stripe_line_id,
            description, quantity, unit_amount, amount, currency, proration)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).run(
        id, factureId, `__test_inv_${factureId}__`, `__test_li_${id}__`,
        productName, qty, unitAmountCents, qty * unitAmountCents, 'CAD', 0
      )
      cleanup.items.push(id)
      return id
    }

    function insertEvent(subId, eventDate, category, prevCad, newCad) {
      const id = `__test_diff_evt_${randomUUID().slice(0, 8)}_${Date.now()}`
      db.prepare(
        `INSERT INTO subscription_events
            (id, subscription_id, company_id, event_date, event_type, category,
             amount_cad_delta, previous_amount_cad, new_amount_cad, currency)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).run(id, subId, companyId, eventDate, 'update', category,
            newCad - prevCad, prevCad, newCad, 'CAD')
      cleanup.events.push(id)
      return id
    }

    // --- UPGRADE : avant = [Produit A], après = [Produit A, Produit B]
    const subUp = insertSub('upgrade', 75)
    const fUpBefore = insertFacture(subUp, beforeDate)
    insertItem(fUpBefore, '__test_diff_Produit_A__', 1, 5000) // 50.00
    const fUpAfter = insertFacture(subUp, afterDate)
    insertItem(fUpAfter, '__test_diff_Produit_A__', 1, 5000)
    insertItem(fUpAfter, '__test_diff_Produit_B__', 1, 2500) // 25.00 ajouté
    insertEvent(subUp, eventDateUp, 'upgrade', 50, 75)

    // --- DOWNGRADE : avant = [A, B], après = [A]
    const subDown = insertSub('downgrade', 50)
    const fDownBefore = insertFacture(subDown, beforeDate)
    insertItem(fDownBefore, '__test_diff_Produit_A__', 1, 5000)
    insertItem(fDownBefore, '__test_diff_Produit_B__', 1, 2500)
    const fDownAfter = insertFacture(subDown, afterDate)
    insertItem(fDownAfter, '__test_diff_Produit_A__', 1, 5000)
    insertEvent(subDown, eventDateDown, 'downgrade', 75, 50)

    // --- UPGRADE qty change : avant = [A x1], après = [A x2]
    const subQty = insertSub('upgrade_qty', 100)
    const fQtyBefore = insertFacture(subQty, beforeDate)
    insertItem(fQtyBefore, '__test_diff_Produit_C__', 1, 5000)
    const fQtyAfter = insertFacture(subQty, afterDate)
    insertItem(fQtyAfter, '__test_diff_Produit_C__', 2, 5000)
    insertEvent(subQty, eventDateUp, 'upgrade', 50, 100)

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
    if (db) {
      try {
        for (const id of cleanup.events) db.prepare('DELETE FROM subscription_events WHERE id=?').run(id)
        for (const id of cleanup.subs) db.prepare('DELETE FROM subscription_events WHERE subscription_id=?').run(id)
        for (const id of cleanup.items) db.prepare('DELETE FROM stripe_invoice_items WHERE id=?').run(id)
        for (const id of cleanup.factures) db.prepare('DELETE FROM factures WHERE id=?').run(id)
        for (const id of cleanup.subs) db.prepare('DELETE FROM subscriptions WHERE id=?').run(id)
      } catch (e) { console.error('cleanup:', e.message) }
      db.close()
    }
    await browser?.close()
  })

  test('upgrade (ajout produit) → products[] = [Produit B] uniquement', async () => {
    const data = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/dashboard/subscription-events?months=12', { headers: { Authorization: `Bearer ${tok}` } })
      return r.json()
    })
    const all = data.months.flatMap(m => m.categories.upgrade.items)
    const item = all.find(i => i.subscription_id?.startsWith('__test_diff_sub_upgrade_') && !i.subscription_id?.includes('_qty_'))
    assert.ok(item, `event upgrade absent : ${JSON.stringify(all.map(x => x.subscription_id))}`)
    const names = item.products.map(p => p.product_name).sort()
    assert.deepEqual(names, ['__test_diff_Produit_B__'],
      `attendu uniquement Produit_B ajouté, vu : ${JSON.stringify(names)}`)
  })

  test('downgrade (retrait produit) → products[] = [Produit B] uniquement', async () => {
    const data = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/dashboard/subscription-events?months=12', { headers: { Authorization: `Bearer ${tok}` } })
      return r.json()
    })
    const all = data.months.flatMap(m => m.categories.downgrade.items)
    const item = all.find(i => i.subscription_id?.startsWith('__test_diff_sub_downgrade_'))
    assert.ok(item, `event downgrade absent : ${JSON.stringify(all.map(x => x.subscription_id))}`)
    const names = item.products.map(p => p.product_name).sort()
    assert.deepEqual(names, ['__test_diff_Produit_B__'],
      `attendu uniquement Produit_B retiré, vu : ${JSON.stringify(names)}`)
  })

  test('upgrade (qty A x1 → x2) → products[] = [Produit C] (montant augmenté)', async () => {
    const data = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/dashboard/subscription-events?months=12', { headers: { Authorization: `Bearer ${tok}` } })
      return r.json()
    })
    const all = data.months.flatMap(m => m.categories.upgrade.items)
    const item = all.find(i => i.subscription_id?.startsWith('__test_diff_sub_upgrade_qty_'))
    assert.ok(item, `event upgrade qty absent : ${JSON.stringify(all.map(x => x.subscription_id))}`)
    const names = item.products.map(p => p.product_name).sort()
    assert.deepEqual(names, ['__test_diff_Produit_C__'],
      `attendu Produit_C dont la qté a augmenté, vu : ${JSON.stringify(names)}`)
  })
})
