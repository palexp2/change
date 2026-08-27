// Dettes à long terme — les deux dettes manquantes (DEC et Ville de Québec) et
// le générateur de cédule d'amortissement.
//
// Vérifie :
//   • les deux prêts existent avec leur cédule complète et un solde qui concorde
//     avec le compte de dette correspondant dans QuickBooks ;
//   • les versements déjà passés côté Ville de Québec sont marqués comptabilisés
//     (donc pas de bouton « Comptabiliser » qui re-pousserait dans QB) ;
//   • le générateur de cédule calcule un aperçu et écrit les versements ;
//   • les récurrentes de trésorerie sont bornées (DEC ne sort rien avant 2028).
//
// Le générateur est testé sur une dette JETABLE créée puis supprimée par le
// test — aucune cédule réelle n'est touchée.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Dettes à long terme — DEC, Ville de Québec et générateur de cédule', () => {
  let browser, ctx, page
  let throwawayDebtId = null

  const api = (path, options) => page.evaluate(async ([p, o]) => {
    const res = await fetch(`/erp/api${p}`, {
      ...o,
      headers: {
        Authorization: `Bearer ${localStorage.getItem('erp_token')}`,
        'Content-Type': 'application/json',
        ...(o?.headers || {}),
      },
    })
    return { status: res.status, body: await res.json().catch(() => null) }
  }, [path, options || null])

  const openDebt = async (label) => {
    await page.click(`button:has-text("${label}")`)
    await page.waitForFunction(
      l => document.querySelector('[data-testid="debt-generate"]')
        && document.body.innerText.includes(l),
      label, { timeout: 15000 })
  }

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 20000 })
    await page.goto(URL + '/dettes-lt', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('button:has-text("Nouvelle dette")', { timeout: 20000 })
  })

  after(async () => {
    // La dette jetable et sa cédule disparaissent avec elle (suppression douce).
    if (throwawayDebtId) {
      await api(`/lt-debts/${throwawayDebtId}`, { method: 'DELETE' }).catch(() => {})
    }
    await browser?.close()
  })

  test('les deux dettes existent avec leurs paramètres et leurs comptes QB', async () => {
    const { body: debts } = await api('/lt-debts')
    const dec = debts.find(d => d.label === 'Prêt DEC')
    const vq = debts.find(d => d.label === 'Prêt Ville de Québec (FLI)')
    assert.ok(dec, 'prêt DEC absent de /dettes-lt')
    assert.ok(vq, 'prêt Ville de Québec absent de /dettes-lt')

    // DEC : contribution remboursable sans intérêt, 72 versements à partir de
    // novembre 2028 (avis de versement final du 2025-11-05).
    assert.equal(dec.annual_rate, 0)
    assert.equal(dec.payment_count, 72)
    assert.equal(dec.remaining_balance, 200000)
    assert.equal(dec.next_payment_date, '2028-11-01')
    assert.equal(dec.next_payment_total, 2777.78)
    assert.equal(dec.qb_debt_acctnum, '27400')
    assert.equal(dec.qb_bank_acctnum, '10000')

    // Ville de Québec : FLI 250 k$ à 6,5 %, 66 versements de 4 664,11 $, dont
    // les 6 premiers déjà comptabilisés.
    assert.equal(vq.annual_rate, 6.5)
    assert.equal(vq.payment_count, 66)
    assert.equal(vq.pushed_count, 6)
    assert.equal(vq.remaining_balance, 238376.61)
    assert.equal(vq.qb_debt_acctnum, '27500')
    assert.equal(vq.qb_interest_acctnum, '79200')
  })

  test('le solde de chaque cédule concorde avec le compte de dette QuickBooks', async () => {
    for (const id of ['ltdebt_dec', 'ltdebt_ville_quebec']) {
      const { status, body } = await api(`/lt-debts/${id}/qb-balance`)
      assert.equal(status, 200, `qb-balance ${id} → ${status}`)
      assert.equal(body.matches, true,
        `${id} : cédule ${body.erp_balance} vs QB ${body.qb_balance} (écart ${body.delta})`)
    }
  })

  test('la page affiche la concordance QB et les versements déjà comptabilisés', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('button:has-text("Nouvelle dette")', { timeout: 20000 })
    await openDebt('Prêt Ville de Québec (FLI)')

    await page.waitForFunction(
      () => /concordant|Écart/.test(document.querySelector('[data-testid="qb-balance-check"]')?.innerText || ''),
      null, { timeout: 25000 })
    const check = await page.locator('[data-testid="qb-balance-check"]').innerText()
    assert.match(check, /concordant avec QuickBooks #27500/)

    // Taux / cadence / montant repris des paramètres du prêt.
    assert.match(await page.locator('[data-testid="debt-terms"]').innerText(), /6,5 % · mensuelle/)

    // Les versements passés sont publiés (lien vers la dépense QB) — pas de
    // bouton qui permettrait de les repousser.
    const body = await page.locator('table').first().innerText()
    assert.match(body, /Publié · Dépense #/)
  })

  test('le générateur calcule un aperçu et écrit la cédule (dette jetable)', async () => {
    const label = `E2E cédule ${Date.now()}`
    const created = await api('/lt-debts', {
      method: 'POST',
      body: JSON.stringify({ label, lender: 'E2E', qb_debt_acctnum: '27400' }),
    })
    assert.equal(created.status, 201)
    throwawayDebtId = created.body.id

    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector(`button:has-text("${label}")`, { timeout: 20000 })
    await openDebt(label)
    await page.click('[data-testid="debt-generate"]')
    await page.waitForSelector('[data-testid="gen-opening_balance"]', { timeout: 15000 })

    await page.fill('[data-testid="gen-opening_balance"]', '12000')
    await page.fill('[data-testid="gen-annual_rate"]', '12')
    await page.fill('[data-testid="gen-first_payment_date"]', '2027-01-15')
    await page.fill('[data-testid="gen-n_payments"]', '12')

    // Aperçu calculé par le serveur : 12 versements, intérêts non nuls.
    await page.waitForFunction(
      () => /^12 versement/.test(document.querySelector('[data-testid="gen-count"]')?.innerText || ''),
      null, { timeout: 15000 })
    const interest = await page.locator('[data-testid="gen-interest"]').innerText()
    assert.ok(!/^0,00/.test(interest.trim()), `intérêts attendus non nuls, reçu ${interest}`)

    await page.click('[data-testid="gen-submit"]')
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="gen-submit"]'), null, { timeout: 20000 })

    const { body: payments } = await api(`/lt-debts/${throwawayDebtId}/payments`)
    assert.equal(payments.payments.length, 12)
    assert.equal(payments.payments[0].payment_date, '2027-01-15')
    assert.equal(payments.payments[0].interest, 120) // 12 000 × 12 % / 12
    assert.equal(payments.payments[11].balance_after, 0)
  })

  test('les versements attendus sont des récurrentes de trésorerie bornées', async () => {
    const { body: recurring } = await api('/treasury/recurring')
    const dec = recurring.find(r => r.label === 'Dette DEC')
    const vq = recurring.find(r => r.label === 'Dette Ville de Québec')
    assert.ok(dec, 'récurrente « Dette DEC » absente')
    assert.ok(vq, 'récurrente « Dette Ville de Québec » absente')
    assert.equal(dec.amount, 2777.78)
    assert.equal(dec.day_of_month, 1)
    assert.equal(dec.starts_on, '2028-11-01')
    assert.equal(dec.ends_on, '2034-10-01')
    assert.equal(vq.ends_on, '2031-07-11')

    // La borne de début fait son travail : DEC n'apparaît pas dans la
    // projection courante, la Ville de Québec oui.
    const { body: proj } = await api('/treasury/projection')
    const labels = (proj.days || []).flatMap(d => (d.events || []).map(e => e.label))
    assert.equal(labels.filter(l => l === 'Dette DEC').length, 0,
      'les versements DEC (nov. 2028) ne doivent pas être projetés aujourd’hui')
    assert.ok(labels.includes('Dette Ville de Québec'),
      'le versement mensuel de la Ville de Québec doit être projeté')
  })

  test('la projection affiche les bornes des récurrentes', async () => {
    // Lecture seule : on ne fait qu'ouvrir le panneau (l'édition d'une
    // récurrente s'autosauvegarde, on n'y touche pas).
    await page.goto(URL + '/comptabilite', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="treasury-recurring-toggle"]', { timeout: 25000 })
    await page.click('[data-testid="treasury-recurring-toggle"]')
    await page.waitForSelector('[data-testid="recurring-add"]', { timeout: 15000 })
    const txt = (await page.locator('[data-testid="treasury-section"]').innerText()).replace(/\s+/g, ' ')
    assert.match(txt, /Dette DEC/)
    assert.match(txt, /à partir du .*2028/)
    assert.match(txt, /jusqu'au .*2031/)
  })
})
