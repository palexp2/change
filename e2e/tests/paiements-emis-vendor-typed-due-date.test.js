// /paiements-emis — la date proposée suit TOUJOURS l'échéance, même quand le
// fournisseur est tapé à la main au lieu d'être pioché dans « Factures à payer ».
//
// Règle de la maison : on paie au DERNIER jour de l'échéance (l'argent reste au
// compte le plus longtemps possible), et la veille ouvrable si les banques sont
// fermées ce jour-là. Le formulaire n'appliquait cette règle qu'au clic sur une
// facture du panneau : saisi à la main, le paiement était daté du jour même.
//
// Vérifie aussi qu'une date corrigée à la main n'est jamais écrasée, et qu'on
// peut revenir à la date proposée d'un clic.
//
// Aucun record réel n'est touché : les factures portent un nom jetable marqué
// E2E et sont supprimées dans after(). Elles sont créées en Brouillon puis
// passées à « Reçue » pour ne PAS déclencher l'ajout au Google Sheet CTB. Aucun
// paiement n'est créé.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const STAMP = Date.now()
const TODAY = new Date().toISOString().slice(0, 10)

// Échéances loin dans le futur pour que le test soit stable :
//   16 janv. 2027 = samedi            → payé le vendredi 15
//   20 janv. 2027 = mercredi ouvrable → payé le jour même
const CASES = [
  { key: 'weekend', vendor: `E2E Saisie Weekend ${STAMP}`, due: '2027-01-16', expect: '2027-01-15', amount: 444.44, words: ['samedi', 'fermées'] },
  { key: 'ouvrable', vendor: `E2E Saisie Ouvrable ${STAMP}`, due: '2027-01-20', expect: '2027-01-20', amount: 555.55, words: ['dernier jour'] },
]

describe('Paiements émis — le fournisseur saisi à la main date le paiement à son échéance', () => {
  let browser, ctx, page
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

    for (const c of CASES) {
      let r = await apiFetch('/achats-fournisseurs', {
        method: 'POST',
        body: JSON.stringify({
          type: 'bill', date_achat: TODAY, due_date: c.due, vendor: c.vendor,
          vendor_invoice_number: `E2E-SAISIE-${c.key}-${STAMP}`, amount_cad: c.amount, tax_cad: 0,
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

    // Les factures ouvertes sont chargées au montage : on n'ouvre la page
    // qu'une fois les records créés.
    await page.goto(URL + '/paiements-emis?onglet=pending', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="payment-new-toggle"]', { timeout: 20000 })
    await page.click('[data-testid="payment-new-toggle"]')
    await page.waitForSelector('[data-testid="payment-new-form"]', { timeout: 20000 })
    // La facture doit être arrivée dans le panneau, sinon le formulaire ne peut
    // pas connaître l'échéance.
    await page.waitForSelector(`[data-testid="open-bill-${billIds.weekend}"]`, { timeout: 20000 })
  })

  after(async () => {
    for (const id of Object.values(billIds)) {
      try { await apiFetch(`/achats-fournisseurs/${id}`, { method: 'DELETE' }) } catch { /* déjà parti */ }
    }
    await browser?.close()
  })

  for (const c of CASES) {
    test(`« ${c.key} » tapé au clavier → date proposée ${c.expect}`, async () => {
      await page.fill('[data-testid="payment-new-label"]', '')
      await page.fill('[data-testid="payment-new-label"]', c.vendor)
      await page.waitForFunction(
        exp => document.querySelector('[data-testid="payment-new-date"]')?.value === exp,
        c.expect, { timeout: 10000 },
      )
      assert.equal(await page.inputValue('[data-testid="payment-new-date"]'), c.expect)

      // La raison est écrite noir sur blanc — sinon la date paraît arbitraire.
      const note = await page.textContent('[data-testid="payment-date-hint"]')
      assert.ok(note.includes(`E2E-SAISIE-${c.key}-${STAMP}`), `le n° de facture doit être nommé : ${note}`)
      for (const w of c.words) {
        assert.ok(note.includes(w), `« ${w} » absent de l'explication : ${note}`)
      }
    })
  }

  test('une date corrigée à la main survit au changement de fournisseur, et se remet d\'un clic', async () => {
    await page.fill('[data-testid="payment-new-label"]', '')
    await page.fill('[data-testid="payment-new-label"]', CASES[0].vendor)
    await page.waitForFunction(
      exp => document.querySelector('[data-testid="payment-new-date"]')?.value === exp,
      CASES[0].expect, { timeout: 10000 },
    )

    const MANUAL = '2027-03-03'
    await page.fill('[data-testid="payment-new-date"]', MANUAL)
    await page.fill('[data-testid="payment-new-label"]', '')
    await page.fill('[data-testid="payment-new-label"]', CASES[1].vendor)
    await page.waitForSelector('[data-testid="payment-date-hint-restore"]', { timeout: 10000 })
    assert.equal(await page.inputValue('[data-testid="payment-new-date"]'), MANUAL,
      'une date saisie à la main ne doit jamais être écrasée')

    await page.click('[data-testid="payment-date-hint-restore"]')
    await page.waitForFunction(
      exp => document.querySelector('[data-testid="payment-new-date"]')?.value === exp,
      CASES[1].expect, { timeout: 10000 },
    )
  })

  test('un fournisseur sans facture ouverte reste daté d\'aujourd\'hui', async () => {
    await page.fill('[data-testid="payment-new-label"]', '')
    await page.fill('[data-testid="payment-new-label"]', `E2E Inconnu ${STAMP}`)
    await page.waitForFunction(
      exp => document.querySelector('[data-testid="payment-new-date"]')?.value === exp,
      TODAY, { timeout: 10000 },
    )
    assert.equal(await page.locator('[data-testid="payment-date-hint"]').count(), 0,
      'aucune échéance connue : pas d\'explication de date')
  })
})
