// Vérifie que POST /api/payments avec skip_qb=true crée la row payment SANS
// poster d'écriture QB. Cas d'usage : facture Stripe paid-out-of-band dont
// l'encaissement réel (Interac, virement, chèque) a déjà été enregistré
// manuellement dans QuickBooks par le comptable.
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

describe('POST /api/payments — skip_qb', () => {
  let browser, ctx, page, db, factureId, paymentId, companyId, token

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })
    const co = db.prepare("SELECT id FROM companies ORDER BY created_at DESC LIMIT 1").get()
    if (!co) throw new Error('Aucune entreprise en base pour le test')
    companyId = co.id

    factureId = randomUUID()
    const today = new Date().toISOString().slice(0, 10)
    db.prepare(`
      INSERT INTO factures (
        id, invoice_id, company_id, document_number, document_date, due_date,
        status, currency, amount_before_tax_cad, total_amount, balance_due,
        kind, sync_source, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `).run(
      factureId,
      `__e2e_skipqb_${factureId}__`,
      companyId,
      `E2E-SKIP-${factureId.slice(0, 8)}`,
      today,
      today,
      'En retard',
      'CAD',
      100.00,
      114.98,
      114.98,
      'order',
      'E2E test',
    )

    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    token = await page.evaluate(() => localStorage.getItem('erp_token'))
    if (!token) throw new Error('Token introuvable après login')
  })

  after(async () => {
    try {
      if (paymentId) db.prepare('DELETE FROM payments WHERE id = ?').run(paymentId)
      db.prepare('DELETE FROM payments WHERE facture_id = ?').run(factureId)
      db.prepare('DELETE FROM factures WHERE id = ?').run(factureId)
    } catch {}
    try { db?.close() } catch {}
    try { await browser?.close() } catch {}
  })

  test('skip_qb=true : row payment créée, aucun qb_deposit_id, qb_skipped renvoyé', async () => {
    const res = await page.evaluate(async ({ factureId, token }) => {
      const r = await fetch('/erp/api/payments', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          facture_id: factureId,
          direction: 'in',
          method: 'interac',
          received_at: new Date().toISOString().slice(0, 10),
          amount: 114.98,
          currency: 'CAD',
          notes: 'E2E skip_qb test',
          skip_qb: true,
        }),
      })
      return { status: r.status, body: await r.json() }
    }, { factureId, token })

    assert.equal(res.status, 201, `POST /api/payments doit réussir (reçu: ${JSON.stringify(res.body)})`)
    paymentId = res.body?.payment?.id
    assert.ok(paymentId, 'payment.id doit être renvoyé')
    assert.equal(res.body.qb_skipped, true, 'qb_skipped doit être true')
    assert.equal(res.body.qb_error, null, 'qb_error doit être null (rien tenté)')
    assert.equal(res.body.qb, null, 'qb doit être null (rien tenté)')

    // La row payment existe, aucun id QB n'est posé.
    const p = db.prepare('SELECT method, qb_deposit_id, qb_journal_entry_id, qb_payment_id FROM payments WHERE id = ?').get(paymentId)
    assert.equal(p.method, 'interac')
    assert.equal(p.qb_deposit_id, null)
    assert.equal(p.qb_journal_entry_id, null)
    assert.equal(p.qb_payment_id, null)

    // factures.balance_due est tout de même recalculée (l'ERP sait que c'est payé).
    const f = db.prepare('SELECT balance_due, status FROM factures WHERE id = ?').get(factureId)
    assert.equal(Number(f.balance_due), 0)
    assert.equal(f.status, 'Payé')

    // qb_skipped est persisté en DB pour distinguer "QB échoué" de "QB skippé volontairement".
    const persisted = db.prepare('SELECT qb_skipped FROM payments WHERE id = ?').get(paymentId)
    assert.equal(persisted.qb_skipped, 1, 'qb_skipped doit être persisté à 1')
  })

  test('GET /api/payments/facture/:id renvoie qb_skipped=true', async () => {
    const res = await page.evaluate(async ({ factureId, token }) => {
      const r = await fetch(`/erp/api/payments/facture/${factureId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      return { status: r.status, body: await r.json() }
    }, { factureId, token })

    assert.equal(res.status, 200)
    const row = res.body.find(r => r.id === paymentId)
    assert.ok(row, 'le payment doit être dans la liste')
    assert.equal(row.qb_skipped, true, 'qb_skipped doit être true dans la réponse API')
  })

  test('POST /api/payments/:id/retry-qb refuse un payment qb_skipped (pas de double Deposit)', async () => {
    const res = await page.evaluate(async ({ paymentId, token }) => {
      const r = await fetch(`/erp/api/payments/${paymentId}/retry-qb`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      return { status: r.status, body: await r.json() }
    }, { paymentId, token })

    assert.equal(res.status, 409, `retry doit retourner 409 sur un qb_skipped (reçu: ${JSON.stringify(res.body)})`)
    assert.equal(res.body.qb_skipped, true)
  })

  test('UI : le bouton Retry n\'est pas affiché, indicateur "saisi à la main" visible', async () => {
    await page.goto(`${URL}/factures/${factureId}`, { waitUntil: 'networkidle' })
    const skippedTag = page.locator(`[data-testid="payment-qb-skipped-${paymentId}"]`)
    await skippedTag.waitFor({ timeout: 5000 })
    assert.equal(await skippedTag.isVisible(), true, 'le tag "saisi à la main" doit être visible')
    // Aucun bouton Retry dans la même row.
    const retryCount = await page.locator('text=Retry').count()
    assert.equal(retryCount, 0, 'aucun bouton Retry ne doit être affiché')
  })

  test('GET /api/payments/:id/qb-link-suggestions renvoie une liste structurée', async () => {
    const res = await page.evaluate(async ({ paymentId, token }) => {
      const r = await fetch(`/erp/api/payments/${paymentId}/qb-link-suggestions`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      return { status: r.status, body: await r.json() }
    }, { paymentId, token })

    assert.equal(res.status, 200, `endpoint doit répondre 200 (reçu: ${JSON.stringify(res.body)})`)
    // Le body contient toujours suggestions (array) + métadonnées contextuelles,
    // même si QB n'a aucune opération matching (array vide) ou si la company
    // n'a pas de customer QB (reason renseigné).
    assert.ok(Array.isArray(res.body.suggestions), 'suggestions doit être un tableau')
    if (res.body.suggestions.length > 0) {
      const s = res.body.suggestions[0]
      assert.ok(s.type && s.column && s.prefix && s.qb_id, `suggestion mal formée: ${JSON.stringify(s)}`)
      assert.ok(['deposit', 'journal', 'salesreceipt'].includes(s.type))
      // Champs de traçabilité comptable (peuvent être null pour SalesReceipt).
      assert.ok('credit_account_id' in s, 'credit_account_id doit être présent')
      assert.ok('credit_account_name' in s, 'credit_account_name doit être présent')
    }
  })

  test('UI : admin peut lier manuellement un Deposit QB → cellule devient lien cliquable', async () => {
    await page.goto(`${URL}/factures/${factureId}`, { waitUntil: 'networkidle' })
    const linkBtn = page.locator(`[data-testid="payment-qb-link-btn-${paymentId}"]`)
    await linkBtn.waitFor({ timeout: 5000 })
    await linkBtn.click()

    const input = page.locator(`[data-testid="payment-qb-link-input-${paymentId}"]`)
    await input.waitFor({ timeout: 3000 })
    await input.fill('999999')
    await page.locator(`[data-testid="payment-qb-link-save-${paymentId}"]`).click()

    // Vérifie d'abord la persistance DB (assertion la moins flaky).
    await page.waitForTimeout(800)
    const persisted = db.prepare('SELECT qb_deposit_id FROM payments WHERE id = ?').get(paymentId)
    assert.equal(persisted.qb_deposit_id, '999999', 'qb_deposit_id doit être persisté')

    // Vérifie aussi via l'API GET pour s'assurer que le serveur renvoie bien la valeur.
    const apiCheck = await page.evaluate(async ({ factureId, token, paymentId }) => {
      const r = await fetch(`/erp/api/payments/facture/${factureId}`, { headers: { Authorization: `Bearer ${token}` } })
      const rows = await r.json()
      return rows.find(p => p.id === paymentId)
    }, { factureId, token, paymentId })
    assert.equal(apiCheck.qb_deposit_id, '999999', `GET API doit renvoyer qb_deposit_id (reçu: ${JSON.stringify(apiCheck)})`)

    // Après save : la row reload, le tag "saisi à la main" disparaît et la
    // cellule QB affiche maintenant "DEP #999999" (lien cliquable si la
    // connexion QB est active, sinon fallback span — peu importe ici).
    const depText = page.locator('text=DEP #999999')
    await depText.waitFor({ timeout: 5000 })
    assert.equal(await depText.isVisible(), true, 'la cellule doit afficher DEP #999999')

    const skippedTag = page.locator(`[data-testid="payment-qb-skipped-${paymentId}"]`)
    assert.equal(await skippedTag.count(), 0, 'le tag "saisi à la main" doit disparaître une fois lié')
  })

  test('GET /api/payments/:id/qb-credit-account 404 sans qb_*_id rattaché', async () => {
    // Avant que le test précédent ait lié un qb_deposit_id, l'endpoint doit refuser.
    // Ici le test précédent a posé qb_deposit_id=999999 — on crée donc un autre payment
    // pour vérifier le 404. On le supprime juste après pour rester propre.
    const created = await page.evaluate(async ({ factureId, token }) => {
      const r = await fetch('/erp/api/payments', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          facture_id: factureId, direction: 'in', method: 'cheque',
          received_at: new Date().toISOString().slice(0, 10),
          amount: 1, currency: 'CAD', skip_qb: true, notes: 'E2E temp 404 check',
        }),
      })
      return await r.json()
    }, { factureId, token })

    try {
      const tempId = created.payment.id
      const res = await page.evaluate(async ({ tempId, token }) => {
        const r = await fetch(`/erp/api/payments/${tempId}/qb-credit-account`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        return { status: r.status, body: await r.json() }
      }, { tempId, token })

      assert.equal(res.status, 404, `endpoint doit retourner 404 sans qb_*_id (reçu: ${JSON.stringify(res.body)})`)

      // Cleanup temp payment.
      await page.evaluate(async ({ tempId, token }) => {
        await fetch(`/erp/api/payments/${tempId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
      }, { tempId, token })
    } catch (e) { throw e }
  })

  test('Le compte crédité est persisté à la liaison + retourné par GET /payments', async () => {
    // Patch direct via raw admin pour simuler ce que fait QbSkippedCell.pickSuggestion + save
    // (ré-écrit qb_deposit_id et ajoute le compte crédité par-dessus le test UI précédent).
    await page.evaluate(async ({ paymentId, token }) => {
      await fetch(`/erp/api/admin/payments/${paymentId}/raw`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          qb_deposit_id: '888888',
          qb_credit_account_id: '123',
          qb_credit_account_name: "23900 Revenus perçus d'avance",
        }),
      })
    }, { paymentId, token })

    const res = await page.evaluate(async ({ factureId, token, paymentId }) => {
      const r = await fetch(`/erp/api/payments/facture/${factureId}`, { headers: { Authorization: `Bearer ${token}` } })
      const rows = await r.json()
      return rows.find(p => p.id === paymentId)
    }, { factureId, token, paymentId })

    assert.equal(res.qb_deposit_id, '888888')
    assert.equal(res.qb_credit_account_id, '123')
    assert.equal(res.qb_credit_account_name, "23900 Revenus perçus d'avance")
  })
})
