const { test, before, after, describe } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérification du statut fiscal avant publication QB (services/fiscalStatus.js).
// On choisit dynamiquement un reçu DONE non publié et on NE PUBLIE JAMAIS — publier
// serait un vrai side effect QB. Changer le code de taxe dans le formulaire PERSISTE
// tax_code_id et recalcule les montants (changeDocCode) → on capture/restaure le code
// et tous les montants, en plus de transaction_type.

let browser, ctx, page, token, receiptId, original

function authFetch(path, opts = {}) {
  return fetch(`${URL}/api${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  })
}

// describe() obligatoire : des hooks before/after top-level ne s'exécutent pas
// proprement (after jamais lancé, runner qui pend) — cf. gotcha E2E du repo.
describe('statut fiscal — vérification avant publication', () => {
  before(async () => {
    const login = await fetch(`${URL}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASS }),
    }).then(r => r.json())
    token = login.token
    assert.ok(token, 'login a échoué')

    // Un reçu extrait mais pas encore publié → le formulaire de publication s'affiche.
    // En CAD : le garde-fou devise du push exige un compte de paiement dans la devise
    // de la transaction, et le sous-test serveur utilise un compte Bank CAD réel.
    const list = await authFetch('/sale-receipts?limit=all').then(r => r.json())
    const candidate = (list.data || []).find(r => r.status === 'done' && !r.quickbooks_id
      && (r.currency || 'CAD').toUpperCase() === 'CAD')
    assert.ok(candidate, 'aucun reçu done+non-publié CAD disponible pour le test')
    receiptId = candidate.id
    original = {
      transaction_type: candidate.transaction_type ?? null,
      tax_code_id: candidate.tax_code_id ?? null, subtotal: candidate.subtotal ?? null,
      tps: candidate.tps ?? null, tvq: candidate.tvq ?? null,
      other_taxes: candidate.other_taxes ?? null, total: candidate.total ?? null,
      items: candidate.items || [],
    }

    browser = await chromium.launch()
    ctx = await browser.newContext()
    page = await ctx.newPage()
    await page.addInitScript(t => localStorage.setItem('erp_token', t), token)
  })

  after(async () => {
    // Restaure code de taxe, montants et transaction_type persistés par changeDocCode.
    if (token && receiptId) {
      await authFetch(`/sale-receipts/${receiptId}`, {
        method: 'PATCH', body: JSON.stringify(original),
      }).catch(() => {})
    }
    await browser?.close()
  })

  // Helpers pour piloter un SearchableSelect (portail partagé #qb-select-portal).
  async function pickOption(selectTestId, optionText, { exact = true } = {}) {
    const select = page.getByTestId(selectTestId)
    await select.waitFor({ state: 'visible', timeout: 30000 })
    await select.click()
    const portal = page.locator('#qb-select-portal')
    await portal.waitFor({ state: 'visible', timeout: 5000 })
    await portal.getByText(optionText, { exact }).first().click()
  }

  test('l’indicateur fiscal reflète l’écart code de taxe vs type de transaction', async () => {
    await page.goto(`${URL}/sale-receipts/${receiptId}`, { waitUntil: 'domcontentloaded' })

    // Le sélecteur de type de transaction doit être présent (formulaire QB chargé).
    await page.getByTestId('qb-txtype-select').waitFor({ state: 'visible', timeout: 30000 })

    // Choisit « Produits alimentaires de base » → statut attendu Détaxé.
    await pickOption('qb-txtype-select', 'Produits alimentaires de base', { exact: false })
    const expected = page.getByTestId('qb-fiscal-expected')
    await expected.waitFor({ state: 'visible', timeout: 5000 })
    await assert.doesNotReject(expected.getByText('Détaxé', { exact: false }).first().waitFor({ timeout: 5000 }),
      'le statut attendu Détaxé doit s’afficher')

    // Code de taxe non conforme (TPS/TVQ QC) → bannière d’écart rouge.
    await pickOption('qb-taxcode-select', 'TPS/TVQ QC - 9,975')
    await assert.doesNotReject(page.getByTestId('qb-fiscal-mismatch').waitFor({ state: 'visible', timeout: 5000 }),
      'l’écart fiscal doit être signalé')

    // Code conforme (Détaxé) → bannière verte de conformité.
    await pickOption('qb-taxcode-select', 'Détaxé')
    await assert.doesNotReject(page.getByTestId('qb-fiscal-ok').waitFor({ state: 'visible', timeout: 5000 }),
      'la conformité fiscale doit être confirmée')
  })

  test('la garde serveur bloque un code non conforme et exige le type (sans publier)', async () => {
    // Type manquant → 400 (jamais de POST QB).
    const noType = await authFetch(`/sale-receipts/${receiptId}/push-to-qb`, {
      method: 'POST',
      body: JSON.stringify({ type: 'purchase', expenseAccountId: 'x', paymentAccountId: 'x', taxCodeId: '8' }),
    })
    assert.equal(noType.status, 400, 'type de transaction requis')
    const noTypeBody = await noType.json()
    assert.match(noTypeBody.error, /[Tt]ype de transaction/, 'message explicite sur le type requis')

    // Type produits alimentaires (Détaxé) + code TPS/TVQ QC (id 8) → écart → 400 bloquant.
    // La garde lève AVANT tout POST QB → aucune transaction créée. Le compte de paiement
    // doit être un compte Bank CAD RÉEL : le garde-fou devise (lecture du compte) passe
    // avant la garde fiscale et rejetterait un id bidon. Le compte de dépense reste bidon
    // ('x') : il n'est jamais lu avant la garde fiscale, et garantirait un refus QB si la
    // garde régressait.
    const accounts = await authFetch('/connectors/quickbooks/accounts').then(r => r.json())
    const cadBank = (Array.isArray(accounts) ? accounts : []).find(a => a.AccountType === 'Bank'
      && ((a.CurrencyRef?.value || 'CAD').toUpperCase() === 'CAD'))
    assert.ok(cadBank, 'un compte Bank CAD est requis dans QB')
    const mismatch = await authFetch(`/sale-receipts/${receiptId}/push-to-qb`, {
      method: 'POST',
      body: JSON.stringify({ type: 'purchase', expenseAccountId: 'x', paymentAccountId: cadBank.Id, taxCodeId: '8', transactionType: 'produits_alimentaires_base' }),
    })
    assert.equal(mismatch.status, 400, 'écart fiscal bloqué')
    const mismatchBody = await mismatch.json()
    assert.match(mismatchBody.error, /[ÉéEe]cart de statut fiscal/, 'message explicite sur l’écart')

    // Le reçu ne doit PAS avoir été publié.
    const after = await authFetch(`/sale-receipts/${receiptId}`).then(r => r.json())
    assert.ok(!after.quickbooks_id, 'le reçu ne doit pas avoir été publié par le test')
  })
})
