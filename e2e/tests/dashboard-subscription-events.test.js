// Vérifie l'endpoint /api/dashboard/subscription-events et le rendu UI du
// panel "Mouvements d'abonnements". Insère des events de test via la DB pour
// avoir un état déterministe (le backfill Stripe est testé séparément).
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = '/home/ec2-user/erp/server/data/erp.db'

describe('Dashboard — Mouvements d\'abonnements', () => {
  let browser, ctx, page, db
  const insertedEventIds = []
  const insertedSubIds = []
  let testCompanyId = null

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })

    // Trouve une entreprise existante pour rattacher les events de test
    const company = db.prepare("SELECT id, name FROM companies WHERE name IS NOT NULL ORDER BY created_at DESC LIMIT 1").get()
    if (!company) throw new Error('Aucune entreprise en base — impossible de tester')
    testCompanyId = company.id

    // Crée 3 events synthétiques sur un mois récent : 1 new + 1 churn + 1 winback
    // (winback = new pour une company qui a aussi un churn antérieur)
    const now = new Date()
    const thisMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
    const lastMonth = (() => {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15))
      return d.toISOString().slice(0, 10)
    })()
    const today = `${thisMonth}-15T12:00:00.000Z`

    // Sub 1 : new ce mois-ci
    const sub1Id = `__test_sub_new_${Date.now()}`
    db.prepare(`INSERT INTO subscriptions (id, company_id, stripe_id, status, amount_monthly, currency, start_date) VALUES (?,?,?,?,?,?,?)`)
      .run(sub1Id, testCompanyId, '__test_stripe_new__', 'active', 100, 'CAD', `${thisMonth}-15`)
    insertedSubIds.push(sub1Id)
    const evt1 = `__test_evt_new_${Date.now()}`
    db.prepare(`INSERT INTO subscription_events (id, subscription_id, company_id, event_date, event_type, category, amount_cad_delta, new_amount_cad, currency) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(evt1, sub1Id, testCompanyId, today, 'creation', 'new', 100, 100, 'CAD')
    insertedEventIds.push(evt1)

    // Sub 2 : churn ce mois-ci, avec un churn ANTÉRIEUR pour rendre la même company
    // éligible au winback. On ajoute aussi un event new ce mois-ci pour la même
    // company → ce 2e new doit être catégorisé winback.
    const sub2Id = `__test_sub_churn_${Date.now()}`
    db.prepare(`INSERT INTO subscriptions (id, company_id, stripe_id, status, amount_monthly, currency) VALUES (?,?,?,?,?,?)`)
      .run(sub2Id, testCompanyId, '__test_stripe_churn__', 'canceled', 80, 'CAD')
    insertedSubIds.push(sub2Id)
    const evt2 = `__test_evt_churn_${Date.now()}`
    // Churn ANTÉRIEUR (mois précédent) — pour que le new soit win-back
    db.prepare(`INSERT INTO subscription_events (id, subscription_id, company_id, event_date, event_type, category, amount_cad_delta, previous_amount_cad, currency) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(evt2, sub2Id, testCompanyId, `${lastMonth}T10:00:00.000Z`, 'cancel', 'churn', -80, 80, 'CAD')
    insertedEventIds.push(evt2)

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
        for (const id of insertedEventIds) db.prepare('DELETE FROM subscription_events WHERE id=?').run(id)
        for (const id of insertedSubIds) db.prepare('DELETE FROM subscription_events WHERE subscription_id=?').run(id)
        for (const id of insertedSubIds) db.prepare('DELETE FROM subscriptions WHERE id=?').run(id)
      } catch (e) { console.error('cleanup:', e.message) }
      db.close()
    }
    await browser?.close()
  })

  test('endpoint /api/dashboard/subscription-events retourne months[]', async () => {
    const data = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/dashboard/subscription-events?months=12', { headers: { Authorization: `Bearer ${tok}` } })
      return r.json()
    })
    assert.ok(Array.isArray(data.months), 'months doit être un array')
    assert.ok(data.months.length > 0, 'aucun mois retourné — events non visibles')
    // Vérifie la structure d'un mois
    const m = data.months[0]
    assert.ok(typeof m.month === 'string' && /^\d{4}-\d{2}$/.test(m.month), `month invalide: ${m.month}`)
    assert.ok(m.categories.new, 'categories.new manquant')
    assert.ok(m.categories.churn, 'categories.churn manquant')
    assert.ok(m.categories.winback, 'categories.winback manquant')
    assert.equal(typeof m.net_mrr_delta_cad, 'number', 'net_mrr_delta_cad doit être un number')
  })

  test('le mois courant contient le sub new injecté avec montant +100', async () => {
    const now = new Date()
    const thisMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
    const data = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/dashboard/subscription-events?months=12', { headers: { Authorization: `Bearer ${tok}` } })
      return r.json()
    })
    const monthRow = data.months.find(m => m.month === thisMonth)
    assert.ok(monthRow, `mois courant ${thisMonth} absent`)
    // Le sub injecté est en winback (car la même company a un churn antérieur).
    // Donc on doit voir au moins 1 winback de 100 ce mois-ci.
    assert.ok(monthRow.categories.winback.count >= 1, `winback count: ${monthRow.categories.winback.count}`)
    const item = monthRow.categories.winback.items.find(i => i.amount_cad_delta === 100)
    assert.ok(item, `winback de 100 absent: ${JSON.stringify(monthRow.categories.winback.items)}`)
  })

  test('panel UI affiche le tableau "Mouvements d\'abonnements"', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="section-subscription-events"]', { timeout: 10000 })
    // Le titre du panel
    const title = await page.locator('[data-testid="section-subscription-events"] h2').innerText()
    assert.match(title, /Mouvements d'abonnements/, `titre inattendu: ${title}`)
    // Au moins une ligne de mois
    const rowCount = await page.locator('[data-testid^="sub-events-month-"]').count()
    assert.ok(rowCount > 0, 'aucune ligne de mois dans le panel')
  })

  test('cliquer sur une ligne de mois déplie le détail des entreprises', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="section-subscription-events"]', { timeout: 10000 })
    const firstRow = page.locator('[data-testid^="sub-events-month-"]').first()
    await firstRow.click()
    await page.waitForTimeout(300)
    // Une section détail devrait apparaître contenant au moins une catégorie titre
    const hasDetail = await page.locator('text=/Nouveaux abonnements|Annulations|Win-back/').first().isVisible()
    assert.ok(hasDetail, 'détail non visible après clic')
  })
})
