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

    // Crée 4 events synthétiques sur un mois récent : 1 creation + 1 churn
    // antérieur + 1 upgrade + 1 downgrade. Note : la catégorie 'winback' a
    // été retirée — toute creation/reactivation tombe maintenant dans 'creation'.
    const now = new Date()
    const thisMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
    const lastMonth = (() => {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15))
      return d.toISOString().slice(0, 10)
    })()
    const today = `${thisMonth}-15T12:00:00.000Z`

    // Sub 1 : creation ce mois-ci — facturation ANNUELLE
    const sub1Id = `__test_sub_new_${Date.now()}`
    db.prepare(`INSERT INTO subscriptions (id, company_id, stripe_id, status, amount_monthly, currency, start_date, interval_type, interval_count) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(sub1Id, testCompanyId, '__test_stripe_new__', 'active', 100, 'CAD', `${thisMonth}-15`, 'year', 1)
    insertedSubIds.push(sub1Id)
    const evt1 = `__test_evt_new_${Date.now()}`
    db.prepare(`INSERT INTO subscription_events (id, subscription_id, company_id, event_date, event_type, category, amount_cad_delta, new_amount_cad, currency) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(evt1, sub1Id, testCompanyId, today, 'creation', 'creation', 100, 100, 'CAD')
    insertedEventIds.push(evt1)

    // Sub 2 : churn antérieur (mois précédent). La creation du sub 1 reste
    // dans 'creation' (la catégorie winback a été retirée).
    const sub2Id = `__test_sub_churn_${Date.now()}`
    db.prepare(`INSERT INTO subscriptions (id, company_id, stripe_id, status, amount_monthly, currency, interval_type, interval_count) VALUES (?,?,?,?,?,?,?,?)`)
      .run(sub2Id, testCompanyId, '__test_stripe_churn__', 'canceled', 80, 'CAD', 'month', 1)
    insertedSubIds.push(sub2Id)
    const evt2 = `__test_evt_churn_${Date.now()}`
    // Churn ANTÉRIEUR (mois précédent) — pour que la creation soit win-back
    db.prepare(`INSERT INTO subscription_events (id, subscription_id, company_id, event_date, event_type, category, amount_cad_delta, previous_amount_cad, currency) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(evt2, sub2Id, testCompanyId, `${lastMonth}T10:00:00.000Z`, 'churn', 'churn', -80, 80, 'CAD')
    insertedEventIds.push(evt2)

    // Sub 3 : upgrade ce mois-ci (50 → 75)
    const sub3Id = `__test_sub_upgrade_${Date.now()}`
    db.prepare(`INSERT INTO subscriptions (id, company_id, stripe_id, status, amount_monthly, currency, interval_type, interval_count) VALUES (?,?,?,?,?,?,?,?)`)
      .run(sub3Id, testCompanyId, '__test_stripe_upgrade__', 'active', 75, 'CAD', 'month', 1)
    insertedSubIds.push(sub3Id)
    const evt3 = `__test_evt_upgrade_${Date.now()}`
    db.prepare(`INSERT INTO subscription_events (id, subscription_id, company_id, event_date, event_type, category, amount_cad_delta, previous_amount_cad, new_amount_cad, currency) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(evt3, sub3Id, testCompanyId, `${thisMonth}-10T12:00:00.000Z`, 'update', 'upgrade', 25, 50, 75, 'CAD')
    insertedEventIds.push(evt3)

    // Sub 4 : downgrade ce mois-ci (90 → 60)
    const sub4Id = `__test_sub_downgrade_${Date.now()}`
    db.prepare(`INSERT INTO subscriptions (id, company_id, stripe_id, status, amount_monthly, currency, interval_type, interval_count) VALUES (?,?,?,?,?,?,?,?)`)
      .run(sub4Id, testCompanyId, '__test_stripe_downgrade__', 'active', 60, 'CAD', 'month', 1)
    insertedSubIds.push(sub4Id)
    const evt4 = `__test_evt_downgrade_${Date.now()}`
    db.prepare(`INSERT INTO subscription_events (id, subscription_id, company_id, event_date, event_type, category, amount_cad_delta, previous_amount_cad, new_amount_cad, currency) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(evt4, sub4Id, testCompanyId, `${thisMonth}-11T12:00:00.000Z`, 'update', 'downgrade', -30, 90, 60, 'CAD')
    insertedEventIds.push(evt4)

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
    assert.ok(m.categories.creation, 'categories.creation manquant')
    assert.ok(m.categories.churn, 'categories.churn manquant')
    assert.ok(m.categories.upgrade, 'categories.upgrade manquant')
    assert.ok(m.categories.downgrade, 'categories.downgrade manquant')
    assert.equal(typeof m.net_mrr_delta_cad, 'number', 'net_mrr_delta_cad doit être un number')
  })

  test('le mois courant contient les events upgrade et downgrade injectés', async () => {
    const now = new Date()
    const thisMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
    const data = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/dashboard/subscription-events?months=12', { headers: { Authorization: `Bearer ${tok}` } })
      return r.json()
    })
    const monthRow = data.months.find(m => m.month === thisMonth)
    assert.ok(monthRow, `mois courant ${thisMonth} absent`)
    assert.ok(monthRow.categories.upgrade.count >= 1, `upgrade count: ${monthRow.categories.upgrade.count}`)
    const upItem = monthRow.categories.upgrade.items.find(i => i.amount_cad_delta === 25)
    assert.ok(upItem, `upgrade de +25 absent: ${JSON.stringify(monthRow.categories.upgrade.items)}`)
    assert.ok(monthRow.categories.downgrade.count >= 1, `downgrade count: ${monthRow.categories.downgrade.count}`)
    const downItem = monthRow.categories.downgrade.items.find(i => i.amount_cad_delta === -30)
    assert.ok(downItem, `downgrade de -30 absent: ${JSON.stringify(monthRow.categories.downgrade.items)}`)
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
    // Toute creation/reactivation tombe désormais dans 'creation' (la catégorie
    // winback a été retirée). On doit voir le sub injecté de +100 ce mois-ci.
    assert.ok(monthRow.categories.creation.count >= 1, `creation count: ${monthRow.categories.creation.count}`)
    const item = monthRow.categories.creation.items.find(i => i.amount_cad_delta === 100)
    assert.ok(item, `creation de 100 absent: ${JSON.stringify(monthRow.categories.creation.items)}`)
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
    // Les colonnes Upgrades et Downgrades doivent être dans l'en-tête
    const headerText = await page.locator('[data-testid="section-subscription-events"] thead').innerText()
    assert.match(headerText, /Upgrades/i, `colonne Upgrades absente: ${headerText}`)
    assert.match(headerText, /Downgrades/i, `colonne Downgrades absente: ${headerText}`)
  })

  test('cellules Nouveaux/Upgrades/Downgrades/Annulations ne montrent que le montant $ (pas le compteur)', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="section-subscription-events"]', { timeout: 10000 })
    const rows = await page.locator('[data-testid^="sub-events-month-"]').all()
    assert.ok(rows.length > 0, 'aucune ligne de mois')
    // Ordre des colonnes dans <tr> : Mois, Net MRR, Nouveaux, Upgrades, Downgrades, Annulations, chevron
    // Les cellules d'index 2..5 doivent contenir soit un montant ($) soit le tiret "—".
    // Aucune d'entre elles ne doit afficher un compteur d'occurrences seul.
    let nonEmptyCellsChecked = 0
    for (const row of rows) {
      const cells = await row.locator('td').all()
      for (let i = 2; i <= 5; i++) {
        const text = (await cells[i].innerText()).trim()
        const isAmount = /\$/.test(text)
        const isEmpty = text === '—'
        assert.ok(isAmount || isEmpty, `cellule ${i} contenu inattendu: "${text}" — doit être un montant $ ou "—"`)
        if (isAmount) nonEmptyCellsChecked += 1
      }
    }
    assert.ok(nonEmptyCellsChecked > 0, 'aucune cellule de mouvement avec montant — données absentes pour valider le format')
  })

  test('cliquer sur une ligne de mois déplie le détail des entreprises', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="section-subscription-events"]', { timeout: 10000 })
    const firstRow = page.locator('[data-testid^="sub-events-month-"]').first()
    await firstRow.click()
    await page.waitForTimeout(300)
    // Une section détail devrait apparaître contenant au moins une catégorie titre
    const hasDetail = await page.locator('text=/Nouveaux abonnements|Annulations|Upgrades|Downgrades/').first().isVisible()
    assert.ok(hasDetail, 'détail non visible après clic')
  })

  test('le détail du mois courant montre les sections Upgrades et Downgrades', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="section-subscription-events"]', { timeout: 10000 })
    const now = new Date()
    const thisMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
    const monthRow = page.locator(`[data-testid="sub-events-month-${thisMonth}"]`)
    await monthRow.click()
    await page.waitForTimeout(300)
    const upgradeTitle = page.locator('text=/^Upgrades \\(/').first()
    const downgradeTitle = page.locator('text=/^Downgrades \\(/').first()
    assert.ok(await upgradeTitle.isVisible(), 'section Upgrades non visible')
    assert.ok(await downgradeTitle.isVisible(), 'section Downgrades non visible')
  })

  test('endpoint retourne products[] sur les items quand une facture liée existe', async () => {
    // Cherche n'importe quel mois où un sub a des produits attachés
    const data = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/dashboard/subscription-events?months=24', { headers: { Authorization: `Bearer ${tok}` } })
      return r.json()
    })
    let foundProducts = false
    let sampleItem = null
    for (const m of data.months) {
      for (const cat of ['creation', 'churn']) {
        for (const it of m.categories[cat].items) {
          assert.ok(Array.isArray(it.products), 'chaque item doit avoir products[]')
          if (it.products.length > 0) {
            foundProducts = true
            sampleItem = it
            for (const p of it.products) {
              assert.ok(typeof p.product_name === 'string' && p.product_name.length > 0, 'product_name requis')
              assert.ok('product_id' in p, 'product_id (peut être null) requis')
              assert.ok(typeof p.quantity === 'number', 'quantity numérique')
            }
          }
        }
      }
    }
    assert.ok(foundProducts, 'aucun item avec products[] non vide — la jointure factures/items est cassée')
    console.log('  → exemple item avec produits:', sampleItem.company_name, '→', sampleItem.products.map(p => p.product_name).join(', '))
  })

  test('endpoint expose interval_type/interval_count sur les items', async () => {
    const data = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/dashboard/subscription-events?months=12', { headers: { Authorization: `Bearer ${tok}` } })
      return r.json()
    })
    // Recherche du sub1 (yearly) et du sub2 (monthly) injectés
    let yearItem = null
    let monthItem = null
    for (const m of data.months) {
      for (const cat of ['creation', 'churn']) {
        for (const it of m.categories[cat].items) {
          if (it.subscription_id?.startsWith('__test_sub_new_')) yearItem = it
          if (it.subscription_id?.startsWith('__test_sub_churn_')) monthItem = it
        }
      }
    }
    assert.ok(yearItem, 'item du sub yearly absent du payload')
    assert.equal(yearItem.interval_type, 'year', `interval_type attendu year, reçu ${yearItem.interval_type}`)
    assert.equal(yearItem.interval_count, 1)
    assert.ok(monthItem, 'item du sub monthly absent du payload')
    assert.equal(monthItem.interval_type, 'month', `interval_type attendu month, reçu ${monthItem.interval_type}`)
  })

  test('UI : badge "(X $/an)"/"Mensuel" affiché à côté du montant des items', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="section-subscription-events"]', { timeout: 10000 })
    // Déplie tous les mois pour exposer les items
    const rows = await page.locator('[data-testid^="sub-events-month-"]').all()
    for (const r of rows) await r.click()
    await page.waitForTimeout(300)

    // Au moins un badge annuel "(… /an)" et un badge "Mensuel" doivent être visibles
    // (les sub injectés en setup ont l'un et l'autre)
    const intervalBadges = page.locator('[data-testid^="sub-event-interval-"]')
    const count = await intervalBadges.count()
    assert.ok(count > 0, 'aucun badge interval visible — la prop interval_type n\'est pas rendue')

    const allTexts = await intervalBadges.allInnerTexts()
    // Les abonnements annuels affichent maintenant le montant annuel entre parenthèses
    // PRÉCÉDÉ d'un signe +/- pour indiquer le sens du mouvement, ex. "(+1 200 $/an)" ou "(-960 $/an)"
    const annualBadges = allTexts.filter(t => /\/an\)$/.test(t.trim()))
    assert.ok(annualBadges.length > 0,
      `aucun badge annuel "(±X $/an)" parmi: ${JSON.stringify(allTexts)}`)
    for (const b of annualBadges) {
      assert.ok(/^\(([+-]).+\/an\)$/.test(b.trim()),
        `badge annuel sans signe +/- : "${b}"`)
    }
    assert.ok(allTexts.includes('Mensuel'), `aucun badge "Mensuel" parmi: ${JSON.stringify(allTexts)}`)
  })

  test('upgrade/downgrade : le diff des items vient des snapshots before/after quand disponibles', async () => {
    // Insère un upgrade de test avec items_before/after_json explicite. La
    // route doit renvoyer dans products[] *seulement* le delta (items ajoutés
    // pour upgrade, items retirés pour downgrade), pas les snapshots entiers.
    const subId = `__test_sub_snap_up_${Date.now()}`
    db.prepare(`INSERT INTO subscriptions (id, company_id, stripe_id, status, amount_monthly, currency, interval_type, interval_count) VALUES (?,?,?,?,?,?,?,?)`)
      .run(subId, testCompanyId, `__test_stripe_snap_up_${Date.now()}`, 'active', 130, 'CAD', 'month', 1)
    insertedSubIds.push(subId)
    const evtId = `__test_evt_snap_up_${Date.now()}`
    const before = JSON.stringify([
      { stripe_price_id: 'price_A', stripe_product_id: 'prod_A', name: 'Widget A', quantity: 1, unit_amount: 10000, currency: 'CAD' },
      { stripe_price_id: 'price_B', stripe_product_id: 'prod_B', name: 'Widget B', quantity: 1, unit_amount: 5000, currency: 'CAD' },
    ])
    const after = JSON.stringify([
      { stripe_price_id: 'price_A', stripe_product_id: 'prod_A', name: 'Widget A', quantity: 1, unit_amount: 10000, currency: 'CAD' },
      { stripe_price_id: 'price_B', stripe_product_id: 'prod_B', name: 'Widget B', quantity: 1, unit_amount: 5000, currency: 'CAD' },
      { stripe_price_id: 'price_C', stripe_product_id: 'prod_C', name: 'Widget C (added)', quantity: 1, unit_amount: 3000, currency: 'CAD' },
    ])
    const now = new Date()
    const thisMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
    db.prepare(`INSERT INTO subscription_events (id, subscription_id, company_id, event_date, event_type, category, amount_cad_delta, previous_amount_cad, new_amount_cad, currency, items_before_json, items_after_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(evtId, subId, testCompanyId, `${thisMonth}-12T12:00:00.000Z`, 'update', 'upgrade', 30, 150, 180, 'CAD', before, after)
    insertedEventIds.push(evtId)

    const data = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/dashboard/subscription-events?months=12', { headers: { Authorization: `Bearer ${tok}` } })
      return r.json()
    })
    const monthRow = data.months.find(m => m.month === thisMonth)
    assert.ok(monthRow, `mois courant ${thisMonth} absent`)
    const item = monthRow.categories.upgrade.items.find(i => i.subscription_id === subId)
    assert.ok(item, `event upgrade snapshot non trouvé`)
    assert.ok(Array.isArray(item.products), 'products[] requis')
    assert.equal(item.products.length, 1, `attendu 1 produit ajouté, reçu ${item.products.length}: ${JSON.stringify(item.products)}`)
    assert.equal(item.products[0].product_name, 'Widget C (added)')
  })

  test('cliquer sur le nom d\'un mouvement ouvre la modale de l\'abonnement', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="section-subscription-events"]', { timeout: 10000 })

    // Déplie le premier mois disponible
    const firstRow = page.locator('[data-testid^="sub-events-month-"]').first()
    await firstRow.click()

    // Clique sur le bouton du premier mouvement déplié
    const firstEventBtn = page.locator('[data-testid^="sub-event-open-"]').first()
    await firstEventBtn.waitFor({ state: 'visible', timeout: 5000 })
    await firstEventBtn.click()

    // La modale "Détails de l'abonnement" doit s'ouvrir
    const modalTitle = page.locator('text=Détails de l\'abonnement')
    await modalTitle.waitFor({ state: 'visible', timeout: 5000 })
    assert.ok(await modalTitle.isVisible(), 'modale d\'abonnement non visible après clic sur le mouvement')
  })
})
