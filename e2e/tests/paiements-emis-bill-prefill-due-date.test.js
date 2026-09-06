// /paiements-emis — choisir une facture dans « Factures à payer » pré-remplit
// TOUT le formulaire, à commencer par la date.
//
// Règle de la maison : une facture se paie le DERNIER jour de son échéance
// (l'argent reste au compte le plus longtemps possible). Si ce jour-là les
// banques sont fermées — fin de semaine ou jour férié — le paiement est daté du
// jour ouvrable précédent. Le formulaire datait tout du jour même : chaque
// paiement partait donc trop tôt, ou trop tard s'il était corrigé de tête.
//
// Vérifie aussi que le compte à débiter vient du profil fournisseur (« Master »
// → MasterCard BNC) quand aucun paiement passé ne le dit — et que le moyen de
// paiement bascule sur « Autre », le seul qui accepte une carte.
//
// Aucun record réel n'est touché : profil fournisseur et factures portent un nom
// jetable marqué E2E et sont supprimés dans after(). Les factures sont créées en
// Brouillon puis passées à « Reçue » pour ne PAS déclencher l'ajout au Google
// Sheet CTB. Aucun paiement n'est créé.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const STAMP = Date.now()
const VENDOR = `E2E Échéance ${STAMP}`
const TODAY = new Date().toISOString().slice(0, 10)

// Échéances choisies loin dans le futur pour que le test soit stable :
//   16 janv. 2027 = samedi           → payé le vendredi 15
//   20 janv. 2027 = mercredi ouvrable → payé le jour même
//   1er juil. 2027 = Fête du Canada   → payé le mercredi 30 juin
const CASES = [
  { key: 'weekend', due: '2027-01-16', expect: '2027-01-15', amount: 111.11, words: ['samedi', 'fermées'] },
  { key: 'ouvrable', due: '2027-01-20', expect: '2027-01-20', amount: 222.22, words: ['dernier jour'] },
  { key: 'ferie', due: '2027-07-01', expect: '2027-06-30', amount: 333.33, words: ['férié', 'Fête du Canada'] },
]

describe('Paiements émis — la facture choisie date le paiement à son échéance', () => {
  let browser, ctx, page
  let profileId = null
  const billIds = {}

  const apiFetch = (path, opts = {}) => page.evaluate(async ({ path, opts }) => {
    const tok = localStorage.getItem('erp_token')
    const r = await fetch(`/erp/api${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}`, ...(opts.headers || {}) },
    })
    return { status: r.status, body: await r.json().catch(() => null) }
  }, { path, opts })

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    // Profil fournisseur : payé « Master » — aucun paiement passé, donc le compte
    // ne peut venir que de là.
    let r = await apiFetch('/vendor-profiles', { method: 'POST', body: JSON.stringify({ name: VENDOR }) })
    assert.equal(r.status, 201, `création du profil : ${JSON.stringify(r.body)}`)
    profileId = r.body.id
    r = await apiFetch(`/vendor-profiles/${profileId}`, {
      method: 'PATCH', body: JSON.stringify({ payment_method: 'Master' }),
    })
    assert.equal(r.status, 200, `compte de paiement du profil : ${JSON.stringify(r.body)}`)

    for (const c of CASES) {
      r = await apiFetch('/achats-fournisseurs', {
        method: 'POST',
        body: JSON.stringify({
          type: 'bill', date_achat: TODAY, due_date: c.due, vendor: VENDOR,
          vendor_invoice_number: `E2E-${c.key}-${STAMP}`, amount_cad: c.amount, tax_cad: 0,
          total_cad: c.amount, status: 'Brouillon', notes: 'Record jetable créé par un test E2E',
        }),
      })
      assert.equal(r.status, 201, `création de la facture ${c.key} : ${JSON.stringify(r.body)}`)
      billIds[c.key] = r.body.id
      r = await apiFetch(`/achats-fournisseurs/${billIds[c.key]}`, {
        method: 'PUT', body: JSON.stringify({ status: 'Reçue' }),
      })
      assert.equal(r.status, 200, `statut de la facture ${c.key} : ${JSON.stringify(r.body)}`)
    }

    await page.goto(URL + '/paiements-emis?onglet=pending', { waitUntil: 'domcontentloaded' })
    // La saisie est repliée par défaut : on l'ouvre avec « Nouveau paiement ».
    await page.waitForSelector('[data-testid="payment-new-toggle"]', { timeout: 20000 })
    await page.click('[data-testid="payment-new-toggle"]')
    await page.waitForSelector('[data-testid="payment-new-form"]', { timeout: 20000 })
  })

  after(async () => {
    for (const id of Object.values(billIds)) {
      try { await apiFetch(`/achats-fournisseurs/${id}`, { method: 'DELETE' }) } catch { /* déjà parti */ }
    }
    if (profileId) { try { await apiFetch(`/vendor-profiles/${profileId}`, { method: 'DELETE' }) } catch { /* déjà parti */ } }
    await browser?.close()
  })

  for (const c of CASES) {
    test(`échéance ${c.due} (${c.key}) → paiement daté du ${c.expect}`, async () => {
      await page.waitForSelector(`[data-testid="open-bill-${billIds[c.key]}"]`, { timeout: 20000 })
      await page.click(`[data-testid="open-bill-${billIds[c.key]}"]`)
      await page.waitForSelector('[data-testid="payment-linked-bill"]', { timeout: 10000 })

      assert.equal(await page.inputValue('[data-testid="payment-new-date"]'), c.expect,
        `la date proposée doit être ${c.expect}`)

      // La raison est écrite noir sur blanc — sinon la date paraît arbitraire.
      const note = await page.textContent('[data-testid="payment-pay-date-note"]')
      for (const w of c.words) {
        assert.ok(note.includes(w), `« ${w} » absent de l'explication : ${note}`)
      }
    })
  }

  test('le compte à débiter vient du profil fournisseur (« Master » → MasterCard BNC)', async () => {
    await page.click(`[data-testid="open-bill-${billIds.ouvrable}"]`)
    await page.waitForSelector('[data-testid="payment-linked-bill"]', { timeout: 10000 })

    const account = (await page.textContent('[data-testid="payment-new-from-account"]')).trim()
    assert.equal(account, 'MasterCard BNC', `compte proposé inattendu : ${account}`)
    // Un Interac ne peut pas partir d'une carte : le moyen bascule sur « Autre ».
    assert.equal(await page.getAttribute('[data-testid="payment-method-autre"]', 'aria-pressed'), 'true',
      'le moyen doit être « Autre » quand le paiement part d\'une carte')

    // Le reste des cases suit la facture (fournisseur, montant, n° de facture).
    assert.equal(await page.inputValue('[data-testid="payment-new-label"]'), VENDOR)
    assert.equal(await page.inputValue('[data-testid="payment-new-amount"]'), '222.22')
    assert.equal(await page.inputValue('[data-testid="payment-new-invoice"]'), `E2E-ouvrable-${STAMP}`)
  })

  test('une date changée à la main peut être remise à la date proposée', async () => {
    await page.click(`[data-testid="open-bill-${billIds.weekend}"]`)
    await page.waitForSelector('[data-testid="payment-linked-bill"]', { timeout: 10000 })
    assert.equal(await page.locator('[data-testid="payment-pay-date-restore"]').count(), 0,
      'aucun lien de retour tant que la date proposée est intacte')

    await page.fill('[data-testid="payment-new-date"]', '2027-02-01')
    await page.waitForSelector('[data-testid="payment-pay-date-restore"]', { timeout: 5000 })
    await page.click('[data-testid="payment-pay-date-restore"]')
    assert.equal(await page.inputValue('[data-testid="payment-new-date"]'), '2027-01-15')
  })
})
