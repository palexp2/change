// /paiements-emis — l'interface montre d'abord la LISTE, pas la saisie.
//
// La page empilait, avant même le premier paiement : un pavé d'explications, un
// encadré QuickBooks bavard (même quand il n'avait rien à dire), le formulaire de
// saisie déplié en permanence et le panneau des factures à payer. La liste — le
// contenu réel — démarrait sous la ligne de flottaison, et chaque ligne affichait
// une douzaine de champs sur deux étages.
//
// Ce test verrouille la nouvelle règle :
//   1. au chargement, la saisie est repliée et le premier paiement est visible
//      dans le premier écran ;
//   2. « Nouveau paiement » ouvre la saisie (avec les factures à payer), la croix
//      la referme ;
//   3. une ligne = une seule ligne — dans l'ordre des colonnes de l'onglet
//      Pmt_Suivi du fichier CTB - Suivi (référence et commentaire y compris) ;
//      seuls les champs sans équivalent dans le fichier (sens, comptes,
//      bénéficiaire réel) s'ouvrent au clic sur le chevron ;
//   4. les actions rares (import, appariement) vivent dans le menu « ⋯ ».
//
// Aucun record réel n'est touché : le paiement créé porte un libellé jetable E2E
// et est supprimé dans after().
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const STAMP = Date.now()
const LABEL = `E2E Interface épurée ${STAMP}`

describe('Paiements émis — interface épurée', () => {
  let browser, ctx, page
  let paymentId = null

  const apiFetch = (path, opts = {}) => page.evaluate(async ({ path, opts }) => {
    const tok = localStorage.getItem('erp_token')
    const r = await fetch(`/erp/api${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}`, ...(opts.headers || {}) },
    })
    return { status: r.status, body: await r.json().catch(() => null) }
  }, { path, opts })

  const count = sel => page.locator(sel).count()

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    // Un paiement jetable, en attente : il fournit la ligne à inspecter.
    const r = await apiFetch('/treasury/payments', {
      method: 'POST',
      body: JSON.stringify({
        payment_date: new Date().toLocaleDateString('en-CA'),
        label: LABEL,
        amount: 12.34,
        direction: 'out',
        account: 'BNC CAD',
        currency: 'CAD',
        method: 'interac',
        reference: `CONF${STAMP}`,
        notes: 'note jetable e2e',
      }),
    })
    assert.ok(r.status < 300, `création du paiement jetable : ${JSON.stringify(r.body)}`)
    paymentId = r.body?.id || r.body?.payment?.id
    assert.ok(paymentId, `id du paiement jetable introuvable : ${JSON.stringify(r.body)}`)

    await page.goto(URL + '/paiements-emis?onglet=pending', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector(`[data-testid="payment-row-${paymentId}"]`, { timeout: 20000 })
  })

  after(async () => {
    if (paymentId) {
      try { await apiFetch(`/treasury/payments/${paymentId}`, { method: 'DELETE' }) } catch { /* déjà parti */ }
    }
    await browser?.close()
  })

  test('au chargement : pas de formulaire déplié, et la liste est dans le premier écran', async () => {
    assert.equal(await count('[data-testid="payment-new-form"]'), 0,
      'la saisie doit être repliée au chargement')
    assert.equal(await count('[data-testid="open-bills-panel"]'), 0,
      'le panneau des factures à payer accompagne la saisie, il ne doit pas occuper la page')
    assert.equal(await count('[data-testid="payment-new-toggle"]'), 1,
      'le bouton « Nouveau paiement » doit rester l\'action principale')

    // Rien à confirmer côté QuickBooks = une ligne discrète, pas un encadré.
    assert.equal(await count('[data-testid="qb-clear-panel"]'), 1)

    // Le vrai contenu — la première ligne de paiement — tient dans le premier écran.
    const box = await page.locator('[data-testid^="payment-row-"]').first().boundingBox()
    assert.ok(box, 'aucune ligne de paiement affichée')
    assert.ok(box.y < 400, `la première ligne démarre trop bas (${Math.round(box.y)} px)`)
  })

  test('« Nouveau paiement » ouvre la saisie et la croix la referme', async () => {
    await page.click('[data-testid="payment-new-toggle"]')
    await page.waitForSelector('[data-testid="payment-new-form"]', { timeout: 10000 })
    assert.equal(await count('[data-testid="open-bills-panel"]'), 1,
      'les factures à payer accompagnent la saisie')

    await page.click('[data-testid="payment-new-close"]')
    await page.waitForSelector('[data-testid="payment-new-form"]', { state: 'detached', timeout: 10000 })
    assert.equal(await count('[data-testid="open-bills-panel"]'), 0)
  })

  test('une ligne tient sur une ligne, avec les colonnes de Pmt_Suivi', async () => {
    const row = `[data-testid="payment-row-${paymentId}"]`
    await page.waitForSelector(row, { timeout: 20000 })

    // Colonnes de l'onglet Pmt_Suivi : visibles directement dans la ligne, pas
    // derrière le chevron.
    assert.equal(await count(`[data-testid="payment-cleared-${paymentId}"]`), 1,
      '« passé à la banque » reste visible sans rien ouvrir')
    assert.equal(await page.inputValue(`[data-testid="payment-reference-${paymentId}"]`), `CONF${STAMP}`,
      '# Paiement doit être visible dans la ligne, comme dans Pmt_Suivi')
    assert.equal(await page.inputValue(`[data-testid="payment-notes-${paymentId}"]`), 'note jetable e2e',
      'Commentaire doit être visible dans la ligne, comme dans Pmt_Suivi')

    const height = (await page.locator(row).boundingBox()).height
    assert.ok(height < 48, `la ligne doit tenir sur une seule ligne (${Math.round(height)} px)`)

    // Déplié : les champs sans équivalent dans le fichier (sens, comptes,
    // bénéficiaire réel), autosauvegardés comme avant.
    await page.click(`[data-testid="payment-expand-${paymentId}"]`)
    await page.waitForSelector(`[data-testid="payment-details-${paymentId}"]`, { timeout: 5000 })

    // Et le détail se referme.
    await page.click(`[data-testid="payment-expand-${paymentId}"]`)
    await page.waitForSelector(`[data-testid="payment-details-${paymentId}"]`, { state: 'detached', timeout: 5000 })
  })

  test('les actions rares sont dans le menu « ⋯ »', async () => {
    assert.equal(await count('[data-testid="payments-import-sheet"]'), 0,
      'l\'import ne doit pas occuper la barre de titre')
    await page.click('[data-testid="payments-more-menu"]')
    await page.waitForSelector('[data-testid="payments-more-menu-panel"]', { timeout: 5000 })
    // On vérifie leur présence sans les déclencher (ce sont de vraies synchros).
    assert.equal(await count('[data-testid="payments-import-sheet"]'), 1)
    assert.equal(await count('[data-testid="payments-auto-clear"]'), 1)
    // Refermé au clic à l'extérieur (le voile transparent capte le clic).
    await page.mouse.click(760, 500)
    await page.waitForSelector('[data-testid="payments-more-menu-panel"]', { state: 'detached', timeout: 5000 })
  })
})
