// /paiements-emis — formulaire de saisie guidé par le moyen de paiement.
//
// Vérifie les trois promesses de la refonte :
//   1. les champs demandés changent selon le moyen (Interac ≠ transfert ≠ chèque) ;
//   2. la saisie « d'où sort l'argent → vers qui » se traduit correctement en
//      stockage (account / direction / counterparty_account) ;
//   3. la mémoire des paiements passés (modèles + bouton « refaire ») pré-remplit
//      tout sauf ce qui change à chaque fois (montant, n° de confirmation, date).
//
// Aucun record réel n'est touché : les paiements créés portent un libellé jetable
// marqué E2E et sont supprimés dans after().
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const STAMP = Date.now()
const INTERAC_LABEL = `E2E Interac ${STAMP}`
const TRANSFER_LABEL = `E2E Transfert ${STAMP}`

describe('Paiements émis — formulaire guidé par le moyen de paiement', () => {
  let browser, ctx, page
  const createdIds = []

  const apiFetch = (path, opts = {}) => page.evaluate(async ({ path, opts }) => {
    const tok = localStorage.getItem('erp_token')
    const r = await fetch(`/erp/api${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}`, ...(opts.headers || {}) },
    })
    return { status: r.status, body: await r.json().catch(() => null) }
  }, { path, opts })

  // Retrouve le paiement créé par son libellé jetable.
  const findByLabel = async (label) => {
    const r = await apiFetch('/treasury/payments?status=all&limit=500')
    assert.equal(r.status, 200)
    return (r.body || []).find(p => p.label === label) || null
  }

  const pickAccount = async (testId, accountName) => {
    await page.click(`[data-testid="${testId}"]`)
    await page.waitForSelector(`[data-testid="${testId}-menu"]`)
    await page.click(`[data-testid="${testId}-menu"] button:has-text("${accountName}")`)
    await page.waitForSelector(`[data-testid="${testId}-menu"]`, { state: 'detached' })
  }

  // Ouvre le panneau de saisie s'il est replié.
  const openForm = async () => {
    await page.waitForSelector('[data-testid="payment-new-toggle"]', { timeout: 20000 })
    if (!(await page.locator('[data-testid="payment-new-form"]').count())) {
      await page.click('[data-testid="payment-new-toggle"]')
    }
    await page.waitForSelector('[data-testid="payment-new-form"]', { timeout: 20000 })
  }

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
    await page.goto(URL + '/paiements-emis', { waitUntil: 'domcontentloaded' })
    // La saisie est repliée par défaut (la page montre d'abord la liste) : on
    // l'ouvre avec le bouton « Nouveau paiement ».
    await openForm()
  })

  after(async () => {
    // Cleanup — s'exécute même en cas d'échec.
    for (const id of createdIds) {
      try { await apiFetch(`/treasury/payments/${id}`, { method: 'DELETE' }) } catch { /* déjà parti */ }
    }
    await browser?.close()
  })

  test('les champs demandés changent selon le moyen de paiement', async () => {
    const count = sel => page.locator(`[data-testid="${sel}"]`).count()

    // Virement Interac : bénéficiaire + n° de confirmation, un seul compte. Le
    // courriel/téléphone du bénéficiaire a été retiré de la saisie (il ne se
    // renseigne plus que dans le détail d'une ligne, au besoin).
    await page.click('[data-testid="payment-method-interac"]')
    assert.equal(await count('payment-new-label'), 1, 'bénéficiaire attendu')
    assert.equal(await count('payment-new-recipient'), 0, 'le champ courriel/téléphone ne doit plus être dans la saisie')
    let text = await page.textContent('[data-testid="payment-new-form"]')
    assert.ok(!text.includes('Courriel ou téléphone du bénéficiaire'),
      `le libellé du champ retiré ne doit plus apparaître : ${text}`)
    assert.equal(await count('payment-new-to-account'), 0, 'pas de second compte pour un Interac')
    assert.equal(await count('payment-new-invoice'), 1, 'n° de facture attendu')
    let formText = await page.textContent('[data-testid="payment-new-form"]')
    assert.ok(formText.includes("Compte d'où part le virement"), `libellé de compte Interac manquant : ${formText}`)
    assert.ok(formText.includes('N° de confirmation de la banque'), 'libellé du n° de confirmation manquant')

    // Transfert entre comptes : deux comptes, aucun bénéficiaire externe, pas de facture.
    await page.click('[data-testid="payment-method-transfert"]')
    assert.equal(await count('payment-new-to-account'), 1, 'compte destinataire attendu')
    assert.equal(await count('payment-new-label'), 0, 'pas de bénéficiaire externe pour un transfert')
    assert.equal(await count('payment-new-recipient'), 0)
    assert.equal(await count('payment-new-invoice'), 0, 'pas de facture pour un mouvement interne')
    formText = await page.textContent('[data-testid="payment-new-form"]')
    assert.ok(formText.includes("Compte d'où part l'argent"), 'libellé « De » manquant')
    assert.ok(formText.includes("Compte qui reçoit l'argent"), 'libellé « Vers » manquant')

    // Chèque : « à l'ordre de » + n° de chèque, ni courriel ni choix de sens.
    await page.click('[data-testid="payment-method-cheque"]')
    assert.equal(await count('payment-new-recipient'), 0)
    assert.equal(await count('payment-new-direction'), 0, 'le sens ne se choisit pas pour un chèque')
    formText = await page.textContent('[data-testid="payment-new-form"]')
    assert.ok(formText.includes("À l'ordre de"), 'libellé « À l\'ordre de » manquant')
    assert.ok(formText.includes('N° du chèque'), 'libellé « N° du chèque » manquant')

    // Autre : le sens redevient explicite.
    await page.click('[data-testid="payment-method-autre"]')
    assert.equal(await count('payment-new-direction'), 1, 'choix du sens attendu pour « Autre »')

    // Carte de crédit : compte payeur → carte payée.
    await page.click('[data-testid="payment-method-carte"]')
    assert.equal(await count('payment-new-to-account'), 1)
    formText = await page.textContent('[data-testid="payment-new-form"]')
    assert.ok(formText.includes('Carte payée'), 'libellé « Carte payée » manquant')
  })

  test('un virement Interac saisi est stocké avec son bénéficiaire et son compte source', async () => {
    await page.click('[data-testid="payment-method-interac"]')
    await page.fill('[data-testid="payment-new-label"]', INTERAC_LABEL)
    await page.fill('[data-testid="payment-new-amount"]', '12,34')
    await page.fill('[data-testid="payment-new-reference"]', `CONF${STAMP}`)
    await page.fill('[data-testid="payment-new-invoice"]', `FAC${STAMP}`)

    // Le résumé relit la saisie en une phrase — c'est le garde-fou anti-erreur de compte.
    const summary = await page.textContent('[data-testid="payment-new-summary"]')
    assert.ok(summary.includes('sortent de'), `résumé inattendu : ${summary}`)
    assert.ok(summary.includes('BNC CAD'), `compte source absent du résumé : ${summary}`)
    assert.ok(summary.includes(INTERAC_LABEL), `bénéficiaire absent du résumé : ${summary}`)

    await page.click('[data-testid="payment-new-save"]')

    // On valide par l'API (l'état DOM immédiat d'un formulaire contrôlé n'est pas fiable).
    let created = null
    for (let i = 0; i < 20 && !created; i++) {
      created = await findByLabel(INTERAC_LABEL)
      if (!created) await new Promise(r => setTimeout(r, 500))
    }
    assert.ok(created, 'paiement Interac non créé')
    createdIds.push(created.id)
    assert.equal(created.method, 'interac')
    assert.equal(created.direction, 'out')
    assert.equal(created.account, 'BNC CAD')
    assert.equal(created.counterparty_account, null, 'un Interac externe n’a pas de second compte')
    assert.equal(created.recipient, null, 'plus de bénéficiaire saisi à la création')
    assert.equal(created.reference, `CONF${STAMP}`)
    assert.equal(created.invoice_number, `FAC${STAMP}`)
    assert.equal(created.amount, 12.34)
    assert.equal(created.cleared_at, null, 'un paiement neuf est encore à passer à la banque')
  })

  test('« refaire ce paiement » recopie tout sauf montant et n° de confirmation', async () => {
    const id = createdIds[0]
    await page.click('[data-testid="payment-new-reset"]')
    assert.equal(await page.inputValue('[data-testid="payment-new-label"]'), '')

    await page.waitForSelector(`[data-testid="payment-reuse-${id}"]`, { timeout: 20000 })
    await page.click(`[data-testid="payment-reuse-${id}"]`)

    assert.equal(await page.getAttribute('[data-testid="payment-method-interac"]', 'aria-pressed'), 'true')
    assert.equal(await page.inputValue('[data-testid="payment-new-label"]'), INTERAC_LABEL)
    assert.equal(await page.inputValue('[data-testid="payment-new-amount"]'), '', 'le montant doit rester à saisir')
    assert.equal(await page.inputValue('[data-testid="payment-new-reference"]'), '', 'le n° de confirmation doit rester à saisir')
    assert.equal(await page.inputValue('[data-testid="payment-new-invoice"]'), '', 'le n° de facture doit rester à saisir')
  })

  test('le sélecteur de modèles retrouve un paiement passé et le rejoue', async () => {
    await page.click('[data-testid="payment-new-reset"]')
    assert.equal(await page.inputValue('[data-testid="payment-new-label"]'), '')

    await page.click('[data-testid="payment-template-picker"]')
    await page.waitForSelector('[data-testid="payment-template-picker-menu"]')
    await page.fill('[data-testid="payment-template-picker-menu"] input', INTERAC_LABEL)
    await page.click(`[data-testid="payment-template-picker-menu"] button:has-text("${INTERAC_LABEL}")`)
    await page.waitForSelector('[data-testid="payment-template-picker-menu"]', { state: 'detached' })

    assert.equal(await page.inputValue('[data-testid="payment-new-label"]'), INTERAC_LABEL)
    assert.equal(await page.getAttribute('[data-testid="payment-method-interac"]', 'aria-pressed'), 'true')
    assert.equal(await page.inputValue('[data-testid="payment-new-amount"]'), '')
    assert.equal(await page.inputValue('[data-testid="payment-new-reference"]'), '')
  })

  test('un transfert vers le BNC CAD est stocké comme une entrée, avec les deux comptes', async () => {
    await page.click('[data-testid="payment-new-reset"]')
    await page.click('[data-testid="payment-method-transfert"]')
    await pickAccount('payment-new-from-account', 'BNC Épargne')
    await pickAccount('payment-new-to-account', 'BNC CAD')

    // Sans libellé saisi, le mouvement se nomme tout seul « De → Vers ».
    await page.fill('[data-testid="payment-new-amount"]', '56.78')
    let summary = await page.textContent('[data-testid="payment-new-summary"]')
    assert.ok(summary.includes('entrent dans'), `un transfert vers le BNC CAD est une entrée : ${summary}`)
    assert.ok(summary.includes('BNC Épargne'), `compte source absent du résumé : ${summary}`)

    // Libellé jetable pour ne pas laisser d'ambiguïté avec les vrais transferts.
    await page.fill('[data-testid="payment-new-transfer-label"]', TRANSFER_LABEL)
    summary = await page.textContent('[data-testid="payment-new-summary"]')
    assert.ok(summary.includes('entrent dans'), `résumé inattendu : ${summary}`)
    await page.click('[data-testid="payment-new-save"]')

    let created = null
    for (let i = 0; i < 20 && !created; i++) {
      created = await findByLabel(TRANSFER_LABEL)
      if (!created) await new Promise(r => setTimeout(r, 500))
    }
    assert.ok(created, 'transfert non créé')
    createdIds.push(created.id)
    assert.equal(created.method, 'transfert')
    assert.equal(created.direction, 'in', 'un transfert qui alimente le BNC CAD est une entrée')
    assert.equal(created.account, 'BNC CAD', 'le côté projeté doit être stocké dans account')
    assert.equal(created.counterparty_account, 'BNC Épargne', 'le compte source doit être conservé')
    assert.equal(created.amount, 56.78)
  })

  test('la ligne d’un transfert laisse voir et modifier les deux comptes', async () => {
    const id = createdIds[createdIds.length - 1]
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector(`[data-testid="payment-row-${id}"]`, { timeout: 20000 })
    // Les détails de saisie d'une ligne s'ouvrent à la demande (chevron).
    await page.click(`[data-testid="payment-expand-${id}"]`)
    await page.waitForSelector(`[data-testid="payment-details-${id}"]`, { timeout: 5000 })
    assert.equal(
      await page.inputValue(`[data-testid="payment-counterparty-${id}"]`), 'BNC Épargne',
      'le second compte doit être visible dans la ligne'
    )
    // La colonne « Confirmation / n° » prend le vocabulaire du moyen.
    const refTitle = await page.getAttribute(`[data-testid="payment-reference-${id}"]`, 'title')
    assert.ok(/confirmation/i.test(refTitle), `titre de référence inattendu : ${refTitle}`)
  })
})
