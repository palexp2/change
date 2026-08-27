const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie qu'après publication sur QuickBooks DEPUIS la fiche détail, on enchaîne
// directement sur le DOCUMENT SUIVANT de la liste (même ordre que les flèches ‹ ›)
// au lieu de revenir au menu Extraction de données. Fallback couvert aussi :
// dernier document de la liste → retour à la liste.
//
// IMPORTANT : publier réellement créerait un enregistrement dans QuickBooks
// (vrai side effect externe). On intercepte donc l'appel `push-to-qb` (réponse
// mockée 200) et on injecte un quickbooks_id dans la relecture post-publication
// — le formulaire et ses comptes restent chargés depuis le vrai connecteur QB,
// seule l'écriture distante est court-circuitée. Aucune donnée QB n'est créée,
// aucune mutation DB persistée.

describe('Extraction de données : publier enchaîne sur le document suivant', () => {
  let browser, ctx, page
  let token, receiptId, expectedNextId
  let originalQbId, originalQbType, nulledForTest
  // Champs de BROUILLON de comptabilisation écrasés par le formulaire (autosave) —
  // restaurés tels quels en fin de test.
  // Choisir un statut fiscal applique aussi un code de taxe et recalcule les montants :
  // on restaure donc aussi ces colonnes pour rendre le reçu strictement intact.
  const DRAFT_FIELDS = [
    'quickbooks_type', 'vendor_id', 'expense_account_id', 'payment_account_id',
    'transaction_type', 'tax_code_id', 'subtotal', 'tps', 'tvq', 'other_taxes', 'total',
  ]
  let originalDraft

  // Remplit le formulaire de publication et clique « Publier sur QuickBooks ».
  async function fillAndPublish() {
    // Le formulaire n'apparaît qu'une fois comptes/vendors/codes de taxe chargés
    // depuis QuickBooks (appels externes réels) — d'où le délai généreux.
    await page.getByTestId('qb-expense-select').waitFor({ state: 'visible', timeout: 60000 })

    // Type « Dépense payée » forcé : le brouillon du reçu peut être en « Facture à
    // payer » (Bill), qui masque le compte de paiement. On fixe le mode pour que le
    // formulaire soit toujours le même quel que soit le reçu candidat.
    await page.getByTestId('qb-type-purchase').click()
    await page.getByTestId('qb-payment-select').waitFor({ state: 'visible', timeout: 10000 })

    // Fournisseur : mode « Nouveau » pour ne pas dépendre d'un vendor existant.
    await page.getByText('Nouveau', { exact: true }).click()
    await page.fill('input[placeholder="Nom du fournisseur"]', 'E2E Vendor')

    // Compte de dépense : première option réelle du portail.
    await page.getByTestId('qb-expense-select').click()
    let portal = page.locator('#qb-select-portal')
    await portal.waitFor({ state: 'visible', timeout: 5000 })
    await portal.locator('button').first().click()

    // Compte de paiement (mode purchase) : première option réelle.
    await page.getByTestId('qb-payment-select').click()
    portal = page.locator('#qb-select-portal')
    await portal.waitFor({ state: 'visible', timeout: 5000 })
    await portal.locator('button').first().click()

    // Type de transaction (statut fiscal) : obligatoire à la publication. Le reçu
    // candidat peut ne rien avoir de détecté → on prend le premier statut proposé.
    if (await page.getByTestId('qb-txtype-missing').count()) {
      await page.getByTestId('qb-txtype-select').click()
      portal = page.locator('#qb-select-portal')
      await portal.waitFor({ state: 'visible', timeout: 5000 })
      await portal.locator('button').first().click()
      await page.getByTestId('qb-txtype-missing').waitFor({ state: 'detached', timeout: 5000 })
    }

    await page.getByRole('button', { name: /Publier sur QuickBooks/ }).click()

    // Écart entre le code de taxe et le statut fiscal → modale de confirmation :
    // le serveur exige alors une justification. On la fournit et on force.
    const modal = page.getByTestId('qb-confirm-modal')
    if (await modal.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false)) {
      if (await page.getByTestId('qb-force-reason').count()) {
        await page.getByTestId('qb-force-reason').fill('Test E2E — publication QB interceptée')
      }
      await page.getByTestId('qb-confirm-publish').click()
    }
  }

  // Message d'erreur affiché par le formulaire, pour un diagnostic lisible quand la
  // publication est refusée côté client (fenêtre de date, champ manquant…).
  async function formError() {
    const err = page.locator('.text-red-600')
    return (await err.count()) ? (await err.first().innerText()).trim() : '(aucun)'
  }

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    token = await page.evaluate(() => localStorage.getItem('erp_token'))

    // Préchauffe les référentiels QuickBooks : le premier appel après un redémarrage
    // serveur traverse l'API QB (lent) et faisait dépasser le délai d'affichage du
    // formulaire de publication.
    await Promise.all([
      '/api/connectors/quickbooks/accounts',
      '/api/connectors/quickbooks/vendors',
      '/api/connectors/quickbooks/tax-codes',
    ].map(p => page.request.get(URL + p, { headers: { Authorization: 'Bearer ' + token }, timeout: 90000 }).catch(() => {})))

    const resp = await page.request.get(URL + '/api/sale-receipts?limit=all', {
      headers: { Authorization: 'Bearer ' + token },
    })
    const body = await resp.json()
    const rows = body.data || []
    // L'ordre de cette liste est exactement celui utilisé par la fiche détail pour
    // prev/next quand on arrive par URL directe (pas d'ordre de vue mémorisé).
    // On exclut le dernier élément : il n'a pas de suivant.
    const idxOf = r => rows.findIndex(x => String(x.id) === String(r.id))
    const hasNext = r => idxOf(r) >= 0 && idxOf(r) < rows.length - 1
    // Fenêtre de publication imposée par le formulaire : ni dans le futur, ni à plus
    // de 30 jours dans le passé. Un reçu sans date échappe au contrôle.
    const inPublishWindow = r => {
      if (!r.receipt_date) return true
      const today = new Date(); today.setHours(0, 0, 0, 0)
      const [y, m, d] = String(r.receipt_date).slice(0, 10).split('-').map(Number)
      const diff = Math.round((today - new Date(y, (m || 1) - 1, d || 1)) / 86400000)
      return diff >= 0 && diff <= 30
    }
    const eligible = r => r.status === 'done' && hasNext(r) && inPublishWindow(r)
    // Idéalement un reçu done non publié ; sinon on en dé-publie un temporairement.
    let candidate = rows.find(r => eligible(r) && !r.quickbooks_id)
    if (!candidate) {
      candidate = rows.find(r => eligible(r) && r.quickbooks_id)
      assert.ok(candidate, 'Préalable : au moins un reçu done, non dernier et dans la fenêtre de 30 jours requis')
      originalQbId = candidate.quickbooks_id
      originalQbType = candidate.quickbooks_type
      nulledForTest = true
      await page.request.patch(URL + '/api/sale-receipts/' + candidate.id, {
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        data: { quickbooks_id: null, quickbooks_type: null },
      })
    }
    receiptId = candidate.id
    expectedNextId = String(rows[idxOf(candidate) + 1].id)
    originalDraft = Object.fromEntries(DRAFT_FIELDS.map(f => [f, candidate[f] ?? null]))
  })

  after(async () => {
    if (receiptId) {
      // Restaure le brouillon de comptabilisation + le quickbooks_id d'origine si on
      // l'avait nullé pour le test.
      const data = { ...originalDraft }
      if (nulledForTest) { data.quickbooks_id = originalQbId; data.quickbooks_type = originalQbType }
      await page.request.patch(URL + '/api/sale-receipts/' + receiptId, {
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        data,
      }).catch(() => {})
    }
    await browser?.close()
  })

  test('publier ouvre directement le document suivant', async () => {
    let published = false

    // Court-circuite l'écriture QB réelle.
    await page.route(`**/api/sale-receipts/${receiptId}/push-to-qb`, async route => {
      published = true
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
    })
    // La relecture post-publication renvoie le reçu marqué publié.
    await page.route(`**/api/sale-receipts/${receiptId}`, async route => {
      if (route.request().method() !== 'GET') return route.continue()
      const response = await route.fetch()
      const json = await response.json()
      if (published) {
        json.quickbooks_id = 'E2E-MOCK'
        json.quickbooks_type = 'purchase'
        json.status = 'published'
      }
      await route.fulfill({ response, json })
    })

    await page.goto(`${URL}/sale-receipts/${receiptId}`, { waitUntil: 'domcontentloaded' })
    await fillAndPublish()

    // On doit atterrir sur la fiche du document SUIVANT, pas sur la liste.
    await page.waitForFunction(
      next => new RegExp(`/sale-receipts/${next}$`).test(location.pathname),
      expectedNextId,
      { timeout: 15000 }
    ).catch(async e => { throw new Error(`${e.message} — erreur du formulaire : ${await formError()}`) })
    assert.match(page.url(), new RegExp(`/sale-receipts/${expectedNextId}$`), `document suivant attendu, vu : ${page.url()}`)
    assert.ok(published, 'l\'appel push-to-qb doit avoir été déclenché')

    await page.unrouteAll({ behavior: 'ignoreErrors' })
  })

  test('dernier document de la liste : retour à la liste', async () => {
    let published = false

    // Liste réduite au seul document courant → aucun suivant possible.
    await page.route(u => u.pathname.endsWith('/api/sale-receipts'), async route => {
      if (route.request().method() !== 'GET') return route.continue()
      const response = await route.fetch()
      const json = await response.json()
      json.data = (json.data || []).filter(r => String(r.id) === String(receiptId))
      await route.fulfill({ response, json })
    })
    await page.route(`**/api/sale-receipts/${receiptId}/push-to-qb`, async route => {
      published = true
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
    })
    await page.route(`**/api/sale-receipts/${receiptId}`, async route => {
      if (route.request().method() !== 'GET') return route.continue()
      const response = await route.fetch()
      const json = await response.json()
      if (published) {
        json.quickbooks_id = 'E2E-MOCK'
        json.quickbooks_type = 'purchase'
        json.status = 'published'
      }
      await route.fulfill({ response, json })
    })

    await page.goto(`${URL}/sale-receipts/${receiptId}`, { waitUntil: 'domcontentloaded' })
    await fillAndPublish()

    await page.waitForFunction(() => /\/sale-receipts$/.test(location.pathname), null, { timeout: 15000 })
      .catch(async e => { throw new Error(`${e.message} — erreur du formulaire : ${await formError()}`) })
    assert.match(page.url(), /\/sale-receipts$/, `retour à la liste attendu, vu : ${page.url()}`)
    assert.ok(published, 'l\'appel push-to-qb doit avoir été déclenché')

    await page.unrouteAll({ behavior: 'ignoreErrors' })
  })
})
