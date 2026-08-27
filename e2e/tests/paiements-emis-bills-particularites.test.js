// /paiements-emis — refonte de la liste + connexions fournisseurs / factures.
//
// Vérifie les trois promesses du chantier :
//   1. le panneau « Factures à payer » liste les factures ouvertes et un clic
//      pré-remplit le formulaire (fournisseur, montant, n° de facture) avec le
//      lien achat_id — la facture sort de la liste une fois le paiement ajouté ;
//   2. les particularités du profil fournisseur s'affichent en avertissement au
//      moment de payer (sélection d'une facture OU saisie du nom) ;
//   3. le bouton « passé à la banque » est en tête de chaque ligne et bascule
//      cleared_at dans les deux sens.
//
// Aucun record réel n'est touché : profil fournisseur, facture et paiements
// portent un nom jetable marqué E2E et sont supprimés dans after(). La facture
// est créée en Brouillon puis passée à « Reçue » pour ne PAS déclencher l'ajout
// au Google Sheet CTB (fire-and-forget sur le POST seulement).
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const STAMP = Date.now()
const VENDOR = `E2E Greenovation ${STAMP}`
const PARTICULARITE = `Inscrire le numéro de document ${STAMP} comme réponse au virement.`
const INVOICE_NO = `E2E-FAC-${STAMP}`
const TODAY = new Date().toISOString().slice(0, 10)

describe('Paiements émis — factures à payer et particularités fournisseur', () => {
  let browser, ctx, page
  let profileId = null
  let billId = null
  const createdPaymentIds = []

  const apiFetch = (path, opts = {}) => page.evaluate(async ({ path, opts }) => {
    const tok = localStorage.getItem('erp_token')
    const r = await fetch(`/erp/api${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}`, ...(opts.headers || {}) },
    })
    return { status: r.status, body: await r.json().catch(() => null) }
  }, { path, opts })

  const findPaymentByLabel = async (label) => {
    const r = await apiFetch('/treasury/payments?status=all&limit=500')
    assert.equal(r.status, 200)
    return (r.body || []).find(p => p.label === label) || null
  }

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    // Décor : un profil fournisseur avec particularité + une facture ouverte.
    let r = await apiFetch('/vendor-profiles', { method: 'POST', body: JSON.stringify({ name: VENDOR }) })
    assert.equal(r.status, 201, `création du profil : ${JSON.stringify(r.body)}`)
    profileId = r.body.id
    r = await apiFetch(`/vendor-profiles/${profileId}`, {
      method: 'PATCH', body: JSON.stringify({ particularites: PARTICULARITE }),
    })
    assert.equal(r.status, 200, `particularités du profil : ${JSON.stringify(r.body)}`)

    // Brouillon d'abord (pas d'écriture Google Sheet), « Reçue » ensuite.
    r = await apiFetch('/achats-fournisseurs', {
      method: 'POST',
      body: JSON.stringify({
        type: 'bill', date_achat: TODAY, due_date: TODAY, vendor: VENDOR,
        vendor_invoice_number: INVOICE_NO, amount_cad: 123.45, tax_cad: 0, total_cad: 123.45,
        status: 'Brouillon', notes: 'Record jetable créé par un test E2E',
      }),
    })
    assert.equal(r.status, 201, `création de la facture : ${JSON.stringify(r.body)}`)
    billId = r.body.id
    r = await apiFetch(`/achats-fournisseurs/${billId}`, { method: 'PUT', body: JSON.stringify({ status: 'Reçue' }) })
    assert.equal(r.status, 200, `statut de la facture : ${JSON.stringify(r.body)}`)

    await page.goto(URL + '/paiements-emis', { waitUntil: 'domcontentloaded' })
    // La saisie est repliée par défaut : on l'ouvre avec « Nouveau paiement ».
    await page.waitForSelector('[data-testid="payment-new-toggle"]', { timeout: 20000 })
    await page.click('[data-testid="payment-new-toggle"]')
    await page.waitForSelector('[data-testid="payment-new-form"]', { timeout: 20000 })
  })

  after(async () => {
    // Cleanup — s'exécute même en cas d'échec.
    for (const id of createdPaymentIds) {
      try { await apiFetch(`/treasury/payments/${id}`, { method: 'DELETE' }) } catch { /* déjà parti */ }
    }
    if (billId) { try { await apiFetch(`/achats-fournisseurs/${billId}`, { method: 'DELETE' }) } catch { /* déjà parti */ } }
    if (profileId) { try { await apiFetch(`/vendor-profiles/${profileId}`, { method: 'DELETE' }) } catch { /* déjà parti */ } }
    await browser?.close()
  })

  test('le panneau « Factures à payer » liste la facture ouverte avec son alerte particularité', async () => {
    await page.waitForSelector(`[data-testid="open-bill-${billId}"]`, { timeout: 20000 })
    const text = await page.textContent(`[data-testid="open-bill-${billId}"]`)
    assert.ok(text.includes(VENDOR), `fournisseur absent de la carte : ${text}`)
    assert.ok(text.includes(INVOICE_NO), `n° de facture absent de la carte : ${text}`)
    // Le triangle ambre = particularité du profil, détaillée dans l'infobulle.
    const title = await page.getAttribute(`[data-testid="open-bill-${billId}"]`, 'title')
    assert.ok(title.includes('Particularité'), `infobulle sans particularité : ${title}`)
  })

  test('choisir une facture pré-remplit le formulaire et affiche la particularité', async () => {
    await page.click(`[data-testid="open-bill-${billId}"]`)

    assert.equal(await page.inputValue('[data-testid="payment-new-label"]'), VENDOR)
    assert.equal(await page.inputValue('[data-testid="payment-new-amount"]'), '123.45')
    assert.equal(await page.inputValue('[data-testid="payment-new-invoice"]'), INVOICE_NO)

    // Bandeau « règle la facture X » + avertissement particularité, impossibles à rater.
    const linked = await page.textContent('[data-testid="payment-linked-bill"]')
    assert.ok(linked.includes(INVOICE_NO), `bandeau facture liée inattendu : ${linked}`)
    const warn = await page.textContent('[data-testid="payment-vendor-particularites"]')
    assert.ok(warn.includes(PARTICULARITE), `particularité absente de l'avertissement : ${warn}`)
  })

  test('le paiement créé est lié à la facture, qui sort de la liste « à payer »', async () => {
    await page.fill('[data-testid="payment-new-reference"]', `CONF${STAMP}`)
    await page.click('[data-testid="payment-new-save"]')

    let created = null
    for (let i = 0; i < 20 && !created; i++) {
      created = await findPaymentByLabel(VENDOR)
      if (!created) await new Promise(r => setTimeout(r, 500))
    }
    assert.ok(created, 'paiement non créé')
    createdPaymentIds.push(created.id)
    assert.equal(created.achat_id, billId, 'le paiement doit être lié à la facture choisie')
    assert.equal(created.invoice_number, INVOICE_NO)
    assert.equal(created.amount, 123.45)
    assert.equal(created.direction, 'out')
    assert.equal(created.cleared_at, null)

    // La facture couverte disparaît du panneau (rechargé après l'ajout)…
    await page.waitForSelector(`[data-testid="open-bill-${billId}"]`, { state: 'detached', timeout: 10000 })
    // …et de l'endpoint.
    const r = await apiFetch('/treasury/payments/open-bills')
    assert.equal(r.status, 200)
    assert.ok(!(r.body || []).some(b => b.id === billId), 'la facture couverte ne doit plus être « à payer »')
  })

  test('la ligne rappelle la particularité et « passé à la banque » bascule dans les deux sens', async () => {
    const id = createdPaymentIds[0]
    await page.waitForSelector(`[data-testid="payment-row-${id}"]`, { timeout: 20000 })

    // Rappel de la particularité tant que le paiement n'est pas passé.
    const reminder = await page.textContent(`[data-testid="payment-particularites-${id}"]`)
    assert.ok(reminder.includes(PARTICULARITE), `rappel absent de la ligne : ${reminder}`)

    // Le bouton est en tête de ligne et dit son état.
    assert.equal(await page.getAttribute(`[data-testid="payment-cleared-${id}"]`, 'aria-pressed'), 'false')
    await page.click(`[data-testid="payment-cleared-${id}"]`)
    let row = null
    for (let i = 0; i < 20 && !row?.cleared_at; i++) {
      row = await findPaymentByLabel(VENDOR)
      if (!row?.cleared_at) await new Promise(r => setTimeout(r, 500))
    }
    assert.ok(row?.cleared_at, 'cleared_at doit être posé après le clic')

    // Passé → il quitte l'onglet « À passer » ; on le retrouve dans « Tous »
    // et on le repasse en attente (décocher = échappatoire).
    await page.click('[data-testid="payments-tab-all"]')
    await page.waitForSelector(`[data-testid="payment-cleared-${id}"][aria-pressed="true"]`, { timeout: 20000 })
    await page.click(`[data-testid="payment-cleared-${id}"]`)
    row = null
    for (let i = 0; i < 20 && (row === null || row.cleared_at); i++) {
      row = await findPaymentByLabel(VENDOR)
      if (row?.cleared_at) await new Promise(r => setTimeout(r, 500))
    }
    assert.equal(row?.cleared_at, null, 'décocher doit remettre le paiement dans la projection')
  })

  test('taper le nom du fournisseur suffit à faire surgir la particularité', async () => {
    await page.click('[data-testid="payment-new-reset"]')
    assert.equal(await page.inputValue('[data-testid="payment-new-label"]'), '')
    assert.equal(await page.locator('[data-testid="payment-vendor-particularites"]').count(), 0,
      'pas d\'avertissement sans fournisseur saisi')

    await page.fill('[data-testid="payment-new-label"]', VENDOR)
    await page.waitForSelector('[data-testid="payment-vendor-particularites"]', { timeout: 5000 })
    const warn = await page.textContent('[data-testid="payment-vendor-particularites"]')
    assert.ok(warn.includes(PARTICULARITE), `particularité absente : ${warn}`)
  })
})
