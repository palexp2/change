// /paiements-emis?onglet=cedule — la référence du paiement se saisit sur la
// ligne, JUSTE APRÈS avoir cliqué « À payer ».
//
// Ce que ça garantit :
//   1. cliquer « À payer » crée le paiement du jour ET fait apparaître le champ
//      de référence sur la ligne (elle ne quitte pas la cédule tout de suite) ;
//   2. aller chercher le numéro dans un AUTRE onglet ne valide rien : la ligne
//      attend le retour, et le curseur revient dans le champ ;
//   3. la référence saisie est enregistrée sur le paiement créé (autosave,
//      aucun bouton « Enregistrer »), et la ligne quitte alors la cédule ;
//   4. Échap passe la saisie : le paiement existe quand même, sans référence.
//
// Aucun record réel n'est touché : une facture fournisseur jetable marquée E2E,
// créée en Brouillon puis passée à « Reçue » pour ne PAS écrire dans le Google
// Sheet CTB. Le paiement créé par le test et la facture sont supprimés dans
// after().
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const STAMP = Date.now()
const VENDOR = `E2E Reference ${STAMP}`
const REF = `E2E-REF-${STAMP}`
const TODAY = new Date().toISOString().slice(0, 10)

describe('Cédule — n° de référence saisi après avoir payé', () => {
  let browser, ctx, page
  let billId = null

  const apiFetch = (path, opts = {}) => page.evaluate(async ({ path, opts }) => {
    const tok = localStorage.getItem('erp_token')
    const r = await fetch(`/erp/api${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}`, ...(opts.headers || {}) },
    })
    return { status: r.status, body: await r.json().catch(() => null) }
  }, { path, opts })

  // La donnée fait foi, pas le DOM : on relit le paiement lié à la facture.
  const payment = async () => {
    const r = await apiFetch('/treasury/payments?status=pending')
    assert.equal(r.status, 200, `paiements : ${JSON.stringify(r.body)}`)
    const rows = r.body?.data || r.body || []
    return rows.find(p => p.achat_id === billId) || null
  }

  const waitForPayment = async (pred, label) => {
    for (let i = 0; i < 25; i++) {
      const p = await payment()
      if (pred(p)) return p
      await new Promise(r => setTimeout(r, 400))
    }
    assert.fail(`condition jamais atteinte sur le paiement : ${label}`)
  }

  const createBill = async (suffix) => {
    const r = await apiFetch('/achats-fournisseurs', {
      method: 'POST',
      body: JSON.stringify({
        type: 'bill', date_achat: TODAY, due_date: TODAY, vendor: VENDOR,
        vendor_invoice_number: `E2E-REF-${STAMP}-${suffix}`, amount_cad: 12.34, tax_cad: 0, total_cad: 12.34,
        status: 'Brouillon', notes: 'Record jetable créé par un test E2E',
      }),
    })
    assert.equal(r.status, 201, `création de la facture : ${JSON.stringify(r.body)}`)
    const id = r.body.id
    const s = await apiFetch(`/achats-fournisseurs/${id}`, { method: 'PUT', body: JSON.stringify({ status: 'Reçue' }) })
    assert.equal(s.status, 200, `statut de la facture : ${JSON.stringify(s.body)}`)
    return id
  }

  const cleanupBill = async (id) => {
    if (!id) return
    try { await apiFetch(`/treasury/payment-schedule/${id}/pay`, { method: 'DELETE' }) } catch { /* pas de paiement */ }
    try { await apiFetch(`/achats-fournisseurs/${id}`, { method: 'DELETE' }) } catch { /* déjà parti */ }
  }

  const openSchedule = async () => {
    await page.goto(`${URL}/paiements-emis?onglet=cedule`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="schedule-view"]', { timeout: 20000 })
    await page.waitForSelector(`[data-testid="schedule-item-${billId}"]`, { timeout: 20000 })
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

    billId = await createBill('A')
    await openSchedule()
  })

  after(async () => {
    // Cleanup — s'exécute même en cas d'échec.
    await cleanupBill(billId)
    await browser?.close()
  })

  test('payer fait apparaître le champ de référence sur la ligne', async () => {
    // Avant le clic : aucun champ de référence.
    assert.equal(
      await page.locator(`[data-testid="schedule-reference-${billId}"]`).count(), 0,
      'le champ de référence ne doit pas exister avant de payer',
    )

    await page.click(`[data-testid="schedule-pay-${billId}"]`)
    // Le champ apparaît, la ligne est marquée « Payé » et reste affichée.
    await page.waitForSelector(`[data-testid="schedule-reference-${billId}"]`, { timeout: 20000 })
    await page.waitForSelector(`[data-testid="schedule-paid-${billId}"]`, { timeout: 10000 })
    // Le paiement du jour existe déjà côté serveur, encore sans référence.
    const created = await waitForPayment(p => !!p, 'paiement du jour créé')
    assert.ok(!created.reference, `le paiement ne doit pas encore porter de référence : ${created.reference}`)
  })

  // Le cas qui faisait perdre la référence : on va la chercher dans un AUTRE
  // onglet (site de la banque) et, au retour, la ligne était déjà partie — le
  // paiement avait été validé sans numéro par le blur du changement d'onglet.
  test("changer d'onglet ne valide rien — la ligne attend le retour", async () => {
    // Chromium headless garde toujours la page « visible et focusée » (même
    // avec un second onglet au premier plan) : on reproduit donc ce que le
    // navigateur RAPPORTE pendant qu'un autre onglet est actif — page cachée,
    // document sans focus — puis on provoque le blur du champ, exactement comme
    // le fait un vrai changement d'onglet.
    const etat = await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
      document.hasFocus = () => false
      document.activeElement?.blur()
      return { hidden: document.hidden, focused: document.hasFocus() }
    })
    assert.ok(etat.hidden && !etat.focused, 'le test doit simuler un onglet passé en arrière-plan')

    // Rien n'a été validé : le champ est toujours là, le paiement toujours sans
    // référence, et la facture n'a pas quitté l'écran.
    await new Promise(r => setTimeout(r, 1500))
    assert.equal(await page.locator(`[data-testid="schedule-reference-${billId}"]`).count(), 1,
      'le champ de référence doit attendre le retour sur la page')
    assert.equal(await page.locator(`[data-testid="schedule-item-${billId}"]`).count(), 1,
      'la ligne ne doit pas quitter la cédule pendant qu\'on cherche le numéro')
    const p = await payment()
    assert.ok(!p.reference, `aucune référence ne doit avoir été envoyée : ${p.reference}`)

    // Retour sur l'onglet : le curseur revient dans le champ, on n'a qu'à écrire.
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
      document.hasFocus = () => true
      window.dispatchEvent(new Event('focus'))
    })
    await page.waitForFunction(
      id => document.activeElement?.getAttribute('data-testid') === `schedule-reference-${id}`,
      billId, { timeout: 10000 },
    )
  })

  test('la référence saisie est enregistrée sur le paiement, puis la ligne quitte la cédule', async () => {
    await page.fill(`[data-testid="schedule-reference-${billId}"]`, REF)
    await page.keyboard.press('Enter')   // autosave au blur, aucun bouton « Enregistrer »

    const saved = await waitForPayment(p => p?.reference === REF, 'référence enregistrée sur le paiement')
    assert.equal(saved.reference, REF)
    // La facture payée quitte la cédule.
    await page.waitForSelector(`[data-testid="schedule-item-${billId}"]`, { state: 'detached', timeout: 20000 })
  })

  test('Échap passe la saisie — le paiement existe, sans référence', async () => {
    await cleanupBill(billId)
    billId = await createBill('B')
    await openSchedule()

    await page.click(`[data-testid="schedule-pay-${billId}"]`)
    await page.waitForSelector(`[data-testid="schedule-reference-${billId}"]`, { timeout: 20000 })
    await page.fill(`[data-testid="schedule-reference-${billId}"]`, 'À jeter — jamais enregistré')
    await page.keyboard.press('Escape')

    await page.waitForSelector(`[data-testid="schedule-item-${billId}"]`, { state: 'detached', timeout: 20000 })
    const p = await waitForPayment(x => !!x, 'paiement du jour créé malgré Échap')
    assert.ok(!p.reference, `Échap ne doit rien écrire comme référence : ${p.reference}`)
  })
})
