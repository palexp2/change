const { test, before, after, describe } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Champ « Montant passé à la banque » du formulaire de publication QB : quand le débit
// bancaire diffère du total de la facture (conversion de devise — cas AWS), l'écart est
// comptabilisé en ligne « Frais de conversion » (Exonéré) au push. Le test valide :
//  1. le champ et son aperçu d'écart côté UI (état LOCAL uniquement — on ne publie jamais) ;
//  2. le garde-fou serveur anti-typo (écart > 10 % → 400 AVANT tout write QB).
// Aucun record n'est créé ni modifié : le reçu est choisi parmi l'existant, les
// interactions restent locales au formulaire, et l'appel push est construit pour
// échouer sur le garde-fou (fee = total ≥ 3 $ > max(2, 10 % du total), garanti).

let browser, ctx, page, token, receipt
// bank_charged_total est un champ « brouillon » persisté par le formulaire de publication
// (autosave onBlur) — pour le test qui vérifie son effet dans les Articles, on capture la
// valeur d'origine du reçu emprunté et on la restaure en after() (cf. règle E2E : jamais de
// mutation non restaurée sur un vrai record).
let originalBankChargedTotal, originalQuickbooksType

function authFetch(path, opts = {}) {
  return fetch(`${URL}/api${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  })
}

describe('publication QB — montant passé à la banque (frais de conversion)', () => {
  before(async () => {
    const login = await fetch(`${URL}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASS }),
    }).then(r => r.json())
    token = login.token
    assert.ok(token, 'login a échoué')

    // Reçu extrait, non publié, total ≥ 3 $ (garantit le déclenchement du garde-fou
    // serveur : fee = total > max(2, total × 0,10) — jamais de write QB).
    const list = await authFetch('/sale-receipts?limit=all').then(r => r.json())
    receipt = (list.data || []).find(r => r.status === 'done' && !r.quickbooks_id
      && Number(r.total) >= 3)
    assert.ok(receipt, 'aucun reçu done+non-publié (total ≥ 3 $) disponible pour le test')
    originalBankChargedTotal = receipt.bank_charged_total ?? null
    originalQuickbooksType = receipt.quickbooks_type ?? null

    browser = await chromium.launch()
    ctx = await browser.newContext()
    page = await ctx.newPage()
    await page.addInitScript(t => localStorage.setItem('erp_token', t), token)
  })

  after(async () => {
    // Restaure le brouillon écrasé par le test « ligne Frais de conversion dans les Articles ».
    if (receipt) {
      await authFetch(`/sale-receipts/${receipt.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ bank_charged_total: originalBankChargedTotal, quickbooks_type: originalQuickbooksType }),
      })
    }
    await browser?.close()
  })

  test('le champ affiche l\'aperçu de l\'écart « Frais de conversion »', async () => {
    await page.goto(`${URL}/sale-receipts/${receipt.id}`, { waitUntil: 'domcontentloaded' })

    // Le champ n'existe que pour le type « Dépense payée (Purchase) » — on le force
    // (état local du formulaire, rien n'est persisté).
    const typePurchase = page.getByTestId('qb-type-purchase')
    await typePurchase.waitFor({ state: 'visible', timeout: 30000 })
    await typePurchase.click()

    // Mode fournisseur « Nouveau » : l'aperçu d'écart n'est calculé que quand la devise
    // de la transaction est celle du reçu (un vendor QB présélectionné dans une autre
    // devise masquerait l'aperçu). État local uniquement.
    await page.locator('label', { hasText: 'Nouveau' }).first().click()

    // Champ replié par défaut (rarement utilisé) — il faut l'ouvrir avant de le remplir.
    const toggle = page.getByTestId('qb-bank-charged-toggle')
    await toggle.waitFor({ state: 'visible', timeout: 10000 })
    await toggle.click()

    const bankField = page.getByTestId('qb-bank-charged')
    await bankField.waitFor({ state: 'visible', timeout: 10000 })

    // Écart de +1,30 (cas AWS août 2026 : facture 72,08 / banque 73,38).
    const bank = (Math.round(Number(receipt.total) * 100) + 130) / 100
    await bankField.fill(String(bank))
    const hint = page.getByTestId('qb-bank-charged-hint')
    await hint.waitFor({ state: 'visible', timeout: 5000 })
    const hintText = await hint.textContent()
    assert.match(hintText, /\+1\.30/, `l'aperçu affiche l'écart (+1.30) — reçu: ${hintText}`)
    assert.match(hintText, /Frais de conversion/i, 'l\'aperçu mentionne la ligne « Frais de conversion »')

    // Montant identique au total → aucun frais.
    await bankField.fill(Number(receipt.total).toFixed(2))
    const sameText = await page.getByTestId('qb-bank-charged-hint').textContent()
    assert.match(sameText, /Identique au total/i, 'montant égal → pas de ligne de frais')
  })

  test('l\'écart persisté ajoute automatiquement l\'article « Frais de conversion »', async () => {
    await page.goto(`${URL}/sale-receipts/${receipt.id}`, { waitUntil: 'domcontentloaded' })

    const typePurchase = page.getByTestId('qb-type-purchase')
    await typePurchase.waitFor({ state: 'visible', timeout: 30000 })
    await typePurchase.click()

    const toggle = page.getByTestId('qb-bank-charged-toggle')
    await toggle.waitFor({ state: 'visible', timeout: 10000 })
    await toggle.click()

    // Cette fois on quitte le champ (blur) : l'autosave persiste bank_charged_total sur
    // le reçu, ce qui doit faire apparaître la ligne dans la section Articles.
    const bank = (Math.round(Number(receipt.total) * 100) + 130) / 100
    const bankField = page.getByTestId('qb-bank-charged')
    await bankField.fill(String(bank))
    await bankField.blur()

    const feeRow = page.getByTestId('receipt-item-conversion-fee')
    await feeRow.waitFor({ state: 'visible', timeout: 10000 })
    const feeText = await feeRow.textContent()
    assert.match(feeText, /Frais de conversion/, 'la ligne d\'article doit être libellée « Frais de conversion »')
    assert.match(feeText, /\+1\.30/, `la ligne d'article affiche le bon montant — reçu: ${feeText}`)
    assert.match(feeText, /Exonéré/, 'la ligne mentionne le code de taxe Exonéré')
  })

  test('garde-fou serveur : écart implausible refusé en 400 (aucun write QB)', async () => {
    // Payload valide jusqu'au calcul des frais : comptes réels dans la devise du reçu,
    // type de transaction connu, fiscal/anomalies neutralisés par les justifications
    // (les événements d'override ne sont journalisés qu'en cas de SUCCÈS — jamais ici).
    const [accounts, vendors, txTypes] = await Promise.all([
      authFetch('/connectors/quickbooks/accounts').then(r => r.json()),
      authFetch('/connectors/quickbooks/vendors').then(r => r.json()),
      authFetch('/sale-receipts/transaction-types').then(r => r.json()),
    ])
    const cur = (receipt.currency || 'CAD').toUpperCase()
    const expense = (accounts || []).find(a => ['Expense', 'Other Expense'].includes(a.AccountType))
    const payment = (accounts || []).find(a => ['Bank', 'Credit Card'].includes(a.AccountType)
      && ((a.CurrencyRef?.value || 'CAD').toUpperCase() === cur))
    // Vendor explicite DANS LA DEVISE DU REÇU : garantit txnCurrency = devise du reçu
    // (pas de conversion FX ni de rejet devise du compte de paiement avant le garde-fou).
    const vendor = (vendors || []).find(v => ((v.CurrencyRef?.value || 'CAD').toUpperCase() === cur))
    const txType = (txTypes.data || []).find(t => t.side !== 'vente')
    assert.ok(expense && payment && vendor && txType, 'comptes/vendors QB ou types de transaction indisponibles')

    const res = await authFetch(`/sale-receipts/${receipt.id}/push-to-qb`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'purchase',
        expenseAccountId: expense.Id,
        paymentAccountId: payment.Id,
        vendorId: vendor.Id,
        taxCodeId: null,
        transactionType: txType.key,
        forceReason: 'Test E2E — garde-fou frais de conversion (doit échouer avant tout write QB)',
        anomalyOverride: 'Test E2E — garde-fou frais de conversion',
        // fee = total → toujours > max(2, total × 0,10) pour total ≥ 3 $ : refus garanti.
        bankChargedTotal: Math.round(Number(receipt.total) * 2 * 100) / 100,
      }),
    })
    assert.equal(res.status, 400, 'le push doit être refusé')
    const body = await res.json()
    assert.match(body.error, /trop grand/i, `le refus vient du garde-fou frais de conversion — reçu: ${body.error}`)
    assert.equal(body.field, 'bank_charged_total')

    // Le reçu n'a pas été publié.
    const fresh = await authFetch(`/sale-receipts/${receipt.id}`).then(r => r.json())
    assert.equal(fresh.quickbooks_id ?? null, null, 'aucune publication QB ne doit avoir eu lieu')
  })
})
