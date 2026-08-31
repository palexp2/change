// Carte « Plafond des cartes » du dashboard comptabilité.
//
// Ce qu'on vérifie :
//   1. La MasterCard BNC seedée s'affiche avec ses TROIS chiffres de tête
//      (solde projeté / marge restante / paiement recommandé) et son détail
//      replié sépare bien « comptabilisé » de « en attente ».
//   2. Le calcul du paiement recommandé arrive jusqu'à l'écran : on insère une
//      carte de test dont le solde est connu (aucun compte QuickBooks, aucune
//      transaction bancaire → 0 $ partout) et on vérifie qu'elle n'affiche pas
//      de paiement à faire, puis qu'éditer le plafond en autosave persiste.
//
// Prod = test (même base) : on ne TOUCHE PAS à la config de la vraie
// MasterCard BNC. Toute l'édition se fait sur une carte synthétique préfixée
// `__test_`, supprimée en after().

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = '/home/ec2-user/erp/server/data/erp.db'

// Le montant affiché est formaté fr-CA (« 3 000 $ », espaces insécables) :
// on compare des nombres, jamais des chaînes.
const num = txt => {
  const cleaned = String(txt || '').replace(/[^\d,.-]/g, '').replace(/\s/g, '').replace(',', '.')
  const v = Number(cleaned)
  return Number.isFinite(v) ? v : null
}

describe('Dashboard comptabilité — plafond des cartes', () => {
  let browser, ctx, page, db
  const testCardId = `__test_ceiling_${Date.now()}`
  const testCardName = `__test_carte_plafond_${Date.now()}`

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })
    db.prepare(`
      INSERT INTO card_ceilings (id, name, qb_acctnum, bank_account_id, credit_limit, ceiling, draft_day, currency)
      VALUES (?, ?, NULL, NULL, 5000, 3000, 4, 'CAD')
    `).run(testCardId, testCardName)

    browser = await chromium.launch()
    ctx = await browser.newContext()
    page = await ctx.newPage()
    await page.goto(`${URL}/login`)
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button[type="submit"]')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 30000 })
  })

  after(async () => {
    // Record de test : suppression franche, il n'a jamais rien signifié.
    try { db?.prepare('DELETE FROM card_ceilings WHERE id = ?').run(testCardId) } catch {}
    try { db?.close() } catch {}
    try { await ctx?.close() } catch {}
    try { await browser?.close() } catch {}
  })

  test('la MasterCard BNC affiche ses trois chiffres, détail séparé QB / en attente', async () => {
    await page.goto(`${URL}/comptabilite`)
    const card = page.getByTestId('compta-card-ceilings')
    await card.waitFor({ state: 'visible', timeout: 30000 })

    const row = card.locator('[data-testid="card-ceiling-row"]')
      .filter({ has: page.getByTestId('card-ceiling-name').filter({ hasText: 'MasterCard BNC' }) })
      .first()
    await row.waitFor({ state: 'visible', timeout: 30000 })

    const projected = num(await row.getByTestId('card-ceiling-projected').textContent())
    const room = num(await row.getByTestId('card-ceiling-room').textContent())
    assert.ok(projected !== null, 'le solde projeté doit être un montant')
    assert.ok(room !== null, 'la marge restante doit être un montant')
    // Marge = plafond − projeté : le chiffre affiché doit être cohérent avec
    // lui-même, sinon la carte ment sur ce qu'elle mesure.
    const ceilingSub = await row.getByTestId('card-ceiling-projected').locator('xpath=following-sibling::p').first().textContent()
    const ceiling = num(ceilingSub)
    assert.ok(ceiling !== null, 'le plafond doit être affiché sous le solde projeté')
    assert.ok(Math.abs((ceiling - projected) - room) <= 1, `marge incohérente : ${ceiling} − ${projected} ≠ ${room}`)

    // Détail replié par défaut, ouvert au clic : QB et « en attente » séparés.
    await assert.rejects(
      row.getByTestId('card-ceiling-detail').waitFor({ state: 'visible', timeout: 1500 }),
      'le détail doit être replié au chargement',
    )
    await row.getByTestId('card-ceiling-toggle').click()
    const detail = row.getByTestId('card-ceiling-detail')
    await detail.waitFor({ state: 'visible', timeout: 10000 })
    const posted = num(await detail.getByTestId('card-ceiling-posted').textContent())
    const pending = num(await detail.getByTestId('card-ceiling-pending').textContent())
    assert.ok(posted !== null && pending !== null, 'comptabilisé et en attente doivent être affichés séparément')
    assert.ok(Math.abs((posted + pending) - projected) <= 1, `projeté ≠ comptabilisé + en attente (${posted} + ${pending} ≠ ${projected})`)
  })

  test('une carte sans dépense n\'affiche aucun paiement recommandé, et le plafond s\'autosave', async () => {
    await page.goto(`${URL}/comptabilite`)
    const card = page.getByTestId('compta-card-ceilings')
    await card.waitFor({ state: 'visible', timeout: 30000 })

    const row = card.locator('[data-testid="card-ceiling-row"]')
      .filter({ has: page.getByTestId('card-ceiling-name').filter({ hasText: testCardName }) })
      .first()
    await row.waitFor({ state: 'visible', timeout: 30000 })

    // Solde 0, plafond 3 000 → marge 3 000, rien à payer.
    assert.equal(num(await row.getByTestId('card-ceiling-projected').textContent()), 0)
    assert.equal(num(await row.getByTestId('card-ceiling-room').textContent()), 3000)
    assert.equal((await row.getByTestId('card-ceiling-recommended').textContent()).trim(), '—')

    // Autosave au blur : pas de bouton « Enregistrer ».
    await row.getByTestId('card-ceiling-toggle').click()
    const input = row.getByTestId('card-ceiling-ceiling-input')
    await input.waitFor({ state: 'visible', timeout: 10000 })
    await input.fill('2500')
    await input.blur()
    await page.waitForTimeout(2500)

    // La valeur doit être en base, pas seulement à l'écran.
    const saved = db.prepare('SELECT ceiling FROM card_ceilings WHERE id = ?').get(testCardId)
    assert.equal(saved.ceiling, 2500, 'le plafond doit être sauvegardé sans bouton « Enregistrer »')

    // Et le chiffre du haut doit avoir suivi.
    await page.reload()
    const row2 = page.getByTestId('compta-card-ceilings').locator('[data-testid="card-ceiling-row"]')
      .filter({ has: page.getByTestId('card-ceiling-name').filter({ hasText: testCardName }) })
      .first()
    await row2.waitFor({ state: 'visible', timeout: 30000 })
    assert.equal(num(await row2.getByTestId('card-ceiling-room').textContent()), 2500)
  })

  test('l\'automation d\'alerte est configurable et sa simulation ne rien envoie', async () => {
    await page.goto(`${URL}/automations/sys_card_ceiling_alert`)
    const cfg = page.getByTestId('generic-config')
    await cfg.waitFor({ state: 'visible', timeout: 30000 })
    // Chaque champ affiché DOIT avoir sa clé côté serveur, sinon il s'édite
    // sans jamais être sauvegardé (régression déjà vue sur sys_treasury_alert).
    for (const key of ['acctnums', 'lead_days', 'min_alert_amount', 'pending_lookback_days',
      'lead_always', 'slack_channel', 'slack_webhook_url', 'slack_webhook_env']) {
      await cfg.getByTestId(`generic-config-${key}`).waitFor({ state: 'visible', timeout: 10000 })
    }
    // Le périmètre par défaut pointe bien sur la Mastercard Banque Nationale.
    assert.equal(await cfg.getByTestId('generic-config-acctnums').inputValue(), '22000')
    assert.equal(await cfg.getByTestId('generic-config-lead_days').inputValue(), '5')

    // Simuler : lecture seule, rien ne part sur Slack et aucune alerte n'est
    // consommée pour le mois en cours.
    const before = db.prepare('SELECT COUNT(*) c FROM card_ceiling_alerts').get().c
    await page.getByRole('button', { name: /Simuler/i }).first().click()
    await page.waitForTimeout(6000)
    assert.equal(db.prepare('SELECT COUNT(*) c FROM card_ceiling_alerts').get().c, before,
      'une simulation ne doit jamais consommer l\'anti-doublon d\'alerte')
  })

  test('un plafond au-dessus de la limite de crédit est refusé', async () => {
    await page.goto(`${URL}/comptabilite`)
    const row = page.getByTestId('compta-card-ceilings').locator('[data-testid="card-ceiling-row"]')
      .filter({ has: page.getByTestId('card-ceiling-name').filter({ hasText: testCardName }) })
      .first()
    await row.waitFor({ state: 'visible', timeout: 30000 })
    await row.getByTestId('card-ceiling-toggle').click()
    const input = row.getByTestId('card-ceiling-ceiling-input')
    await input.waitFor({ state: 'visible', timeout: 10000 })
    await input.fill('9000')      // limite = 5 000
    await input.blur()
    await page.waitForTimeout(2500)
    const saved = db.prepare('SELECT ceiling FROM card_ceilings WHERE id = ?').get(testCardId)
    assert.equal(saved.ceiling, 2500, 'un plafond au-dessus de la limite ne doit pas être enregistré')
  })
})
