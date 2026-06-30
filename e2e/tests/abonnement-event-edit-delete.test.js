// Vérifie que l'utilisateur peut modifier et supprimer une entrée dans
// l'historique de changement d'abonnement, depuis la fiche entreprise.
//
// Stratégie : on choisit un abonnement existant qui a déjà des events en DB
// (donc dont le stripe_id résout) et on injecte un event synthétique daté
// dans le futur pour qu'il apparaisse en tête de la liste. On l'édite via
// l'UI (boutons révélés au hover), on le supprime via l'UI, on nettoie.
//
// L'insert direct via better-sqlite3 suit le pattern de
// dashboard-subscription-events.test.js — il n'y a pas de POST /events.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = '/home/ec2-user/erp/server/data/erp.db'

describe("AbonnementDetailModal — édition et suppression d'event d'historique", () => {
  let browser, ctx, page, db
  let subscriptionId = null
  let companyId = null
  const insertedEventIds = []
  let evtId = null

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })

    // Cherche un abonnement actif lié à une entreprise, qui a déjà des events
    // (gage que son stripe_id résout encore et que /stripe-details va répondre).
    const row = db.prepare(`
      SELECT s.id AS sub_id, s.company_id
      FROM subscription_events e
      JOIN subscriptions s ON s.id = e.subscription_id
      WHERE s.stripe_id IS NOT NULL
        AND s.company_id IS NOT NULL
        AND s.status = 'active'
      GROUP BY s.id
      ORDER BY MAX(e.event_date) DESC
      LIMIT 1
    `).get()
    if (!row) throw new Error('Aucun abonnement actif avec events trouvé')
    subscriptionId = row.sub_id
    companyId = row.company_id

    // Event synthétique daté dans le futur → en tête (ORDER event_date DESC)
    const futureDate = new Date(Date.now() + 86400_000).toISOString()
    evtId = `__test_evt_edit_${Date.now()}`
    db.prepare(`
      INSERT INTO subscription_events (id, subscription_id, event_date, event_type, category, currency)
      VALUES (?,?,?,?,?,?)
    `).run(
      evtId,
      subscriptionId,
      futureDate,
      'upgrade',
      'upgrade',
      'CAD',
    )
    insertedEventIds.push(evtId)

    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    page.on('pageerror', err => console.error('PAGEERROR:', err.message))

    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => {
    if (db) {
      try { for (const id of insertedEventIds) db.prepare('DELETE FROM subscription_events WHERE id=?').run(id) }
      catch (e) { console.error('cleanup:', e.message) }
      db.close()
    }
    await browser?.close()
  })

  // Ouvre la fiche entreprise > onglet abonnements et clique le sub qui contient
  // le marqueur de test, en itérant sur les lignes (le row n'expose pas l'id).
  async function openSubDetail() {
    await page.goto(`${URL}/companies/${companyId}`, { waitUntil: 'networkidle' })
    await page.locator('button:has-text("abonnements"), button:has-text("Abonnements")').first().click()
    await page.waitForTimeout(500)

    const rows = page.locator('[data-row-id]')
    const count = await rows.count()
    if (!count) throw new Error("Aucune ligne d'abonnement pour cette entreprise")

    for (let i = 0; i < count; i++) {
      const row = rows.nth(i)
      await row.click()
      // Attend que les details soient chargés OU qu'un message d'erreur apparaisse
      await page.waitForFunction(() => {
        return document.body.innerText.includes('Historique') ||
               document.body.innerText.includes('Impossible de charger')
      }, { timeout: 6000 }).catch(() => null)

      const marker = await page.locator(`[data-testid="event-row-${evtId}"]`).count()
      if (marker > 0) return
      // Pas trouvé — referme la modale (Escape) pour réessayer la ligne suivante.
      // Re-cliquer la ligne ne marche pas : la modale ouverte intercepte le clic.
      await page.keyboard.press('Escape')
      await page.waitForTimeout(250)
    }
    throw new Error(`event-row-${evtId} introuvable dans aucune ligne (parcouru ${count})`)
  }

  test("la ligne d'event affiche les boutons éditer et supprimer", async () => {
    await openSubDetail()
    const row = page.locator(`[data-testid="event-row-${evtId}"]`)
    await row.waitFor({ state: 'visible', timeout: 5000 })
    await row.hover()
    await row.locator('[data-testid="event-edit"]').waitFor({ state: 'visible', timeout: 2000 })
    await row.locator('[data-testid="event-delete"]').waitFor({ state: 'visible', timeout: 2000 })
  })

  // Autosave : les champs persistent on blur (plus de bouton « Enregistrer » sur
  // l'édition d'un record existant). On poll la DB car le PATCH est async.
  async function waitForDb(query, predicate, timeout = 8000) {
    const start = Date.now()
    let last
    while (Date.now() - start < timeout) {
      last = db.prepare(query).get(evtId)
      if (predicate(last)) return last
      await new Promise(r => setTimeout(r, 150))
    }
    throw new Error('waitForDb timeout — dernier état: ' + JSON.stringify(last))
  }

  test("éditer catégorie/montants autosave on blur et auto-recalcule le delta", async () => {
    const row = page.locator(`[data-testid="event-row-${evtId}"]`)
    await row.hover()
    await row.locator('[data-testid="event-edit"]').click()

    const editor = page.locator(`[data-testid="event-row-${evtId}-edit"]`)
    await editor.waitFor({ state: 'visible', timeout: 3000 })

    // Plus aucun bouton « Enregistrer » sur l'édition d'un record existant.
    assert.equal(await editor.locator('button:has-text("Enregistrer")').count(), 0,
      'l\'édition existante ne doit plus avoir de bouton Enregistrer (autosave)')

    // Catégorie = upgrade, prev=100, new=150 → delta auto-calculé doit être 50.
    // Chaque fill suivant blur le champ précédent → autosave.
    await editor.locator('[data-testid="event-category"]').selectOption('upgrade')
    await editor.locator('[data-testid="event-prev-amount"]').fill('100')
    await editor.locator('[data-testid="event-new-amount"]').fill('150')

    // Vérifie que le delta a été auto-recalculé avant de toucher la devise
    const deltaValue = await editor.locator('[data-testid="event-delta"]').inputValue()
    assert.equal(deltaValue, '50', `delta auto-recalculé attendu = 50, observé = ${deltaValue}`)

    await editor.locator('[data-testid="event-currency"]').fill('USD')
    await editor.locator('[data-testid="event-currency"]').blur() // déclenche le dernier autosave

    // Persistance DB sur tous les champs (poll car PATCH async)
    const dbRow = await waitForDb(
      `SELECT category, currency, previous_amount_cad, new_amount_cad, amount_cad_delta
       FROM subscription_events WHERE id=?`,
      r => r && r.currency === 'USD' && r.amount_cad_delta === 50,
    )
    assert.equal(dbRow.category, 'upgrade')
    assert.equal(dbRow.currency, 'USD')
    assert.equal(dbRow.previous_amount_cad, 100)
    assert.equal(dbRow.new_amount_cad, 150)
    assert.equal(dbRow.amount_cad_delta, 50)

    // Referme l'éditeur (action purement locale, pas de save)
    await editor.locator('[data-testid="event-done"]').click()
    await editor.waitFor({ state: 'detached', timeout: 8000 })
  })

  test("override manuel du delta est respecté côté serveur (autosave)", async () => {
    const row = page.locator(`[data-testid="event-row-${evtId}"]`)
    await row.hover()
    await row.locator('[data-testid="event-edit"]').click()

    const editor = page.locator(`[data-testid="event-row-${evtId}-edit"]`)
    await editor.waitFor({ state: 'visible', timeout: 3000 })

    // Override le delta manuellement à 999.99 sans toucher prev/new, puis blur
    await editor.locator('[data-testid="event-delta"]').fill('999.99')
    await editor.locator('[data-testid="event-delta"]').blur()

    await waitForDb(
      'SELECT amount_cad_delta FROM subscription_events WHERE id=?',
      r => r && r.amount_cad_delta === 999.99,
    )

    await editor.locator('[data-testid="event-done"]').click()
    await editor.waitFor({ state: 'detached', timeout: 8000 })
  })

  test("supprimer une entrée la retire de la liste et de la DB", async () => {
    const row = page.locator(`[data-testid="event-row-${evtId}"]`)
    await row.hover()
    await row.locator('[data-testid="event-delete"]').click()

    // ConfirmModal : attend que le titre apparaisse puis clique "Supprimer".
    await page.locator('h2:has-text("Supprimer l\'entrée")').waitFor({ state: 'visible', timeout: 3000 })
    await page.locator('button:has-text("Supprimer")').last().click()

    await row.waitFor({ state: 'detached', timeout: 8000 })

    // Persistance DB
    const dbRow = db.prepare('SELECT id FROM subscription_events WHERE id=?').get(evtId)
    assert.equal(dbRow, undefined, "l'event devrait être supprimé en DB")

    insertedEventIds.length = 0
  })
})
