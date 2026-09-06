// Vérifie que l'utilisateur peut ajouter manuellement une entrée dans
// l'historique de changement d'abonnement, depuis la fiche entreprise.
//
// Pattern aligné sur abonnement-event-edit-delete.test.js : on choisit un
// abonnement existant qui a déjà des events (pour que /stripe-details résolve),
// on ouvre la modale via la fiche entreprise, on clique "Ajouter une entrée",
// on remplit le formulaire, on enregistre et on vérifie la persistance en DB,
// puis on nettoie l'event créé.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = '/home/ec2-user/erp/server/data/erp.db'

describe("AbonnementDetailModal — ajout manuel d'event d'historique", () => {
  let browser, ctx, page, db
  let subscriptionId = null
  let companyId = null
  const createdEventIds = []

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })

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
      try { for (const id of createdEventIds) db.prepare('DELETE FROM subscription_events WHERE id=?').run(id) }
      catch (e) { console.error('cleanup:', e.message) }
      db.close()
    }
    await browser?.close()
  })

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
      await page.waitForFunction(() => {
        return document.body.innerText.includes('Historique') ||
               document.body.innerText.includes('Impossible de charger')
      }, { timeout: 6000 }).catch(() => null)

      const subUuidAttr = await page.locator('[data-testid^="event-row-"]').first().getAttribute('data-testid').catch(() => null)
      // On vérifie qu'on est sur le bon sub en regardant la présence du bouton "Ajouter"
      if (await page.locator('[data-testid="event-add"]').count() > 0) {
        // OK, modale ouverte ; on prend cette sub si elle correspond
        // (toutes les subs de la company ouvrent une modale ; on accepte la première)
        void subUuidAttr
        return
      }
      await row.click()
      await page.waitForTimeout(150)
    }
    throw new Error("Modale d'abonnement avec bouton Ajouter introuvable")
  }

  test("ajouter une entrée la persiste en DB et l'affiche dans l'historique", async () => {
    await openSubDetail()

    const addBtn = page.locator('[data-testid="event-add"]')
    await addBtn.waitFor({ state: 'visible', timeout: 5000 })

    // Compte les events existants pour ce sub avant l'ajout
    const beforeCount = db.prepare(
      'SELECT COUNT(*) AS n FROM subscription_events WHERE subscription_id=?'
    ).get(subscriptionId).n

    await addBtn.click()

    const editor = page.locator('[data-testid="event-row-new"]')
    await editor.waitFor({ state: 'visible', timeout: 3000 })

    // Catégorie = upgrade, prev=200, new=275 → delta auto = 75
    await editor.locator('[data-testid="event-category"]').selectOption('upgrade')
    await editor.locator('[data-testid="event-prev-amount"]').fill('200')
    await editor.locator('[data-testid="event-new-amount"]').fill('275')
    await editor.locator('[data-testid="event-currency"]').fill('CAD')

    const deltaValue = await editor.locator('[data-testid="event-delta"]').inputValue()
    assert.equal(deltaValue, '75', `delta auto attendu = 75, observé = ${deltaValue}`)

    await editor.locator('[data-testid="event-save"]').click()
    await editor.waitFor({ state: 'detached', timeout: 8000 })

    // Persistance DB : un nouvel event a été créé sur ce sub
    const after = db.prepare(`
      SELECT id, category, currency, previous_amount_cad, new_amount_cad, amount_cad_delta
      FROM subscription_events
      WHERE subscription_id=? AND category='upgrade' AND previous_amount_cad=200 AND new_amount_cad=275
      ORDER BY event_date DESC LIMIT 1
    `).get(subscriptionId)
    assert.ok(after, 'event créé introuvable en DB')
    createdEventIds.push(after.id)

    assert.equal(after.currency, 'CAD')
    assert.equal(after.previous_amount_cad, 200)
    assert.equal(after.new_amount_cad, 275)
    assert.equal(after.amount_cad_delta, 75)

    const afterCount = db.prepare(
      'SELECT COUNT(*) AS n FROM subscription_events WHERE subscription_id=?'
    ).get(subscriptionId).n
    assert.equal(afterCount, beforeCount + 1)
  })

  test("annuler ferme le formulaire sans créer d'entrée", async () => {
    const beforeCount = db.prepare(
      'SELECT COUNT(*) AS n FROM subscription_events WHERE subscription_id=?'
    ).get(subscriptionId).n

    await page.locator('[data-testid="event-add"]').click()
    const editor = page.locator('[data-testid="event-row-new"]')
    await editor.waitFor({ state: 'visible', timeout: 3000 })
    await editor.locator('button:has-text("Annuler")').click()
    await editor.waitFor({ state: 'detached', timeout: 3000 })

    const afterCount = db.prepare(
      'SELECT COUNT(*) AS n FROM subscription_events WHERE subscription_id=?'
    ).get(subscriptionId).n
    assert.equal(afterCount, beforeCount, "aucun event ne doit être créé après annulation")
  })
})
