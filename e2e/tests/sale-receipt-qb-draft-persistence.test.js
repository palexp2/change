const { test, before, after, describe } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Brouillon de comptabilisation dans l'extracteur (formulaire QB de la fiche reçu) :
// les choix faits — type, fournisseur, comptes — sont autosauvegardés sur le reçu et
// retrouvés tels quels quand on revient sur la facture après avoir navigué ailleurs.
// On choisit un reçu DONE non publié et on NE PUBLIE JAMAIS (vrai side effect QB).
// Le test restaure les champs brouillon d'origine du reçu en after().

let browser, ctx, page, token, receiptId, original
let expenseTarget, paymentTarget, vendorTarget

function authFetch(path, opts = {}) {
  return fetch(`${URL}/api${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  })
}

// describe() obligatoire : des hooks before/after top-level ne s'exécutent pas
// proprement (after jamais lancé, runner qui pend) — cf. gotcha E2E du repo.
describe('extracteur — persistance du brouillon de comptabilisation', () => {
  before(async () => {
    const login = await fetch(`${URL}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASS }),
    }).then(r => r.json())
    token = login.token
    assert.ok(token, 'login a échoué')

    // Un reçu extrait mais pas encore publié → le formulaire de publication s'affiche.
    const list = await authFetch('/sale-receipts?limit=all').then(r => r.json())
    const candidate = (list.data || []).find(r => r.status === 'done' && !r.quickbooks_id
      && (r.currency || 'CAD').toUpperCase() === 'CAD')
    assert.ok(candidate, 'aucun reçu done+non-publié CAD disponible pour le test')
    receiptId = candidate.id
    // Champs brouillon restaurés en after() — le test ne touche ni au code de taxe ni
    // au type de transaction (leur changement recalcule les montants du reçu).
    original = {
      quickbooks_type: candidate.quickbooks_type ?? null,
      vendor_id: candidate.vendor_id ?? null,
      expense_account_id: candidate.expense_account_id ?? null,
      payment_account_id: candidate.payment_account_id ?? null,
    }

    // Cibles déterministes : des comptes/vendor QB réels DIFFÉRENTS des valeurs
    // actuelles du reçu, pour prouver que c'est bien la sélection qui est restaurée.
    const accounts = await authFetch('/connectors/quickbooks/accounts').then(r => r.json())
    assert.ok(Array.isArray(accounts) && accounts.length, 'comptes QB requis')
    expenseTarget = accounts.find(a => ['Expense', 'Other Expense', 'Cost of Goods Sold'].includes(a.AccountType)
      && a.Id !== candidate.expense_account_id)
    paymentTarget = accounts.find(a => a.AccountType === 'Bank'
      && ((a.CurrencyRef?.value || 'CAD').toUpperCase() === 'CAD') && a.Id !== candidate.payment_account_id)
    assert.ok(expenseTarget, 'un compte de dépense QB est requis')
    assert.ok(paymentTarget, 'un compte Bank CAD QB est requis')
    const vendors = await authFetch('/connectors/quickbooks/vendors').then(r => r.json())
    vendorTarget = (Array.isArray(vendors) ? vendors : []).find(v => v.Id !== candidate.vendor_id && v.DisplayName)
    assert.ok(vendorTarget, 'un vendor QB est requis')

    browser = await chromium.launch()
    ctx = await browser.newContext()
    page = await ctx.newPage()
    await page.addInitScript(t => localStorage.setItem('erp_token', t), token)
  })

  after(async () => {
    if (token && receiptId) {
      await authFetch(`/sale-receipts/${receiptId}`, {
        method: 'PATCH', body: JSON.stringify(original),
      }).catch(() => {})
    }
    await browser?.close()
  })

  const accountLabel = a => (a.AcctNum ? `${a.AcctNum} — ${a.Name}` : a.Name)

  // Pilote un SearchableSelect : ouvre, filtre par le libellé exact, clique l'option.
  async function pickOption(selectTestId, optionText) {
    const select = page.getByTestId(selectTestId)
    await select.waitFor({ state: 'visible', timeout: 30000 })
    await select.click()
    const portal = page.locator('#qb-select-portal')
    await portal.waitFor({ state: 'visible', timeout: 5000 })
    await portal.locator('input').fill(optionText)
    await portal.getByText(optionText, { exact: false }).first().click()
  }

  // Poll l'API jusqu'à ce que le champ du reçu atteigne la valeur attendue (l'autosave
  // est asynchrone — on ne se fie pas au DOM immédiat, cf. gotcha E2E du repo).
  async function waitForField(field, expected, label) {
    const deadline = Date.now() + 10000
    let last
    while (Date.now() < deadline) {
      const r = await authFetch(`/sale-receipts/${receiptId}`).then(x => x.json())
      last = r[field]
      if (last === expected) return
      await new Promise(res => setTimeout(res, 300))
    }
    assert.equal(last, expected, `${label} doit être persisté (autosave brouillon)`)
  }

  test('les choix du formulaire QB sont persistés puis restaurés au retour sur la facture', async () => {
    await page.goto(`${URL}/sale-receipts/${receiptId}`, { waitUntil: 'domcontentloaded' })
    await page.getByTestId('qb-expense-select').waitFor({ state: 'visible', timeout: 30000 })

    // Force le type Purchase (le profil fournisseur peut présélectionner Bill, qui
    // masque le compte de paiement) — persisté comme brouillon, restauré en after().
    await page.getByTestId('qb-type-purchase').click()
    await waitForField('quickbooks_type', 'purchase', 'le type QB (purchase)')

    // Saisit fournisseur + comptes (type purchase → le compte de paiement est visible).
    await pickOption('qb-vendor-select', vendorTarget.DisplayName)
    await waitForField('vendor_id', vendorTarget.Id, 'le fournisseur')
    await pickOption('qb-expense-select', accountLabel(expenseTarget))
    await waitForField('expense_account_id', expenseTarget.Id, 'le compte de dépense')
    await pickOption('qb-payment-select', accountLabel(paymentTarget))
    await waitForField('payment_account_id', paymentTarget.Id, 'le compte de paiement')
    // Puis bascule le type en « Facture à payer (Bill) » — persisté aussi.
    await page.getByTestId('qb-type-bill').click()
    await waitForField('quickbooks_type', 'bill', 'le type QB')

    // « Je m'en vais vers une autre facture » : navigation vers la liste, puis retour.
    await page.goto(`${URL}/sale-receipts`, { waitUntil: 'domcontentloaded' })
    await page.goto(`${URL}/sale-receipts/${receiptId}`, { waitUntil: 'domcontentloaded' })

    // Le brouillon est restauré tel quel — il prime sur le profil fournisseur,
    // l'historique « dernière compta » et le rapprochement flou.
    const expenseSelect = page.getByTestId('qb-expense-select')
    await expenseSelect.waitFor({ state: 'visible', timeout: 30000 })
    await assert.doesNotReject(
      expenseSelect.getByText(expenseTarget.Name, { exact: false }).waitFor({ timeout: 10000 }),
      'le compte de dépense choisi doit être restauré')
    await assert.doesNotReject(
      page.getByTestId('qb-vendor-select').getByText(vendorTarget.DisplayName, { exact: false }).waitFor({ timeout: 10000 }),
      'le fournisseur choisi doit être restauré')
    assert.equal(await page.getByTestId('qb-type-bill').isChecked(), true,
      'le type « Facture à payer » doit être restauré')

    // Le compte de paiement (masqué en mode Bill) reste persisté côté données.
    const fresh = await authFetch(`/sale-receipts/${receiptId}`).then(r => r.json())
    assert.equal(fresh.payment_account_id, paymentTarget.Id, 'le compte de paiement reste persisté')
    assert.ok(!fresh.quickbooks_id, 'le reçu ne doit pas avoir été publié par le test')
  })
})
