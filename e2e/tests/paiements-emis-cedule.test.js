// /paiements-emis?onglet=cedule — cédule hebdomadaire de paiements fournisseurs.
//
// Vérifie les quatre promesses du chantier :
//   1. les factures ouvertes de la semaine apparaissent, regroupées par
//      fournisseur (l'écran n'a plus de tuiles de tête : ni total de séance, ni
//      solde BNC, ni projection de carte — retirées le 12 août 2026) ;
//   2. cocher une ligne crée le paiement émis DU JOUR lié à la facture, demande
//      sa référence sur place, puis retire la facture de la cédule (elle
//      continue sa vie dans « À passer à la banque » — il n'y a pas de section
//      « déjà payées ») ;
//   3. reporter est un état avec sa raison (autosave), réversible ;
//   4. basculer une facture sur la Mastercard se voit sur la ligne, sans
//      ressusciter la projection retirée de l'écran.
//
// Aucun record réel n'est touché : deux factures jetables marquées E2E, créées
// en Brouillon puis passées à « Reçue » pour ne PAS écrire dans le Google Sheet
// CTB (fire-and-forget sur le POST seulement), supprimées dans after() avec les
// paiements et le report éventuellement créés.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const STAMP = Date.now()
const VENDOR = `E2E Cedule ${STAMP}`
const VENDOR_CARD = `E2E Cedule Carte ${STAMP}`
const TODAY = new Date().toISOString().slice(0, 10)
const IN_2_DAYS = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10)
const CARD_ACCOUNT = 'MasterCard BNC'

describe('Paiements émis — cédule hebdomadaire de paiements fournisseurs', () => {
  let browser, ctx, page
  let billId = null
  let cardBillId = null
  const extraBillIds = []
  const createdPaymentIds = []

  const apiFetch = (path, opts = {}) => page.evaluate(async ({ path, opts }) => {
    const tok = localStorage.getItem('erp_token')
    const r = await fetch(`/erp/api${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}`, ...(opts.headers || {}) },
    })
    return { status: r.status, body: await r.json().catch(() => null) }
  }, { path, opts })

  const createBill = async (vendor, amount, dueDate) => {
    let r = await apiFetch('/achats-fournisseurs', {
      method: 'POST',
      body: JSON.stringify({
        type: 'bill', date_achat: TODAY, due_date: dueDate, vendor,
        vendor_invoice_number: `E2E-${vendor.slice(-6)}`, amount_cad: amount, tax_cad: 0, total_cad: amount,
        status: 'Brouillon', notes: 'Record jetable créé par un test E2E',
      }),
    })
    assert.equal(r.status, 201, `création de la facture : ${JSON.stringify(r.body)}`)
    const id = r.body.id
    r = await apiFetch(`/achats-fournisseurs/${id}`, { method: 'PUT', body: JSON.stringify({ status: 'Reçue' }) })
    assert.equal(r.status, 200, `statut de la facture : ${JSON.stringify(r.body)}`)
    return id
  }

  const schedule = async () => {
    const r = await apiFetch('/treasury/payment-schedule')
    assert.equal(r.status, 200, `cédule : ${JSON.stringify(r.body)}`)
    return r.body
  }

  // La cédule ne contient QUE ce qui reste à décider : une facture réglée n'y
  // apparaît plus nulle part (sa suite se joue dans « À passer à la banque »).
  const findItem = (sched, id) => [
    ...sched.vendors.flatMap(g => g.items),
    ...sched.later.flatMap(g => g.items),
    ...sched.deferred,
  ].find(i => i.id === id) || null

  // Ce qui reste PROPOSÉ (hors factures payées, hors reportées).
  const proposed = (sched, id) => sched.vendors.some(g => g.items.some(i => i.id === id))

  const paymentForBill = async (id) => {
    const r = await apiFetch('/treasury/payments?status=all&limit=500')
    assert.equal(r.status, 200)
    return (r.body || []).find(p => p.achat_id === id) || null
  }

  // Attend qu'une condition sur la cédule serveur devienne vraie (l'UI écrit,
  // on vérifie la donnée — pas le DOM immédiat).
  const waitForSchedule = async (pred, label) => {
    for (let i = 0; i < 25; i++) {
      const s = await schedule()
      if (pred(s)) return s
      await new Promise(r => setTimeout(r, 400))
    }
    assert.fail(`condition jamais atteinte : ${label}`)
  }

  const openSchedule = async () => {
    await page.goto(`${URL}/paiements-emis?onglet=cedule`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="schedule-view"]', { timeout: 20000 })
  }

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    billId = await createBill(VENDOR, 1234.56, IN_2_DAYS)
    cardBillId = await createBill(VENDOR_CARD, 12000, IN_2_DAYS)
    await openSchedule()
  })

  after(async () => {
    // Cleanup — s'exécute même en cas d'échec.
    for (const id of [billId, cardBillId, ...extraBillIds].filter(Boolean)) {
      try { await apiFetch(`/treasury/payment-schedule/${id}/defer`, { method: 'DELETE' }) } catch { /* pas de report */ }
      try { await apiFetch(`/treasury/payment-schedule/${id}/pay`, { method: 'DELETE' }) } catch { /* pas de paiement */ }
    }
    for (const id of createdPaymentIds) {
      try { await apiFetch(`/treasury/payments/${id}`, { method: 'DELETE' }) } catch { /* déjà parti */ }
    }
    for (const id of [billId, cardBillId, ...extraBillIds].filter(Boolean)) {
      try { await apiFetch(`/achats-fournisseurs/${id}`, { method: 'DELETE' }) } catch { /* déjà parti */ }
    }
    await browser?.close()
  })

  test('la cédule liste la facture de la semaine, groupée par fournisseur, et totalise', async () => {
    await page.waitForSelector(`[data-testid="schedule-item-${billId}"]`, { timeout: 20000 })

    const s = await schedule()
    const item = findItem(s, billId)
    assert.ok(item, 'la facture doit être dans la cédule')
    assert.equal(item.bucket, 'week')
    assert.equal(item.amount, 1234.56)
    assert.equal(item.paid, false)
    // Un groupe par fournisseur, avec le total du fournisseur.
    const group = s.vendors.find(g => g.vendor === VENDOR)
    assert.ok(group, 'groupe fournisseur absent')
    assert.equal(group.total_cad, 1234.56)
    await page.waitForSelector(`[data-testid="schedule-vendor-${group.key}"]`, { timeout: 10000 })

    // Le total de la semaine comprend bien nos deux factures jetables.
    assert.ok(s.totals.week_cad >= 13234.56, `total de semaine trop bas : ${s.totals.week_cad}`)
  })

  test('cocher crée le paiement du jour et RETIRE la facture de la cédule', async () => {
    const avant = await schedule()
    await page.click(`[data-testid="schedule-pay-${billId}"]`)

    // Juste après le clic, la ligne demande la référence du paiement (n° de
    // confirmation, n° de chèque…) : c'est ce qui la retient à l'écran. Échap
    // passe la saisie — ce flux a son propre test
    // (paiements-emis-cedule-reference).
    await page.waitForSelector(`[data-testid="schedule-reference-${billId}"]`, { timeout: 20000 })
    await page.keyboard.press('Escape')

    // Payée = elle disparaît de la cédule (proposition, « plus tard », reportées) :
    // il n'y a plus de section « déjà payées », la suite est dans « À passer à
    // la banque ».
    const s = await waitForSchedule(x => findItem(x, billId) === null, 'facture retirée de la cédule')
    assert.equal(proposed(s, billId), false)
    assert.equal(await page.locator('[data-testid="schedule-paid-list"]').count(), 0,
      'la section « déjà payées » ne doit plus exister')
    await page.waitForSelector(`[data-testid="schedule-item-${billId}"]`, { state: 'detached', timeout: 20000 })

    // Le paiement existe vraiment dans /paiements-emis, à la date du jour et
    // lié à la facture.
    const pmt = await paymentForBill(billId)
    assert.ok(pmt, 'paiement absent de la liste des paiements émis')
    createdPaymentIds.push(pmt.id)
    assert.equal(pmt.payment_date, TODAY, 'le paiement doit porter la date du jour')
    assert.equal(pmt.amount, 1234.56)
    assert.equal(pmt.direction, 'out')
    assert.equal(pmt.cleared_at, null)
    // Elle est bien dans l'onglet « À passer à la banque ».
    await page.goto(`${URL}/paiements-emis?onglet=pending`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector(`[data-testid="payment-row-${pmt.id}"]`, { timeout: 20000 })

    // Le reste à payer a baissé d'autant, et le solde reste explicable : ce qui
    // est déjà payé sort de la liste mais continue de grever le compte.
    assert.ok(Math.abs(avant.totals.week_remaining_cad - s.totals.week_remaining_cad - 1234.56) < 0.01,
      'le reste à payer doit baisser du montant réglé')
    assert.ok(Math.abs(s.balance.week_outflow - (s.balance.week_outflow_to_pay + s.balance.week_outflow_paid)) < 0.01,
      'la décomposition du solde doit rester exacte')

    // Suppression du paiement (l'annulation se fait ici) → la facture revient.
    const del = await apiFetch(`/treasury/payments/${pmt.id}`, { method: 'DELETE' })
    assert.equal(del.status, 200)
    createdPaymentIds.length = 0
    const back = await waitForSchedule(x => proposed(x, billId), 'facture revenue dans la cédule')
    assert.ok(findItem(back, billId), 'la facture doit être de nouveau proposée')
    await openSchedule()
  })

  // Le bouton « Reporter » a été retiré de la ligne : on ne reporte plus depuis
  // la cédule. L'état existe toujours (report posé côté serveur), et tout ce qui
  // s'y rattache — raison, date de retour, reprise — reste piloté depuis la
  // section « Reportés ».
  test('aucun bouton « Reporter » sur la ligne de la cédule', async () => {
    await openSchedule()
    await page.waitForSelector(`[data-testid="schedule-item-${billId}"]`, { timeout: 20000 })
    assert.equal(await page.locator(`[data-testid="schedule-defer-${billId}"]`).count(), 0,
      'le bouton « Reporter » ne doit plus exister sur la ligne')
    const row = await page.textContent(`[data-testid="schedule-item-${billId}"]`)
    assert.ok(!/Reporter/.test(row), `la ligne ne doit plus proposer de report : ${row}`)
  })

  test('une facture reportée garde sa raison (autosave), et se reprend', async () => {
    const r = await apiFetch(`/treasury/payment-schedule/${billId}/defer`, {
      method: 'PUT', body: JSON.stringify({ reason: '' }),
    })
    assert.ok(r.status < 300, `report : ${JSON.stringify(r.body)}`)
    await waitForSchedule(x => findItem(x, billId)?.deferred, 'facture reportée')
    await openSchedule()
    await page.waitForSelector(`[data-testid="schedule-reason-${billId}"]`, { timeout: 20000 })

    const REASON = `Avoir en attente ${STAMP}`
    await page.fill(`[data-testid="schedule-reason-${billId}"]`, REASON)
    // Autosave au blur — aucun bouton « Enregistrer ».
    await page.click('[data-testid="schedule-window-explainer"]')
    const s = await waitForSchedule(x => findItem(x, billId)?.defer_reason === REASON, 'raison enregistrée')
    assert.equal(findItem(s, billId).deferred, true)
    // Reportée = hors du total de la semaine.
    assert.ok(!s.vendors.some(g => g.items.some(i => i.id === billId)), 'la reportée ne doit plus être proposée')

    await page.click(`[data-testid="schedule-resume-${billId}"]`)
    const back = await waitForSchedule(x => findItem(x, billId)?.deferred === false, 'facture reprise')
    assert.ok(back.vendors.some(g => g.items.some(i => i.id === billId)), 'la facture doit revenir dans la cédule')
  })

  // Le cycle réel : on paie le mardi, et ce jour-là on règle tout ce qui échoit
  // AVANT le mercredi suivant — donc jusqu'au mardi d'après inclus.
  test('la fenêtre suit la séance du mardi et l\'écrit noir sur blanc', async () => {
    const s = await schedule()
    const dow = new Date(`${s.week.pay_day}T12:00:00Z`).getUTCDay()
    assert.equal(dow, 2, `la séance de paiement doit tomber un mardi : ${s.week.pay_day}`)
    const plus7 = new Date(`${s.week.pay_day}T12:00:00Z`)
    plus7.setUTCDate(plus7.getUTCDate() + 7)
    assert.equal(s.week.end, plus7.toISOString().slice(0, 10), 'la fenêtre va jusqu\'au mardi suivant inclus')
    const cutoff = new Date(`${s.week.end}T12:00:00Z`)
    cutoff.setUTCDate(cutoff.getUTCDate() + 1)
    assert.equal(s.week.cutoff, cutoff.toISOString().slice(0, 10), 'la coupure est le mercredi')

    // Une facture échéant le mardi suivant est DANS la cédule ; le mercredi, non.
    const dernierJour = await createBill(`E2E Mardi ${STAMP}`, 11.11, s.week.end)
    extraBillIds.push(dernierJour)
    const apresCoupure = await createBill(`E2E Mercredi ${STAMP}`, 22.22, s.week.cutoff)
    extraBillIds.push(apresCoupure)

    const s2 = await waitForSchedule(x => findItem(x, dernierJour) && findItem(x, apresCoupure), 'factures visibles')
    assert.equal(findItem(s2, dernierJour).bucket, 'week', 'échéance au mardi suivant = à payer cette séance')
    assert.equal(findItem(s2, apresCoupure).bucket, 'later', 'échéance au mercredi = séance suivante')
    assert.equal(proposed(s2, apresCoupure), false)

    // La règle est écrite dans l'interface, pas seulement dans le calcul.
    await openSchedule()
    const rule = await page.textContent('[data-testid="schedule-window-explainer"]')
    assert.ok(/mardi/i.test(rule) && /avant le mercredi/i.test(rule), `règle absente de l'interface : ${rule}`)
    assert.ok(/inclus/.test(rule), 'la règle doit préciser la dernière échéance couverte')
  })

  test('un bouton ouvre la facture dans QuickBooks (grisé si elle n\'y est pas encore)', async () => {
    // Pas encore publiée à QB : le bouton existe mais n'est pas un lien.
    await openSchedule()
    await page.waitForSelector(`[data-testid="schedule-qb-${billId}"]`, { timeout: 20000 })
    assert.equal(await page.evaluate(id => document.querySelector(`[data-testid="schedule-qb-${id}"]`).tagName, billId), 'SPAN')

    // Publiée à QB : lien direct vers la facture, dans un nouvel onglet.
    const QB_ID = '999999'
    const r = await apiFetch(`/achats-fournisseurs/${billId}`, {
      method: 'PUT', body: JSON.stringify({ quickbooks_id: QB_ID }),
    })
    assert.equal(r.status, 200, `lien QB : ${JSON.stringify(r.body)}`)
    await waitForSchedule(x => findItem(x, billId)?.qb_url, 'url QuickBooks exposée')

    await openSchedule()
    const link = page.locator(`a[data-testid="schedule-qb-${billId}"]`)
    await link.waitFor({ timeout: 20000 })
    const href = await link.getAttribute('href')
    assert.ok(href.includes(`txnId=${QB_ID}`), `href inattendu : ${href}`)
    assert.ok(/\/app\/bill\?/.test(href), `l'URL doit pointer sur la facture QB : ${href}`)
    assert.equal(await link.getAttribute('target'), '_blank')

    // Remis comme avant pour ne rien laisser traîner sur la facture jetable.
    await apiFetch(`/achats-fournisseurs/${billId}`, { method: 'PUT', body: JSON.stringify({ quickbooks_id: null }) })
  })

  // Les trois tuiles de tête (total de la séance, solde BNC après cédule, solde
  // projeté de la carte) ont été retirées le 12 août 2026 : l'écran ne montre
  // plus que la liste à payer. Le serveur continue de calculer ces chiffres.
  test('aucune tuile de tête : l\'écran ne montre que la liste à payer', async () => {
    await openSchedule()
    await page.waitForSelector(`[data-testid="schedule-item-${billId}"]`, { timeout: 20000 })

    for (const id of ['schedule-week-total', 'schedule-balance-after', 'schedule-mc-projected',
      'schedule-window-rule', 'schedule-week-already-paid', 'schedule-mc-alert']) {
      assert.equal(await page.locator(`[data-testid="${id}"]`).count(), 0, `la tuile ${id} ne doit plus exister`)
    }
    // Le premier bloc de la vue est bien la liste, plus une rangée de tuiles.
    const first = await page.evaluate(() =>
      document.querySelector('[data-testid="schedule-view"]').firstElementChild.getAttribute('data-testid'))
    assert.equal(first, 'schedule-vendors', 'la liste à payer doit ouvrir l\'écran')
  })

  // La bascule sur la carte reste possible et se voit sur la ligne, mais elle
  // n'alimente plus de projection à l'écran.
  test('basculer une facture sur la Mastercard marque la ligne, sans projection affichée', async () => {
    await openSchedule()
    await page.waitForSelector(`[data-testid="schedule-account-${cardBillId}"]`, { timeout: 20000 })

    const s = await schedule()
    assert.ok(s.mastercard?.available_data, 'le serveur doit continuer d\'exposer la carte')
    assert.equal(s.mastercard.threshold, 10000)
    assert.equal(s.mastercard.limit, 15000)
    assert.equal(await page.locator(`[data-testid="schedule-on-card-${cardBillId}"]`).count(), 0)

    await page.selectOption(`[data-testid="schedule-account-${cardBillId}"]`, CARD_ACCOUNT)
    await page.waitForSelector(`[data-testid="schedule-on-card-${cardBillId}"]`, { timeout: 10000 })
    assert.equal(await page.locator('[data-testid="schedule-mc-alert"]').count(), 0,
      'plus d\'alerte de carte à l\'écran')
  })
})
