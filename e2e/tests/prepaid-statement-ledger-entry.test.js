// Relevé mensuel Twilio (comptes prépayés) : quand le document joint est la
// FACTURE d'usage (pas le reçu de paiement), son montant doit maintenant mettre
// à jour le solde du compte prépayé dans l'ERP — pas seulement s'attacher aux
// transactions QuickBooks. Le vrai clic « Joindre » appellerait QuickBooks pour
// de vrai (interdit de le déclencher en E2E — voir feedback_e2e_never_mutate_real_records),
// donc on intercepte la réponse réseau pour vérifier uniquement le rendu client
// (toast + bandeau), sans toucher au serveur ni à QuickBooks.
//
// Wrapper describe() obligatoire : un after() top-level (hors describe) ne
// s'exécute jamais avec ce runner — voir gotcha_e2e_toplevel_after_hook_never_runs.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Document réel déjà détecté comme relevé mensuel Twilio (facture — pas le
// reçu). On ne clique jamais réellement le bouton d'attachement : la réponse
// réseau est interceptée et remplacée avant d'atteindre le serveur.
const RECEIPT_ID = '1819bb5c-57a3-4bfb-86f5-6618453f2be2'

describe('Relevé mensuel prépayé — enregistrement de la facture au ledger', () => {
  let browser, ctx, page, token

  before(async () => {
    const login = await fetch(`${URL}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASS }),
    }).then(r => r.json())
    token = login.token
    assert.ok(token, 'login a échoué')

    browser = await chromium.launch()
    ctx = await browser.newContext()
    page = await ctx.newPage()
    await page.addInitScript(t => localStorage.setItem('erp_token', t), token)
  })

  after(async () => {
    await browser?.close()
  })

  test('bandeau relevé mensuel : le montant de facture enregistré au ledger est affiché', async () => {
    await page.goto(`${URL}/sale-receipts/${RECEIPT_ID}`, { waitUntil: 'domcontentloaded' })

    const banner = page.getByTestId('prepaid-statement-banner')
    await banner.waitFor({ state: 'visible', timeout: 15000 })

    // Intercepte l'appel réel d'attachement — jamais exécuté côté serveur/QuickBooks.
    await page.route('**/api/sale-receipts/*/attach-to-month-qb', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          month: '2026-07',
          vendor: 'Twilio',
          transactions: [{ qb_txn_type: 'Purchase', qb_txn_id: '999', entry_date: '2026-07-16', amount: 500.05, uploaded: 1, skipped: 0, qb_url: null }],
          attached: 1,
          skipped: 0,
          files: ['facture.pdf'],
          ledger_entry: { id: 'fake-id', amount: 757.84, month: '2026-07', created: false },
        }),
      })
    })

    await page.getByTestId('prepaid-statement-attach').click()

    // Toast confirmant l'attachement ET l'enregistrement au solde prépayé
    // (regex — le symbole monétaire fr-CA utilise une espace insécable).
    await page.getByText(/facture de 757,84\s*\$\s*enregistrée au solde prépayé/).waitFor({ timeout: 10000 })

    await page.unroute('**/api/sale-receipts/*/attach-to-month-qb')
  })
})
